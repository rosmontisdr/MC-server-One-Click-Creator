'use strict';
/**
 * 输入装载：把四种客户端整合包形态归一成一份文件清单，上层只面对清单。
 * 形态：已解压的客户端实例目录 / 客户端实例 zip / Modrinth .mrpack / CurseForge 整合包 zip。
 * 「包内实体文件」与「清单声明但包内没有的文件」分开返回：后者只有 .mrpack 带下载地址与哈希。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ZipReader } = require('./zip');

const COPY_CHUNK = 1024 * 1024;

const JUNK_DIRS = new Set(['.git', '.idea', '.vscode', 'node_modules', '__MACOSX']);
const JUNK_FILES = new Set(['.DS_Store', 'desktop.ini', 'Thumbs.db']);

function isJunk(rel, isDir) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  if (isDir) return JUNK_DIRS.has(base) || segs.some((s) => JUNK_DIRS.has(s));
  return JUNK_FILES.has(base);
}

/** Windows 路径统一成 zip 内的正斜杠相对路径 */
function toRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function sha512hex(buf) {
  return crypto.createHash('sha512').update(buf).digest('hex');
}

/**
 * 分块复制并同时算 sha512：只读一遍源文件，内存占用恒定。
 * build 阶段先用它把模组落到暂存区，后续读元数据、扫通道都对着暂存文件做，
 * 输入目录因此只被完整读一次（先前 analyze、netgate、copy 各读一遍）。
 */
function copyAndHashSync(src, dest) {
  const hash = crypto.createHash('sha512');
  const inFd = fs.openSync(src, 'r');
  try {
    const outFd = fs.openSync(dest, 'w');
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK);
      let size = 0;
      for (;;) {
        const n = fs.readSync(inFd, buf, 0, buf.length, null);
        if (!n) break;
        hash.update(buf.subarray(0, n));
        let off = 0;
        while (off < n) off += fs.writeSync(outFd, buf, off, n - off);
        size += n;
      }
      return { size, hash512: hash.digest('hex') };
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.closeSync(inFd);
  }
}

// ── 目录输入 ────────────────────────────────────────────────────────────────

class DirPack {
  constructor(root) { this.root = root; this.skipped = []; }

  list(skip) {
    const out = [];
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        const isDir = ent.isDirectory();
        if (isJunk(r, isDir)) continue;
        // 记下被排除的顶层项：目录不进枚举，故这里一条记录就代表整棵子树
        if (skip && skip(r, isDir)) { this.skipped.push({ rel: r, isDir }); continue; }
        const full = path.join(dir, ent.name);
        if (isDir) {
          // 不跟随符号链接：链接可指向包外，会让「只读输入目录」的保证失效
          if (!ent.isSymbolicLink()) walk(full, r);
          continue;
        }
        if (!ent.isFile()) continue;
        out.push({ rel: r, size: fs.statSync(full).size });
      }
    };
    walk(this.root, '');
    return out.sort(byRel);
  }

  read(rel) { return fs.readFileSync(path.join(this.root, rel)); }
  copyTo(rel, dest) { fs.copyFileSync(path.join(this.root, rel), dest); }
  copyAndHash(rel, dest) { return copyAndHashSync(path.join(this.root, rel), dest); }
  close() {}

  /**
   * 判定加载器要看的路径。libraries/ 整棵被排除出文件清单，故这里定点探测而非依赖 files。
   * 返回的是「名字」列表，只用于模式匹配，不对应真实文件。
   */
  signs() {
    const out = [];
    for (const rel of ['libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge', 'libraries/net/neoforged/forge']) {
      try {
        for (const name of fs.readdirSync(path.join(this.root, rel))) out.push(`${rel}/${name}/`);
      } catch { /* 该布局不存在 */ }
    }
    try {
      for (const name of fs.readdirSync(this.root)) out.push(name);
    } catch { /* 根目录不可读 */ }
    return out;
  }
}

// ── zip 输入 ────────────────────────────────────────────────────────────────

