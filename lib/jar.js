'use strict';
/**
 * 从一个 jar 里读出判定所需的全部证据。除网络通道外都只看元数据与条目名，不解压字节。
 * Forge 的运行侧不像 Fabric 有 environment 字段，而是写在依赖表里：
 *   [[dependencies.<自身modId>]]  modId="minecraft" side="CLIENT"   —— 只在客户端存在
 * 核心依赖（minecraft/forge/neoforge）全部声明 CLIENT 才是纯客户端；
 * 全部声明 BOTH/SERVER 说明作者明确要两端都装，任何名单都不得把它剔掉。
 * 判定还看两样东西，它们比任何声明都硬：自有命名空间下的服务端内容、以及网络通道。
 */
const { ZipReader } = require('./zip');

const CORE_DEPS = ['minecraft', 'forge', 'neoforge'];
const TABLE_RE = /^\s*\[\[([^\]]+)\]\][^\S\n]*(?:#.*)?$/gm;
const KV_OPT = /^\s*(\w+)\s*=\s*"([^"]*)"/gm;

/** 网络 API 标记：只认 Forge 会漏掉 Architectury / Fabric 系的模组，那正是踩过的坑 */
const NET_API = [
  'NetworkRegistry', 'SimpleChannel', 'ChannelBuilder', 'registerMessage',
  'PacketDistributor', 'RegisterChannelEvent', 'RegisterPayloadHandlersEvent',
  'devin/architectury/networking', 'NetworkManager', 'NetworkChannel',
  'S2CMessage', 'C2SMessage', 'EntitySpawnS2CPacket',
  'ServerPlayNetworking', 'ClientPlayNetworking', 'PayloadTypeRegistry',
  'ServerPlayConnectionEvents',
  'CustomPayload', 'PacketByteBuf', 'FriendlyByteBuf',
];
const NET_PKG_RE = /(?:^|\/)(?:network|networking)\/[^/]*\.class$/i;
const C2S_RE = /(Request|Submit|Update|Query|Interact|Action|Sync|Send|Click|Use|Pull|Set|Toggle|Select|Move|Place|Break|Craft)[A-Za-z]*(Message|Packet|C2S)/i;

// ── ToML ────────────────────────────────────────────────────────────────────

/** 按顶层表切开：`[[dependencies.foo]]` 之后到下一个表头之前的正文 */
function tomlTables(text) {
  const out = new Map();
  const hits = [...text.matchAll(TABLE_RE)];
  for (let i = 0; i < hits.length; i++) {
    const name = hits[i][1].trim();
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(text.slice(hits[i].index + hits[i][0].length, end));
  }
  return out;
}

