进口 { WebSocketServer } 从……起 'WS';
进口 { randomBytes } 从……起 'crypto';
进口 FS 从……起 'fs';
进口 路径 从……起 'path';
进口 HTTP 从……起 'http';
进口 archiver 从……起 'archiver';
进口 PraesessorServer 从……起 './praesessor_server.js'; // 追加：引入先莅

Const client_MAGIC='LC-v3.6-2f8a3c7e';
Const CLIENT_SECRET='lc-7a3f9e-2026-8b1c';
const MIN_VERSION='3.6.0';

//=================追加区：先莅环境与配置=================
const creative_WHITELIST=['Admin', 'ServerOwner', '你的名字'];
const allow_ANY_CREATIVE=false;

过程.在……之上('uncaughtException', (err)=>{ console.error('[srv]⚠️防崩拦截：', err.message); });
过程.在……之上('unhandledRejection', (理由)=>{ console.error('[srv]⚠️防崩拦截：', 理由); });

global.LC=global.LC||{};
global.块={ 所有: [], 得到: ()=>({}), _register: ()=>{}, _unregister: ()=>{} };
global.Textures={ 注册: async ()=>true, 有: ()=>true };
global.几何图形={ 建立: ()=>[] };

function authHash(现时) {
  让 h=0x811c9dc5;
  const s=现时+'|'+CLIENT_SECRET;
  为 (让 i=0; i<s.length; i++) {
    h=Math.伊穆尔(h^s.charCodeAt(i), 0x01000193);
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
  }
  return h.toString(36);
}

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const PORT  = parseInt(process.argv[2] || process.env.PORT || '8765', 10);
const TOKEN = process.env.TOKEN || '';
const PROTO = 1;
const AUTH_TIMEOUT_MS = 8000;

const T = {
  HELLO: 'H', WELCOME: 'W',
  BLOCK: 'B', PLAYER: 'P',
  JOIN: 'J', LEAVE: 'L',
  CHAT: 'C', PING: 'p', PONG: 'q',
  SYNC_REQ: 'S', SYNC_RES: 'R',
  SKIN: 'K', START: 'T',
  PVP_HIT: 'X', PVP_DIE: 'Z', PVP_RESPAWN: 'z',
  ROOM_INFO: 'I', KICK: 'Y',
  CHALLENGE: 'A',
  INVENTORY: 'V', BREAK: 'G',
  ITEM_SPAWN: 'i', ITEM_PICK: 'g',
  MODE_FORCE: 'F'   // ★ 服务端强制切换模式（未授权创造模式回退）
};

// ================= 原版：CFG 文件与初始化（一字不改） =================
const CFG_FILE = path.resolve('./world.cfg.json');
let CFG = null;
if (fs.existsSync(CFG_FILE)) {
  try { CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch (e) { CFG = null; }
}
if (!CFG) {
  CFG = { seed: Math.floor(Math.random() * 100000), maxPlayers: 16, pvp: true, spawn: null };
  fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2));
}
console.log('[srv] 世界种子:', CFG.seed, '| PVP:', CFG.pvp ? '开' : '关');

// ================= 追加：动态世界存档系统 =================
const WORLDS_DIR = path.resolve('./worlds');
if (!fs.existsSync(WORLDS_DIR)) fs.mkdirSync(WORLDS_DIR, { recursive: true });

// 扩展原版 CFG，加入方块历史与玩家数据
CFG.blockLog = CFG.blockLog || [];
CFG.players = CFG.players || {};
CFG.id = 'default';

