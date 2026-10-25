'use strict';
/**
 * 装配服务端包：复制保留文件、拉取 .mrpack 清单里的文件、生成启动所需文件与体检报告。
 * 只写 out 目录，绝不改动输入目录；out 已存在且非空时，除非 force 否则直接拒绝。
 * 写入前每条路径都过 safeRel，任一条非法即中止，不落盘半个文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeRel } = require('./policy');

const PROPS_NAME = 'server.properties';

function sha512hex(buf) {
  return crypto.createHash('sha512').update(buf).digest('hex');
}

function ensureOut(out, force) {
  if (!fs.existsSync(out)) {
    fs.mkdirSync(out, { recursive: true });
    return;
  }
  if (!fs.statSync(out).isDirectory()) throw new Error(`输出路径已存在且不是目录：${out}`);
  if (fs.readdirSync(out).length && !force) {
    throw new Error(`输出目录已存在且非空：${out}\n换一个 -o，或加 --force 就地覆盖（同名文件会被替换）`);
  }
}

/** 暂存文件与输出同卷，rename 是纯元数据操作；只有跨卷才退回复制 */
function placeStaged(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// ── 启动命令行 ──────────────────────────────────────────────────────────────

function mcParts(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mc || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function mcAtLeast(mc, major, minor) {
  const v = mcParts(mc);
  return v ? v[0] > major || (v[0] === major && v[1] >= minor) : false;
}

/** 该游戏版本的服务端运行需要的 Java 主版本 */
function requiredJava(mc) {
  const v = mcParts(mc);
  if (!v) return 17;
  if (v[0] > 1 || v[1] >= 21) return 21;
  if (v[1] === 20 && v[2] >= 5) return 21;
  if (v[1] >= 18) return 17;
  if (v[1] === 17) return 16;
  return 8;
}

/** Forge 的 Maven 产物名带游戏版本前缀：1.20.1 + 47.4.23 → 1.20.1-47.4.23 */
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

/** 1.17 起 Forge/NeoForge 改用参数文件启动；更早的版本只有一个可执行 jar */
function usesArgsFile(loader, mc) {
  if (!loader) return false;
  if (loader.name === 'neoforge') return true;
  if (loader.name !== 'forge') return false;
  return Boolean(mc && mcAtLeast(mc, 1, 17));
}

function forgeArgsDir(loader, mc) {
  if (!loader || loader.name !== 'forge' || !usesArgsFile(loader, mc)) return null;
  const full = forgeFullVersion(loader, mc);
  return full ? `libraries/net/minecraftforge/forge/${full}/` : null;
}

/** NeoForge 1.20.1 沿用 forge 产物路径（版本带 1.20.1- 前缀），1.20.2 起才是 neoforge */
function neoArgsDir(loader, mc) {
  if (!loader || loader.name !== 'neoforge' || !loader.version) return null;
  let v = String(loader.version);
  const legacy = v.startsWith('1.20.1-') || mc === '1.20.1' || (!mc && /^4\d\./.test(v));
  if (legacy && !v.startsWith('1.20.1-')) v = `1.20.1-${v}`;
  if (!legacy && mc && v.startsWith(`${mc}-`)) v = v.slice(mc.length + 1);
  return legacy
    ? `libraries/net/neoforged/forge/${v}/`
    : `libraries/net/neoforged/neoforge/${v}/`;
}

function existsIn(outDir, rel) {
  if (!outDir) return false;
  try { return fs.existsSync(path.join(outDir, rel)); } catch { return false; }
}

/** 启动真正需要的文件：args 文件两套（Windows/Linux 各一）与 libraries 整棵 */
function checkRuntime(outDir, launch) {
  const required = launch.kind === 'args-file'
    ? [launch.required, `${launch.argsDir}unix_args.txt`, 'libraries/']
    : [launch.required];
  const missing = required.filter((rel) => !existsIn(outDir, rel));
  return { required, missing, ok: missing.length === 0 };
}

/** 1.13–1.16 的 Forge 安装器在根目录生成 forge-<版本>.jar；1.12 及更早是 -universal.jar */
function legacyForgeJar(loader, mc, outDir) {
  const full = forgeFullVersion(loader, mc);
  if (!full) return null;
  const universal = `forge-${full}-universal.jar`;
  const plain = `forge-${full}.jar`;
  if (existsIn(outDir, universal)) return universal;
  if (existsIn(outDir, plain)) return plain;
  return mc && mcAtLeast(mc, 1, 13) ? plain : universal;
}

function jarPlan(jar, heap, mc) {
  const cmd = `java ${heap} -jar ${jar} nogui`;
  return { kind: 'jar', heap, jar, required: jar, javaMajor: requiredJava(mc), bat: cmd, sh: cmd };
}

/**
 * 决定启动方式。outDir 用来识别安装器实际生成的文件：
 * Fabric/Quilt 装好后是各自的 launch jar，没装时退回 server.jar。
 */
function launchPlan(loader, jvm, opts = {}) {
  const heap = jvm || '-Xmx4G -Xms2G';
  const mc = opts.mcVersion || inferMc(loader);
  const outDir = opts.outDir;
  const name = loader && loader.name;
  const argsDir = name === 'forge' ? forgeArgsDir(loader, mc) : name === 'neoforge' ? neoArgsDir(loader, mc) : null;
  if (argsDir) {
    return {
      kind: 'args-file',
      heap,
      argsDir,
      required: `${argsDir}win_args.txt`,
      javaMajor: requiredJava(mc),
      bat: `java @user_jvm_args.txt @${argsDir.replace(/\//g, '\\')}win_args.txt nogui`,
      sh: `java @user_jvm_args.txt @${argsDir}unix_args.txt nogui`,
    };
  }
  if (name === 'forge') {
    const jar = legacyForgeJar(loader, mc, outDir);
    if (jar) return jarPlan(jar, heap, mc);
  }
  let jar = 'server.jar';
  if (name === 'fabric' && existsIn(outDir, 'fabric-server-launch.jar')) jar = 'fabric-server-launch.jar';
  if (name === 'quilt' && existsIn(outDir, 'quilt-server-launch.jar')) jar = 'quilt-server-launch.jar';
  return jarPlan(jar, heap, mc);
}

function startBat(launch) {
  // 保持纯 ASCII 并显式用 CRLF：cmd.exe 按 ANSI 代码页解析 .bat，UTF-8 汉字会错位吞掉后续字节。
  // 启动前先检查 Java 版本与加载器文件：缺文件时给出明确提示，而不是让 java 吐一句 main class 找不到。
  // 1.12.2 一代只能用 Java 8；让新版本 Java 蒙混过关只会换来一堆难懂的启动异常。
  const req = launch.required.replace(/\//g, '\\');
  const major = launch.javaMajor;
  const need = major === 8 ? 'Java 8' : `Java ${major}+`;
  const verCheck = major === 8
    ? `if defined JAVA_MAJOR if not "%JAVA_MAJOR%"=="8" (\r\n`
      + `  echo [ERROR] This server requires Java 8; found Java %JAVA_MAJOR%.\r\n`
      + `  pause\r\n`
      + `  exit /b 1\r\n`
      + `)\r\n`
    : `if defined JAVA_MAJOR if %JAVA_MAJOR% LSS ${major} (\r\n`
      + `  echo [ERROR] This server requires Java ${major}+; found Java %JAVA_MAJOR%.\r\n`
      + `  pause\r\n`
      + `  exit /b 1\r\n`
      + `)\r\n`;
  return `@echo off\r\n`
    + `REM Generated by mcsp. Rerun mcsp to refresh this file.\r\n`
    + `cd /d "%~dp0"\r\n`
    + `where java >nul 2>nul\r\n`
    + `if errorlevel 1 (\r\n`
    + `  echo [ERROR] ${need} was not found in PATH.\r\n`
    + `  echo Install a compatible JDK and run this file again.\r\n`
    + `  pause\r\n`
    + `  exit /b 1\r\n`
    + `)\r\n`
    + `set "JAVA_RAW="\r\n`
    + `set "JAVA_MAJOR="\r\n`
    + `for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do set "JAVA_RAW=%%~v"\r\n`
    + `if defined JAVA_RAW (\r\n`
    + `  for /f "tokens=1,2 delims=." %%a in ("%JAVA_RAW%") do (\r\n`
    + `    if "%%a"=="1" (set "JAVA_MAJOR=%%b") else (set "JAVA_MAJOR=%%a")\r\n`
    + `  )\r\n`
    + `)\r\n`
    + verCheck
    + `if not exist "${req}" (\r\n`
    + `  echo [ERROR] Missing server file: ${req}\r\n`
    + `  echo The loader or vanilla server was not installed. See mcsp-README.md.\r\n`
    + `  pause\r\n`
    + `  exit /b 1\r\n`
    + `)\r\n`
    + (launch.kind === 'args-file'
      ? `if not exist "libraries\\" (\r\n`
        + `  echo [ERROR] Missing server directory: libraries\r\n`
        + `  echo The loader libraries were not installed. See mcsp-README.md.\r\n`
        + `  pause\r\n`
        + `  exit /b 1\r\n`
        + `)\r\n`
      : '')
    + `${launch.bat}\r\n`
    + `pause\r\n`;
}

function startSh(launch) {
  const major = launch.javaMajor;
  const need = major === 8 ? 'Java 8' : `Java ${major}+`;
  const verCheck = major === 8
    ? `if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" != "8" ]; then\n`
      + `  echo "[ERROR] This server requires Java 8; found Java $JAVA_MAJOR." >&2\n`
      + `  exit 1\n`
      + `fi\n`
    : `if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -lt ${major} ]; then\n`
      + `  echo "[ERROR] This server requires Java ${major}+; found Java $JAVA_MAJOR." >&2\n`
      + `  exit 1\n`
      + `fi\n`;
  return `#!/bin/sh\n`
    + `# Generated by mcsp. Rerun mcsp to refresh this file.\n`
    + `cd "$(dirname "$0")"\n`
    + `if ! command -v java >/dev/null 2>&1; then\n`
    + `  echo "[ERROR] ${need} was not found in PATH." >&2\n`
    + `  exit 1\n`
    + `fi\n`
    + `JAVA_VER=$(java -version 2>&1 | sed -n 's/.*version "\\([^"]*\\)".*/\\1/p' | head -n 1)\n`
    + `JAVA_MAJOR=$(printf '%s' "$JAVA_VER" | cut -d. -f1)\n`
    + `if [ "$JAVA_MAJOR" = "1" ]; then JAVA_MAJOR=$(printf '%s' "$JAVA_VER" | cut -d. -f2); fi\n`
    + verCheck
    + `if [ ! -f "${launch.required}" ]; then\n`
    + `  echo "[ERROR] Missing server file: ${launch.required}" >&2\n`
    + `  echo "The loader or vanilla server was not installed. See mcsp-README.md." >&2\n`
    + `  exit 1\n`
    + `fi\n`
    + (launch.kind === 'args-file'
      ? `if [ ! -d "libraries" ]; then\n`
        + `  echo "[ERROR] Missing server directory: libraries" >&2\n`
        + `  echo "The loader libraries were not installed. See mcsp-README.md." >&2\n`
        + `  exit 1\n`
        + `fi\n`
      : '')
    + `exec ${launch.sh}\n`;
}

// ── 生成文件 ────────────────────────────────────────────────────────────────

function writeIfAbsent(file, content) {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content);
  return true;
}

/**
 * 启动脚本是「由 mcsp 生成」的文件，必须跟安装后的真实布局一致：
 * 旧版本生成过错误的 args 路径，重跑 --force 时若继续 writeIfAbsent，会把坏脚本原样留下。
 * 因此带生成标记（或精确匹配旧版生成形状）的脚本在内容变化时直接刷新；
 * server.properties / eula.txt / user_jvm_args.txt 仍保持 writeIfAbsent，不碰用户改过的配置。
 */
function writeGenerated(file, content) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content);
    return true;
  }
  let old;
  try { old = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (old === content) return false;
  const marked = /Generated by mcsp/.test(old);
  const legacyBat = /^@echo off\r?\ncd \/d "%~dp0"\r?\njava [^\r\n]*\r?\npause\r?\n?$/.test(old);
  const legacySh = /^#!\/bin\/sh\ncd "\$\(dirname "\$0"\)"\nexec java [^\n]*\n$/.test(old);
  if (marked || legacyBat || legacySh) {
    fs.writeFileSync(file, content);
    return true;
  }
  return false;
}

