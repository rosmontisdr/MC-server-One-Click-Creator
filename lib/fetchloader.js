'use strict';
/**
 * 取回并安装服务端运行文件。产物里只有模组与配置是不够的：
 * 没有原版服务端、加载器库与启动 jar，start.bat 一跑就会报「找不到文件」。
 *
 * 各种加载器各自走官方途径：
 *   vanilla    Mojang 版本清单 → 原版 server.jar
 *   Fabric     官方 installer → server -downloadMinecraft（原版 + 库 + fabric-server-launch.jar）
 *   Quilt      官方 installer → install server --download-server
 *   Forge      maven 上的 installer → --installServer（原版 + 库 + win/unix_args.txt 或可执行 jar）
 *   NeoForge   同上，maven 上的 neoforge/forge installer
 *
 * 没有 Java、源站不可达或安装器失败都只收敛成 notes，不抛错、不影响其余产物；
 * 此时会保留已下载的安装器，并在 README 里给出可手工执行的命令。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/** 源站被墙时 TCP 连接会一直挂着，长超时等于卡死整条流程 */
const DEFAULT_TIMEOUT = 60000;
/** 安装器与 47MB 的原版服务端都比普通 jar 大，下载超时单独放宽 */
const DOWNLOAD_TIMEOUT = 180000;
/** 安装器要下载几十上百个库，慢机器上给足时间 */
const INSTALL_TIMEOUT = 15 * 60 * 1000;
const INSTALL_LOG = 'mcsp-install.log';