let _saveTimer = null;
function saveWorldNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const file = path.join(WORLDS_DIR, (CFG.id || 'default') + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify(CFG, null, 2));
    fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2)); // 保持原版行为
    console.log(`[srv] 💾 世界已保存: ${CFG.id}.json`);
  } catch (e) { console.error('[srv] ❌ 世界保存失败', e); }
}
function queueSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => saveWorldNow(), 2000);
}
function loadWorld(id) {
  const file = path.join(WORLDS_DIR, id + '.json');
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      CFG = { ...CFG, ...data, id: id };
      console.log(`[srv] ✅ 已加载世界: ${id} | 种子: ${CFG.seed}`);
    } catch (e) { console.error('[srv] 加载世界失败', e); }
  } else { console.log(`[srv] ⚠️ 世界文件不存在: ${id}`); }
}
function createWorld(id) {
  if (!id) id = 'world_' + randomBytes(2).toString('hex');
  const file = path.join(WORLDS_DIR, id + '.json');
  if (fs.existsSync(file)) return console.log('[srv] 世界已存在！');
  CFG = { id: id, seed: Math.floor(Math.random() * 100000), maxPlayers: 16, pvp: true, spawn: null, blockLog: [], players: {} };
  saveWorldNow();
  console.log(`[srv] ✨ 新世界创建成功: ${id}`);
}
// 如果 worlds/default.json 存在，覆盖加载
loadWorld('default');

const clients  = new Map();
const blockLog = []; // 原版变量保留
const BLOCKLOG_LIMIT = 32768;

// ================= 先莅目录与打包 =================
const PSSR_DIR = path.resolve('./pssr');
if (!fs.existsSync(PSSR_DIR)) fs.mkdirSync(PSSR_DIR, { recursive: true });

// 启动时清空 .pssr 缓存，保证每次重启都是最新代码
(function clearPssrCache() {
  try {
    const files = fs.readdirSync(PSSR_DIR);
    let cleared = 0;
    for (const f of files) {
      if (f.toLowerCase().endsWith('.pssr')) {
        try { fs.unlinkSync(path.join(PSSR_DIR, f)); cleared++; } catch (e) {}
      }
    }
    if (cleared > 0) console.log(`[srv] 🧹 已清理 ${cleared} 个旧 .pssr 缓存`);
  } catch (e) {
    console.warn('[srv] 清理 .pssr 缓存失败', e);
  }
})();

/**
 * 现场把目录打包成 .pssr（如果已存在就直接复用）
 * @param {string} dirPath  源目录（绝对路径）
 * @param {string} zipPath  目标 zip（绝对路径）
 * @returns {Promise<string>}
 */
function ensurePssrZip(dirPath, zipPath) {
  if (fs.existsSync(zipPath)) return Promise.resolve(zipPath);

  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { try { fs.unlinkSync(zipPath); } catch (e) {} };

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      if (finished) return;
      finished = true;
      resolve(zipPath);
    });
    output.on('error', (e) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(e);
    });
    archive.on('error', (e) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(e);
    });

    archive.pipe(output);
    // 第二个参数 false：不包含 dirPath 本身这一层，
    // 解压后 praesessor.json 直接落在目标目录下，符合 loadModFromDir
    archive.directory(dirPath, false);
    archive.finalize().catch(reject);
  });
}

// ================= 先莅 HTTP 服务（推 .pssr 二进制） =================
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.url.startsWith('/pssr/download')) {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const rawId = urlObj.searchParams.get('id');
      if (!rawId) {
        res.writeHead(400); return res.end('Missing id');
      }

      // 路径穿越防护
      const decoded = decodeURIComponent(rawId);
      if (decoded.includes('..') || decoded.includes('\\') || decoded.startsWith('/')) {
        res.writeHead(400); return res.end('Invalid path');
      }

      const modDir = path.resolve(path.join(PSSR_DIR, decoded));
      if (!modDir.startsWith(PSSR_DIR + path.sep)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      if (!fs.existsSync(modDir) || !fs.statSync(modDir).isDirectory()) {
        res.writeHead(404); return res.end('Not Found');
      }

      const baseName = path.basename(decoded);
      const zipPath  = path.join(PSSR_DIR, baseName + '.pssr');

      // 现场打包（如不存在）
      await ensurePssrZip(modDir, zipPath);

      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(baseName)}.pssr"`
      });
      fs.createReadStream(zipPath).pipe(res);
      console.log(`[srv] 📦 推送先莅：${decoded}（${(stat.size / 1024).toFixed(1)} KB）`);
      return;
    }

    // 兼容旧的 /pssr/memory（已废弃，返回 410 提示升级）
    if (req.url.startsWith('/pssr/memory')) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('此接口已废弃，请更新客户端到最新版本（改为 .pssr 二进制下载）');
    }

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    console.error('[srv] HTTP 处理异常', e);
    try { res.writeHead(500); res.end('Internal Error'); } catch (_) {}
  }
});

