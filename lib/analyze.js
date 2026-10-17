'use strict';
/**
 * 体检阶段：列模组、逐个算 sha512 并读 jar 证据，再按需联网与读字节做复核。
 * 顺序是「先便宜的、后昂贵的」：本地元数据 → Modrinth 批量反查 → MC百科逐个查 → 网络通道扫 class 字节。
 * 后一步会跳过前一步已经定论的模组，所以越靠后的步骤覆盖的模组越少。
 */
const crypto = require('crypto');
const { inspectJar, scanNetwork } = require('./jar');
const { isCandidate, serverWants } = require('./classify');

const MOD_RE = /^mods\/[^/]+\.(?:jar|zip)$/i;

function isModRel(rel) { return MOD_RE.test(rel); }

function sha512(buf) {
  return crypto.createHash('sha512').update(buf).digest('hex');
}

/** 暂存只是性能路径，失败就退回整读；真正的写盘失败由 write 阶段记录 */
function tryStage(stage, rel) {
  try { return stage(rel); } catch { return null; }
}

/**
 * @param {object} pack pack.open() 的返回值
 * @param {{online?:object, mcmod?:object, rules?:object, dropOptional?:boolean, mcmodLimit?:number,
 *          onEvent?:Function, stage?:Function}} opts
 *   stage(rel)：build 路径专用，把模组复制到暂存区并返回 {path,size,hash512}；不传则整读输入。
 */
async function analyze(pack, opts = {}) {
  const emit = opts.onEvent || (() => {});
  const warnings = [];
  const broken = [];
  const mods = [];
  // 已落进暂存区的模组：rel → 暂存文件路径。后续元数据与通道扫描都直接读它，不再碰输入。
  const stagedPaths = new Map();

  const localMods = pack.files.filter((f) => isModRel(f.rel));
  emit({ t: 'phase', name: 'scan', done: 0, total: localMods.length });
  let done = 0;
  for (const f of localMods) {
    // build 路径下先复制再分析：读一遍输入就同时得到写盘副本与 sha512。
    // 暂存失败时退回原来的整读路径，由 write 阶段如实记失败。
    const staged = opts.stage ? tryStage(opts.stage, f.rel) : null;
    if (staged) {
      stagedPaths.set(f.rel, staged.path);
      const jar = inspectJar(staged.path);
      if (jar.err) warnings.push(`解析元数据失败 ${f.rel}：${jar.err}`);
      mods.push({ rel: f.rel, size: staged.size, hash512: staged.hash512, jar, origin: 'in-pack' });
      done++;
      if (done % 25 === 0) emit({ t: 'phase', name: 'scan', done, total: localMods.length });
      continue;
    }

    let buf;
    try {
      buf = pack.read(f.rel);
    } catch (err) {
      // 读不出来的 jar 既判不了也复制不了，直接排除并留痕，不静默吞掉
      broken.push({ rel: f.rel, why: err.message });
      warnings.push(`无法读取 ${f.rel}：${err.message}`);
      continue;
    }
    const jar = inspectJar(buf);
    // 解析不出元数据的模组只剩「无证据」一条路，必须让使用者看到，不能静默当普通模组放过
    if (jar.err) warnings.push(`解析元数据失败 ${f.rel}：${jar.err}`);
    mods.push({ rel: f.rel, size: buf.length, hash512: sha512(buf), jar, origin: 'in-pack' });
    done++;
    if (done % 25 === 0) emit({ t: 'phase', name: 'scan', done, total: localMods.length });
  }
  emit({ t: 'phase', name: 'scan', done, total: localMods.length });

  // 整合包清单里声明、但包里没有实体的模组（.mrpack），运行侧由清单 env 直接给出
  const localRels = new Set(mods.map((m) => m.rel));
  for (const m of pack.manifest) {
    if (!m.path || !isModRel(m.path) || m.source !== 'modrinth' || localRels.has(m.path)) continue;
    mods.push({
      rel: m.path,
      size: m.size,
      hash512: m.sha512,
      jar: null,
      origin: 'download',
      url: m.url,
      sha1: m.sha1,
      env: { client: m.client, server: m.server },
    });
  }

  warnDuplicates(mods, warnings);
  const onlineFound = await attachOnline(mods, opts);
  const mcmodFound = await attachMcmod(mods, opts);
  const netKept = await gateNetwork(mods, pack, opts, warnings, stagedPaths);
  return { mods, broken, warnings, stats: { onlineFound, mcmodFound, netKept } };
}

