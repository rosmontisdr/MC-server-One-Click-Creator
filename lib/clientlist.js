'use strict';
/**
 * 内置客户端专用模组名单，只在前两级证据（jar 元数据、Modrinth）都没有结论时兜底。
 * TOKENS 精确匹配：对照模组 id 与去掉版本/加载器后缀的文件名，不会误伤「名字里含这几个字母」的服务端模组。
 * WORDS 子串匹配：命中即剔除，但一律在报告里标为需人工复核。
 */

/** 归一：只保留小写字母数字与汉字，其余分隔符一律去掉 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-z一-鿿]/g, '');
}

/** 文件名去噪：反复削掉尾部的版本号与加载器词，得到可用作精确匹配的候选 */
function stemVariants(stem) {
  const out = new Set();
  const push = (s) => { const n = normalize(s); if (n) out.add(n); };
  let s = String(stem);
  push(s);
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/\+.*$/, ''); // + 之后全是构建元数据
    s = s.replace(/[-_. ]?(?:mc)?\d[\w.\-+]*$/i, '');
    s = s.replace(/[-_. ](?:fabric|forge|neoforge|quilt|common|client|server|api|core|mod|main)$/i, '');
    push(s);
    if (s === before) break;
  }
  return out;
}

/** 逐项：渲染 / 光影  |  小地图  |  物品与配方查看  |  相机与录像  |  皮肤与模型  |  音效  |  建筑辅助  |  杂项界面 */
const TOKENS = new Set([
  // 渲染与光影
  'sodium', 'sodiumextra', 'reesessodiumoptions', 'reesessodiumoptionsflutter',
  'iris', 'irisshaders', 'oculus', 'optifine', 'optifabric', 'optiforges',
  'embeddium', 'embeddiumplus', 'embeddiumextra', 'rubidium', 'rubidiumextra',
  'magnesium', 'magnesiumextras', 'nvidium', 'canvas', 'immediatelyfast',
  'entityculling', 'moreculling', 'culllessleaves', 'cullingleaves',
  'dynamiclights', 'dynamiclight', 'lambdynlights', 'lambdabettergrass',
  'continuity', 'indium', 'skinlayers3d', '3dskinlayers',
  // 小地图与地图
  'journeymap', 'xaerosminimap', 'xaerosworldmap', 'xaerominimap', 'xaeroworldmap',
  'voxelmap', 'betterpvp',
  // 物品与配方查看
  'jei', 'jeiplus', 'justenoughitems', 'rei', 'roughlyenoughitems', 'emi', 'jeed',
  'jech', 'roughlyenoughresources', 'moreoverlays', 'moreoverlaysupdated',
  // 相机、视角与录像
  'replaymod', 'flashback', 'freecam', 'logicalzoom', 'zoomify', 'okzoomer',
  'camerautils', 'betterthirdperson', 'firstpersonmodel', 'shoulderdancing',
  'notenoughanimations', 'effortlessbuilding',
  // 皮肤、披风与模型
  'customskinloader', 'skinshuffle', 'capes', 'waveycapes', 'etf',
  'entitytexturefeatures', 'emf', 'entitymodelfeatures', 'figura',
  // 音效
  'presencefootsteps', 'soundphysics', 'ambientsounds', 'extrasounds',
  // 建筑、原理图与客户端工具
  'litematica', 'malilib', 'minihud', 'tweakeroo', 'itemscroller', 'schematica',
  'worldeditcui', 'appleskin', 'betteradvancements', 'wthit', 'hwyla',
  'torohealth', 'neat', 'jadeadditions',
  // 界面与提示
  'modmenu', 'catalog', 'menulist', 'betterf3', 'toasts', 'toastcontrol',
  'chatheads', 'betterpingdisplay', 'packmenu', 'blur', 'borderless',
  'fullscreenwindowed', 'smoothboot', 'essential', 'essentialmod', 'discordrpc',
  'zoom', 'fpsdisplay', 'betterfps', 'fpsreducer',
]);

/** 子串词：模组名里出现即按客户端模组处理，但结论不可靠，必须人工过目 */
const WORDS = [
  'minimap', 'shader', 'shaders', 'freecam', 'screenshot', '光影', '小地图', '透视',
];

/**
 * 对照名单。
 * @param {string[]} names 模组 id / 名称 / 文件名主干
 * @param {string} stem 文件名的原始主干，用于生成去噪候选
 * @returns {{token:string, exact:boolean}|null}
 */
function matchClientList(names, stem) {
  const cands = new Set();
  for (const n of names) {
    const x = normalize(n);
    if (x) cands.add(x);
  }
  for (const v of stemVariants(stem)) cands.add(v);

  for (const c of cands) if (TOKENS.has(c)) return { token: c, exact: true };

  const joined = [...names, stem].map(normalize).join(' ');
  for (const w of WORDS) if (joined.includes(w)) return { token: w, exact: false };
  return null;
}

module.exports = { TOKENS, WORDS, normalize, stemVariants, matchClientList };