function pairs(body) {
  const out = new Map();
  for (const m of body.matchAll(KV_OPT)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

/** 依赖表 → 自有 modId、依赖清单、核心依赖的运行侧 */
function readToml(text) {
  const tables = tomlTables(text);
  const mods = [];
  const deps = [];
  const core = [];
  for (const [name, bodies] of tables) {
    for (const body of bodies) {
      const kv = pairs(body);
      if (name === 'mods') {
        if (kv.has('modId')) {
          mods.push({
            id: kv.get('modId'),
            version: kv.get('version') || null,
            name: kv.get('displayName') || null,
            // displayTest 决定客户端会不会因为服务端缺这个模组而标红叉，缺省是 MATCH_VERSION（会标）
            displayTest: (kv.get('displayTest') || '').toUpperCase() || null,
          });
        }
      } else if (name.startsWith('dependencies.')) {
        const id = kv.get('modId');
        if (!id) continue;
        deps.push({ id, mandatory: (kv.get('mandatory') || 'true').toLowerCase() === 'true' });
        // side 缺省即 BOTH，故「写了 BOTH」与「没写」要分开记
        if (CORE_DEPS.includes(id)) core.push({ id, side: (kv.get('side') || 'BOTH').toUpperCase(), explicit: kv.has('side') });
      }
    }
  }
  return { mods, deps, core };
}

// ── 内容与网络 ──────────────────────────────────────────────────────────────

/** 自有命名空间下的服务端内容：有这些的模组无论怎么标注运行侧都得在服务端 */
function scanContent(names, ids) {
  const own = new Set(ids);
  const c = { blocks: 0, recipes: 0, loot: 0, advancements: 0, blockEntity: 0 };
  for (const n of names) {
    const p = n.split('/');
    // 只看自有命名空间：别的命名空间多为资源包式覆盖，不构成「必须上服务端」
    if (p[0] === 'assets' && own.has(p[1]) && p[2] === 'blockstates') {
      c.blocks++;
    } else if (p[0] === 'data' && own.has(p[1])) {
      if (p[2] === 'recipes') c.recipes++;
      else if (p[2] === 'loot_tables' && p[3] === 'blocks') c.loot++;
      else if (p[2] === 'advancements') c.advancements++;
    } else if (n.endsWith('.class')) {
      // mixin 与 client 包里的 BlockEntity 名字是在改渲染，不是注册了方块实体
      if (/(?:^|\/)(?:mixin|mixins|client)\//i.test(n) || /Renderer/i.test(n)) continue;
      const base = p[p.length - 1];
      if (base === 'BlockEntity.class' || /\/block\/entity\/[^/]+\.class$/i.test(n)) c.blockEntity++;
    }
  }
  return c;
}

function contentSummary(c) {
  const parts = [];
  if (c.blocks) parts.push(`方块 ${c.blocks}`);
  if (c.recipes) parts.push(`配方 ${c.recipes}`);
  if (c.loot) parts.push(`方块掉落 ${c.loot}`);
  if (c.advancements) parts.push(`进度 ${c.advancements}`);
  if (c.blockEntity) parts.push(`方块实体类 ${c.blockEntity}`);
  return parts.join('、');
}

/**
 * 扫网络通道。要读 class 字节，故只在真正需要时对候选调用。
 * Forge 登录握手核对的是网络通道而非整份模组表，纯客户端模组一旦注册通道就不能从服务端拿走。
 */
function scanNetwork(buf) {
  const z = new ZipReader(buf);
  try {
    const api = new Set();
    const c2s = new Set();
    for (const n of z.names()) {
      if (!n.endsWith('.class')) continue;
      const base = n.slice(n.lastIndexOf('/') + 1, -'.class'.length);
      if (NET_PKG_RE.test(n) && C2S_RE.test(base)) c2s.add(base);
      const blob = z.read(n);
      for (const m of NET_API) {
        if (blob.includes(m)) api.add(m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m);
      }
      if (c2s.size && api.size) break; // 只要结论，不必扫完
    }
    return { api: [...api], c2s: [...c2s], any: api.size > 0 || c2s.size > 0 };
  } finally {
    z.close();
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const normSide = (v) => {
  const s = String(v || '').toLowerCase();
  if (s === 'client') return 'client';
  if (s === 'server' || s === 'dedicated_server') return 'server';
  if (s === '*' || s === 'both' || s === '') return 'both';
  return null;
};

/**
 * 读一个 jar 的全部离线证据。
 * @param {Buffer} buf jar 字节
 * @returns {object} 见下方字段说明；结构解析失败只影响该字段，不影响其余
 */
function inspectJar(buf) {
  const out = {
    ids: [], name: null, version: null, loader: 'unknown', mc: null,
    // 运行侧：client 纯客户端 | server 服务端专用 | both 作者声明两端都要 | mixed 声明矛盾 | none 没声明
    side: 'none', sideWhy: null,
    deps: [], content: null, contentWhy: '',
    displayTest: null,
    // 拿掉它会不会让客户端登录时对不上：能证明不会，才允许在稳妥模式下剔除
    handshakeSafe: false, handshakeWhy: null,
  };
  let z = null;
  try {
    z = new ZipReader(buf);
    const names = z.names();
    const fabric = z.tryRead('fabric.mod.json');
    if (fabric) {
      const j = JSON.parse(fabric.toString('utf8'));
      out.loader = 'fabric';
      out.ids = [j.id].filter(Boolean);
      out.name = j.name || j.id || null;
      out.version = j.version ? String(j.version) : null;
      const dep = j.depends && j.depends.minecraft;
      const v = Array.isArray(dep) ? dep[0] : dep;
      if (v) out.mc = String(v);
      const env = 'environment' in j ? j.environment : '*';
      const s = normSide(env);
      if (s === 'client') { out.side = 'client'; out.sideWhy = `fabric.mod.json environment="client"`; }
      else if (s === 'server') { out.side = 'both'; out.sideWhy = `fabric.mod.json environment="server"`; }
      else if (j.environment === '*') { out.side = 'both'; out.sideWhy = 'fabric.mod.json environment="*"'; }
      else { out.side = 'none'; out.sideWhy = null; }
    } else {
      const quilt = z.tryRead('quilt.mod.json');
      if (quilt) {
        const j = JSON.parse(quilt.toString('utf8'));
        const q = j.quilt_loader || {};
        out.loader = 'quilt';
        out.ids = [q.id].filter(Boolean);
        out.name = (q.metadata && q.metadata.name) || q.id || null;
        out.version = q.version ? String(q.version) : null;
        const env = (j.minecraft || {}).environment;
        const s = normSide(env === undefined ? '*' : env);
        if (s === 'client') { out.side = 'client'; out.sideWhy = 'quilt.mod.json environment="client"'; }
        else if (s === 'server') { out.side = 'both'; out.sideWhy = 'quilt.mod.json environment="dedicated_server"'; }
        else if (env === '*') { out.side = 'both'; out.sideWhy = 'quilt.mod.json environment="*"'; }
      }
    }

    const tomlName = z.pick('META-INF/neoforge.mods.toml', 'META-INF/mods.toml');
    if (tomlName) {
      const t = readToml(z.read(tomlName).toString('utf8'));
      if (!out.ids.length) out.ids = t.mods.map((m) => m.id).filter(Boolean);
      if (!out.name) out.name = (t.mods[0] && (t.mods[0].name || t.mods[0].id)) || null;
      if (!out.version) out.version = (t.mods[0] && t.mods[0].version) || null;
      if (t.mods[0] && t.mods[0].displayTest) out.displayTest = t.mods[0].displayTest;
      out.loader = tomlName.includes('neoforge') ? 'neoforge' : 'forge';
      out.deps = t.deps;
      if (out.side !== 'client') {
        const sides = t.core.map((c) => c.side);
        const explicit = [...new Set(t.core.filter((c) => c.explicit).map((c) => c.side))];
        if (sides.length && sides.every((s) => s === 'CLIENT')) {
          out.side = 'client';
          out.sideWhy = '核心依赖 side=CLIENT';
        } else if (sides.length && sides.every((s) => s === 'SERVER')) {
          out.side = 'server';
          out.sideWhy = '核心依赖 side=SERVER';
        } else if (sides.length && sides.every((s) => s === 'BOTH')) {
          // 两头都写 BOTH：作者自称两端通用，但多数模组是顺手写的，不足以单独作保留依据
          out.side = 'both';
          out.sideWhy = '核心依赖 side=BOTH';
        } else if (sides.length && sides.includes('CLIENT') && sides.some((s) => s !== 'CLIENT')) {
          out.side = 'mixed';
          out.sideWhy = `核心依赖 side 混有 ${[...new Set(sides)].sort().join('/')}`;
        } else if (explicit.length === 1 && explicit[0] === 'BOTH') {
          out.side = 'both';
          out.sideWhy = '核心依赖显式声明 side=BOTH';
        }
      }
    }
    if (!out.ids.length) {
      const legacy = z.tryRead('mcmod.info');
      if (legacy) {
        const arr = JSON.parse(legacy.toString('utf8'));
        const first = Array.isArray(arr) ? arr[0] : arr;
        if (first) {
          out.ids = [first.modid].filter(Boolean);
          out.name = first.name || first.modid || out.name;
          out.version = String(first.version || '') || out.version;
          out.loader = 'forge';
          if (!out.mc && first.mcversion) out.mc = first.mcversion;
          if (first.clientSideOnly === true) { out.side = 'client'; out.sideWhy = 'mcmod.info clientSideOnly=true'; }
        }
      }
    }

    if (out.ids.length) {
      out.content = scanContent(names, out.ids);
      out.contentWhy = contentSummary(out.content);
    }

    // 拿掉它会不会让客户端登进去时对不上：只有能证明不会，稳妥模式才敢剔。
    // Forge 由 displayTest 说话（缺省 MATCH_VERSION 会标红叉）；Fabric/Quilt 不做整份模组表的兼容检查，
    // 声明 environment=client 的模组本来就不该出现在服务端。
    if ((out.loader === 'fabric' || out.loader === 'quilt') && out.side === 'client') {
      out.handshakeSafe = true;
      out.handshakeWhy = out.sideWhy;
    } else if (out.displayTest === 'IGNORE_ALL_VERSION' || out.displayTest === 'IGNORE_SERVER_VERSION') {
      out.handshakeSafe = true;
      out.handshakeWhy = `displayTest=${out.displayTest}`;
    }
  } catch (err) {
    // 不是 zip、结构损坏、字段缺失都走这里：证据缺失而已，一律按「未知」处理，绝不抛给上层
    out.err = err.message;
  } finally {
    if (z) z.close();
  }
  return out;
}

module.exports = { inspectJar, scanNetwork };