function ascii(s) {
  return String(s || '').replace(/[^\x20-\x7e]/g, '').trim();
}

/** server.properties 由 Java 按 ISO-8859-1 读取，注释与取值一律保持 ASCII，中文只放进 README */
function serverProperties(plan, opts) {
  const lines = [
    '# Generated by mcsp. Only the essentials are set; the server fills in the rest on first run.',
    `motd=${ascii(plan.input.name) || 'Minecraft Server'}`,
    'server-port=25565',
    'level-name=world',
    'max-players=20',
    'view-distance=8',
    'simulation-distance=8',
    // 加模组后飞行道具很常见，关掉会在空中踢人
    'allow-flight=true',
    // 默认开正版验证：关掉后任何人可冒用他人 ID 进服，仅在内网或配白名单时才改
    'online-mode=true',
    'enable-command-block=false',
  ];
  if (opts.rcon) {
    lines.push(
      '# RCON lets a panel control this server. It is writable once open: restrict it by firewall or bind locally.',
      'enable-rcon=true',
      `rcon.port=${opts.rconPort || 25575}`,
      `rcon.password=${opts.rconPassword || crypto.randomBytes(9).toString('hex')}`,
    );
  } else {
    lines.push('enable-rcon=false');
  }
  return `${lines.join('\n')}\n`;
}

