'use strict';
/**
 * mcsp 公开接口。其他程序只需 require 本文件，不必走命令行。
 *
 *   const mcsp = require('D:/claude/mcsp');
 *   const plan    = await mcsp.plan(input, { onEvent });        // 只体检，不落盘
 *   const report  = await mcsp.build(input, out, { onEvent });  // 体检并写出服务端包
 *   const brief   = await mcsp.identify(input);                 // 只看形态与加载器
 *
 * 三个函数都接受 onEvent(evt) 回调，逐条回吐进度与判定结果，宿主可直接做进度条。
 * cli 的 --json 输出的就是同一串事件（NDJSON），两种调用方式结果一致。
 */
const fs = require('fs');
const path = require('path');
const { open, detectLoader, detectMcVersion } = require('./lib/pack');
const { analyze, gateDeps, isModRel } = require('./lib/analyze');
const { classify } = require('./lib/classify');
const { Modrinth } = require('./lib/online');
const { Mcmod } = require('./lib/mcmod');
const { normalize } = require('./lib/clientlist');
const policy = require('./lib/policy');
const writer = require('./lib/build');
const { fetchLoader } = require('./lib/fetchloader');

const VERSION = '1.0.0';
const TOOL = { name: 'mcsp', version: VERSION };

function userAgent(opts) {
  return opts.ua || `mcsp/${VERSION} (modpack-to-server packer)`;
}

/** 命令行传进来的 --loader forge-1.20.1-47.2.0 形式，拆成名字与版本 */
function parseLoaderArg(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  const s = String(v);
  const i = s.indexOf('-');
  return i < 0 ? { name: s, version: null } : { name: s.slice(0, i), version: s.slice(i + 1) };
}

/** 只读输入形态，不读模组、不联网。给宿主做「这是哪种整合包」的预览用 */
async function identify(input, opts = {}) {
  const pack = open(input, { skip: (rel) => policy.reasonFor(rel) !== null });
  try {
    return {
      kind: pack.kind,
      name: pack.name,
      loader: detectLoader(pack.signs(), [], pack.loaderHint),
      mcVersion: pack.mcVersion,
      fileCount: pack.files.length,
      notes: pack.notes,
      warnings: pack.warnings,
    };
  } finally {
    pack.close();
  }
}

/**
 * 体检并给出方案，不写任何文件。
 * @returns {Promise<object>} plan，字段见 HANDOFF.md
 */
async function plan(input, opts = {}) {
  const ctx = await prepare(input, opts);
  ctx.pack.close();
  return ctx.plan;
}

/**
 * 体检并写出服务端包。
 * @param {string} input 客户端整合包目录 / zip / .mrpack
 * @param {string} out 输出目录；已存在且非空时需 opts.force
 */
async function build(input, out, opts = {}) {
  if (!out) throw new Error('缺少输出目录');
  // 输出落在输入树内会被下一次运行当成输入复制一遍，代价是无声的自我繁殖，必须在开工前拒绝
  const rel = path.relative(path.resolve(input), path.resolve(out));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`输出目录不能位于输入目录之内：${out}\n换一个 -o，或改用同一级的兄弟目录`);
  }
  const outAbs = path.resolve(out);
  const outExisted = fs.existsSync(outAbs);
  // 先校验输出目录，暂存区必须在里面：同卷 rename 才算纯元数据操作
  writer.ensureOut(outAbs, opts.force);
  const stageDir = fs.mkdtempSync(path.join(outAbs, '.mcsp-stage-'));
  const staged = new Map();
  let pack = null;
  try {
    const ctx = await prepare(input, {
      ...opts,
      stageDir,
      staged,
      // prepare 中途失败时也要能关掉 zip 句柄
      onPack: (p) => { pack = p; },
    });
    const report = await writer.build(ctx.plan, {
      out,
      force: opts.force,
      rcon: opts.rcon,
      jvm: opts.jvm,
      pack: ctx.pack,
      staged,
      outReady: true,
      ua: userAgent(opts),
      tool: TOOL,
      onEvent: opts.onEvent,
      download: opts.download,
      // 默认取回并安装服务端文件：没有它们，产物一启动就报缺文件。
      // 宿主不想联网时显式传 fetch: false；plan() 永远不联网取文件。
      fetch: opts.fetch === false ? null : (dir, p) => fetchLoader(dir, p, { ua: userAgent(opts) }),
      downloadTimeout: opts.downloadTimeout,
    });
    if (opts.onEvent) opts.onEvent({ t: 'done', out: report.out, counts: report.counts, report: report.report });
    return report;
  } finally {
    if (pack) pack.close();
    // 剔除的模组与失败残留都在暂存区里，整棵删掉；输出目录只留最终文件
    fs.rmSync(stageDir, { recursive: true, force: true });
    // 分析阶段就失败时，输出目录是本次新建的：空着就一并收回，避免留下误导性的空目录
    if (!outExisted) {
      try { fs.rmdirSync(outAbs); } catch { /* 非空或已被删除 */ }
    }
  }
}

