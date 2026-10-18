/**
 * Praesessor_Server —— 先莅服务端版本（100% 完整保留原版逻辑，0 阉割）
 */
import fs from 'fs';
import path from 'path';

export default (function () {
  'use strict';

  const VERSION  = '1.1.3-server';
  const MANIFEST = 'praesessor.json';
  const PSSR_EXT = '.pssr';
  const MODS_DIR = path.resolve('./pssr'); // 服务端先莅目录

  const LOG  = (...a) => console.log('%c[先莅]',   'color:#c8a4ff', ...a);
  const WARN = (...a) => console.warn('%c[先莅]',  'color:#ffb060', ...a);
  const ERR  = (...a) => console.error('%c[先莅]', 'color:#ff5050', ...a);

  // ════════════════════════════════════════════════════
  //  工具函数
  // ════════════════════════════════════════════════════
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  function cmpVer(a, b) {
    const pa = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function matchVerRange(ver, range) {
    if (!range || range === '*' || range === 'any') return true;
    range = String(range).trim();
    if (range[0] === '^') {
      const base = range.slice(1);
      const major = parseInt(base.split('.')[0], 10) || 0;
      return cmpVer(ver, base) >= 0 && cmpVer(ver, (major + 1) + '.0.0') < 0;
    }
    const tokens = range.split(/\s+/);
    for (const tk of tokens) {
      const m = tk.match(/^(>=|<=|>|<|=)?(.+)$/);
      if (!m) continue;
      const op = m[1] || '=';
      const c = cmpVer(ver, m[2]);
      if (op === '>=' && c < 0) return false;
      if (op === '<=' && c > 0) return false;
      if (op === '>'  && c <= 0) return false;
      if (op === '<'  && c >= 0) return false;
      if (op === '='  && c !== 0) return false;
    }
    return true;
  }

  const _cbCache = new WeakMap();
  function safe(fn, modId, tag) {
    if (typeof fn !== 'function') return fn;
    if (_cbCache.has(fn)) return _cbCache.get(fn);
    const w = function (...args) {
      try { return fn.apply(this, args); }
      catch (e) { ERR('[mod:' + modId + '] 回调异常 @' + (tag || '?'), e); }
    };
    w._orig = fn; w._modId = modId; w._tag = tag || '';
    _cbCache.set(fn, w);
    return w;
  }
  function unwrap(fn) { return _cbCache.get(fn) || fn; }

  // ════════════════════════════════════════════════════
  //  EventBus
  // ════════════════════════════════════════════════════
  const EventBus = (() => {
    const handlers = {};
    const depth = {};
    function on(evt, fn, opts = {}) {
      if (typeof fn !== 'function') return () => {};
      (handlers[evt] ||= []).push({ fn, modId: opts.modId || '?', once: !!opts.once, priority: opts.priority || 0 });
      handlers[evt].sort((a, b) => b.priority - a.priority);
      return () => off(evt, fn);
    }
    function once(evt, fn, opts = {}) { return on(evt, fn, { ...opts, once: true }); }
    function off(evt, fn) {
      const list = handlers[evt]; if (!list) return;
      const orig = unwrap(fn);
      for (let i = list.length - 1; i >= 0; i--)
        if (list[i].fn === fn || list[i].fn === orig) list.splice(i, 1);
    }
    function emit(evt, data) {
      if ((depth[evt] || 0) > 20) { WARN('事件递归过深：' + evt); return; }
      depth[evt] = (depth[evt] || 0) + 1;
      const list = handlers[evt];
      if (list) for (const h of list.slice()) {
        try { h.fn(data); } catch (e) { ERR('事件回调异常 ' + evt, e); }
        if (h.once) off(evt, h.fn);
      }
      depth[evt]--;
    }
    function clear(modId) {
      for (const e in handlers) {
        const list = handlers[e];
        for (let i = list.length - 1; i >= 0; i--)
          if (list[i].modId === modId) list.splice(i, 1);
      }
    }
    return { on, once, off, emit, clear, listEvents: () => Object.keys(handlers), count: evt => (handlers[evt] || []).length };
  })();

  // ════════════════════════════════════════════════════
  //  LifecycleBus
  // ════════════════════════════════════════════════════
  const LifecycleBus = (() => {
    const phases = ['construct', 'setup', 'ready', 'unload'];
    const list = Object.fromEntries(phases.map(p => [p, []]));
    function on(phase, fn, modId) {
      if (!list[phase]) return () => {};
      const entry = { fn, modId };
      list[phase].push(entry);
      return () => { const i = list[phase].indexOf(entry); if (i >= 0) list[phase].splice(i, 1); };
    }
    async function fire(phase) {
      const arr = list[phase] || [];
      await Promise.all(arr.map(e => {
        try { return Promise.resolve(e.fn({ phase })); } catch (err) { ERR('生命周期 ' + phase + ' @' + e.modId, err); }
      }));
    }
    function cleanup(modId) {
      for (const p in list) {
        for (let i = list[p].length - 1; i >= 0; i--)
          if (list[p][i].modId === modId) list[p].splice(i, 1);
      }
    }
    return { on, fire, cleanup, phases };
  })();

  // ════════════════════════════════════════════════════
  //  Registry
  // ════════════════════════════════════════════════════
  const Registry = (() => {
    const types = {};
    const watchers = {};
    ['block','item','entity','recipe','biome','dimension','command','hud','particle','sound','texture','event','mode','rule','service'].forEach(t => types[t] = {});
    function define(type) { if (!types[type]) types[type] = {}; }
    function register(type, id, def) {
      define(type);
      if (!id) throw new Error('Registry: 缺少 id');
      if (types[type][id]) WARN('覆盖已注册：' + type + '/' + id);
      def.id = id; def.type = type;
      types[type][id] = def;
      (watchers[type] || []).forEach(fn => { try { fn(def); } catch (e) { ERR(e); } });
      return def;
    }
    function get(type, id) { return (types[type] || {})[id] || null; }
    function all(type) { return Object.values(types[type] || {}); }
    function exists(type, id) { return !!(types[type] || {})[id]; }
    function remove(type, id) { if (types[type]) delete types[type][id]; }
    function onRegister(type, fn) { (watchers[type] ||= []).push(fn); }
    function listTypes() { return Object.keys(types); }
    function count(type) { return Object.keys(types[type] || {}).length; }
    return { define, register, get, all, exists, remove, onRegister, listTypes, count };
  })();

  // ════════════════════════════════════════════════════
  //  InterceptSystem
  // ════════════════════════════════════════════════════
  const InterceptSystem = (() => {
    const state = {};
    const attached = {};
    function resolvePath(p) {
      let o = global;
      for (const part of String(p).split('.')) { if (o == null) return null; o = o[part]; }
      return o;
    }
    function getParent(p) {
      const parts = String(p).split('.'); let o = global;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      return o;
    }
    function attach(path, handlers, modId) {
      if (!attached[path]) {
        const target = resolvePath(path);
        if (typeof target !== 'function') { WARN('无法拦截（非函数）：' + path); return false; }
        const parent = getParent(path);
        const key = String(path).split('.').pop();
        attached[path] = { original: target, parent, key };
        const wrap = function (...args) {
          const list = state[path] || [];
          for (const it of list) {
            if (!it.before) continue;
            try {
              const r = it.before(args);
              if (r === false) return undefined;
              if (Array.isArray(r)) args = r;
            } catch (e) { ERR('拦截 before ' + path, e); }
          }
          let result = attached[path].original.apply(this, args);
          for (const it of list) {
            if (!it.after) continue;
            try {
              const r = it.after(result, args);
              if (r !== undefined) result = r;
            } catch (e) { ERR('拦截 after ' + path, e); }
          }
          return result;
        };
        try { parent[key] = wrap; } catch (e) { WARN('无法替换 ' + path, e); }
      }
      (state[path] ||= []).push({
        before: handlers.before || null,
        after: handlers.after || null,
        modId
      });
      return true;
    }
    function detach(path, modId) {
      const list = state[path];
      if (!list) return;
      if (modId) {
        for (let i = list.length - 1; i >= 0; i--)
          if (list[i].modId === modId) list.splice(i, 1);
      } else list.length = 0;
      if (list.length === 0 && attached[path]) {
        try { attached[path].parent[attached[path].key] = attached[path].original; } catch (e) {}
        delete attached[path];
        delete state[path];
      }
    }
    function list() {
      return Object.entries(state).map(([path, arr]) => ({
        path, count: arr.length, mods: arr.map(x => x.modId)
      }));
    }
    return { attach, detach, list, isAttached: p => !!attached[p] };
  })();

  // ════════════════════════════════════════════════════
  //  OverrideSystem
  // ════════════════════════════════════════════════════
  const OverrideSystem = (() => {
    const state = {};
    function resolvePath(p) {
      let o = global; for (const x of String(p).split('.')) { if (o == null) return null; o = o[x]; }
      return o;
    }
    function getParent(p) {
      const parts = String(p).split('.'); let o = global;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      return o;
    }
    function dispatch(s, self, args, idx) {
      if (idx >= s.stack.length) return s.original.apply(self, args);
      const entry = s.stack[idx];
      const next = (...a) => dispatch(s, self, a.length ? a : args, idx + 1);
      return entry.fn.apply(self, [next, ...args]);
    }
    function override(path, fn, modId, priority = 0) {
      if (typeof fn !== 'function') { WARN('override 需要函数：' + path); return false; }
      if (!state[path]) {
        const orig = resolvePath(path);
        if (typeof orig !== 'function') { WARN('override 找不到函数：' + path); return false; }
        const parent = getParent(path);
        const key = String(path).split('.').pop();
        state[path] = { original: orig, stack: [], parent, key };
        try {
          parent[key] = function (...args) { return dispatch(state[path], this, args, 0); };
        } catch (e) { WARN('无法覆盖 ' + path, e); delete state[path]; return false; }
      }
      state[path].stack.push({ fn, modId, priority });
      state[path].stack.sort((a, b) => b.priority - a.priority);
      return true;
    }
    function restore(path, modId) {
      const s = state[path]; if (!s) return false;
      if (modId) {
        for (let i = s.stack.length - 1; i >= 0; i--)
          if (s.stack[i].modId === modId) s.stack.splice(i, 1);
      } else s.stack.length = 0;
      if (s.stack.length === 0) {
        try { s.parent[s.key] = s.original; } catch (e) {}
        delete state[path];
      }
      return true;
    }
    function list() {
      return Object.entries(state).map(([p, s]) => ({
        path: p, count: s.stack.length, mods: s.stack.map(x => x.modId)
      }));
    }
    return { override, restore, list, isOverridden: p => !!state[p] };
  })();

  // ════════════════════════════════════════════════════
  //  Services
  // ════════════════════════════════════════════════════
  const Services = {
    _data: {},
    provide(name, value, modId) {
      if (!name) return false;
      if (this._data[name]) WARN('覆盖服务：' + name);
      this._data[name] = { value, modId, at: Date.now() };
      EventBus.emit('service.provide', { name, value, modId });
      return true;
    },
    require(name) { return this._data[name]?.value ?? null; },
    has(name) { return !!this._data[name]; },
    remove(name, modId) {
      const d = this._data[name]; if (!d) return false;
      if (modId && d.modId !== modId) return false;
      delete this._data[name];
      EventBus.emit('service.remove', { name });
      return true;
    },
    removeAll(modId) { Object.keys(this._data).forEach(n => this.remove(n, modId)); },
    list() {
      return Object.entries(this._data).map(([n, d]) => ({ name: n, modId: d.modId, at: d.at }));
    }
  };

  // ════════════════════════════════════════════════════
  //  ResourceMgr（服务端替换了真实加载，但保留所有方法名）
  // ════════════════════════════════════════════════════
  function makeResourceMgr(dir, modId) {
    const cache = { textures: {}, sounds: {}, jsons: {} };
    let audioCtx = null;

    async function readBinary(p) {
      return fs.readFileSync(path.join(dir, p));
    }
    function guessMime(p) { return 'application/octet-stream'; }
    function getAudioCtx() { return null; }

    return {
      dir, modId,
      async loadText(p) { return fs.readFileSync(path.join(dir, p), 'utf8'); },
      async loadJSON(p) { return JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')); },
      loadBinary: readBinary,
      async loadTexture(p, opts = {}) {
        LOG(`服务端忽略渲染加载贴图：${p}`);
        return { __isServerTexture: true };
      },
      async loadAudio(p, opts = {}) {
        LOG(`服务端忽略播放加载音频：${p}`);
        return { __isServerAudio: true };
      },
      playSound(bufOrPath, opts = {}) {
        LOG(`服务端触发播放音频：${bufOrPath}`);
        return { stop: () => {} };
      },
      disposeAll() { }
    };
  }

  // ════════════════════════════════════════════════════
  //  高风险权限
  // ════════════════════════════════════════════════════
  function makeSeize(modId) {
    return function seize(name) {
      if (!name) return null;
      const known = {
        window: global, global: global, document: global.document,
        body: null, head: null, canvas: null,
        location: null, navigator: null, localStorage: null, sessionStorage: null,
        THREE: global.THREE, LC: global.LC, NS: global.NS,
        Praesessor: API, Storage: global.Storage, Blocks: global.Blocks, Textures: global.Textures, Geometries: global.Geometries,
        core: global.LC && global.LC.Core,
        world: global.LC && global.LC.Core && global.LC.Core.world,
        scene: null, camera: null, renderer: null, player: global.LC && global.LC.Core && global.LC.Core.player
      };
      if (name in known) return known[name];
      let o = global;
      for (const part of String(name).split('.')) {
        if (o == null) { WARN('[seize] 未找到: ' + name); return null; }
        o = o[part];
      }
      return o;
    };
  }

  function makeUsurp(modId) {
    return function usurp(path, replacement) {
      if (!path || typeof path !== 'string') return false;
      const parts = path.split('.');
      let o = global;
      for (let i = 0; i < parts.length - 1; i++) {
        if (o == null) { WARN('[usurp] 路径无效: ' + path); return false; }
        o = o[parts[i]];
      }
      if (o == null) return false;
      const key = parts[parts.length - 1];
      try {
        o[key] = replacement;
        WARN('[usurp] 已应用: ' + path);
        return true;
      } catch (e) { WARN('[usurp] 失败: ' + path, e); return false; }
    };
  }

  function makeEval(modId) {
    return function evalJS(code, opts = {}) {
      if (typeof code !== 'string') throw new Error('evalJS: 需要字符串');
      const fn = new Function('LC', 'THREE', 'NS', 'api', 'Praesessor', 'Blocks', 'Textures', 'Geometries', 'window', 'document', '"use strict";\n' + code);
      return fn.call(global, global.LC, global.THREE, global.NS, null, API, global.Blocks, global.Textures, global.Geometries, global, global.document);
    };
  }

  function makeJsFn(modId) {
    return function jsFn(code) {
      if (typeof code !== 'string') throw new Error('jsFn: 需要字符串');
      const factory = new Function('LC', 'THREE', 'NS', 'Praesessor', 'Blocks', 'Textures', 'Geometries', 'window', 'document', '"use strict";\n' + code);
      return factory.call(global, global.LC, global.THREE, global.NS, API, global.Blocks, global.Textures, global.Geometries, global, global.document);
    };
  }

  // 服务端放行高危
  async function showRiskWarning(meta, risky) {
    LOG(`[安全警告] 服务端放行先莅 ${meta.id} 的高危权限。`);
    return true;
  }

  // ════════════════════════════════════════════════════
  //  存储引擎变量（完全保留原版）
  // ════════════════════════════════════════════════════
  const loadedMods   = {};
  const packageIndex = {};
  const loadOrder    = [];
  const customGeos   = {};
  const customBlocks = {};

  // ════════════════════════════════════════════════════
  //  createModAPI（一行不少）
  // ════════════════════════════════════════════════════
  function createModAPI(modId, meta, dir, grants) {
    const resources       = makeResourceMgr(dir, modId);
    const myEvents        = [];
    const myLifecycles    = [];
    const myIntercepts    = [];
    const myOverrides     = [];
    const myFrameHooks    = [];
    const myTimers        = [];
    const myServices      = [];
    const myRegistryEnts  = [];
    const mySceneObjects  = [];
    const myCameraObjects = [];
    const myHUDs          = [];
    const myBlocks        = [];
    const myGeometries    = [];
    const myTextures      = [];

    const api = {
      id: modId, meta, dir,
      Praesessor: API,
      THREE: global.THREE,
      LC: global.LC,
      NS: global.NS,
      Blocks: global.Blocks, Textures: global.Textures, Geometries: global.Geometries, Storage: global.Storage,

      log:   (...a) => console.log('%c[mod:' + modId + ']', 'color:#8fd3ff', ...a),
      warn:  (...a) => console.warn('[mod:' + modId + ']', ...a),
      error: (...a) => console.error('[mod:' + modId + ']', ...a),
      toast: msg => API._toast('[' + (meta.name || modId) + '] ' + msg),

      on(evt, fn, opts = {}) {
        const w = safe(fn, modId, 'on:' + evt);
        const off = EventBus.on(evt, w, { ...opts, modId });
        myEvents.push(off);
        return off;
      },
      once(evt, fn, opts = {}) {
        const w = safe(fn, modId, 'once:' + evt);
        return EventBus.once(evt, w, { ...opts, modId });
      },
      off(evt, fn) { EventBus.off(evt, fn); },
      emit(evt, data) { EventBus.emit(evt, data); },

      onLifecycle(phase, fn) {
        const w = safe(fn, modId, 'life:' + phase);
        const off = LifecycleBus.on(phase, w, modId);
        myLifecycles.push(off);
        return off;
      },

      register(type, id, def) {
        def._modId = modId;
        const r = Registry.register(type, id, def);
        myRegistryEnts.push({ type, id });
        API._onRegistryInject(type, id, def);
        return r;
      },
      unregister(type, id) {
        API._onRegistryRemove(type, id);
        Registry.remove(type, id);
        for (let i = myRegistryEnts.length - 1; i >= 0; i--) {
          const e = myRegistryEnts[i];
          if (e.type === type && e.id === id) myRegistryEnts.splice(i, 1);
        }
      },
      getRegistered:    (t, id) => Registry.get(t, id),
      getAllRegistered: t => Registry.all(t),

      intercept(path, handlers = {}) {
        const h = {
          before: handlers.before ? safe(handlers.before, modId, 'int.b:' + path) : null,
          after:  handlers.after  ? safe(handlers.after,  modId, 'int.a:' + path) : null
        };
        InterceptSystem.attach(path, h, modId);
        myIntercepts.push(path);
        return true;
      },
      unintercept(path) { InterceptSystem.detach(path, modId); },

      override(path, fn, priority = 0) {
        const w = safe(fn, modId, 'ovr:' + path);
        const ok = OverrideSystem.override(path, w, modId, priority);
        if (ok) myOverrides.push(path);
        return ok;
      },
      restore(path) { return OverrideSystem.restore(path, modId); },

      provide(name, value) {
        myServices.push(name);
        return Services.provide(name, value, modId);
      },
      require:    n => Services.require(n),
      hasService: n => Services.has(n),

      resources,
      loadTexture: (p, o) => resources.loadTexture(p, o),
      loadAudio:   (p, o) => resources.loadAudio(p, o),
      loadJSON:    p => resources.loadJSON(p),
      loadText:    p => resources.loadText(p),
      loadBinary:  p => resources.loadBinary(p),
      playSound:   (b, o) => resources.playSound(b, o),

      async registerTexture(name, source) {
        if (!name) throw new Error('registerTexture: 缺 name');
        if (global.Textures) await global.Textures.register(name, source);
        if (myTextures.indexOf(name) < 0) myTextures.push(name);
        return true;
      },

      registerGeometry(name, faces) {
        if (!name) throw new Error('registerGeometry: 缺 name');
        if (!Array.isArray(faces)) throw new Error('registerGeometry: faces 必须是数组');
        const norm = faces.map(f => ({
          texKey: f.texKey || 'px',
          cull:   f.cull === undefined ? null : f.cull,
          verts:  f.verts
        }));
        customGeos[name] = norm;
        if (myGeometries.indexOf(name) < 0) myGeometries.push(name);
        return true;
      },
      unregisterGeometry(name) {
        delete customGeos[name];
        const i = myGeometries.indexOf(name);
        if (i >= 0) myGeometries.splice(i, 1);
      },

      async registerBlock(def) {
        if (!def || !def.name) throw new Error('registerBlock: 缺 name');
        if (def.id == null)    throw new Error('registerBlock: 缺 id');
        if (def.id < 16)       throw new Error('registerBlock: id 必须 ≥ 16（0-15 是内置）');
        
        if (global.Blocks && global.Blocks.get(def.id).id === def.id && def.id < 16) {
          throw new Error('registerBlock: id 与内置冲突');
        }

        if (def.svg && typeof def.svg === 'object') {
          for (const [name, svg] of Object.entries(def.svg)) {
            if (global.Textures) await global.Textures.register(name, svg);
            if (myTextures.indexOf(name) < 0) myTextures.push(name);
          }
        }
        if (def.textures && typeof def.textures === 'object') {
          for (const [name, src] of Object.entries(def.textures)) {
            if (global.Textures) await global.Textures.register(name, src);
            if (myTextures.indexOf(name) < 0) myTextures.push(name);
          }
        }

        let geo = def.geo || { type: 'cube' };
        if (geo.type === 'custom-named') {
          const gname = geo.name;
          if (!customGeos[gname]) throw new Error('未知命名几何体：' + gname);
          geo = { type: 'custom', faces: customGeos[gname] };
        }

        const blockDef = {
          id: def.id,
          name: def.name,
          solid: def.solid !== false,
          transparent: !!def.transparent,
          liquid: !!def.liquid,
          alphaTest: def.alphaTest,
          tex: def.tex || { all: def.name },
          geo,
          _modId: modId
        };
        
        if (global.Blocks && global.Blocks._register) {
          global.Blocks._register(def.id, blockDef);
        }
        customBlocks[def.id] = blockDef;
        if (myBlocks.indexOf(def.id) < 0) myBlocks.push(def.id);

        invalidateAllChunks();
        LOG('注册方块 id=' + def.id + ' name=' + def.name);
        return blockDef;
      },

      unregisterBlock(id) {
        const bd = customBlocks[id];
        if (!bd || bd._modId !== modId) return false;
        if (global.Blocks && global.Blocks._unregister) {
          global.Blocks._unregister(id);
        } else if (global.Blocks && global.Blocks.all) {
          const i = global.Blocks.all.indexOf(bd);
          if (i >= 0) global.Blocks.all.splice(i, 1);
        }
        delete customBlocks[id];
        const i = myBlocks.indexOf(id);
        if (i >= 0) myBlocks.splice(i, 1);
        invalidateAllChunks();
        return true;
      },

      getBlock(x, y, z) {
        const w = global.LC?.Core?.world;
        return w ? w.getBlock(x | 0, y | 0, z | 0) : 0;
      },
      setBlock(x, y, z, id) {
        const w = global.LC?.Core?.world;
        if (w) w.setBlock(x | 0, y | 0, z | 0, id | 0);
      },
      fillBox(x1, y1, z1, x2, y2, z2, id) {
        const w = global.LC?.Core?.world;
        if (!w) return;
        const ax = Math.min(x1, x2) | 0, bx = Math.max(x1, x2) | 0;
        const ay = Math.min(y1, y2) | 0, by = Math.max(y1, y2) | 0;
        const az = Math.min(z1, z2) | 0, bz = Math.max(z1, z2) | 0;
        for (let x = ax; x <= bx; x++)
          for (let y = ay; y <= by; y++)
            for (let z = az; z <= bz; z++)
              w.setBlock(x, y, z, id | 0);
      },
      raycast(origin, dir, dist) {
        const core = global.LC?.Core;
        if (!core) return { hit: false };
        const p = core.player;
        return core.world.raycast(origin || p.getEyePosition(), dir, dist || 6);
      },

      getPlayerPos() {
        const p = global.LC?.Core?.player;
        return p ? { x: p.position.x, y: p.position.y, z: p.position.z } : { x: 0, y: 0, z: 0 };
      },
      getPlayerLook() {
        const p = global.LC?.Core?.player;
        return p ? { yaw: p.yaw, pitch: p.pitch } : { yaw: 0, pitch: 0 };
      },
      teleport(x, y, z) {
        const p = global.LC?.Core?.player;
        if (p) p.teleport(x, y, z);
      },
      setFlying(on) { const p = global.LC?.Core?.player; if (p) p.flying = !!on; },
      setSelectedBlock(id) { const p = global.LC?.Core?.player; if (p) p.selectedBlock = id | 0; },
      jump() { const p = global.LC?.Core?.player; if (p && typeof p.jump === 'function') p.jump(); },

      getScene()    { return global.LC?.Core?.scene; },
      getCamera()   { return global.LC?.Core?.camera; },
      getRenderer() { return global.LC?.Core?.renderer; },

      addToScene(o) {
        const s = global.LC?.Core?.scene;
        if (s) { s.add(o); mySceneObjects.push(o); }
        return o;
      },
      addToCamera(o) {
        const c = global.LC?.Core?.camera;
        if (c) { c.add(o); myCameraObjects.push(o); }
        return o;
      },
      removeFromScene(o) {
        const s = global.LC?.Core?.scene;
        if (s) s.remove(o);
        const i = mySceneObjects.indexOf(o);
        if (i >= 0) mySceneObjects.splice(i, 1);
      },

      addHUD(id, html, css) {
        if (!global.document) return null;
        const fullId = 'pssr-' + modId + '-' + id;
        let el = global.document.getElementById(fullId);
        if (!el) {
          el = global.document.createElement('div');
          el.id = fullId;
          el.style.cssText = 'position:fixed;pointer-events:none;z-index:40;' + (css || '');
          el.innerHTML = html;
          global.document.body.appendChild(el);
          myHUDs.push(el);
        } else {
          el.innerHTML = html;
          if (css) el.style.cssText = 'position:fixed;pointer-events:none;z-index:40;' + css;
        }
        return el;
      },
      removeHUD(id) {
        if (!global.document) return;
        const fullId = 'pssr-' + modId + '-' + id;
        const el = global.document.getElementById(fullId);
        if (el) {
          el.remove();
          const i = myHUDs.indexOf(el); if (i >= 0) myHUDs.splice(i, 1);
        }
      },
      onHUD(id, evt, fn) {
        if (!global.document) return null;
        const el = global.document.getElementById('pssr-' + modId + '-' + id);
        if (!el) return null;
        const w = safe(fn, modId, 'hud:' + id + ':' + evt);
        el.addEventListener(evt, w);
        api._track.listeners.push({ target: el, event: evt, fn: w });
        return w;
      },

      setTimeout(fn, ms) {
        const w = safe(fn, modId, 'setTimeout');
        const id = setTimeout(w, ms);
        myTimers.push({ id, type: 't' });
        return id;
      },
      setInterval(fn, ms) {
        const w = safe(fn, modId, 'setInterval');
        const id = setInterval(w, ms);
        myTimers.push({ id, type: 'i' });
        return id;
      },
      clearTimer(id) {
        clearTimeout(id); clearInterval(id);
        for (let i = myTimers.length - 1; i >= 0; i--)
          if (myTimers[i].id === id) myTimers.splice(i, 1);
      },

      onFrame(fn, priority = 0) {
        const w = safe(fn, modId, 'onFrame');
        w._pssrPriority = priority;
        if (global.LC?.Core?.addFrameHook) global.LC.Core.addFrameHook(w);
        myFrameHooks.push(w);
        return w;
      },
      offFrame(fn) {
        if (global.LC?.Core?.removeFrameHook) global.LC.Core.removeFrameHook(fn);
        const i = myFrameHooks.indexOf(fn);
        if (i >= 0) myFrameHooks.splice(i, 1);
      },

      config: {
        get(key, def) {
          const k = 'pssr_' + modId + '_' + key;
          const v = global.localStorage ? global.localStorage.getItem(k) : null;
          if (v === null) return def;
          try { return JSON.parse(v); } catch (e) { return def; }
        },
        set(key, val) {
          if (global.localStorage) global.localStorage.setItem('pssr_' + modId + '_' + key, JSON.stringify(val));
        },
        remove(key) { if (global.localStorage) global.localStorage.removeItem('pssr_' + modId + '_' + key); },
        all() { return {}; },
        clear() {}
      },

      _track: { dom: [], styles: [], listeners: [], observers: [], slots: [], classes: [] },
      own(node) {
        if (node && this._track.dom.indexOf(node) < 0) this._track.dom.push(node);
        return node;
      },
      ownStyle(css) {
        if (!global.document) return null;
        const el = global.document.createElement('style');
        el.textContent = css;
        global.document.head.appendChild(el);
        this._track.styles.push(el);
        return el;
      },
      onGlobal(target, evt, fn, opts) {
        const w = safe(fn, modId, 'onGlobal:' + evt);
        if (target.addEventListener) target.addEventListener(evt, w, opts);
        this._track.listeners.push({ target, event: evt, fn: w, opts });
        return w;
      },
      onWindow(evt, fn, opts)   { return this.onGlobal(global, evt, fn, opts); },
      onDocument(evt, fn, opts) { if (global.document) return this.onGlobal(global.document, evt, fn, opts); return null; },
      observer(obs) { if (obs) this._track.observers.push(obs); return obs; },
      patch(obj, key, value) {
        const had = Object.prototype.hasOwnProperty.call(obj, key);
        const orig = obj[key];
        obj[key] = value;
        this._track.slots.push({ obj, key, orig, had });
        return value;
      },
      addBodyClass(cls) {
        if (!global.document) return;
        global.document.body.classList.add(cls);
        this._track.classes.push(cls);
      },

      _cleanup() {
        for (const id of myBlocks.slice()) {
          try { api.unregisterBlock(id); } catch (e) {}
        }
        for (const n of myGeometries.slice()) {
          try { api.unregisterGeometry(n); } catch (e) {}
        }
        myEvents.forEach(off => { try { off(); } catch (e) {} });
        myLifecycles.forEach(off => { try { off(); } catch (e) {} });
        EventBus.clear(modId);
        LifecycleBus.cleanup(modId);
        myIntercepts.forEach(p => { try { InterceptSystem.detach(p, modId); } catch (e) {} });
        myOverrides.forEach(p => { try { OverrideSystem.restore(p, modId); } catch (e) {} });
        myRegistryEnts.forEach(({ type, id }) => {
          try { API._onRegistryRemove(type, id); Registry.remove(type, id); } catch (e) {}
        });
        myFrameHooks.forEach(fn => {
          if (global.LC?.Core?.removeFrameHook) global.LC.Core.removeFrameHook(fn);
        });
        myTimers.forEach(t => {
          try { clearTimeout(t.id); clearInterval(t.id); } catch (e) {}
        });
        myServices.forEach(n => { try { Services.remove(n, modId); } catch (e) {} });
        for (const o of mySceneObjects) {
          try {
            if (o.parent) o.parent.remove(o);
            if (o.traverse) o.traverse(c => {
              if(c.geometry) c.geometry.dispose();
              if (c.material) {
                if (Array.isArray(c.material))
                  c.material.forEach(m => { if(m.map) m.map.dispose(); if(m.dispose) m.dispose(); });
                else { if(c.material.map) c.material.map.dispose(); if(c.material.dispose) c.material.dispose(); }
              }
            });
          } catch (e) {}
        }
        mySceneObjects.length = 0;
        for (const o of myCameraObjects) {
          try { if (o.parent) o.parent.remove(o); } catch (e) {}
        }
        myCameraObjects.length = 0;
        myHUDs.forEach(el => { try { el.remove(); } catch (e) {} });
        myHUDs.length = 0;

        const t = this._track;
        t.dom.forEach(n => { try { n.remove(); } catch (e) {} });
        t.styles.forEach(n => { try { n.remove(); } catch (e) {} });
        t.listeners.forEach(L => {
          try { if(L.target.removeEventListener) L.target.removeEventListener(L.event, L.fn, L.opts); } catch (e) {}
        });
        t.observers.forEach(o => { try { o.disconnect(); } catch (e) {} });
        t.slots.forEach(s => {
          try {
            if (s.had) s.obj[s.key] = s.orig;
            else try { delete s.obj[s.key]; } catch (e) { s.obj[s.key] = undefined; }
          } catch (e) {}
        });
        t.classes.forEach(c => { try { if(global.document) global.document.body.classList.remove(c); } catch (e) {} });
        t.dom.length = t.styles.length = t.listeners.length =
          t.observers.length = t.slots.length = t.classes.length = 0;

        try { resources.disposeAll(); } catch (e) {}
      }
    };

    if (grants.seize) api.seize = makeSeize(modId);
    if (grants.usurp) api.usurp = makeUsurp(modId);
    if (grants.eval || grants.seize || grants.usurp) {
      api.evalJS = makeEval(modId);
      api.jsFn   = makeJsFn(modId);
    } else {
      const denied = () => { throw new Error('未授权：需要 seize / usurp / eval 权限'); };
      api.evalJS = denied;
      api.jsFn   = denied;
    }
    api.hasSeize = () => !!grants.seize;
    api.hasUsurp = () => !!grants.usurp;
    api.hasEval  = () => !!(grants.eval || grants.seize || grants.usurp);

    return api;
  }

  // ════════════════════════════════════════════════════
  //  依赖排序与加载（完全保留）
  // ════════════════════════════════════════════════════
  function invalidateAllChunks() {
    const core = global.LC && global.LC.Core;
    if (core && core.world && core.world.chunks) {
      for (const [, c] of core.world.chunks) c.dirty = true;
    }
  }

  function checkDependencies(meta) {
    const deps = Array.isArray(meta.dependencies) ? meta.dependencies : [];
    for (const dep of deps) {
      const [depId, range = '*'] = String(dep).split('@');
      const realId = packageIndex[depId];
      if (!realId || !loadedMods[realId]) throw new Error('缺少依赖：' + depId);
      const actual = loadedMods[realId].meta.version || '0.0.1';
      if (!matchVerRange(actual, range))
        throw new Error('依赖版本不满足：' + depId + ' 需要 ' + range + '，实际 ' + actual);
    }
  }

  async function findManifestDir(rootDir, depth, maxDepth) {
    maxDepth = maxDepth == null ? 3 : maxDepth;
    if (depth >= maxDepth) return null;
    let items = [];
    try { items = fs.readdirSync(rootDir).map(name => ({ name, isDir: fs.statSync(path.join(rootDir, name)).isDirectory() })); }
    catch (e) { return null; }

    for (const it of items) {
      if (!it.isDir) continue;
      const sub = path.join(rootDir, it.name);
      if (fs.existsSync(path.join(sub, MANIFEST))) return sub;
    }
    for (const it of items) {
      if (!it.isDir) continue;
      const sub = path.join(rootDir, it.name);
      const r = await findManifestDir(sub, depth + 1, maxDepth);
      if (r) return r;
    }
    return null;
  }

  async function loadModFromDir(dir) {
    LOG('加载：' + dir);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch (e) {}

    if (!meta) {
      const found = await findManifestDir(dir, 0, 3);
      if (found) {
        LOG('在子目录找到 ' + MANIFEST + '：' + found);
        dir  = found;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch (e) {}
      }
    }

    if (!meta) throw new Error('缺少 ' + MANIFEST + '（目录：' + dir + '）');
    if (!meta.id) throw new Error('manifest 缺少 id');
    if (!meta.version) meta.version = '0.0.1';

    if (loadedMods[meta.id]) return loadedMods[meta.id];
    checkDependencies(meta);

    const perms = Array.isArray(meta.permissions) ? meta.permissions : [];
    const risky = {
      seize: perms.includes('seize') || meta.seize === true,
      usurp: perms.includes('usurp') || meta.usurp === true,
      eval:  perms.includes('eval')  || meta.eval  === true
    };
    const grants = { seize: false, usurp: false, eval: false };

    if (risky.seize || risky.usurp || risky.eval) {
      const approved = await showRiskWarning(meta, risky);
      if (approved) { grants.seize = risky.seize; grants.usurp = risky.usurp; grants.eval = risky.eval; }
    }

    const api = createModAPI(meta.id, meta, dir, grants);
    const mod = { id: meta.id, meta, dir, api, grants };
    loadedMods[meta.id] = mod;
    loadOrder.push(meta.id);
    packageIndex[meta.package || meta.id] = meta.id;
    global.__PSSR__ = { loadedMods, packageIndex, loadOrder };

    await LifecycleBus.fire('construct');

    let entry = meta.main;
    if (!entry) {
      for (const f of ['main.js', 'index.js', 'main.mjs']) {
        if (fs.existsSync(path.join(dir, f))) { entry = f; break; }
      }
    }
    
    if (entry) {
      try {
        const code = fs.readFileSync(path.join(dir, entry), 'utf8');
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const runner = new AsyncFunction('api', 'Praesessor', 'LC', 'THREE', 'Blocks', 'Textures', 'Geometries', 'Storage', 'console', '"use strict";\n' + code);
        await runner.call(global, api, API, global.LC, global.THREE, global.Blocks, global.Textures, global.Geometries, global.Storage, console);
      } catch (e) { ERR('入口执行失败 ' + meta.id + '/' + entry, e); }
    } else {
      WARN('未找到入口脚本：' + meta.id);
    }

    await LifecycleBus.fire('setup');
    EventBus.emit('mod.loaded', { id: meta.id, meta, api });
    LOG('✅ 完成：' + (meta.name || meta.id) + ' v' + meta.version);
    API._toast('先莅已加载：' + (meta.name || meta.id) + ' v' + meta.version);
    return mod;
  }

  // ════════════════════════════════════════════════════
  //  扫描与排序
  // ════════════════════════════════════════════════════
  async function scanAll() {
    const root = MODS_DIR;
    LOG('扫描：' + root);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

    const dirs = fs.readdirSync(root).filter(f => fs.statSync(path.join(root, f)).isDirectory() && !f.startsWith('.'));
    const ordered = await resolveOrder(dirs);

    for (const name of ordered) {
      try { await loadModFromDir(path.join(root, name)); }
      catch (e) { ERR('加载失败 ' + name, e); }
    }
    return listMods();
  }

  async function resolveOrder(names) {
    const manifests = {};
    for (const n of names) {
      try { manifests[n] = JSON.parse(fs.readFileSync(path.join(MODS_DIR, n, MANIFEST), 'utf8')) || {}; }
      catch (e) { manifests[n] = {}; }
    }
    const set = new Set(names);
    const graph = {}, inDeg = {};
    names.forEach(n => { graph[n] = []; inDeg[n] = 0; });
    names.forEach(n => {
      const deps = manifests[n].dependencies || [];
      for (const dep of deps) {
        const depId = String(dep).split('@')[0];
        if (set.has(depId)) { graph[depId].push(n); inDeg[n]++; }
      }
    });
    const queue = names.filter(n => inDeg[n] === 0);
    const result = [];
    while (queue.length) {
      const cur = queue.shift();
      result.push(cur);
      for (const nxt of graph[cur] || [])
        if (--inDeg[nxt] === 0) queue.push(nxt);
    }
    for (const n of names) if (!result.includes(n)) {
      WARN('循环依赖：' + n); result.push(n);
    }
    return result;
  }

  // ════════════════════════════════════════════════════
  //  卸载 / 重载 / 删除
  // ════════════════════════════════════════════════════
  function unloadMod(id) {
    const mod = loadedMods[id];
if(！mod)返回false；
尝试{LifecycleBus.fire('unload')；}赶上(e){}(e){}
尝试{mod.API._cleanup()；}赶上(e){ERR('清理失败'，E)；}{mod.API._cleanup()；}赶上(e){ERR('清理失败'，E)；}
mod
log
const pkg=mod.meta.package||mod.id； pkg=mod.meta.package||mod.id；
删除packageIndex[pkg]；[pkg]；
删除loadedMods[id]；[id]；
Const锂=loadorder。indexOf(id)；锂=loadorder.indexOf(id)；
拼接(li，1)；(锂>=0)loadorder.拼接(li，1)；
EventBus.emit('mod.unloaded'，{id})；.emit('mod.unloaded'，{id})；
log('已下载：'+身份标识)；('已下载：'+身份标识)；
    return true;return true;
  }

异步函数reloadMod(id){(id){
Const m=loadedMods[id]；m=loadedMods[id]；
if(！m)抛出新错误('找不到：'+身份标识)；(！M)抛出新错误('找不到：'+身份标识)；
const dir=m.dir； dir=m.dir；
unloadMod(id)；(id)；
返回loadmodfromdir(dir)；(dir)；
  }

异步函数deleteMod(id){(id){
Const m=loadedMods[id]；m=loadedMods[id]；
if(！m)返回false；(！m)返回false；
const dir=m.dir； dir=m.dir；
unloadMod(id)；(id)；
尝试{{
fs.rmsync(目录，{递进的：true，force:true})；.rmSync(dir，{递进的：true，force:true})；
log('已删除目录：'+目录)；('已删除目录：'+目录)；
API._toast('已彻底删除：'+身份标识)；._toast('已彻底删除：'+身份标识)；
}赶上(e){警告('删除目录失败：'+Dir，e)；}赶上(e){警告('删除目录失败：'+Dir，e)；}
    return true;return true;
  }

函数listMods(){(){
返回loadOrder.map(id=>{.map(id=>{
Const m=loadedMods[id]；m=loadedMods[id]；
返回{{
身份标识，名称：m.meta.name||身份标识，版本：米.meta.version||'？'，.meta.name||身份标识，版本：米.meta.version||'？'，
作者：米.元。作者||'？'，描述：米.元。描述||"，.元。作者||'？'，描述：米.元。描述||package:m.meta.package||id，dir:m.dir，
package:m.meta.package||id，dir:m.dir，
权限：米.meta.permissions||[]，.meta.permissions||[]，
赠款：米。赠款||{缴获：假，篡夺：假，评估：假}，：米。赠款||{缴获：假，篡夺：假，评估：假}，
块：m.api？m.API._myBlocksList||[]：[]：m.api？m.API._myBlocksList||[]：[]
      };
    });
  }

//════════════════════════════════════════════════════
//  控制台命令
//════════════════════════════════════════════════════
函数cmd(输入){(输入){
常数[c，...args]=字符串(输入)。修剪()。分离(/\s+/)；const[c，...args]=String(input).Trim().分离(/\s+/)；
开关(c){(c){
case'mods'：返回listMods()；'mods'：返回listMods()；
案例“事件”：返回EventBus.listEvents()；'events'：返回EventBus。listEvents()；
case'types'：return 注册表.listTypes()；'types'：return 注册表.listTypes()；
case'overr'：传回OverrideSystem.list()；'overr'：传回OverrideSystem.list()；
大小写“int”：传回拦截系统.列表()；case'int'：return拦截系统.列表()；
案例'SVC'：返回服务.列表()；'SVC'：返回服务.列表()；
案例'块'：返回(全局。积木？全球的。块。全部：[]).map(b=>b.id+'：'+b.Name)。参加('\n')；'块'：返回(全局。积木？全球的。块。全部：[]).map(b=>b.id+'：'+b.Name)。参加('\n')；
案例'geos'：传回对象。键(自定义地理位置)。参加('\n')||'（无自定义几几体）'；'地理位置'：传回对象。键(自定义地理位置)。参加('\n')||'（无自定义几几体）'；
case'扫描'：return scanAll()；'扫描'：return scanAll()；
案例'load'：传回引数[0]？loadModFromDir(路径.参加(MODS_DIR，args[0])：null；case'load'：返回参数[0]？loadModFromDir(路径.参加(MODS_DIR，参数[0]))：null；
      case 'unload':  return args[0] ? unloadMod(args[0]) : null;case 'unload':  return args[0] ? unloadMod(args[0]) : null;
      case 'reload':  return args[0] ? reloadMod(args[0]) : null;case 'reload':  return args[0] ? reloadMod(args[0]) : null;
案例'删除'：传递自变量[0]？deleteMod(引数[0])：null；'删除'：传递自变量[0]？deleteMod(引数[0])：null；
默认值：返回‘未知命令：'+C；'+c；
    }
  }

//════════════════════════════════════════════════════
  //  对外暴露//  对外暴露
//════════════════════════════════════════════════════
常量API={={
事件：事件总线，生命周期：生命周期总线，注册表，
version，MANIFEST，PSSR_EXT，
截取：截取系统，覆盖：覆盖系统，服务，
makeResourceMgr、makeSeize、makeUsurp、makeEval、makeJsFn、showRiskWarning、
loadModFromDir，findManifestDir，scanAll，unloadMod，reloadMod，deleteMod，
listMods，resolveOrder，checkDependencies，invalidateAllChunks，cmd，

_onRegistryInject(type，id，def){EventBus.emit('注册表。inject'，{type，id，def})；}，(type，id，def){EventBus.emit('注册表。inject'，{type，id，def})；}，
onRegistryRemove(_onRegistryRemove)(类型，ID){EventBus.emit('注册表。移除'，{type，id})；}，(_onRegistryRemove)(类型，ID){EventBus.emit('注册表。移除'，{type，id})；}，
_toast(msg){(msg){
      // 服务端没有 UI，直接打日志// 服务端没有 UI，直接打日志
日志(msg)；(msg)；
    },

得到loadedMods(){返回loadedMods；}，(){returnloadedMods；}，
获取packageIndex(){return packageIndex；}，(){return packageIndex；}，
得到loadorder(){return loadorder；}，(){return loadorder；}，
获取customBlocks(){return customBlocks；}，(){return customBlocks；}，
获取customGeos(){return customGeos；}(){return customGeos；}
  };

log('先莅v'+版本+('先莅v'+版本+'就绪')；
返回API；
})();