httpServer.on('error', (e) => {
  console.error(`[srv] ❌ HTTP 服务启动失败（端口 ${PORT + 1}）:`, e.message);
});
httpServer.listen(PORT + 1, () => {
  console.log(`📦 HTTP 服务启动: http://0.0.0.0:${PORT + 1}/pssr/download?id=<mod>`);
});

// ================= 追加：先莅引擎初始化 =================
global._server_context = {
  broadcast: (msg) => broadcast(msg, null),
  sendTo: (playerId, msg) => { for (const [ws, c] of clients) if (c.playerId === playerId && c.authed) send(ws, msg); },
  kick: (playerId, reason) => { for (const [ws, c] of clients) if (c.playerId === playerId) { send(ws, { t: T.KICK, reason }); setTimeout(() => ws.close(), 100); } },
  getPlayers: () => Array.from(clients.values()).filter(c => c.authed)
};
global._broadcast = global._server_context.broadcast;

PraesessorServer._toast = (msg) => console.log(msg);
PraesessorServer.scanAll(PSSR_DIR).then((mods) => {
  global._pssrList = mods.map(m => {
    let relPath = '';
    try { relPath = path.relative(PSSR_DIR, m.dir).split(path.sep).join('/'); }
    catch (e) { relPath = path.basename(m.dir); }
    return {
      id:      m.id,
      name:    m.name || m.id,
      version: m.version || '1.0.0',
      dirName: path.basename(m.dir),
      relPath: relPath
    };
  });
  if (global._pssrList.length) {
    console.log('[srv] 📚 已加载私服先莅：');
    for (const m of global._pssrList) {
      console.log(`  · ${m.id} v${m.version}  (${m.relPath})`);
    }
  } else {
    console.log('[srv] 📚 没有私服先莅');
  }
}).catch(err => console.error('[srv] ❌ 先莅加载失败', err));

// ================= 原版：WebSocket 核心 =================
const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log('');
  console.log('  🟢 Libercraft 私服已启动');
  console.log('  📡 ws://0.0.0.0:' + PORT);
  if (TOKEN) console.log('  🔑 房间密码：已开启');
  console.log('  📋 玩家在大厅点「加入房间」，填 你的IP:' + PORT);
  console.log('  控制台命令：list / pvp on|off / kick <名字> / seed / help');
  console.log('  管理员扩展：world load/create | js <代码>');
  console.log('');
});

wss.on('connection', (ws, req) => {
  const gotToken = extractToken(req);
  if (TOKEN && gotToken !== TOKEN) {
    try { ws.send(JSON.stringify({ t: T.KICK, reason: '密码错误' })); } catch (e) {}
    ws.close(4001, 'auth failed');
    return;
  }
  if (clients.size >= CFG.maxPlayers) {
    try { ws.send(JSON.stringify({ t: T.KICK, reason: '服务器已满' })); } catch (e) {}
    ws.close(4002, 'full');
    return;
  }

  const conn = {
    ws, id: randomUUID8(), playerId: null, name: '?', skin: null,
    alive: false,
    nonce: null, authed: false, authTimer: null
  };
  clients.set(ws, conn);
  console.log('[srv] +' + conn.id + '  在线 ' + clients.size);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handle(conn, m); } catch (e) { console.error('[srv] 处理异常', e); }
  });

  ws.on('close', () => {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    clients.delete(ws);
    if (conn.alive) {
      broadcast({ t: T.LEAVE, id: conn.playerId }, ws);
      console.log('[srv] -' + conn.name + '  在线 ' + clients.size);
    }
  });

  ws.on('error', e => console.warn('[srv] ws error:', e.message));
});