async function prepare(input, opts) {
  const emit = opts.onEvent || (() => {});
  const online = new Modrinth({ ua: userAgent(opts), enabled: opts.online !== false, timeout: opts.timeout });
  // 允许直接注入一个已构造好的查询器：测试与宿主可以借此接管网络
  const mcmod = opts.mcmod && typeof opts.mcmod.lookup === 'function'
    ? opts.mcmod
    : new Mcmod({ ua: userAgent(opts), enabled: opts.mcmod !== false, delay: opts.mcmodDelay });
  // 按排除策略做粗筛：整棵不需要的子树不进枚举，但记录下结果供报告使用
  const pack = open(input, { skip: (rel) => policy.reasonFor(rel) !== null });
  if (opts.onPack) opts.onPack(pack);
  emit({ t: 'start', input: pack.name, kind: pack.kind });

  // build 路径：复制一遍就同时得到落盘副本与 sha512，后续分析对着暂存文件做。
  // plan 没有暂存区，仍走只读路径。
  let stage = null;
  if (opts.stageDir && opts.staged) {
    let seq = 0;
    stage = (rel) => {
      const dest = path.join(opts.stageDir, `m${++seq}.jar`);
      const rec = pack.copyAndHash(rel, dest);
      opts.staged.set(rel, { path: dest, size: rec.size, hash512: rec.hash512 });
      return opts.staged.get(rel);
    };
  }

  const warnings = [...pack.warnings];
  const scan = await analyze(pack, {
    online,
    mcmod,
    rules: opts.rules,
    dropOptional: opts.dropOptional,
    mcmodLimit: opts.mcmodLimit,
    onEvent: emit,
    stage,
  });
  warnings.push(...scan.warnings);
  for (const w of online.warnings) warnings.push(w);
  for (const w of mcmod.warnings) warnings.push(w);

  const cls = { rules: opts.rules, dropOptional: opts.dropOptional, conservative: opts.conservative };
  let mods = classify(scan.mods, cls);
  // 依赖闸门会连环保留（找回的模组自身还有依赖），迭代到不再有新的找回为止
  for (let round = 0; round < 3; round++) {
    if (!gateDeps(scan.mods, mods)) break;
    mods = classify(scan.mods, cls);
  }
  const loader = detectLoader(pack.signs(), scan.mods, parseLoaderArg(opts.loader) || pack.loaderHint);
  const mcVersion = opts.mc || pack.mcVersion || detectMcVersion(scan.mods);

  const { write, skip } = splitFiles(pack, mods);
  // 被排除的文件也在检查范围内：账号文件正属于被排除之列，但必须明确提醒用户
  const sensitive = [...new Set([...pack.files, ...pack.skipped].map((f) => f.rel).filter((r) => policy.isSensitive(r)))];
  if (sensitive.length) {
    warnings.push(
      `输入里含启动器账号文件（${sensitive.join('、')}），已排除、不会写进服务端包；` +
      '该文件含登录令牌，这个目录不宜整体打包外传。',
    );
  }

  const manifestOnly = pack.manifest.filter((m) => !m.path).length;
  const byEvidence = (ev, dec) => mods.filter((m) => m.evidence === ev && (!dec || m.decision === dec)).length;
  // 稳妥模式下有一部分「判定该剔但留下了」，统计与对比一律用判定结论，两种模式才可比
  const eff = (m) => m.judged || m.decision;
  // 按「结论变化」而不是「证据来源」统计百科的影响：跑一遍去掉百科结论的判定做对照
  const noMcmod = classify(scan.mods.map((m) => (m.mcmod ? { ...m, mcmod: null } : m)), cls);
  const counts = {
    modsTotal: mods.length,
    kept: mods.filter((m) => m.decision !== 'drop').length,
    dropped: mods.filter((m) => m.decision === 'drop').length,
    // 稳妥模式：判定该剔、但因证明不了不影响握手而留下的个数（记账用，不对外宣告）
    judgedClientOnly: mods.filter((m) => m.judged === 'drop').length,
    // 下面几个计数一律按「实际剔除了」算，否则稳妥模式下会和摘要里的剔除数打架
    heuristicDropped: mods.filter((m) => m.decision === 'drop' && m.evidence === 'heuristic').length,
    reviewKept: mods.filter((m) => m.review && m.decision !== 'drop').length,
    // 三道闸门各拦下多少：内容、网络通道、被依赖
    contentKept: byEvidence('content'),
    netKept: byEvidence('net'),
    depsKept: byEvidence('deps'),
    // MC百科带来的改动：查到多少条目、据此挪回多少、据此剔除多少
    mcmodFound: scan.stats.mcmodFound,
    mcmodRestored: mods.filter((m, i) => eff(m) !== 'drop' && noMcmod[i].decision === 'drop').length,
    mcmodDropped: mods.filter((m, i) => m.decision === 'drop' && noMcmod[i].decision !== 'drop').length,
    // 作者自称两端通用却被剔除的：剔错代价最大的一类，摘要与报告都要点名
    conflicts: mods.filter((m) => m.conflict && m.decision === 'drop').length,
    filesWrite: write.length,
    downloads: write.filter((f) => f.origin === 'download').length,
    skipped: skip.length,
    broken: scan.broken.length,
    manifestOnly,
  };

  emit({
    t: 'mods',
    total: counts.modsTotal,
    kept: counts.kept,
    dropped: counts.dropped,
    judgedClientOnly: counts.judgedClientOnly,
    contentKept: counts.contentKept,
    netKept: counts.netKept,
    depsKept: counts.depsKept,
    mcmodFound: counts.mcmodFound,
    mcmodRestored: counts.mcmodRestored,
    reviewKept: counts.reviewKept,
  });
  // 剔除的与「闸门拦回来的」都要发给宿主：后者是复审时最需要看的一批。
  // decision 报的是判定结论，kept 报的是实际有没有留下，保守模式下两者会不同。
  for (const m of mods) {
    const judged = eff(m);
    if (judged === 'drop' || ['content', 'net', 'deps'].includes(m.evidence)) {
      emit({ t: 'mod', rel: m.rel, decision: judged, kept: m.decision, reason: m.reason, evidence: m.evidence, confidence: m.confidence });
    }
  }

  return {
    pack,
    plan: {
      tool: TOOL,
      input: {
        path: input,
        kind: pack.kind,
        name: pack.name,
        loader,
        mcVersion,
        notes: pack.notes,
        warnings: pack.warnings,
      },
      mods,
      broken: scan.broken,
      write,
      skip,
      counts,
      warnings,
      manifestOnly,
    },
  };
}