/** 同一 mods/ 里出现两个同 id 模组，服务端会因重复注册起不来，必须提前点出来 */
function warnDuplicates(mods, warnings) {
  const byId = new Map();
  for (const m of mods) {
    const id = m.jar && m.jar.ids && m.jar.ids[0];
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(m.rel);
  }
  for (const [id, rels] of byId) {
    if (rels.length > 1) warnings.push(`模组 id 重复：${id} 出现 ${rels.length} 次（${rels.join('、')}），服务端可能无法启动`);
  }
}

// ── 联网：Modrinth ──────────────────────────────────────────────────────────

/**
 * 本地证据已定论的不查网：省请求，也让结果更稳定。
 * 只认作者给出的确定结论（纯客户端 / 服务端专用）；side=BOTH 仍要查，因为断言太弱。
 */
function decidedLocally(mod) {
  return Boolean(mod.jar && (mod.jar.side === 'client' || mod.jar.side === 'server'));
}

async function attachOnline(mods, opts) {
  const online = opts.online;
  if (!online || !online.enabled) return 0;
  const hashes = mods.filter((m) => m.hash512 && !decidedLocally(m)).map((m) => m.hash512);
  if (!hashes.length) return 0;
  const emit = opts.onEvent || (() => {});
  emit({ t: 'phase', name: 'online', done: 0, total: hashes.length });
  let found = 0;
  try {
    const map = await online.byHashes(hashes);
    for (const m of mods) {
      if (!m.hash512) continue;
      const hit = map.get(m.hash512);
      if (hit && hit.project) { m.online = hit; found++; }
    }
  } catch (err) {
    // 联网不可用不阻断构建：整批留作未收录，由名单层接手
    online.warn(`联网查询不可用：${err.message}`);
  }
  emit({ t: 'phase', name: 'online', done: hashes.length, total: hashes.length, found });
  return found;
}

// ── 联网：MC百科运行环境 ────────────────────────────────────────────────────

/**
 * 用 MC百科的「运行环境」复核，查的是「结论还能被改变」的模组：
 * 已被正向证据保留的不查，自有内容的也不查（内容闸门无论如何都会留下它）。
 * 剩下的就是可能被冤枉的候选与毫无证据的模组，正好是百科最有价值的用武之地。
 */
async function attachMcmod(mods, opts) {
  const mcmod = opts.mcmod;
  if (!mcmod || !mcmod.enabled) return 0;
  const limit = opts.mcmodLimit || 200;
  const targets = mods.filter((m) => !serverWants(m, opts) && !(m.jar && m.jar.contentWhy));
  if (!targets.length) return 0;
  const emit = opts.onEvent || (() => {});
  const queue = targets.slice(0, limit);
  if (targets.length > queue.length) {
    mcmod.warn(`待复核模组 ${targets.length} 个，超出上限只查前 ${limit} 个（--mcmod-limit 可调）`);
  }
  emit({ t: 'phase', name: 'mcmod', done: 0, total: queue.length });
  let done = 0;
  let found = 0;
  for (const m of queue) {
    if (mcmod.dead) break;
    const stem = m.rel.split('/').pop().replace(/\.(?:jar|zip)$/i, '');
    const keys = [m.jar?.ids?.[0], m.jar?.name, stem].filter(Boolean);
    let hit = null;
    try {
      hit = await mcmod.lookup(keys);
    } catch (err) {
      mcmod.warn(`MC百科查询异常：${err.message}`);
    }
    if (hit) {
      m.mcmod = hit;
      found++;
      emit({ t: 'mcmod', rel: m.rel, server: hit.server, env: `${hit.client || '?'}/${hit.server}`, url: hit.url });
    }
    done++;
    if (done % 5 === 0) emit({ t: 'phase', name: 'mcmod', done, total: queue.length });
  }
  emit({ t: 'phase', name: 'mcmod', done: queue.length, total: queue.length, found });
  return found;
}