async function getJson(url, ua, timeout) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(timeout || DEFAULT_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 下载到 dest。官方元数据给了 sha1 就校验；内容过小基本是错误页面，直接丢弃。
 */
async function download(url, dest, ua, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(opts.timeout || DOWNLOAD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('返回内容过小，可能不是有效文件');
  if (opts.sha1) {
    const got = crypto.createHash('sha1').update(buf).digest('hex');
    if (got.toLowerCase() !== String(opts.sha1).toLowerCase()) {
      throw new Error('sha1 校验失败，已丢弃');
    }
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ── Java 探测 ───────────────────────────────────────────────────────────────

function mcParts(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mc || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function requiredJava(mc) {
  const v = mcParts(mc);
  if (!v) return 17;
  if (v[0] > 1 || v[1] >= 21) return 21;
  if (v[1] === 20 && v[2] >= 5) return 21;
  if (v[1] >= 18) return 17;
  if (v[1] === 17) return 16;
  return 8;
}

function javaNames() {
  return process.platform === 'win32' ? ['java.exe', 'java'] : ['java'];
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** PATH、JAVA_HOME、以及 Windows 上常见的 JDK 安装位置 */
function candidateJavas() {
  const out = [];
  const add = (p) => {
    if (p && !out.includes(p) && isFile(p)) out.push(p);
  };
  if (process.env.JAVA_HOME) {
    for (const n of javaNames()) add(path.join(process.env.JAVA_HOME, 'bin', n));
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const clean = dir.replace(/^"|"$/g, '');
    if (!clean) continue;
    for (const n of javaNames()) add(path.join(clean, n));
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  const roots = [
    home && path.join(home, '.jdks'),
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      for (const n of javaNames()) add(path.join(root, ent.name, 'bin', n));
    }
  }
  return out;
}

function javaMajor(exe) {
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const text = `${r.stderr || ''}\n${r.stdout || ''}`;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  const major = m[1] === '1' ? Number(m[2] || 0) : Number(m[1]);
  return major || null;
}

let javaCache = null;

/**
 * 找一个能跑安装器的 Java。优先与游戏版本匹配的主版本；
 * 没有匹配的就用最低的可用版本（安装器通常能跨版本运行，运行服务端时再按 README 装对应版本）。
 */
function findJava(mc, notes) {
  if (!javaCache) {
    javaCache = [];
    for (const exe of candidateJavas()) {
      const major = javaMajor(exe);
      if (major) javaCache.push({ exe, major });
    }
    javaCache.sort((a, b) => a.major - b.major);
  }
  const required = requiredJava(mc);
  const exact = javaCache.find((j) => j.major === required);
  const higher = javaCache.find((j) => j.major >= required);
  const best = exact || higher || javaCache[javaCache.length - 1] || null;
  if (!best) {
    notes.push(`未找到 Java，无法自动安装服务端；本服务端运行需要 Java ${required}${required === 8 ? '' : '+'}`);
    return null;
  }
  if (best.major !== required) {
    if (required === 8) {
      notes.push(`用 Java ${best.major} 执行安装器；注意 Minecraft ${mc} 服务端运行仍需 Java 8`);
    } else {
      notes.push(`安装器使用 Java ${best.major}（该游戏版本推荐 Java ${required}+）`);
    }
  }
  return { ...best, required };
}

/** 起安装器，流式收日志，超时就杀；永远 resolve，由调用方看 code */
function runInstaller(java, args, cwd) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const child = spawn(java, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      finish(-1, new Error('安装器超过 15 分钟未结束'));
    }, INSTALL_TIMEOUT);
    const onData = (d) => {
      const s = d.toString();
      chunks.push(s);
      size += s.length;
      // 安装器日志可能上万行，只保留最后一段用于错误提示
      while (size > 500000 && chunks.length > 1) size -= chunks.shift().length;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    function finish(code, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = chunks.join('');
      try { fs.writeFileSync(path.join(cwd, INSTALL_LOG), output); } catch { /* 写不了日志不影响安装结果 */ }
      resolve({ code, error: err || null, output });
    }
    child.on('error', (err) => finish(-1, err));
    child.on('close', (code) => finish(code));
  });
}

// ── 加载器版本 ──────────────────────────────────────────────────────────────

function mcAtLeast(mc, major, minor) {
  const v = mcParts(mc);
  return v ? v[0] > major || (v[0] === major && v[1] >= minor) : false;
}

function forgeFullVersion(loader, mc) {
  if (!loader || !loader.version) return null;
  const v = String(loader.version);
  if (!mc) return /^\d+\.\d+(?:\.\d+)?-/.test(v) ? v : null;
  return v.startsWith(`${mc}-`) ? v : `${mc}-${v}`;
}

/** 从 full 版本串（如 1.20.1-47.4.23）反推游戏版本 */
function inferMc(loader) {
  if (!loader || !loader.version) return null;
  const m = /^(\d+\.\d+(?:\.\d+)?)-/.exec(String(loader.version));
  return m ? m[1] : null;
}

/** NeoForge 1.20.1 走 net/neoforged/forge，1.20.2 起是 net/neoforged/neoforge */
function neoLayout(loader, mc) {
  let v = String((loader && loader.version) || '');
  if (!v) return null;
  const legacy = v.startsWith('1.20.1-') || mc === '1.20.1' || (!mc && /^4\d\./.test(v));
  if (legacy && !v.startsWith('1.20.1-')) v = `1.20.1-${v}`;
  if (!legacy && mc && v.startsWith(`${mc}-`)) v = v.slice(mc.length + 1);
  return { group: legacy ? 'forge' : 'neoforge', full: v };
}

function pickLoaderVersion(list) {
  if (!Array.isArray(list)) return null;
  const stable = list.find((x) => x && x.loader && x.loader.version && !/-beta/i.test(x.loader.version));
  const first = stable || list.find((x) => x && x.loader && x.loader.version);
  return first ? first.loader.version : null;
}

async function latestLoader(base, mc, ua) {
  const list = await getJson(`${base}/versions/loader/${encodeURIComponent(mc)}`, ua);
  return pickLoaderVersion(list);
}

/** 安装后确认关键文件真的落盘，避免「安装器说成功但产物缺文件」 */
function missingAfterInstall(outDir, rel) {
  return !fs.existsSync(path.join(outDir, rel));
}

// ── 原版服务端 ──────────────────────────────────────────────────────────────

async function fetchVanilla(outDir, mc, ua, notes) {
  const manifest = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', ua);
  const version = (manifest.versions || []).find((v) => v.id === mc);
  if (!version) throw new Error(`Mojang 版本清单里没有 ${mc}`);
  const meta = await getJson(version.url, ua);
  const server = meta && meta.downloads && meta.downloads.server;
  if (!server || !server.url) throw new Error(`Minecraft ${mc} 没有可下载的服务端`);
  await download(server.url, path.join(outDir, 'server.jar'), ua, { sha1: server.sha1 });
  notes.push(`已下载原版服务端 Minecraft ${mc} → server.jar`);
  return { file: 'server.jar', files: ['server.jar'], installed: true };
}

// ── Fabric ──────────────────────────────────────────────────────────────────

async function fetchFabric(outDir, loader, mc, ua, notes) {
  if (!mc) throw new Error('未识别游戏版本，无法安装 Fabric 服务端');
  let ver = loader.version;
  if (!ver) {
    ver = await latestLoader('https://meta.fabricmc.net', mc, ua);
    if (!ver) throw new Error('Fabric 元数据里没有该游戏版本的 loader');
    notes.push(`加载器版本未识别，取该游戏版本最新 Fabric loader ${ver}`);
  }
  const installers = await getJson('https://meta.fabricmc.net/v2/versions/installer', ua);
  const inst = Array.isArray(installers) ? installers[0] : null;
  if (!inst || !inst.url) throw new Error('取不到 Fabric 安装器下载地址');

  const installer = 'fabric-installer.jar';
  await download(inst.url, path.join(outDir, installer), ua);
  notes.push(`已下载 Fabric 安装器 ${inst.version}`);
  const java = findJava(mc, notes);
  const javaInfo = java ? { path: java.exe, major: java.major, required: java.required } : null;
  if (!java) {
    notes.push(`执行下面这行可完成安装：java -jar ${installer} server -dir . -mcversion ${mc} -loader ${ver} -downloadMinecraft`);
    return { file: installer, files: [installer], installed: false, java: null };
  }

  const r = await runInstaller(java.exe, [
    '-jar', installer, 'server', '-dir', outDir, '-mcversion', mc, '-loader', ver, '-downloadMinecraft',
  ], outDir);
  if (r.code === 0 && !missingAfterInstall(outDir, 'fabric-server-launch.jar')) {
    notes.push(`已安装 Fabric ${ver}（Minecraft ${mc}）：原版服务端、运行库与 fabric-server-launch.jar 均已就位`);
    return { file: 'fabric-server-launch.jar', files: [installer, 'fabric-server-launch.jar'], installed: true, java: javaInfo };
  }

  const why = r.error ? r.error.message : `退出码 ${r.code}`;
  notes.push(`Fabric 安装器执行失败（${why}），日志见 ${INSTALL_LOG}`);
  // 安装器不行时退一步：至少把官方启动 jar 放好，首次启动会自行补原版与库
  try {
    await download(
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(ver)}/${encodeURIComponent(inst.version)}/server/jar`,
      path.join(outDir, 'server.jar'), ua,
    );
    notes.push('已改为下载 Fabric 启动 jar → server.jar；首次启动仍需联网补齐原版服务端与运行库');
    return { file: 'server.jar', files: [installer, 'server.jar'], installed: false, java: javaInfo };
  } catch (err) {
    notes.push(`Fabric 启动 jar 也未能取回：${err.message}`);
    return { file: installer, files: [installer], installed: false, java: javaInfo };
  }
}

// ── Quilt ───────────────────────────────────────────────────────────────────

async function fetchQuilt(outDir, loader, mc, ua, notes) {
  if (!mc) throw new Error('未识别游戏版本，无法安装 Quilt 服务端');
  let ver = loader.version;
  if (!ver) {
    ver = await latestLoader('https://meta.quiltmc.org', mc, ua);
    if (!ver) throw new Error('Quilt 元数据里没有该游戏版本的 loader');
    notes.push(`加载器版本未识别，取该游戏版本最新 Quilt loader ${ver}`);
  }
  const installers = await getJson('https://meta.quiltmc.org/v3/versions/installer', ua);
  const inst = Array.isArray(installers) ? installers[0] : null;
  if (!inst || !inst.url) throw new Error('取不到 Quilt 安装器下载地址');

  const installer = 'quilt-installer.jar';
  await download(inst.url, path.join(outDir, installer), ua);
  notes.push(`已下载 Quilt 安装器 ${inst.version}`);
  const java = findJava(mc, notes);
  const javaInfo = java ? { path: java.exe, major: java.major, required: java.required } : null;
  if (!java) {
    notes.push(`执行下面这行可完成安装：java -jar ${installer} install server ${mc} ${ver} --install-dir=. --download-server`);
    return { file: installer, files: [installer], installed: false, java: null };
  }

  const r = await runInstaller(java.exe, [
    '-jar', installer, 'install', 'server', mc, ver, `--install-dir=${outDir}`, '--download-server',
  ], outDir);
  if (r.code === 0 && !missingAfterInstall(outDir, 'quilt-server-launch.jar')) {
    notes.push(`已安装 Quilt ${ver}（Minecraft ${mc}）：原版服务端、运行库与 quilt-server-launch.jar 均已就位`);
    return { file: 'quilt-server-launch.jar', files: [installer, 'quilt-server-launch.jar'], installed: true, java: javaInfo };
  }

  const why = r.error ? r.error.message : `退出码 ${r.code}`;
  notes.push(`Quilt 安装器执行失败（${why}），日志见 ${INSTALL_LOG}`);
  try {
    await download(
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(ver)}/${encodeURIComponent(inst.version)}/server/jar`,
      path.join(outDir, 'server.jar'), ua,
    );
    notes.push('已改为下载 Quilt 启动 jar → server.jar；首次启动仍需联网补齐原版服务端与运行库');
    return { file: 'server.jar', files: [installer, 'server.jar'], installed: false, java: javaInfo };
  } catch (err) {
    notes.push(`Quilt 启动 jar 也未能取回：${err.message}`);
    return { file: installer, files: [installer], installed: false, java: javaInfo };
  }
}

// ── Forge / NeoForge 共用的安装流程 ─────────────────────────────────────────

/** 安装器完成后应出现的启动文件。1.13–1.16 生成的是 forge-<版本>.jar，1.12 及更早是 -universal.jar */
function forgeLaunchMarkers(loader, mc) {
  const full = forgeFullVersion(loader, mc);
  if (!full) return [];
  if (!mc) return [`libraries/net/minecraftforge/forge/${full}/win_args.txt`, `forge-${full}-universal.jar`, `forge-${full}.jar`];
  if (mcAtLeast(mc, 1, 17)) return [`libraries/net/minecraftforge/forge/${full}/win_args.txt`];
  return [mcAtLeast(mc, 1, 13) ? `forge-${full}.jar` : `forge-${full}-universal.jar`];
}

function neoLaunchMarkers(loader, mc) {
  const layout = neoLayout(loader, mc);
  return layout ? [`libraries/net/neoforged/${layout.group}/${layout.full}/win_args.txt`] : [];
}

async function installForgeLike(outDir, opts) {
  const { url, installer, markers, label, ua, mc, notes } = opts;
  await download(url, path.join(outDir, installer), ua);
  notes.push(`已下载 ${label} 安装器 → ${installer}`);
  const java = findJava(mc, notes);
  const javaInfo = java ? { path: java.exe, major: java.major, required: java.required } : null;
  if (!java) {
    notes.push(`执行下面这行可完成安装：java -jar ${installer} --installServer .`);
    return { file: installer, files: [installer], installed: false, java: null };
  }
  const r = await runInstaller(java.exe, ['-jar', installer, '--installServer', '.'], outDir);
  if (r.code !== 0) {
    const why = r.error ? r.error.message : `退出码 ${r.code}`;
    notes.push(`${label} 安装器执行失败（${why}），日志见 ${INSTALL_LOG}`);
    return { file: installer, files: [installer], installed: false, java: javaInfo };
  }
  const found = markers.find((rel) => fs.existsSync(path.join(outDir, rel)));
  if (!found) {
    notes.push(`${label} 安装器结束了，但没有找到预期的启动文件（${markers.join(' 或 ') || '未知'}）；请查看 ${INSTALL_LOG}`);
    return { file: installer, files: [installer], installed: false, java: javaInfo };
  }
  notes.push(`已安装 ${label}：原版服务端、libraries/ 与启动文件均已就位`);
  return { file: installer, files: [installer, found], installed: true, java: javaInfo };
}

async function fetchForge(outDir, loader, mc, ua, notes) {
  const full = forgeFullVersion(loader, mc);
  if (!full) throw new Error('未识别 Forge 版本，无法定位安装器');
  const installer = 'forge-installer.jar';
  return installForgeLike(outDir, {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
    installer,
    markers: forgeLaunchMarkers(loader, mc),
    label: `Forge ${full}`,
    ua,
    mc,
    notes,
  });
}

async function fetchNeoForge(outDir, loader, mc, ua, notes) {
  const layout = neoLayout(loader, mc);
  if (!layout) throw new Error('未识别 NeoForge 版本，无法定位安装器');
  const installer = 'neoforge-installer.jar';
  return installForgeLike(outDir, {
    url: `https://maven.neoforged.net/releases/net/neoforged/${layout.group}/${encodeURIComponent(layout.full)}/${layout.group}-${encodeURIComponent(layout.full)}-installer.jar`,
    installer,
    markers: neoLaunchMarkers(loader, mc),
    label: `NeoForge ${layout.full}`,
    ua,
    mc,
    notes,
  });
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * @param {string} outDir 服务端包目录，文件直接落在根下
 * @param {object} plan index.plan() 的结果
 * @param {{ua?:string}} opts
 * @returns {Promise<{file:string|null, files:string[], installed:boolean, java:object|null, notes:string[]}>}
 */
async function fetchLoader(outDir, plan, opts = {}) {
  const ua = opts.ua || 'mcsp';
  const notes = [];
  const loader = plan.input.loader;
  const mc = plan.input.mcVersion || inferMc(loader);
  const result = { file: null, files: [], installed: false, java: null, notes };
  try {
    if (loader && loader.name === 'fabric') {
      Object.assign(result, await fetchFabric(outDir, loader, mc, ua, notes));
    } else if (loader && loader.name === 'quilt') {
      Object.assign(result, await fetchQuilt(outDir, loader, mc, ua, notes));
    } else if (loader && loader.name === 'forge') {
      Object.assign(result, await fetchForge(outDir, loader, mc, ua, notes));
    } else if (loader && loader.name === 'neoforge') {
      Object.assign(result, await fetchNeoForge(outDir, loader, mc, ua, notes));
    } else if (mc) {
      // 未识别加载器：按原版服务端处理
      Object.assign(result, await fetchVanilla(outDir, mc, ua, notes));
    } else {
      notes.push('未识别加载器与游戏版本，跳过服务端文件下载');
    }
  } catch (err) {
    notes.push(`下载或安装服务端文件失败：${err.message}`);
  }
  return result;
}

module.exports = { fetchLoader, requiredJava, findJava };
