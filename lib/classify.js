'use strict';
/**
 * 判定一个模组能否从服务端移出。门槛不是「看起来像客户端模组」，而是三道闸门全过：
 *   内容  自有命名空间下有方块/配方/掉落/进度/方块实体 —— 内容物必须在服务端，标注什么运行侧都没用
 *   网络  注册了 Forge / Architectury / Fabric 的网络通道 —— Forge 登录握手核对通道，拿走会让客户端登不上
 *   依赖  被某个保留的模组当作必需依赖 —— 拿走服务端起不来
 * 任一不满足即保留。作者明确声明两端都要（side=BOTH/SERVER）同样不得被名单覆盖。
 * 没有纯客户端证据的模组一律保留：多留只是多占内存，误剔会让服务端起不来。
 */
const { matchClientList } = require('./clientlist');

/** 正向证据：服务端要它 */
function serverWants(mod, opts = {}) {
  const jar = mod.jar;
  // 作者声明服务端专用就是明确的保留依据；声明两端通用不算，那多半是顺手写的
  if (jar && jar.side === 'server') {
    return { reason: `author:${jar.sideWhy}`, evidence: 'author', confidence: 'high' };
  }
  if (mod.env?.server === 'required') return { reason: 'mrpack:server=required', evidence: 'metadata', confidence: 'high' };
  if (mod.mcmod?.server === 'required') return { reason: 'mcmod:运行环境=服务端需装', evidence: 'mcmod', confidence: 'high' };
  if (mod.online?.project?.server === 'required') return { reason: 'modrinth:server=required', evidence: 'modrinth', confidence: 'high' };
  if (opts.dropOptional) return null;
  // 「服务端可选」表示装了也没事：默认保留（JEI、苹果皮都在此列），要精简时用 --drop-optional
  if (mod.mcmod?.server === 'optional') return { reason: 'mcmod:运行环境=服务端可选', evidence: 'mcmod', confidence: 'medium' };
  if (mod.online?.project?.server === 'optional') return { reason: 'modrinth:server=optional', evidence: 'modrinth', confidence: 'medium' };
  if (mod.env?.server === 'optional') return { reason: 'mrpack:server=optional', evidence: 'metadata', confidence: 'medium' };
  return null;
}

/** 反向证据：纯客户端 */
function clientEvidence(mod, opts = {}) {
  const jar = mod.jar;
  if (jar && jar.side === 'client') return { reason: `author:${jar.sideWhy}`, evidence: 'author', confidence: 'high' };
  if (mod.env?.server === 'unsupported') return { reason: 'mrpack:server=unsupported', evidence: 'metadata', confidence: 'high' };
  if (mod.online?.project?.server === 'unsupported') return { reason: 'modrinth:server=unsupported', evidence: 'modrinth', confidence: 'high' };
  if (mod.mcmod?.server === 'unsupported') return { reason: 'mcmod:运行环境=服务端无效', evidence: 'mcmod', confidence: 'medium' };

  const stem = mod.rel.split('/').pop().replace(/\.(?:jar|zip)$/i, '');
  const names = [mod.jar?.ids?.[0], mod.jar?.name, stem].filter(Boolean);
  const hit = matchClientList(names, stem);
  if (hit) return { reason: `heuristic:${hit.token}`, evidence: 'heuristic', confidence: hit.exact ? 'medium' : 'low' };

  // --drop-optional 时把「服务端可选」当作可剔证据，否则它只在正向里出现过
  if (opts.dropOptional) {
    if (mod.mcmod?.server === 'optional') return { reason: 'mcmod:运行环境=服务端可选（--drop-optional）', evidence: 'mcmod', confidence: 'low' };
    if (mod.online?.project?.server === 'optional') return { reason: 'modrinth:server=optional（--drop-optional）', evidence: 'modrinth', confidence: 'low' };
    if (mod.env?.server === 'optional') return { reason: 'mrpack:server=optional（--drop-optional）', evidence: 'metadata', confidence: 'low' };
  }
  return null;
}

/** 需要联网/读字节核对的模组：有客户端证据、且没有正向证据 */
function isCandidate(mod, opts = {}) {
  return !serverWants(mod, opts) && Boolean(clientEvidence(mod, opts));
}

/**
 * @param {Array<object>} mods analyze() 产出的模组记录
 * @param {{rules?:{keep:string[],drop:string[]}, dropOptional?:boolean, conservative?:boolean}} [opts]
 *   conservative：稳妥模式——只剔除能证明「客户端不指望服务端有它」的模组（见 jar.handshakeSafe）。
 *   证明不了的照样保留，但用 judged 记下「判定本该剔除」，报告里可查。
 */