// ── 闸门：网络通道 ──────────────────────────────────────────────────────────

/**
 * 对候选剔除项扫网络通道。要解压全部 class，所以只扫「有客户端证据、且没有自有内容」的模组，
 * 其余要么已被正向保留，要么会被内容闸门拦下，都不必花这份 IO。
 */
async function gateNetwork(mods, pack, opts, warnings, stagedPaths) {
  const targets = mods.filter((m) => m.origin === 'in-pack' && !(m.jar && m.jar.contentWhy) && isCandidate(m, opts));
  const fromManifest = mods.filter((m) => m.origin === 'download' && isCandidate(m, opts));
  if (fromManifest.length) {
    warnings.push(
      `${fromManifest.length} 个模组只存在于清单里、本地没有文件，无法扫自有内容与网络通道；` +
      '这类模组只能依据清单声明、MC百科与 Modrinth 判断。',
    );
  }
  if (!targets.length) return 0;
  const emit = opts.onEvent || (() => {});
  emit({ t: 'phase', name: 'netgate', done: 0, total: targets.length });
  let done = 0;
  let kept = 0;
  for (const m of targets) {
    try {
      // 暂存副本已在盘上，直接随机访问读 class，避免把整个 jar 再读进内存
      const src = stagedPaths && stagedPaths.has(m.rel) ? stagedPaths.get(m.rel) : pack.read(m.rel);
      const net = scanNetwork(src);
      if (net.any) { m.net = net; kept++; }
    } catch (err) {
      // 读不出来就不给通道结论，宁可留在服务端
      m.net = { api: [], c2s: [], any: true, why: err.message };
      kept++;
      warnings.push(`扫描网络通道失败 ${m.rel}：${err.message}，按「有通道」保留`);
    }
    done++;
    if (done % 5 === 0) emit({ t: 'phase', name: 'netgate', done, total: targets.length });
  }
  emit({ t: 'phase', name: 'netgate', done: targets.length, total: targets.length, found: kept });
  return kept;
}

// ── 闸门：依赖 ──────────────────────────────────────────────────────────────

/** 服务端自带、永远存在的提供者 */
const ALWAYS_PROVIDED = new Set([
  'minecraft', 'forge', 'fml', 'java', 'neoforge', 'connector',
  'fabricloader', 'fabric', 'fabric_api', 'fabric-api', 'quilt_loader', 'quilt',
]);

/**
 * 保留的模组若声明了必需依赖，而提供该依赖的模组正被剔除，就把它找回来。
 * 依赖可以连环（找回的模组自身还有依赖），故由调用方循环到没有新的找回为止。
 * 判定用 judged（判定结论）而不是 decision（实际动作）：稳妥模式下两者会不同，
 * 用判定结论才能算出「激进模式会剔掉的那批」，两种模式的对照才有意义。
 * @returns {number} 本轮新标记找回的模组数
 */
function gateDeps(mods, entries) {
  const judged = (e) => e.judged || e.decision;
  const keptIds = new Set();
  for (let i = 0; i < mods.length; i++) {
    if (judged(entries[i]) === 'drop') continue;
    for (const id of mods[i].jar?.ids || []) keptIds.add(id);
  }
  let added = 0;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (judged(entries[i]) !== 'drop' || m.requiredBy) continue;
    const mine = new Set(m.jar?.ids || []);
    if (!mine.size) continue;
    const needers = [];
    for (let j = 0; j < mods.length; j++) {
      if (judged(entries[j]) === 'drop') continue;
      for (const d of mods[j].jar?.deps || []) {
        if (!d.mandatory || ALWAYS_PROVIDED.has(d.id) || keptIds.has(d.id)) continue;
        if (mine.has(d.id)) needers.push(mods[j].jar?.ids?.[0] || mods[j].rel);
      }
    }
    if (needers.length) {
      m.requiredBy = [...new Set(needers)];
      added++;
    }
  }
  return added;
}

module.exports = { analyze, gateDeps, isModRel };
