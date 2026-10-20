'use strict';
/**
 * 输出侧策略：哪些文件不进服务端包，哪些客户端配置跟着被剔除的模组一起删。
 * 与 pack 层的 JUNK 分工不同——JUNK 是任何整合包里都无意义的文件，这里排除的是「只对客户端有意义」的。
 * 另外提供 rel 路径校验：写入前每一条都必须过 safeRel，失败即整批中止。
 */
const { normalize } = require('./clientlist');

/** 顶层目录名（小写）→ 不输出的原因 */
const SKIP_DIRS = new Map([
  ['resourcepacks', '客户端资源包'],
  ['shaderpacks', '光影包'],
  ['shaders', '光影包'],
  ['screenshots', '截图'],
  ['logs', '客户端日志'],
  ['crash-reports', '客户端崩溃报告'],
  ['saves', '单人存档'],
  ['backups', '备份'],
  ['libraries', '客户端库文件：服务端由加载器安装器自行准备'],
  ['versions', '启动器版本目录'],
  ['local', '启动器本地数据'],
  ['downloaded', '启动器下载缓存'],
  ['journeymap', '客户端小地图数据'],
  ['xaero', '客户端小地图数据'],
  ['xaerowaypoints', '客户端路径点'],
  ['xaeroworldmap', '客户端地图缓存'],
  ['.fabric', 'Fabric 客户端缓存'],
  ['.quilt', 'Quilt 客户端缓存'],
  ['.mixin.out', 'Mixin 调试输出'],
  ['.minecraft', '.minecraft 运行时目录'],
  ['packmenu', '客户端主菜单配置'],
]);

/** 文件名（小写）→ 不输出的原因 */
const SKIP_FILES = new Map([
  ['options.txt', '客户端画面与按键设置'],
  ['optionsof.txt', '客户端光影设置'],
  ['optionsshaders.txt', '客户端光影设置'],
  ['servers.dat', '客户端服务器列表'],
  ['servers.dat_old', '客户端服务器列表'],
  ['usercache.json', '客户端玩家缓存'],
  ['usernamecache.json', '客户端玩家缓存'],
  ['realms_persistence.json', 'Realms 客户端状态'],
  // 这两个文件含微软账号登录令牌，随整合包外流等于泄露账号，任何情况下都不进服务端包
  ['launcher_profiles.json', '启动器配置：含登录令牌'],
  ['launcher_accounts.json', '启动器账号：含登录令牌'],
  ['launcher_accounts_microsoft_store.json', '启动器账号：含登录令牌'],
  ['hotbar.nbt', '客户端快捷栏缓存'],
  // 启动器导出的整合包元数据：留在服务端里没有意义
  ['mcbbs.packmeta', 'MCBBS 整合包元数据'],
  ['modpack.json', 'HMCL 整合包元数据'],
  ['pack.json', 'HMCL 实例清单'],
  ['mmc-pack.json', 'MultiMC/Prism 实例元数据'],
  ['instance.cfg', 'MultiMC/Prism 实例配置'],
  ['server-manifest.json', 'HMCL 服务端整合包元数据'],
]);

const SENSITIVE = /^launcher_(accounts|profiles).*\.json$/;

/**
 * 该路径是否应排除出服务端包。
 * @returns {string|null} 原因；null 表示可以输出
 */
function reasonFor(rel) {
  const segs = String(rel).split('/');
  const dir = SKIP_DIRS.get(segs[0].toLowerCase());
  if (dir) return dir;
  const base = segs[segs.length - 1].toLowerCase();
  // 客户端已停用的模组不能在服务端被启用，复制过去等于改了玩家的模组表
  if (segs.length === 2 && segs[0].toLowerCase() === 'mods' && /\.(?:disabled|bak|old)$/.test(base)) {
    return '模组已停用或为备份';
  }
  const f = SKIP_FILES.get(base);
  if (f) return f;
  if (/^hs_err_pid.*\.log$/.test(base) || /^replay_pid.*\.log$/.test(base)) return 'JVM 崩溃日志';
  return null;
}

/** 输入里出现了登录令牌类文件，需要提醒用户该目录不宜整体外传 */
function isSensitive(rel) {
  return SENSITIVE.test(String(rel).split('/').pop());
}

// ── 配置裁剪 ────────────────────────────────────────────────────────────────

/** 纯客户端的配置名（已归一），即使对应模组没被剔除也不该进服务端 */
const CLIENT_CONFIGS = new Set([
  'iris', 'sodium', 'sodiumoptions', 'sodiumfrapioptions', 'reesessodiumoptions',
  'embeddium', 'embeddiumplus', 'embeddiumoptions', 'rubidium', 'rubidiumoptions',
  'magnesium', 'oculus', 'optifine', 'betterf3', 'modmenu', 'entityculling',
  'immediatelyfast', 'continuity', 'indium', 'journeymap', 'xaero', 'xaerominimap',
  'xaeroworldmap', 'fancymenu', 'litematica', 'malilib', 'minihud', 'tweakeroo',
  'itemscroller', 'replaymod', 'flashback', 'customskinloader', 'skinshuffle',
  'capes', 'entitytexturefeatures', 'entitymodelfeatures', 'jei', 'roughlyenoughitems',
  'emi', 'presencefootsteps', 'soundphysics', 'appleskin', 'wthit', 'sodiumextra',
]);

const CONFIG_ROOTS = /^(config|defaultconfigs)\/(.+)$/;

/**
 * 配置是否该删：要么它属于某个被剔除的模组，要么它本身就是客户端配置。
 * @param {string} rel
 * @param {Set<string>} dropped 被剔除模组的归一 id 集合
 * @returns {string|null} 原因
 */
function configReason(rel, dropped) {
  if (/^kubejs\/client_scripts\//.test(rel)) return 'KubeJS 客户端脚本：服务端不执行';
  const m = CONFIG_ROOTS.exec(rel);
  if (!m) return null;
  const rest = m[2];
  const segs = rest.split('/');
  const head = segs[0];
  const stem = head.replace(/\.[^.]+$/, '');
  const headNorm = normalize(stem);
  const dirNorm = normalize(head);
  if (CLIENT_CONFIGS.has(headNorm) || CLIENT_CONFIGS.has(normalize(segs[0]))) return '客户端模组配置';
  if (segs.length > 1 && dropped.has(dirNorm)) return '所属模组已剔除';
  if (dropped.has(headNorm)) return '所属模组已剔除';
  return null;
}

// ── 写入路径校验 ────────────────────────────────────────────────────────────

const WIN_BAD = /[<>:"|?*\u0000-\u001f]/;
const WIN_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * 校验将要写出的相对路径。条目名来自整合包自身，带 ../ 或盘符即可写到 out 之外，
 * 故此处一律按白名单收：相对路径、无 ..、无绝对前缀、无 Windows 非法字符。
 * @returns {string} 规范化后的相对路径
 */
function safeRel(rel) {
  const r = String(rel).replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-zA-Z]:/.test(r)) throw new Error(`非法输出路径: ${rel}`);
  for (const seg of r.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error(`非法输出路径: ${rel}`);
    if (WIN_BAD.test(seg)) throw new Error(`非法输出路径: ${rel}`);
    if (WIN_DEVICE.test(seg)) throw new Error(`非法输出路径: ${rel}`);
  }
  return r;
}

module.exports = { reasonFor, isSensitive, configReason, safeRel, CLIENT_CONFIGS, SKIP_DIRS };