function handle(c, m) {
  switch (m.t) {
    case T.CHALLENGE:   return onChallenge(c, m);
    case T.HELLO:       return onHello(c, m);
    case T.BLOCK:       return onBlock(c, m);
    case T.PLAYER:      return onPlayer(c, m);
    case T.CHAT:        return onChat(c, m);
    case T.PING:        return onPing(c, m);
    case T.SKIN:        return onSkin(c, m);
    case T.PVP_HIT:     return onPvpHit(c, m);
    case T.PVP_DIE:     return onPvpDie(c, m);
    case T.PVP_RESPAWN: return onPvpRespawn(c, m);
    case T.SYNC_REQ:    return onSyncReq(c, m);
    case T.INVENTORY:   return onInventory(c, m);
    case T.BREAK:       return onBreak(c, m);
    case T.ITEM_SPAWN:  return onItemSpawn(c, m);
    case T.ITEM_PICK:   return onItemPick(c, m);
    default:
      // 追加：放行未知数据包
      if (c.authed && m.t) {
        broadcast(m, c.ws);
      }
      break;
  }
}

function onChallenge(c, m) {
  if (c.authed || !m.req || c.nonce) return;
  c.nonce = randomBytes(16).toString('hex');
  send(c.ws, { t: T.CHALLENGE, nonce: c.nonce });
  c.authTimer = setTimeout(() => {
    if (!c.authed) kickAuth(c, '认证超时');
  }, AUTH_TIMEOUT_MS);
}

function onHello(c, m) {
  if (c.authed) return;

  if (!m.magic || m.magic !== CLIENT_MAGIC) return kickAuth(c, '客户端版本不匹配，请使用官方客户端');
  if (!c.nonce || m.nonce !== c.nonce) return kickAuth(c, '认证 nonce 无效');
  if (m.hash !== authHash(c.nonce)) return kickAuth(c, '客户端认证失败');
  if (cmpVer(m.ver, MIN_VERSION) < 0) return kickAuth(c, '客户端版本过低（需 ≥ ' + MIN_VERSION + '）');

  c.authed = true;
  if (c.authTimer) { clearTimeout(c.authTimer); c.authTimer = null; }

  c.playerId = m.id || ('p' + randomUUID8());
  c.name     = String(m.name || 'Player').slice(0, 24);
  c.skin     = m.skin || null;
  c.alive    = true;

  const players = [];
  for (const [, x] of clients) {
    if (x === c || !x.alive) continue;
    players.push({ id: x.playerId, name: x.name, skin: x.skin });
  }

  // 修复：CFG.spawn 为空时兜底，避免客户端清空世界后落到虚空
  let spawnPoint = CFG.spawn;
  if (!spawnPoint || typeof spawnPoint.x !== 'number' ||
      typeof spawnPoint.y !== 'number' || typeof spawnPoint.z !== 'number') {
    spawnPoint = { x: 0.5, y: 80, z: 0.5 };
    CFG.spawn = spawnPoint;
    queueSave();
    console.warn('[srv] ⚠ spawn 缺失，已兜底为 (0.5, 80, 0.5)');
  }

  send(c.ws, {
    t: T.WELCOME, proto: PROTO, seed: CFG.seed, spawn: spawnPoint,
    self: null, name: 'Libercraft 私服', skin: null, started: 1,
    roomConfig: { maxPlayers: CFG.maxPlayers, pvp: CFG.pvp }, players,
    pssrList: global._pssrList || [],
    pssrHttpPort: PORT + 1
  });

  // 追加：下发玩家存档
  if (CFG.players[c.playerId]) {
      setTimeout(() => send(c.ws, { t: 'PLAYER_LOAD', data: CFG.players[c.playerId] }), 500);
  }

  broadcast({ t: T.JOIN, id: c.playerId, name: c.name, skin: c.skin }, c.ws);

  if (blockLog.length || CFG.blockLog.length) {
    setTimeout(() => {
      if (c.ws.readyState === 1) {
        const bl = CFG.blockLog.length ? CFG.blockLog.slice(-8192) : blockLog.slice(-8192);
        send(c.ws, { t: T.SYNC_RES, blocks: bl });
      }
    }, 600);
  }

  setTimeout(() => {
    if (c.ws.readyState !== 1) return;
    send(c.ws, { t: T.ROOM_INFO, maxPlayers: CFG.maxPlayers, pvp: CFG.pvp });
    send(c.ws, { t: T.START });
  }, 120);

  console.log('[srv] ✔ ' + c.name + ' 已加入（' + clients.size + ' 人在线）');
}

