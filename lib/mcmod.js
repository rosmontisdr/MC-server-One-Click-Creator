'use strict';
/**
 * MC百科（mcmod.cn）查询：按模组名搜索，读页面里的「运行环境」字段。
 * 这一栏是中文社区人工维护的口径，取值形如「客户端需装, 服务端无效」，
 * 恰好覆盖 Modrinth 上大量缺位的 Forge 与国产模组。
 * 约定：只在匹配到确定的模组页且取到字段时才返回结论；否则返回 null，由上层维持原判。
 */
const { normalize, stemVariants } = require('./clientlist');

const SEARCH = 'https://search.mcmod.cn/s?key=';
const PAGE = 'https://www.mcmod.cn/class/';
const MAX_RESULTS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 搜索结果条目：链接文本形如 `[TLM] 车万女仆 (Touhou Little Maid)` */
function parseResults(html) {
  const out = [];
  const seen = new Set();
  for (const block of html.split('class="result-item"').slice(1)) {
    const m = /href="https:\/\/www\.mcmod\.cn\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(splitNames(stripTags(m[2])), m[1]);
    if (out.length >= MAX_RESULTS) break;
  }
  // 压平：每项为 {id, url, zh, en}
  const list = [];
  for (let i = 0; i < out.length; i += 2) {
    const names = out[i];
    const id = out[i + 1];
    list.push({ id, url: PAGE + id + '.html', ...names });
  }
  return list;
}

/** 拆出中文名与括号里的英文名，并去掉 [缩写] 前缀 */
function splitNames(text) {
  const t = String(text).replace(/^\[[^\]]{0,12}\]\s*/, '').trim();
  const m = /^(.*?)\s*[（(]\s*([^（()）]{1,60})\s*[)）]\s*$/.exec(t);
  return { zh: m ? m[1].trim() : t, en: m ? m[2].trim() : '' };
}

/** 页面里的「运行环境」，值只有 需装 / 可选 / 无效 三种，分客户端与服务端两栏 */
function parseEnv(html) {
  const m = /运行环境\s*[:：]\s*([^<]{1,80})/.exec(html);
  const out = { client: null, server: null };
  if (!m) return out;
  for (const part of m[1].split(/[,，、;；|]/)) {
    const s = part.trim();
    const level = s.includes('需装') ? 'required' : s.includes('可选') ? 'optional' : s.includes('无效') ? 'unsupported' : null;
    if (!level) continue;
    if (s.includes('客户端')) out.client = level;
    else if (s.includes('服务端')) out.server = level;
  }
  return out;
}

class Mcmod {
  constructor(opts = {}) {
    this.ua = opts.ua || 'mcsp';
    this.timeout = opts.timeout || 20000;
    this.delay = opts.delay === undefined ? 600 : opts.delay;
    this.enabled = typeof fetch === 'function' && opts.enabled !== false;
    this.cache = new Map();
    this.warnings = [];
    this.requests = 0;
    this.dead = false; // 站点不可用时整体停手，不逐个模组重试
    this._last = 0;
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** 串行 + 固定间隔：这是第三方维基站点，不值得为省几秒压垮它 */
  async _get(url) {
    if (this.dead) return null;
    const wait = this.delay - (Date.now() - this._last);
    if (wait > 0) await sleep(wait);
    this._last = Date.now();
    this.requests++;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': this.ua, Accept: 'text/html', Referer: 'https://www.mcmod.cn/' },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      this.dead = true;
      this.warn(`MC百科访问失败：${err.message}，本次不再查询`);
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      this.dead = true;
      this.warn(`MC百科返回 HTTP ${res.status}，本次不再查询`);
      return null;
    }
    return res.text();
  }

  /**
   * 查一个模组的运行环境。
   * @param {string[]} keys 候选检索词，按优先级排（模组 id、显示名、文件名主干）
   * @returns {Promise<{id:string,url:string,zh:string,en:string,client:string|null,server:string|null}|null>}
   */
  async lookup(keys) {
    if (!this.enabled || this.dead) return null;
    const cands = new Set();
    for (const k of keys) {
      const n = normalize(k);
      if (n) cands.add(n);
      for (const v of stemVariants(String(k))) cands.add(v);
    }
    for (const key of keys) {
      if (this.dead) return null;
      const ck = `k:${String(key).toLowerCase()}`;
      if (this.cache.has(ck)) {
        const hit = this.cache.get(ck);
        if (hit) return hit;
        continue;
      }
      const html = await this._get(SEARCH + encodeURIComponent(key));
      if (html === null) { this.cache.set(ck, null); continue; }
      const target = this._pick(parseResults(html), cands);
      if (!target) { this.cache.set(ck, null); continue; }
      const page = await this._get(target.url);
      if (page === null) { this.cache.set(ck, null); continue; }
      const env = parseEnv(page);
      if (!env.server) {
        // 页面没有运行环境栏（整合包、工具、教程页都会如此），不作为结论
        this.cache.set(ck, null);
        continue;
      }
      const hit = { ...target, ...env };
      this.cache.set(ck, hit);
      return hit;
    }
    return null;
  }

  /** 只在名字对得上时才认账：认错页面会把该保留的模组剔掉 */
  _pick(results, cands) {
    for (const r of results) {
      if (cands.has(normalize(r.zh)) || cands.has(normalize(r.en))) return r;
    }
    return null;
  }
}

module.exports = { Mcmod, parseEnv, parseResults, splitNames };
