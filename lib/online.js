'use strict';
/**
 * Modrinth 查询客户端（零依赖，用全局 fetch）。
 * 路线：jar 的 sha512 → 版本记录 → 项目 → client_side / server_side，逐文件哈希反查，不靠文件名猜。
 * 联网失败一律不抛：整批退化为「未收录」，构建照常进行，由关键词层接手。
 */
const API = 'https://api.modrinth.com/v2';
const HASH_CHUNK = 200;
const ID_CHUNK = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Modrinth {
  constructor(opts = {}) {
    this.ua = opts.ua || 'mcsp';
    this.timeout = opts.timeout || 20000;
    this.tries = opts.tries || 3;
    this.enabled = typeof fetch === 'function' && opts.enabled !== false;
    this.warnings = [];
    this.requests = 0;
  }

  async _json(url, init = {}) {
    if (!this.enabled) throw new Error('未启用联网查询');
    let lastErr = null;
    for (let attempt = 0; attempt < this.tries; attempt++) {
      this.requests++;
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': this.ua,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
          },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (attempt === this.tries - 1) break;
          await sleep(this._backoff(res, attempt));
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
        return await res.json();
      } catch (err) {
        // 超时 / DNS / 连接失败都走重试，最后一次失败向上抛给调用方汇总
        lastErr = err;
        if (attempt === this.tries - 1) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastErr || new Error('请求失败');
  }

  /** 限流重试等待：优先用服务端给出的重置时间，最长 30 秒 */
  _backoff(res, attempt) {
    const ra = Number(res.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      const wait = reset * 1000 - Date.now();
      if (wait > 0) return Math.min(wait + 250, 30000);
    }
    return 500 * 2 ** attempt;
  }

  /**
   * 按 sha512 批量反查。
   * @param {string[]} hashes 十六进制 sha512，小写
   * @returns {Promise<Map<string,{project:object|null,version:object|null}>>}
   */
  async byHashes(hashes) {
    const out = new Map();
    const list = [...new Set(hashes.filter(Boolean).map((h) => h.toLowerCase()))];
    if (!this.enabled || !list.length) return out;

    const versions = new Map();
    for (let i = 0; i < list.length; i += HASH_CHUNK) {
      const chunk = list.slice(i, i + HASH_CHUNK);
      let got;
      try {
        got = await this._json(`${API}/version_files`, {
          method: 'POST',
          body: JSON.stringify({ hashes: chunk, algorithm: 'sha512' }),
        });
      } catch (err) {
        this.warn(`按哈希查询失败（本批 ${chunk.length} 个）：${err.message}`);
        continue;
      }
      for (const [hash, v] of Object.entries(got || {})) versions.set(hash.toLowerCase(), v);
    }

    const ids = [...new Set([...versions.values()].map((v) => v.project_id).filter(Boolean))];
    const projects = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const q = encodeURIComponent(JSON.stringify(chunk));
      let got;
      try {
        got = await this._json(`${API}/projects?ids=${q}`);
      } catch (err) {
        this.warn(`查询项目失败（本批 ${chunk.length} 个）：${err.message}`);
        continue;
      }
      for (const p of got || []) projects.set(p.id, normalizeProject(p));
    }

    for (const h of list) {
      const v = versions.get(h) || null;
      const p = v ? projects.get(v.project_id) || null : null;
      out.set(h, { project: p, version: v ? { id: v.id, number: v.version_number, name: v.name } : null });
    }
    return out;
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

function normalizeProject(p) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    type: p.project_type,
    client: p.client_side,
    server: p.server_side,
    url: `https://modrinth.com/${p.project_type || 'mod'}/${p.slug}`,
  };
}

module.exports = { Modrinth };