/** 选出能命中最外层目录结构的根前缀：整合包常被套一层 <包名>/ 或 .minecraft/ */
function pickPrefix(zip, candidates) {
  for (const pre of candidates) {
    const marker = `${pre}mods/`;
    if (zip.names().some((n) => n.startsWith(marker))) return pre;
  }
  for (const pre of candidates) {
    const marker = `${pre}config/`;
    if (zip.names().some((n) => n.startsWith(marker))) return pre;
  }
  return '';
}

function rootPrefixCandidates(zip) {
  const tops = new Set();
  for (const n of zip.names()) {
    const i = n.indexOf('/');
    if (i > 0 && !n.slice(i + 1).includes('/')) tops.add(n.slice(0, i));
  }
  return ['', '.minecraft/', ...[...tops].map((t) => `${t}/`)];
}

class ZipPack {
  /** @param {string[]} prefixes 允许的文件前缀；命中第一个即取，其余文件被忽略 */
  constructor(zip, prefixes) {
    this.zip = zip;
    this.entries = new Map();
    this.ignored = [];
    this.skipped = [];
    for (const name of zip.names()) {
      if (name.endsWith('/')) continue;
      const pre = prefixes.find((p) => name.startsWith(p));
      if (pre === undefined) { this.ignored.push(name); continue; }
      const rel = name.slice(pre.length);
      if (!rel) continue;
      this.entries.set(rel, name);
    }
  }

  list(skip) {
    const out = [];
    for (const [rel, name] of this.entries) {
      if (isJunk(rel, false)) continue;
      if (skip && skip(rel, false)) { this.skipped.push({ rel, isDir: false }); continue; }
      out.push({ rel, size: this.zip.sizeOf(name) });
    }
    return out.sort(byRel);
  }

  read(rel) {
    const name = this.entries.get(rel);
    if (!name) throw new Error(`输入包中不存在: ${rel}`);
    return this.zip.read(name);
  }
  /** zip 内全部名字（含被排除项）已在内存里，加载器判定直接扫这份 */
  signs() { return [...this.entries.keys()]; }
  copyTo(rel, dest) { fs.writeFileSync(dest, this.read(rel)); }
  /** zip 条目只能整段解压，故只能拿一次解压结果同时写盘与算哈希（不额外再解一遍） */
  copyAndHash(rel, dest) {
    const buf = this.read(rel);
    fs.writeFileSync(dest, buf);
    return { size: buf.length, hash512: sha512hex(buf) };
  }
  close() { this.zip.close(); }
}

function byRel(a, b) { return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0; }

// ── 清单解析 ────────────────────────────────────────────────────────────────

/** mrpack 与 CF 都只是 zip + 一个索引文件，索引里已经写明每个文件的运行侧 */
function parseMrpack(json) {
  const deps = json.dependencies || {};
  let hint = null;
  if (deps['fabric-loader']) hint = { name: 'fabric', version: String(deps['fabric-loader']) };
  else if (deps['quilt-loader']) hint = { name: 'quilt', version: String(deps['quilt-loader']) };
  else if (deps.neoforge) hint = { name: 'neoforge', version: String(deps.neoforge) };
  else if (deps.forge) hint = { name: 'forge', version: String(deps.forge) };

  const manifest = [];
  for (const f of json.files || []) {
    const env = f.env || {};
    manifest.push({
      path: toRel(f.path || ''),
      source: 'modrinth',
      client: env.client || null,
      server: env.server || null,
      url: (f.downloads || [])[0] || null,
      sha512: (f.hashes || {}).sha512 || null,
      sha1: (f.hashes || {}).sha1 || null,
      size: f.fileSize || 0,
    });
  }
  return { name: json.name || null, mcVersion: deps.minecraft || null, hint, manifest };
}