/** 同样按 ISO-8859-1 读，且属于法律确认文件，一律纯 ASCII */
const EULA = `# Read and agree to the Minecraft EULA before starting: https://aka.ms/MinecraftEULA
# mcsp does not accept it for you. Change the line below to true after you have read it.
eula=false
`;

function generatedReadme(plan, opts, launch) {
  const l = plan.input.loader || {};
  const L = [];
  L.push(`# ${plan.input.name} 服务端`);
  L.push('');
  L.push(`由 mcsp 从客户端整合包生成。输入：\`${plan.input.path}\`（形态：${plan.input.kind}）。`);
  L.push(`加载器：${l.name || '未识别'}${l.version ? ` ${l.version}` : ''}　游戏版本：${plan.input.mcVersion || '未识别'}`);
  L.push('');

  const fetched = (opts.fetchResult && opts.fetchResult.file) || null;
  const installed = Boolean(opts.fetchResult && opts.fetchResult.installed);
  L.push('## 启动步骤');
  L.push(launch.javaMajor === 8
    ? `本服务端需要 **Java 8**（游戏版本 ${plan.input.mcVersion || '未识别'}）；这一代 Forge/加载器不能用 Java 17+ 启动。`
    : `本服务端需要 **Java ${launch.javaMajor} 或更高版本**（游戏版本 ${plan.input.mcVersion || '未识别'}）。`);
  L.push('');
  if (opts.runtime && !opts.runtime.ok) {
    L.push(`> **服务端运行文件未补齐**：缺 ${opts.runtime.missing.map((x) => `\`${x}\``).join('、')}。`);
    L.push('> 先按下面第 1 步安装加载器；安装完成后再运行启动脚本。');
    L.push('');
  }
  if (l.name === 'forge' || l.name === 'neoforge') {
    const inst = l.name === 'forge' ? 'forge-installer.jar' : 'neoforge-installer.jar';
    const home = l.name === 'forge' ? 'https://files.minecraftforge.net/' : 'https://neoforged.net/';
    if (installed) {
      L.push(`1. 加载器已自动安装完成（安装器 \`${inst}\`），原版服务端与 \`libraries/\` 均已就位。`);
    } else if (fetched === inst) {
      L.push('1. 安装器已下载到本目录，但还没安装。执行下面这行，它会补齐原版服务端与 `libraries/`：');
      L.push('');
      L.push('   ```');
      L.push(`   java -jar ${inst} --installServer .`);
      L.push('   ```');
      L.push('');
    } else {
      L.push('1. 缺加载器服务端文件。客户端包里的 `libraries/` 属于客户端，不能顶替，必须让安装器自己下载：');
      L.push('');
      L.push(`   先到 ${home} 取 ${l.name}${l.version ? ` ${l.version}` : ''} 的 installer，放到本目录并命名 \`${inst}\`。`);
      L.push('   ```');
      L.push(`   java -jar ${inst} --installServer .`);
      L.push('   ```');
      L.push('');
    }
    L.push(`2. 确认 \`${PROPS_NAME}\` 与 \`eula.txt\` 中的设置，把 \`eula.txt\` 改为 \`eula=true\`。`);
    L.push(`3. 运行 \`start.bat\`（Windows）或 \`./start.sh\`（Linux）：\`${launch.bat}\`。`);
  } else {
    if (installed && fetched === launch.jar) {
      L.push(`1. 服务端文件 \`${launch.jar}\`、原版服务端与运行库均已就位，无需另行下载。`);
    } else if (fetched === launch.jar) {
      L.push(`1. 已取回 \`${launch.jar}\`；首次启动会自动下载原版服务端与加载器运行库（需要联网）。`);
    } else if (fetched === 'fabric-installer.jar' || fetched === 'quilt-installer.jar') {
      const mc = plan.input.mcVersion || '<mc-version>';
      const ver = l.version || '<loader-version>';
      L.push('1. 安装器已下载到本目录，但还没安装（通常是没找到 Java）。执行下面这行补齐原版服务端与运行库：');
      L.push('');
      L.push('   ```');
      L.push(l.name === 'fabric'
        ? `   java -jar ${fetched} server -dir . -mcversion ${mc} -loader ${ver} -downloadMinecraft`
        : `   java -jar ${fetched} install server ${mc} ${ver} --install-dir=. --download-server`);
      L.push('   ```');
      L.push('');
    } else {
      L.push(`1. 缺服务端启动文件 \`${launch.jar}\`：到 https://fabricmc.net/use/server/（或对应加载器官网）按游戏版本 ${plan.input.mcVersion || '(未识别)'} 下载，`);
      L.push(`   放到本目录并命名为 \`${launch.jar}\`。也可重新运行 mcsp（默认会自动取回并安装）。`);
    }
    L.push('2. 把 `eula.txt` 改为 `eula=true`。');
    L.push(`3. 运行 \`start.bat\`（Windows）或 \`./start.sh\`（Linux）：\`${launch.bat}\`。`);
  }
  L.push('');
  L.push(`内存写在 \`user_jvm_args.txt\`（Forge/NeoForge）或启动脚本里，默认 ${launch.heap}，按机器实际情况改。`);
  L.push('');
  if (plan.write.some((w) => w.rel.startsWith('datapacks/'))) {
    L.push('原包的 `datapacks/` 已原样保留在根目录。要让服务端读到，需手工放进 `world/datapacks/`，或首次启动后再移动。');
    L.push('');
  }
  L.push('把包传到 Linux 上运行时，先执行 `chmod +x start.sh`。');
  L.push('');

  const dropped = plan.mods.filter((m) => m.decision === 'drop');
  L.push(`## 已剔除的模组（${dropped.length}）`);
  L.push('');
  if (!dropped.length) L.push('无。');
  for (const m of dropped) L.push(`- \`${m.rel}\` — ${m.reason}`);
  L.push('');

  const review = plan.mods.filter((m) => m.review && m.decision !== 'drop');
  L.push(`## 保留但建议复核（${review.length}）`);
  L.push('');
  L.push('无证据或证据偏弱，按「宁可多留」保留。服务端启动失败时优先从这份清单里找嫌疑。');
  L.push('');
  if (!review.length) L.push('无。');
  for (const m of review) L.push(`- \`${m.rel}\` — ${m.reason}${m.project ? `（${m.project.url}）` : ''}`);
  L.push('');

  if (plan.manifestOnly) {
    L.push('## 需要手工补齐的文件');
    L.push('');
    L.push(`输入是 CurseForge 整合包清单，其中 ${plan.manifestOnly} 个文件只给了 projectID/fileID，无法自动取回。`);
    L.push('请用启动器把这些模组下到 `mods/`，或改用带 `mods/` 目录的客户端实例重跑。');
    L.push('');
  }
  if (plan.input.notes.length) {
    L.push('## 说明');
    L.push('');
    for (const n of plan.input.notes) L.push(`- ${n}`);
    L.push('');
  }
  L.push('完整判定明细见 `mcsp-report.json`。');
  L.push('');
  return L.join('\n');
}

