'use strict';
/**
 * 取回加载器服务端文件：Fabric/Quilt 下可直接运行的启动 jar，Forge/NeoForge 只下安装器。
 * Forge/NeoForge 的库文件必须由安装器自行下载，客户端目录里的 libraries/ 不能拿来顶替。
 * 版本号缺失或接口不通就跳过并说明原因，不影响其余产物。
 */
const fs = require('fs');
const path = require('path');

/** 超时压在 60 秒：源站被墙时 TCP 连接会一直挂着，长超时等于卡死整条流程 */
const DEFAULT_TIMEOUT = 60000;

async function getJson(url, ua, timeout) {
  const res = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(timeout || 20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function download(url, dest, ua, timeout) {
  const res = await fetch(url, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(timeout || DEFAULT_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('返回内容过小，可能不是有效文件');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/**
 * @param {string} outDir 服务端包目录，文件直接落在根下
 * @param {object} plan index.plan() 的结果
 * @param {{ua?:string}} opts
 * @returns {Promise<{file:string|null, notes:string[]}>}
 */
async function fetchLoader(outDir, plan, opts = {}) {
  const ua = opts.ua || 'mcsp';
  const notes = [];
  const loader = plan.input.loader;
  const mc = plan.input.mcVersion;
  let file = null;
  try {
    if (!loader || !loader.name) {
      notes.push('未识别加载器，跳过服务端文件下载');
    } else if (loader.name === 'fabric') {
      if (!mc) throw new Error('未识别游戏版本，无法定位 Fabric 服务端');
      let ver = loader.version;
      if (!ver) {
        const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mc}`, ua);
        ver = list && list[0] && list[0].loader && list[0].loader.version;
        if (!ver) throw new Error('Fabric 元数据里没有该游戏版本的 loader');
        notes.push(`加载器版本未识别，取该游戏版本最新 Fabric loader ${ver}`);
      }
      file = 'server.jar';
      await download(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${ver}/server/jar`, path.join(outDir, file), ua);
    } else if (loader.name === 'quilt') {
      if (!mc) throw new Error('未识别游戏版本，无法定位 Quilt 服务端');
      const installers = await getJson('https://meta.quiltmc.org/v3/versions/installer', ua);
      const inst = installers && installers[0] && installers[0].version;
      if (!inst) throw new Error('取不到 Quilt 安装器版本');
      let ver = loader.version;
      if (!ver) {
        const list = await getJson(`https://meta.quiltmc.org/v3/versions/loader/${mc}`, ua);
        ver = list && list[0] && list[0].loader && list[0].loader.version;
        if (!ver) throw new Error('Quilt 元数据里没有该游戏版本的 loader');
        notes.push(`加载器版本未识别，取该游戏版本最新 Quilt loader ${ver}`);
      }
      file = 'server.jar';
      await download(`https://meta.quiltmc.org/v3/versions/loader/${mc}/${ver}/${inst}/server/jar`, path.join(outDir, file), ua);
    } else if (loader.name === 'forge') {
      let id = loader.version && loader.version.includes('-') ? loader.version : null;
      if (!id && mc && loader.version) id = `${mc}-${loader.version}`;
      if (!id && mc) {
        const promos = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', ua);
        const p = promos && promos.promos;
        const v = p && (p[`${mc}-recommended`] || p[`${mc}-latest`]);
        if (v) { id = `${mc}-${v}`; notes.push(`加载器版本未识别，取该游戏版本推荐构建 ${id}`); }
      }
      if (!id) throw new Error('未识别 Forge 版本，无法定位安装器');
      file = 'forge-installer.jar';
      await download(
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}/forge-${id}-installer.jar`,
        path.join(outDir, file), ua,
      );
      notes.push(`已下载安装器，须自行执行：java -jar ${file} --installServer`);
    } else if (loader.name === 'neoforge') {
      const ver = loader.version;
      if (!ver) throw new Error('未识别 NeoForge 版本，无法定位安装器');
      file = 'neoforge-installer.jar';
      await download(
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`,
        path.join(outDir, file), ua,
      );
      notes.push(`已下载安装器，须自行执行：java -jar ${file} --installServer`);
    } else {
      notes.push(`未支持自动下载 ${loader.name} 服务端文件`);
    }
  } catch (err) {
    file = null;
    notes.push(`下载加载器文件失败：${err.message}`);
  }
  return { file, notes };
}

module.exports = { fetchLoader };