function kickAuth(c, reason) {
  console.warn('[srv] ✕ 拒绝 ' + c.id + '：' + reason);
  if (c.authTimer) { clearTimeout(c.authTimer); c.authTimer = null; }
  try { send(c.ws, { t: T.KICK, reason }); } catch (e) {}
  setTimeout(() => { try { c.ws.close(4001, reason); } catch (e) {} }, 120);
}

功能 onBlock(c, 米) {
  如果 (!c.已授权) 返回;
  Const 进入={ t: T.块, x: 米.x, y: 米.y, z: 米.z, i: 米.i };

  blockLog.推(进入);
  如果 (blockLog.length>BLOCKLOG_LIMIT) blockLog.转变();

  // 追加：动态世界存盘
  CFG.blockLog.推(进入);
  如果 (CFG.blockLog.length>50000) CFG.blockLog.转变();
  queueSave();

  广播(进入, c.WS);
}

功能 onPlayer(c, 米) {
  如果 (!c.已授权) 返回;

  // 修复：创造模式未授权时，不再踢人；改为发 MODE_FORCE 让客户端切回生存，
  //同时把广播出去的mode强制改成幸存。
  Const allowedCreative=allow_ANY_CREATIVE||creative_WHITELIST.包括(c.姓名);
  如果 (米.模式==='创意' && !allowedCreative) {
    如果 (!c._creativeWarned) {
      c._creativeWarned=正确;
      控制台.警告('[srv] ⚠ 玩家'+c.姓名+' 尝试使用未授权的创造模式，已回退为生存');
    }
    尝试 { 发送(c.WS, { t: T.mode_FORCE, 模式: '生存', 理由: '创造模式未授权，已切回生存' }); } 赶上 (e) {}
    米.模式='生存';
  }

  // 追加：更新玩家存档
  如果 (!CFG.玩家[c.playerID]) CFG.玩家[c.playerID]={};
  CFG.玩家[c.playerID].POS={ x: 米.x, y: 米.y, z: 米.z, 偏航: 米.偏航, 球场: 米.球场 };
  CFG.玩家[c.playerID].模式=米.模式;

  // 原版逻辑保留
  米.身份标识=c.playerID;
  米.姓名=c.姓名;
  广播(米, c.WS);
}

功能 onChat(c, 米) {
  如果 (!c.已授权) 返回;
  Const 味精={ t: T.聊天, 从……起: c.playerID, 姓名: c.姓名, 文本: 线(米.文本||'').片(0, 200) };
  广播(味精, c.WS);
}

功能 onPing(c, 米) {
  如果 (!c.已授权) 返回;
  发送(c.WS, { t: T.pong, TS: 米.TS });
}

function onSkin(c, m) {
  if (!c.authed) return;
  c.skin = m.skin;
  broadcast({ t: T.SKIN, id: c.playerId, skin: m.skin }, c.ws);
}

function onPvpHit(c, m) {
  if (!c.authed || !CFG.pvp) return;
  m.from = c.playerId;
  m.fromName = c.name;
  broadcast(m, c.ws);
}

function onPvpDie(c, m) {
  if (!c.authed) return;
  m.id = c.playerId;
  m.name = c.name;
  broadcast(m, c.ws);
}

function onPvpRespawn(c, m) {
  if (!c.authed) return;
  m.id = c.playerId;
  broadcast(m, c.ws);
}

function onSyncReq(c) {
  if (!c.authed) return;
  send(c.ws, { t: T.SYNC_RES, blocks: blockLog.slice(-8192) });
}

inventory(c，m){
if(！c.ruthed)返回；
//追加：存盘背包
if(！CFG.players[c.playerId])CFG.players[c.playerId]={}；
CFG.players[c.playerId].inv=m.inv；
queueSave()；

m.id=c.playerId；
广播(m，c.ws)；
}

函数onbreak(c，m){
if(！c.ruthed)返回；
m.id=c.playerId；
广播(m，c.ws)；
}