// ── 下载 ────────────────────────────────────────────────────────────────────

/** 缺下载地址就抛错而不是静默返回：否则会被记成「已下载」，服务端少文件却看不出来 */
async function downloadOne(item, dest, opts) {
  if (!item.url) throw new Error('清单未给出下载地址');
  const res = await fetch(item.url, {
    headers: { 'User-Agent': opts.ua },
    signal: AbortSignal.timeout(opts.downloadTimeout || 120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (item.sha512 && item.sha512.toLowerCase() !== sha512hex(buf)) {
    throw new Error('sha512 校验失败，已丢弃');
  }
  // MCBBS 的 AddonFile 与 HMCL 服务端清单用 SHA-1
  if (item.sha1) {
    const got = crypto.createHash('sha1').update(buf).digest('hex');
    if (item.sha1.toLowerCase() !== got) throw new Error('sha1 校验失败，已丢弃');
  }
  await fs.promises.writeFile(dest, buf);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 按 plan 写出服务端包。
 * @param {object} plan index.plan() 的返回值
 * @param {{out:string, force?:boolean, rcon?:boolean, jvm?:string, pack:object, ua:string,
 *          onEvent?:Function, tool:object, staged?:Map<string,{path:string}>}} opts
 *   staged：分析阶段已复制到暂存区的模组（rel → 暂存路径），写盘时直接 rename，不再读输入。
 */
async function build(plan, opts) {
  const out = path.resolve(opts.out);
  const emit = opts.onEvent || (() => {});
  // 调用方（index.build）已校验输出目录，并在其中建了暂存区；再校验会把暂存区当成「非空」拒绝
  if (!opts.outReady) ensureOut(out, opts.force);

  const abs = (rel) => path.join(out, safeRel(rel));
  const failed = [];
  const undownloaded = [];
  let copied = 0;
  let downloaded = 0;
  let fetchResult = null;

  const total = plan.write.length;
  emit({ t: 'phase', name: 'write', done: 0, total });
  let seen = 0;
  for (const item of plan.write) {
    seen++;
    const dest = abs(item.rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (opts.staged && item.origin !== 'download' && opts.staged.has(item.rel)) {
        // 分析阶段已经边复制边算哈希，这里直接落位，不再读输入
        placeStaged(opts.staged.get(item.rel).path, dest);
        copied++;
      } else if (item.origin === 'download') {
        // 用户主动要求的跳过不是失败，单独记，不影响退出码
        if (opts.download === false) undownloaded.push({ rel: item.rel, why: '按 --no-download 跳过' });
        else { await downloadOne(item, dest, opts); downloaded++; }
      } else {
        opts.pack.copyTo(item.rel, dest);
        copied++;
      }
    } catch (err) {
      // 单个文件失败不终止整批：记入报告，其余照写，最后统一汇报
      failed.push({ rel: item.rel, why: err.message });
    }
    if (seen % 50 === 0) emit({ t: 'phase', name: 'write', done: seen, total });
  }
  emit({ t: 'phase', name: 'write', done: total, total });

  const loader = plan.input.loader || null;
  const generated = [];
  const add = (name, ok) => { if (ok) generated.push(name); };

  add(PROPS_NAME, writeIfAbsent(path.join(out, PROPS_NAME), serverProperties(plan, opts)));
  add('eula.txt', writeIfAbsent(path.join(out, 'eula.txt'), EULA));
  // Forge/NeoForge 1.17+ 安装器会生成 user_jvm_args.txt；先写好内存参数，它发现文件已存在就不会覆盖
  const launchBeforeFetch = launchPlan(loader, opts.jvm, { mcVersion: plan.input.mcVersion, outDir: out });
  if (launchBeforeFetch.kind === 'args-file') {
    // 一行一个参数，便于用户直接增删
    const jvm = `${launchBeforeFetch.heap.trim().split(/\s+/).join('\n')}\n`;
    add('user_jvm_args.txt', writeIfAbsent(path.join(out, 'user_jvm_args.txt'), jvm));
  }

  // 本地文件写完之后再联网取加载器：先出本地结果，网络慢也不挡进度。
  // 这里会下载并执行官方安装器，把原版服务端、加载器库一并装好，产物才能直接启动。
  if (opts.fetch) {
    emit({ t: 'phase', name: 'fetch', done: 0, total: 1 });
    emit({ t: 'note', msg: '正在下载并安装服务端文件（原版服务端与加载器库），首次可能需要几分钟……' });
    fetchResult = await opts.fetch(out, plan);
    for (const n of (fetchResult && fetchResult.notes) || []) emit({ t: 'note', msg: n });
    emit({ t: 'phase', name: 'fetch', done: 1, total: 1 });
  }

  // 安装完成后重新判定：Fabric/Quilt 的 launch jar、Forge 的实际产物、
  // 以及联网补齐的加载器版本这时才落盘
  const effectiveLoader = (fetchResult && fetchResult.loader) || loader;
  const launch = launchPlan(effectiveLoader, opts.jvm, { mcVersion: plan.input.mcVersion, outDir: out });
  const runtime = checkRuntime(out, launch);
  add('start.bat', writeGenerated(path.join(out, 'start.bat'), startBat(launch)));
  add('start.sh', writeGenerated(path.join(out, 'start.sh'), startSh(launch)));
  if (fetchResult && fetchResult.file) generated.push(fetchResult.file);
  const readmePlan = effectiveLoader === loader ? plan : { ...plan, input: { ...plan.input, loader: effectiveLoader } };
  add('mcsp-README.md', writeIfAbsent(path.join(out, 'mcsp-README.md'), generatedReadme(readmePlan, { ...opts, fetchResult, runtime }, launch)));

  const report = {
    tool: opts.tool,
    generatedAt: new Date().toISOString(),
    input: { ...plan.input, path: path.resolve(plan.input.path) },
    out,
    loader: effectiveLoader,
    mcVersion: plan.input.mcVersion,
    launch: {
      kind: launch.kind,
      heap: launch.heap,
      jar: launch.jar || null,
      argsDir: launch.argsDir || null,
      bat: launch.bat,
      java: launch.javaMajor,
    },
    runtime,
    counts: {
      ...plan.counts,
      copied,
      downloaded,
      failed: failed.length,
      undownloaded: undownloaded.length,
      missingRuntime: runtime.missing.length,
    },
    generated,
    mods: plan.mods,
    review: plan.mods.filter((m) => m.review).map((m) => ({ rel: m.rel, decision: m.decision, reason: m.reason })),
    conflicts: plan.mods.filter((m) => m.conflict && m.decision === 'drop').map((m) => ({ rel: m.rel, why: m.conflict, reason: m.reason })),
    // 稳妥模式下「判定该剔、但因证明不了不影响握手而留下」的模组清单
    judgedClientOnly: plan.mods.filter((m) => m.judged === 'drop').map((m) => ({ rel: m.rel, reason: m.reason, confidence: m.confidence })),
    skipped: plan.skip,
    failed,
    undownloaded,
    fetch: fetchResult,
    notes: plan.input.notes,
    warnings: plan.warnings.concat(fetchResult ? fetchResult.notes : []),
  };
  if (undownloaded.length) {
    report.warnings.push(`${undownloaded.length} 个文件按 --no-download 未取回，服务端会缺这些内容，需要时自行补齐。`);
  }
  if (failed.length) {
    report.warnings.push(`${failed.length} 个文件未写出，见报告的 failed 字段。`);
  }
  if (!runtime.ok) {
    report.warnings.push(
      `服务端运行文件仍未补齐：${runtime.missing.join('、')}。` +
      '按 mcsp-README.md 的启动步骤手工执行安装器，或重新运行 mcsp。',
    );
    emit({ t: 'warn', msg: `服务端运行文件仍未补齐：${runtime.missing.join('、')}` });
  }
  fs.writeFileSync(path.join(out, 'mcsp-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  report.report = path.join(out, 'mcsp-report.json');
  return report;
}

module.exports = { build, launchPlan, forgeArgsDir, serverProperties, ensureOut };
