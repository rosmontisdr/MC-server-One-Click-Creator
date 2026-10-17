#!/usr/bin/env node
'use strict';
/**
 * 命令行入口。单独启动用这个；被其他程序调用请 require('./index.js')。
 * 约定：--json 时 stdout 只出现 NDJSON 事件流，人类可读内容一律走 stderr，两者互不污染。
 */
const path = require('path');
const mcsp = require('./index');

const USAGE = `mcsp — 把 Minecraft 客户端整合包做成服务端包

用法
  node mcsp.js make <输入> [-o <输出>] [选项]     生成服务端包
  node mcsp.js plan <输入> [选项]                 只体检并打印方案，不写任何文件
  node mcsp.js identify <输入>                    只看这是哪种整合包，不读模组

输入可以是：已解压的客户端实例目录、客户端实例 zip、Modrinth .mrpack、CurseForge 整合包 zip。

选项
  -o, --out <目录>        输出目录，默认 <输入名>-server
      --force             输出目录非空时覆盖同名文件
      --offline           不联网：只用 jar 元数据与内置名单判定
      --no-mcmod          不做 MC百科「运行环境」复核（默认做：把百科标为服务端需装/可选的模组挪回服务端）
      --mcmod-delay <毫秒> 百科查询间隔，默认 600；站点慢就调大，别调小
      --mcmod-limit <个数> 单次最多复核多少个模组，默认 200
      --no-download       不下载 .mrpack 清单里声明的文件
      --fetch             顺带下载加载器服务端文件（Fabric/Quilt 直接可用，Forge/NeoForge 只下安装器）
      --keep <模式>       强制保留，可重复；含 * 按通配，否则按子串
      --drop <模式>       强制剔除，可重复；写法同上
      --drop-optional     连「服务端可选」的模组一并剔除（如 JEI、苹果皮），默认保留
      --conservative      稳妥模式：只剔除能证明「客户端不指望服务端有它」的模组，
                          其余判定为客户端的一律留下（报告里逐条记录）
      --loader <名[-版本]> 指定加载器，如 forge-1.20.1-47.2.0
      --mc <版本>         指定游戏版本，如 1.20.1
      --jvm "<参数>"      内存等 JVM 参数，默认 "-Xmx4G -Xms2G"
      --rcon              在 server.properties 里开启 RCON 并写入随机密码
      --json              以 NDJSON 输出事件流，供其他程序解析
      --quiet             只在结束时输出结论
  -h, --help              显示本说明
  -v, --version           显示版本

退出码  0 成功 ｜ 1 失败 ｜ 2 用法错误 ｜ 3 成功但存在完全无法判定的模组
`;

/** 被闸门拦回的证据：这类保留有明确理由，和「无证据」不是一回事，摘要里分开展示 */
const GATE_EVIDENCE = ['content', 'net', 'deps'];

const PHASE_LABEL = {
  scan: '扫描模组',
  online: '反查 Modrinth',
  mcmod: '复核 MC百科',
  netgate: '扫网络通道',
  write: '写出文件',
  fetch: '取回加载器',
};

function usageError(msg) {
  const err = new Error(msg);
  err.usage = true;
  return err;
}

/** 会吃掉下一个参数的开关，用于识别「取值漏写」；值本身以 - 开头是合法的（如 --jvm -Xmx4G） */
const TAKES_VALUE = new Set([
  '-o', '--out', '--keep', '--drop', '--loader', '--mc', '--jvm',
  '--mcmod-delay', '--mcmod-limit',
]);