/** 把「包内实体文件」与「清单里待下载的文件」合成一份写出清单，逐条套用排除策略 */
function splitFiles(pack, mods) {
  const droppedIds = new Set();
  for (const m of mods) {
    if (m.decision !== 'drop') continue;
    if (m.id) droppedIds.add(normalize(m.id));
    droppedIds.add(normalize(m.rel.split('/').pop().replace(/\.(?:jar|zip)$/i, '')));
  }
  const modByRel = new Map(mods.map((m) => [m.rel, m]));

  const all = new Map();
  for (const f of pack.files) {
    if (!all.has(f.rel)) all.set(f.rel, { rel: f.rel, size: f.size, origin: 'in-pack' });
  }
  for (const m of pack.manifest) {
    if (!m.path || all.has(m.path)) continue; // 包里已有实体，不必再下
    all.set(m.path, {
      rel: m.path, size: m.size, origin: 'download', url: m.url, sha512: m.sha512, sha1: m.sha1,
    });
  }

  const write = [];
  const skip = [];
  for (const item of [...all.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    const why = skipReason(item.rel, modByRel, droppedIds);
    if (why) skip.push({ rel: item.rel, why });
    else write.push(item);
  }
  return { write, skip: [...aggregateSkips(pack.skipped), ...skip] };
}

function skipReason(rel, modByRel, droppedIds) {
  const mod = isModRel(rel) ? modByRel.get(rel) : null;
  if (mod && mod.decision === 'drop') return `模组已剔除：${mod.reason}`;
  return policy.reasonFor(rel) || policy.configReason(rel, droppedIds) || null;
}

/** 被粗筛挡在枚举之外的一批文件合并成条目：整棵目录只报一条，zip 内逐个跳过则计数 */
function aggregateSkips(records) {
  const dirs = new Map();
  const files = [];
  for (const r of records) {
    const top = r.rel.split('/')[0];
    const why = policy.reasonFor(r.rel) || '已排除';
    const key = `${top}|${why}`;
    if (r.isDir) {
      dirs.set(key, { rel: `${top}/`, why, files: null });
    } else if (r.rel.includes('/')) {
      const e = dirs.get(key) || { rel: `${top}/`, why, files: 0 };
      e.files = (e.files || 0) + 1;
      dirs.set(key, e);
    } else {
      files.push({ rel: r.rel, why });
    }
  }
  return [...dirs.values(), ...files];
}

module.exports = { plan, build, identify, VERSION, TOOL, _internal: { splitFiles, aggregateSkips } };