function classify(mods, opts = {}) {
  const rules = { keep: opts.rules?.keep || [], drop: opts.rules?.drop || [] };
  const out = mods.map((mod) => judge(mod, rules, opts));
  if (!opts.conservative) return out;
  for (const e of out) {
    if (e.decision !== 'drop') continue;
    if (e.handshakeSafe) continue; // 拿掉它客户端不会对不上，稳妥模式也照样剔
    e.judged = 'drop';
    e.decision = 'keep';
    e.keptBy = 'conservative';
  }
  return out;
}

function judge(mod, rules, opts) {
  const stem = mod.rel.split('/').pop().replace(/\.(?:jar|zip)$/i, '');
  const names = [mod.jar?.ids?.[0], mod.jar?.name, stem].filter(Boolean);
  const entry = {
    rel: mod.rel,
    id: mod.jar?.ids?.[0] ?? null,
    name: mod.jar?.name ?? null,
    version: mod.jar?.version ?? null,
    loader: mod.jar?.loader ?? null,
    hash512: mod.hash512 ?? null,
    side: mod.jar?.side ?? 'none',
    displayTest: mod.jar?.displayTest ?? null,
    handshakeSafe: Boolean(mod.jar?.handshakeSafe),
    handshakeWhy: mod.jar?.handshakeWhy ?? null,
    decision: 'keep',
    reason: 'unknown',
    evidence: 'none',
    confidence: 'none',
    review: false,
    content: mod.jar?.content ?? null,
    net: mod.net ?? null,
    mcmod: mod.mcmod ?? null,
    project: mod.online?.project ?? null,
    modVersion: mod.online?.version ?? null,
  };

  const forced = matchRules(names, mod.rel, entry.project, rules);
  if (forced) return decide(entry, forced, `rule:--${forced}`, 'rule', 'high');

  const wants = serverWants(mod, opts);
  if (wants) {
    const e = decide(entry, 'keep', wants.reason, wants.evidence, wants.confidence);
    e.review = wants.confidence !== 'high';
    return e;
  }

  const client = clientEvidence(mod, opts);
  if (!client) {
    entry.review = true;
    return entry;
  }

  // 三道闸门，任一不过就保留并说明原因
  if (mod.jar?.contentWhy) {
    const e = decide(entry, 'keep', `content:自有${mod.jar.contentWhy}`, 'content', 'high');
    e.review = true;
    return e;
  }
  if (mod.net?.any) {
    const what = [...(mod.net.c2s || []), ...(mod.net.api || [])].slice(0, 3).join('/');
    const e = decide(entry, 'keep', `net:注册网络通道 ${what}`, 'net', 'high');
    e.review = true;
    return e;
  }
  if (mod.requiredBy?.length) {
    const e = decide(entry, 'keep', `deps:被 ${mod.requiredBy.slice(0, 3).join('、')} 依赖`, 'deps', 'high');
    e.review = true;
    return e;
  }

  const e = decide(entry, 'drop', client.reason, client.evidence, client.confidence);
  // 名单与弱证据属启发式，剔除后必须人工过目；作者/清单/Modrinth 的硬证据不必
  e.review = client.evidence !== 'author' && client.evidence !== 'metadata';
  // 作者自称两端通用却被剔了：这是最容易剔错的一类，单独标出来供复核（对应真实案例里的事后审计）
  if (mod.jar?.side === 'both') e.conflict = mod.jar.sideWhy;
  return e;
}

function decide(entry, decision, reason, evidence, confidence) {
  entry.decision = decision;
  entry.reason = reason;
  entry.evidence = evidence;
  entry.confidence = confidence;
  return entry;
}

/** --keep / --drop：带 * 按通配，否则按子串；比对文件名、模组 id 与项目 slug/标题 */
function matchRules(names, rel, project, rules) {
  const hay = [...names, rel];
  if (project) hay.push(project.slug, project.title);
  const fields = hay.filter(Boolean).map((s) => String(s).toLowerCase());
  for (const decision of ['drop', 'keep']) {
    for (const raw of rules[decision]) {
      const pat = String(raw).toLowerCase();
      const hit = pat.includes('*')
        ? fields.some((s) => wildcardRe(pat).test(s))
        : fields.some((s) => s.includes(pat));
      if (hit) return decision;
    }
  }
  return null;
}

const WILDCARD = new Map();
function wildcardRe(pat) {
  let re = WILDCARD.get(pat);
  if (!re) {
    re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    WILDCARD.set(pat, re);
  }
  return re;
}

module.exports = { classify, serverWants, clientEvidence, isCandidate };