函数onItemSpawn(c，m){
if(！c.ruthed)返回；
m.id=c.playerId；
广播(m，c.ws)；
}

函数onItemPick(c，m){
if(！c.ruthed)返回；
m.id=c.playerId；
广播(m，c.ws)；
}

函数发送(ws，m){
if(ws.readyState！==1)返回；
try{ws.send(JSON.stringify(m))；}catch(e){}
}

功能广播(m，Ws除外){
Const s=JSON.stringify(m)；
for(客户端的Const[ws，conn]){
if(ws===除Ws)继续；
if(！conn.hauthed)继续；
if(ws.readyState===1){
尝试{ws.send(s)；}catch(e){}
    }
  }
}

函数extractToken(req){
尝试{
const u=新URL(req.url，'ws://x')；
if(u.searchParams.get('token'))返回u.searchParams.get('token')；
}渔获物(e){}
Const auth=req.headers['authorization']；
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
Const proto=req.headers['sec-websocket-protocol']；
if(proto)返回proto.split('，')[0].Trim()；
return”；
}

return”；
+
}

过程。on('SIGINT'，()=>{.on('SIGINT'，()=>{.on('SIGINT'，()=>{.on('SIGINT'，()=>{.on('SIGINT'，()=>{
console.log('[srv]正在关闭…')；console.log('[srv]正在关闭…')；.日志('[srv]正在关闭…')；console.log('[srv]正在关闭…')；
(4).toString('hex')；返回randomBytes(4).toString('hex')；
CMD
WSS.关闭(()=>进程。退出(0))；wss.关闭(()=>进程。退出(0))；.关闭(()=>进程。退出(0))；wss.关闭(()=>process.exit(0))；
});

//=================原版：终端指令(只追加，未删除原有案例)=================
过程。stdin.SetEncoding('utf8')；.stdin.SetEncoding('utf8')；.stdin.SetEncoding('utf8')；.stdin.SetEncoding('utf8')；
过程。标准。on('data'，line=>{.stdin.on('data'，line=>{.stdin.on('data'，line=>{.stdin.on('data'，line=>{
const parts=line.trim().split(/\s+/)；const parts=line。修剪()。split(/\s+/)；parts=line。修剪()。split(/\s+/)；const parts=line。修剪()。拆分(/\s+/)；
常量cmd=parts[0]，args=parts。切片(1)；常量cmd=parts[0]，args=parts.切片(1)；cmd=parts[0]，args=parts.切片(1)；const CMD=parts[0]，args=parts。切片(1)；
开关(cmd){开关(cmd){(cmd){switch(cmd){
案例'清单'：案例'清单'：'清单'：案例'清单'：
控制台。log('在线'+clients.size+'人：')；console.log('在线'+clients.size+'人：')；.log('在线'+clients.size+'人：')；console.log('在线'+clients.size+'人：')；
对于(const[，c]个客户端){for(客户的Const[，c]){(const[，c]个客户端){for(const[，c]个客户端){
if(c.ive)控制台.日志('·'+c.名称+'('+c.playerID+')')；if(c.ive)控制台。log('·'+c.名称+'('+c.playerID+')')；(c.活动)控制台。log('·'+c.name+'('+c.playerID+')')；if(c.alive)console.log('·'+c.name+'('+c.playerID+')')；
      }
打破；打破；;
案例'PVP'：案例'pvp'：'pvp'：case'pvp'：
CFG.PvP=args[0]==='on'；CFG。PvP=args[0]==='on'；。PvP=args[0]==='on'；CFG.PvP=args[0]==='on'；
FS.writeFileSync(CFG_FILE，JSON.Stringify(CFG，null，2))；fs.writeFileSync(CFG_FILE，JSON.stringify(CFG，null，2))；.writeFileSync(CFG_FILE，JSON.stringify(CFG，null，2))；fs.writeFileSync(CFG_FILE, JSON.stringify(CFG，null，2))；
for(const[ws，c]个客户端){for(const[ws，c]个客户端){(const[ws，c]个客户端){for(const[ws，c]个客户端){
if(c.已授权)发送(ws，{t:T.room_INFO，maxplayers:CFG.maxplayers，pvp:CFG.PvP)；if(c.已授权)发送(ws，{t:T.room_INFO，maxplayers:CFG.maxplayers，pvp:CFG。{\f25PvP})；(c.已授权)发送(ws，{t:T.room_INFO，maxplayers:CFG.maxplayers，pvp:CFG.PvP)；if(c.已验证)发送(ws，{t:T.room_INFO，maxplayers:CFG.maxplayers，pvp:CFG.PvP})；
      }
console.log('PVP：'+(CFG.pvp？'开'：'关'))；console.log('PVP：'+(CFG.pvp？'开'：'关'))；.log('PVP：'+(CFG.pvp？'开'：'关'))；console.log('PVP：'+(CFG.pvp？'开'：'关'))；
queueSave()；queueSave()；()；queueSave()；
打破；打破；;
案例“踢脚”：案例“踢脚”：'踢'：
for(const[ws，c]个客户端){for(const[ws，c]个客户端){(const[ws，c]个客户端){for(const[ws，c]个客户端){
if(c.playerID===args[0]||c.name===args[0]){if(c.playerID===args[0]||c.name===args[0]){(c.playerID===args[0]||c.name===args[0]){if(c.playerID===args[0]||c.name===args[0]){
发送(ws，{t:T.ick，原因：'被管理员踢出'})；发送(ws，{t:T.踢，原因：'被管理员踢出'})；(ws，{t:T.KICK，原因：'被管理员踢出'})；发送(ws，{t:T.KICK，原因：'被管理员踢出'})；
ws.close()；ws.close()；.close()；ws.close()；
控制台。log('已踢出：'+c.name)；控制台。log('已踢出：'+c.姓名)；。log('已踢出：'+c.name)；控制台。log('已踢出：'+c.name)；
打破；打破；;
        }
      }
打破；打破；;
案例“种子”：案例“种子”：'种子'：
console.log('世界种子：'+CFG.seed)；console.log('世界种子：'+CFG.种子)；.log('世界种子：'+CFG.seed)；console.log('世界种子：'+CFG.种子)；
打破；打破；;
案例“帮忙”：案例'help'：'help'：
案例""：案例"：'':
控制台。log('命令：list|pvp on|off|kick<名字>|seed|help')；控制台。log('命令：list|pvp on|off|kick<名字>|seed|help')；.log('命令：list|pvp on|off|kick<名字>|seed|help')；console.log('命令：list|pvp on|off|kick<名字>|seed|help')；
打破；打破；;

//=================追加：高级终端指令=================// =================追加：高级终端指令=================
案例"保存"：案例'save'：'save'：
saveWorldNow()；saveWorldNow()；()；saveWorldNow()；
打破；打破；;
case'world'：case'world'：case'world'：case'world'：
if(args[0]==='load'){if (args[0] === 'load') {(args[0]==='load'){if (args[0] === 'load') {
saveWorldNow()；saveWorldNow()；()；saveWorldNow()；
loadWorld(args[1])；loadWorld(args[1]);(args[1])；loadWorld(args[1]);
for(const[ws]个客户端)发送(ws，{t:T.KICK，原因：'管理员已切换世界，请重新进入'})；for(const[ws]个客户端)发送(ws，{t:T.KICK，原因：'管理员已切换世界，请重新进入'})；(const[ws]个客户端)发送(ws，{t:T.KICK，原因：'管理员已切换世界，请重新进入'})；for(const[ws]个客户端)发送(ws，{t:T.KICK，原因：'管理员已切换世界，请重新进入'})；
setTimeout(()=>客户端。clear()，500)；setTimeout(()=>客户端。clear()，500)；(()=>clients。clear()，500)；setTimeout(()=>客户端。清除()，500)；
}else if(args[0]==='create'){}else if(args[0]==='create'){else if(args[0]==='create'){}else if(args[0]==='create'){
saveWorldNow()；saveWorldNow()；()；saveWorldNow()；
createWorld(args[1])；createWorld(args[1])；(args[1])；createWorld(args[1])；
}else{}else{else{}else{
console.log('用法：全局加载<id>|全局创建<id>')；console.log('用法：世界加载<id>|世界创建<id>')；.log('用法：world load<id>|world create<id>')；console.log('用法：世界加载<id>|世界创建<id>')；
      }
打破；打破；;
案例“PSSR”：案例“PSSR”：“PSSR”：
      // 打印当前已加载的私服先莅// 打印当前已加载的私服先莅// 打印当前已加载的私服先莅// 打印当前已加载的私服先莅
if(全局._PSSRList&&全局._pssrList.Length){if(全局._PSSRList&&全局._pssrList.Length){(全局._PSSRList&&全局。_pssrList.length){if(全局._PSSRList&&全局._pssrList.length){
控制台。log('私服先莅('+global._pssrList.length+'个)：')；console.log('私服先莅('+global._pssrList.length+'个)：')；.log('私服先莅('+global._pssrList.length+'个)：')；console.log('私服先莅('+global._pssrList.length+'个）：')；
全局._pssrList的常量M{for(const m全球的。_pssrList){(全局._pssrList的常量M){for(const全局._pssrList的M){
控制台。日志(“·${m.ID}v${M.version}(${m.RELPATH})”)；控制台。日志('·${m.ID}v${m.版本}(${m.RELPATH})')；.日志("·${m.ID}v${M.版本}(${m.relpath})")；控制台。日志('·${m.id}v${M.version}(${m.relPath})')；
        }
}else{}else{else{}else{
console.log('没有私服先莅')；console.log('没有私服先莅')；.log('没有私服先莅')；console.log('没有私服先莅')；
      }
打破；打破；;
    case 'js': {case 'js': {case 'js': {case 'js': {
//修复：原版在非async回调中await，导致server.js语法错误、完全无法启动；//修复：原版在非async回调中await，导致server.js语法错误、完全无法启动；
//改为IIFE包裹await.//改为IIFE包裹await.
常量代码=line.修剪()。SLIC(3)；常量代码=line.修剪()。切片(3)；=直线。修剪()。slice(3)；常量代码=line.trim().切片(3)；
控制台。日志('[执行JS]${code}')；控制台。日志('[执行JS]${code}')；.log('[执行JS]${code}')；console.log('[执行JS]${code}')；
(async()=>{(async()=>{async()=>{(async()=>{
尝试{try{{try{
常量{createRequire}=等待导入('module')；const{createRequire}=等待导入('module')；{createRequire}=等待导入('module')；const{createRequire}=等待导入(“模块”)；
常量请求=createRequire(import.meta.url)；常量请求=createRequire(import.元。URL)；req=createRequire(导入。元。URL)；const req=createRequire(import.meta.url)；
常数fn=新函数(const fn=new函数
'broadcast'，'clients'，'CFG'，'require'，'broadcast', 'clients', 'CFG', 'require',，'clients'，'CFG'，'require'，'broadcast', 'clients', 'CFG', 'require',
'return(async()=>{'+code+'})()"return(async()=>{'+code+'})()'+code+'})()"return(async()=>{'+code+'})()'
          );
常数res=等待fn(全局._广播，客户端，CFG，请求)；常数res=等待fn(全局._广播，客户端，CFG，请求)；res=等待fn(全局._广播，客户端，CFG，请求)；常数res=等待fn(全局._广播，客户端，CFG，请求)；
if(res！==未定义)控制台。日志('[JS结果]'，res)；if(res！==未定义)console.log('[JS结果]'，res)；(res！==未定义)console.log('[JS结果]'，res)；if(res！==未定义)控制台。日志('[JS结果]'，res)；
}渔获物(e){}渔获物(e){渔获物(e){}渔获物(e){
控制台。错误('[JS异常]'，e)；控制台。错误('[JS异常]'，e)；。错误('[JS异常]'，e)；控制台。错误('[JS异常]'，e)；
        }
      })();
打破；打破；;
    }

默认：默认：:
console.log('未知命令：'+CMD+'(输入帮助查看)')；控制台.日志('未知命令：'+CMD+'(输入帮助查看).log("未知命令：'日志'(输入帮助查看)'CMD+'未知命令：'；控制台'(输入帮助查看)'输入帮助查看CMD+
  }
});