function parseArgs(argv) {
  const o = { keep: [], drop: [] };
  const rest = [];
  let i = 0;
  const value = (flag) => {
    const v = argv[++i];
    if (v === undefined || TAKES_VALUE.has(v)) throw usageError(`${flag} 缺少取值`);
    return v;
  };
  for (; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      argv.splice(i + 1, 0, a.slice(eq + 1));
      a = a.slice(0, eq);
    }
    switch (a) {
      case '-o': case '--out': o.out = value(a); break;
      case '--force': o.force = true; break;
      case '--conservative': o.conservative = true; break;
      case '--offline': case '--no-online': o.online = false; o.mcmod = false; break;
      case '--no-mcmod': o.mcmod = false; break;
      case '--mcmod-delay': o.mcmodDelay = Number(value(a)); break;
      case '--mcmod-limit': o.mcmodLimit = Number(value(a)); break;
      case '--no-download': o.download = false; break;
      case '--fetch': o.fetch = true; break;
      case '--keep': o.keep.push(value(a)); break;
      case '--drop': o.drop.push(value(a)); break;
      case '--drop-optional': o.dropOptional = true; break;
      case '--loader': o.loader = value(a); break;
      case '--mc': o.mc = value(a); break;
      case '--jvm': o.jvm = value(a); break;
      case '--rcon': o.rcon = true; break;
      case '--json': o.json = true; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw usageError(`未知选项 ${a}`);
        rest.push(a);
    }
  }
  return { o, rest };
}

function makeReporter(o) {
  const tty = Boolean(process.stderr.isTTY) && !o.quiet;
  const marked = new Map(); // 非终端模式每档只报一次，避免刷屏
  return (evt) => {
    if (o.json) {
      process.stdout.write(`${JSON.stringify(evt)}\n`);
      return;
    }
    if (o.quiet) return;
    if (evt.t === 'phase') {
      const label = PHASE_LABEL[evt.name] || evt.name;
      if (evt.done >= evt.total) {
        // 非终端时不留 \r 与补白，避免日志或管道里出现残迹
        const done = evt.found !== undefined ? `（命中 ${evt.found}）` : `（${evt.total}）`;
        process.stderr.write(`${tty ? '\r' : ''}${label} 完成${done}${tty ? ' '.repeat(8) : ''}\n`);
      } else if (tty) {
        process.stderr.write(`\r${label} ${evt.done}/${evt.total}   `);
      } else {
        // 输出到日志/管道时没有 \r 可用，改成每过四分之一报一行，否则整段是黑的
        const step = Math.max(1, Math.ceil(evt.total / 4));
        const bucket = Math.floor(evt.done / step);
        if (bucket > 0 && !marked.has(`${evt.name}:${bucket}`)) {
          marked.set(`${evt.name}:${bucket}`, true);
          process.stderr.write(`${label} ${evt.done}/${evt.total}\n`);
        }
      }
      return;
    }
    if (evt.t === 'warn' || evt.t === 'note') process.stderr.write(`${evt.msg}\n`);
  };
}

function loaderText(input) {
  const l = input.loader;
  return l && l.name ? `${l.name}${l.version ? ` ${l.version}` : ''}` : '未识别';
}