function parseCfManifest(json) {
  const mc = json.minecraft || {};
  const loaders = mc.modLoaders || [];
  const primary = loaders.find((l) => l.primary) || loaders[0] || null;
  let hint = null;
  if (primary && primary.id) {
    const id = String(primary.id);
    const i = id.indexOf('-');
    hint = { name: id.slice(0, i), version: id.slice(i + 1) };
  }
  // CF 清单只给 projectID/fileID，没有文件名、哈希与直链，不接入 API 就无法取回文件
  const manifest = (json.files || []).map((f) => ({
    path: null,
    source: 'curseforge',
    client: null,
    server: null,
    url: null,
    sha512: null,
    sha1: null,
    size: 0,
    projectID: f.projectID,
    fileID: f.fileID,
    required: f.required !== false,
  }));
  return { name: json.name || null, mcVersion: mc.version || null, hint, manifest };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function readJsonSafe(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * 打开输入，返回统一的包描述。同步完成，不做任何网络访问。
 * @param {string} input 目录、zip、.mrpack 路径
 * @param {{skip?:Function}} [opts] skip(rel, isDir) 返回 true 则不进清单
 */
function open(input, opts = {}) {
  const abs = path.resolve(input);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return openDir(abs, opts);
  if (!st.isFile()) throw new Error('输入既不是文件也不是目录');
  return openZip(abs, opts);
}

function makeSkip(opts) {
  const extra = opts.skip;
  if (!extra) return null;
  return (rel, isDir) => extra(rel, isDir) === true;
}

function openDir(root, opts) {
  const pack = new DirPack(root);
  const files = pack.list(makeSkip(opts));
  return {
    kind: 'instance',
    signs: () => pack.signs(),
    name: path.basename(root),
    files,
    manifest: [],
    loaderHint: null,
    mcVersion: null,
    notes: [],
    warnings: [],
    ignored: [],
    skipped: pack.skipped,
    read: (rel) => pack.read(rel),
    copyTo: (rel, dest) => pack.copyTo(rel, dest),
    copyAndHash: (rel, dest) => pack.copyAndHash(rel, dest),
    close: () => pack.close(),
  };
}

function openZip(abs, opts) {
  const zip = new ZipReader(abs);
  const base = path.basename(abs).replace(/\.(zip|mrpack)$/i, '');
  try {
    const notes = [];
    const warnings = [];

    if (zip.has('modrinth.index.json')) {
      const idx = readJsonSafe(zip.read('modrinth.index.json'));
      if (!idx) throw new Error('.mrpack 的 modrinth.index.json 无法解析');
      const meta = parseMrpack(idx);
      const pack = new ZipPack(zip, ['overrides/']);
      const files = pack.list(makeSkip(opts));
      const clientOv = zip.names().filter((n) => n.startsWith('client-overrides/') && !n.endsWith('/'));
      if (clientOv.length) {
        notes.push(`忽略 client-overrides/：其中 ${clientOv.length} 个文件只用于客户端`);
      }
      return {
        kind: 'mrpack',
        signs: () => pack.signs(),
        name: meta.name || base,
        files,
        manifest: meta.manifest,
        loaderHint: meta.hint,
        mcVersion: meta.mcVersion,
        notes,
        warnings,
        ignored: pack.ignored,
        skipped: pack.skipped,
        read: (rel) => pack.read(rel),
        copyTo: (rel, dest) => pack.copyTo(rel, dest),
        copyAndHash: (rel, dest) => pack.copyAndHash(rel, dest),
        close: () => pack.close(),
      };
    }

    if (zip.has('manifest.json')) {
      const man = readJsonSafe(zip.read('manifest.json'));
      if (man && man.minecraft && Array.isArray(man.files)) {
        const meta = parseCfManifest(man);
        const pack = new ZipPack(zip, ['overrides/']);
        const files = pack.list(makeSkip(opts));
        warnings.push(
          'CurseForge 整合包清单不含模组文件本体，也不含直链与哈希，无法取回或逐个体检模组；' +
          '本次只输出 overrides/。要得到完整服务端，请用带 mods/ 目录的客户端实例（或 .mrpack）作为输入。',
        );
        return {
          kind: 'cf',
          signs: () => pack.signs(),
          name: meta.name || base,
          files,
          manifest: meta.manifest,
          loaderHint: meta.hint,
          mcVersion: meta.mcVersion,
          notes,
          warnings,
          ignored: pack.ignored,
          skipped: pack.skipped,
          read: (rel) => pack.read(rel),
          copyTo: (rel, dest) => pack.copyTo(rel, dest),
          copyAndHash: (rel, dest) => pack.copyAndHash(rel, dest),
          close: () => pack.close(),
        };
      }
    }

    // 其余按「客户端实例打包成的 zip」处理，自动剥掉外面套的那一层目录
    const prefix = pickPrefix(zip, rootPrefixCandidates(zip));
    if (prefix) notes.push(`zip 外层目录 ${prefix} 已忽略`);
    const pack = new ZipPack(zip, [prefix]);
    const files = pack.list(makeSkip(opts));
    return {
      kind: 'instance-zip',
      signs: () => pack.signs(),
      name: base,
      files,
      manifest: [],
      loaderHint: null,
      mcVersion: null,
      notes,
      warnings,
      ignored: pack.ignored,
      skipped: pack.skipped,
      read: (rel) => pack.read(rel),
      copyTo: (rel, dest) => pack.copyTo(rel, dest),
      copyAndHash: (rel, dest) => pack.copyAndHash(rel, dest),
      close: () => pack.close(),
    };
  } catch (err) {
    zip.close();
    throw err;
  }
}

// ── 加载器 / 游戏版本推断 ────────────────────────────────────────────────────

const LIB_SIGNS = [
  [/^libraries\/net\/neoforged\/neoforge\/([^/]+)\//, 'neoforge'],
  [/^libraries\/net\/neoforged\/forge\/([^/]+)\//, 'neoforge'], // NeoForge 1.20.1 一代沿用 forge 产物路径
  [/^libraries\/net\/minecraftforge\/forge\/([^/]+)\//, 'forge'],
];

/** 从 libraries/ 目录与根目录启动器 jar 直接读加载器，比按模组数投票可靠 */
function loaderFromTree(names) {
  for (const rel of names) {
    for (const [re, name] of LIB_SIGNS) {
      const m = re.exec(rel);
      if (m) return { name, version: m[1] };
    }
  }
  for (const rel of names) {
    let m = /^(?:\.minecraft\/)?quilt-server-launch[^/]*\.jar$/i.exec(rel);
    if (m) return { name: 'quilt', version: null };
    m = /^(?:\.minecraft\/)?fabric-server-launch[^/]*\.jar$/i.exec(rel);
    if (m) return { name: 'fabric', version: null };
  }
  return null;
}

/** 模组数投票：多数模组声明的加载器即包加载器 */
function loaderFromMods(mods) {
  const tally = new Map();
  for (const m of mods) {
    const loader = m.jar && m.jar.loader;
    if (!loader || loader === 'unknown') continue;
    tally.set(loader, (tally.get(loader) || 0) + 1);
  }
  let best = null;
  for (const [name, n] of tally) if (!best || n > best.n) best = { name, n };
  return best ? { name: best.name, version: null } : null;
}

/** 版本范围 `~1.20.1` / `>=1.20` / `[1.20.1,1.21)` 一律取第一个数字段 */
function mcFromRange(s) {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(s || ''));
  return m ? m[1] : null;
}

function detectMcVersion(mods) {
  const tally = new Map();
  for (const m of mods) {
    const v = m.jar && m.jar.mc ? mcFromRange(m.jar.mc) : null;
    if (v) tally.set(v, (tally.get(v) || 0) + 1);
  }
  let best = null;
  for (const [v, n] of tally) if (!best || n > best.n) best = { v, n };
  return best ? best.v : null;
}

/** 加载器优先级：显式指定 > 目录特征 > 模组投票 */
function detectLoader(names, mods, hint) {
  if (hint && hint.name) return hint;
  return loaderFromTree(names) || loaderFromMods(mods);
}

module.exports = { open, detectLoader, detectMcVersion };