function summary(plan, out) {
  const c = plan.counts;
  const L = [];
  L.push('');
  L.push(`输入    ${plan.input.name}（${plan.input.kind}，${loaderText(plan.input)}，${plan.input.mcVersion || '版本未识别'}）`);
  L.push(`模组    ${c.modsTotal} 个：保留 ${c.kept}，剔除 ${c.dropped}`);
  if (c.heuristicDropped) L.push(`        其中 ${c.heuristicDropped} 个靠内置名单剔除，不是硬证据，需人工确认`);
  if (c.conflicts) L.push(`        其中 ${c.conflicts} 个作者声明两端通用，仍被剔除，见报告的 conflicts`);
  const gated = [
    ['自有内容', c.contentKept], ['网络通道', c.netKept], ['被依赖', c.depsKept],
  ].filter(([, n]) => n);
  if (gated.length) L.push(`        闸门拦回 ${gated.reduce((s, [, n]) => s + n, 0)} 个：${gated.map(([k, n]) => `${k} ${n}`).join('、')}`);
  if (c.mcmodFound) L.push(`百科    复核到 ${c.mcmodFound} 个条目：据此挪回 ${c.mcmodRestored}，据此剔除 ${c.mcmodDropped}`);
  L.push(`文件    写出 ${c.filesWrite}${c.downloads ? `（其中待下载 ${c.downloads}）` : ''}，排除 ${c.skipped}`);
  if (c.manifestOnly) L.push(`清单    ${c.manifestOnly} 个条目只有 CurseForge 编号，无法自动取回`);
  L.push(`输出    ${out || '（plan 模式，未落盘）'}`);

  const dropped = plan.mods.filter((m) => m.decision === 'drop');
  if (dropped.length) {
    L.push('');
    L.push(`已剔除（${dropped.length}）`);
    for (const m of dropped) L.push(`  - ${m.rel}  ${m.reason}`);
  }
  const kept = plan.mods.filter((m) => m.decision !== 'drop');
  const blocked = kept.filter((m) => GATE_EVIDENCE.includes(m.evidence));
  if (blocked.length) {
    L.push('');
    L.push(`闸门拦回（${blocked.length}）：判为纯客户端，但有内容/通道/被依赖，不能拿掉`);
    for (const m of blocked.slice(0, 30)) L.push(`  - ${m.rel}  ${m.reason}`);
    if (blocked.length > 30) L.push(`  …… 其余 ${blocked.length - 30} 项见报告`);
  }
  const unsure = kept.filter((m) => !GATE_EVIDENCE.includes(m.evidence) && m.review);
  if (unsure.length) {
    L.push('');
    L.push(`保留但无把握（${unsure.length}）：证据不足，宁可多留，服务端起不来时先查这里`);
    for (const m of unsure.slice(0, 30)) L.push(`  - ${m.rel}  ${m.reason}`);
    if (unsure.length > 30) L.push(`  …… 其余 ${unsure.length - 30} 项见报告`);
  }
  if (plan.warnings.length) {
    L.push('');
    L.push('提示');
    for (const w of plan.warnings) L.push(`  - ${w}`);
  }
  L.push('');
  return L.join('\n');
}

function defaultOut(input) {
  const abs = path.resolve(input);
  const base = path.basename(abs).replace(/\.(zip|mrpack)$/i, '');
  return path.join(path.dirname(abs), `${base}-server`);
}

async function main(argv) {
  const { o, rest } = parseArgs(argv);
  if (o.version) {
    process.stdout.write(`${mcsp.VERSION}\n`);
    return 0;
  }
  if (o.help || !rest.length) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = rest[0];
  const input = rest[1];
  if (!['make', 'plan', 'identify'].includes(cmd)) throw usageError(`未知子命令 ${cmd}`);
  if (!input) throw usageError(`${cmd} 缺少输入路径`);

  const opts = {
    onEvent: makeReporter(o),
    online: o.online,
    mcmod: o.mcmod,
    mcmodDelay: o.mcmodDelay,
    mcmodLimit: o.mcmodLimit,
    rules: { keep: o.keep, drop: o.drop },
    dropOptional: o.dropOptional,
    conservative: o.conservative,
    loader: o.loader,
    mc: o.mc,
  };

  if (cmd === 'identify') {
    const brief = await mcsp.identify(input);
    if (o.json) process.stdout.write(`${JSON.stringify({ t: 'identify', ...brief })}\n`);
    else process.stdout.write(`${brief.name}：${brief.kind}，${loaderText(brief)}，${brief.mcVersion || '版本未识别'}，${brief.fileCount} 个文件\n`);
    return 0;
  }

  if (cmd === 'plan') {
    const p = await mcsp.plan(input, opts);
    if (!o.json) process.stdout.write(summary(p, null));
    return exitCode(p);
  }

  const out = path.resolve(o.out || defaultOut(input));
  const report = await mcsp.build(input, out, { ...opts, force: o.force, rcon: o.rcon, jvm: o.jvm, fetch: o.fetch, download: o.download });
  if (!o.json) {
    process.stdout.write(summary({ ...report, input: report.input }, out));
    process.stdout.write(`报告    ${report.report}\n\n`);
  }
  return report.counts.failed ? 1 : exitCode(report);
}

/** 有模组连一条证据都拿不到时以 3 退出，便于脚本区分「结果需要人工过目」 */
function exitCode(x) {
  const mods = x.mods || [];
  return mods.some((m) => m.evidence === 'none') ? 3 : 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    if (err.usage) {
      process.stderr.write(`用法错误：${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`错误：${err.message}\n`);
      process.exitCode = 1;
    }
  });
