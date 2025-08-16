/**********************************************************
 * DOM REFERENCES
 **********************************************************/
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const captionInput = document.getElementById('caption');
const statusEl = document.getElementById('status');
const feedList = document.getElementById('feedList');
const toggleFeedBtn = document.getElementById('toggleFeedBtn');
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');
const feedBackdrop = document.getElementById('feedBackdrop');

// New UI elements
const sidebar = document.getElementById('sidebar');
const mobileHeaderToggle = document.getElementById('mobileHeaderToggle');
const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
const main = document.querySelector('.main');
const mobileUploadBtn = document.getElementById('mobileUploadBtn');
const mobileCaptionInput = document.getElementById('mobileCaption');
const wrap = document.getElementById('canvasWrap');

/**********************************************************
 * LOGGING: CONFIG + TRANSPORT (client → server)
 * - Mirrors console.* and window errors to POST /api/log
 * - Batches logs to reduce chattiness
 * - Supports: level toggles, fetch URL ignore, sampling, runtime control
 **********************************************************/
const LOG_ENDPOINT = '/api/log';
const Log = (() => {
  // ---- Runtime config (editable via window.LogConfig / localStorage) ----
  const defaultConfig = {
    levels: { debug: true, log: true, info: true, warn: true, error: true },
    // Ignore these fetch URLs (string match or RegExp)
    fetchIgnore: [
      /\/api\/grid\b/i, // grid polling is chatty; ignore by default
      /\/api\/log\b/i,  // don't log the logger
    ],
    // Sample rates per level (0..1). e.g. 0.1 = keep 10%
    sample: { debug: 0.25, log: 1, info: 1, warn: 1, error: 1 },
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem('LOG_CONFIG');
      if (!raw) return { ...defaultConfig };
      const user = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...user,
        levels: { ...defaultConfig.levels, ...(user.levels || {}) },
        sample: { ...defaultConfig.sample, ...(user.sample || {}) },
        fetchIgnore: Array.isArray(user.fetchIgnore) ? user.fetchIgnore : defaultConfig.fetchIgnore,
      };
    } catch {
      return { ...defaultConfig };
    }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem('LOG_CONFIG', JSON.stringify(cfg)); } catch { 
      console.warn('Failed to save log config to localStorage');
     }
  }
  let CONFIG = loadConfig();

  // Quick runtime controls in DevTools:
  //   LogConfig.levels({ debug:false })
  //   LogConfig.ignore([/\/api\/grid/, '/api/feed'])
  //   LogConfig.sample({ debug:0.1 })
  //   LogConfig.reset()
  window.LogConfig = {
    get: () => ({ ...CONFIG }),
    set: (patch) => { CONFIG = { ...CONFIG, ...patch }; saveConfig(CONFIG); },
    levels: (patch) => { CONFIG.levels = { ...CONFIG.levels, ...patch }; saveConfig(CONFIG); },
    ignore: (arr) => { CONFIG.fetchIgnore = arr || []; saveConfig(CONFIG); },
    sample: (patch) => { CONFIG.sample = { ...CONFIG.sample, ...patch }; saveConfig(CONFIG); },
    reset: () => { CONFIG = { ...defaultConfig }; saveConfig(CONFIG); },
  };

  // ---- Keep originals so local console still works ----
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  // ---- Internals ----
  const queue = [];
  let flushTimer = null;
  const MAX_BATCH = 20;
  const FLUSH_MS = 1500;
  const MAX_ARG_LEN = 5000;

  function levelEnabled(level) {
    if (!CONFIG.levels[level]) return false;
    const rate = CONFIG.sample[level] ?? 1;
    return Math.random() < rate;
  }

  function urlIgnored(url) {
    try {
      return CONFIG.fetchIgnore.some(rule => {
        if (typeof rule === 'string') return url.includes(rule);
        if (rule instanceof RegExp) return rule.test(url);
        return false;
      });
    } catch { return false; }
  }

  function safeSerialize(arg) {
    try {
      if (arg instanceof Error) {
        return { __type: 'Error', name: arg.name, message: arg.message, stack: arg.stack };
      }
      if (arg && typeof arg === 'object') {
        return JSON.parse(JSON.stringify(arg, (_, v) => (typeof v === 'function' ? '[Function]' : v)));
      }
      return String(arg);
    } catch { try { return String(arg); } catch { return '[Unserializable]'; } }
  }

  function nowTs() { return new Date().toISOString(); }

  async function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, MAX_BATCH);
    const payload = {
      ts: nowTs(),
      page: location.href,
      ua: navigator.userAgent,
      lang: navigator.language,
      screen: { w: window.screen?.width, h: window.screen?.height, dpr: window.devicePixelRatio || 1 },
      events: batch,
    };
    try {
      await fetch(LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // swallow
    } finally {
      if (queue.length) schedule();
    }
  }

  function schedule() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function push(ev) {
    if (!levelEnabled(ev.level)) return;
    if (Array.isArray(ev.args)) {
      ev.args = ev.args.map(a => {
        const s = typeof a === 'string' ? a : JSON.stringify(safeSerialize(a));
        return s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN) + '…[trunc]' : s;
      });
    }
    queue.push(ev);
    if (queue.length >= MAX_BATCH) flush(); else schedule();
  }

  function wireConsole() {
    ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
      console[level] = (...args) => {
        original[level](...args);         // keep developer console output
        push({ level, ts: nowTs(), args });
      };
    });
  }

  function wireGlobalErrors() {
    window.addEventListener('error', (e) => {
      push({
        level: 'error',
        ts: nowTs(),
        args: ['[window.onerror]', e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error ? (e.error.stack || e.error.message) : null],
      });
    });
    window.addEventListener('unhandledrejection', (e) => {
      push({ level: 'error', ts: nowTs(), args: ['[unhandledrejection]', safeSerialize(e.reason)] });
    });
  }

  // ---- Fetch mirror with URL ignore ----
  const _fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const started = performance.now();
    const url = (args[0] && args[0].toString()) || '';
    const shouldLogFetch = !urlIgnored(url);

    try {
      const res = await _fetch(...args);
      if (shouldLogFetch) {
        const dur = Math.round(performance.now() - started);
        push({ level: 'debug', ts: nowTs(), args: ['[fetch]', url, res.status, `${dur}ms`] });
      }
      return res;
    } catch (err) {
      if (shouldLogFetch) {
        const dur = Math.round(performance.now() - started);
        push({ level: 'error', ts: nowTs(), args: ['[fetch error]', url, err?.message || String(err), `${dur}ms`] });
      }
      throw err;
    }
  };

  function init() {
    wireConsole();
    wireGlobalErrors();
    console.info('[client] logger initialized');
  }

  window.addEventListener('beforeunload', () => { flush(); });

  return { init, flush, push };
})();
Log.init();


/**********************************************************
 * CORE STATE
 **********************************************************/
const isMobileConnect = /Mobi|Android/i.test(navigator.userAgent);
let GRID = { w: 1000, h: 1000, slotSize: 40 }; // until /api/config loads
let scale = 0.25;                 // zoom level (logical tile → CSS px)
let origin = { x: 0, y: 0 };      // top-left in grid coords
let dpr = window.devicePixelRatio || 1; // HiDPI
const LOD_SWITCH_PX = isMobileConnect ? 300 : 160;        // CSS px per tile to switch to original

let dragging = false;
let dragStart = { x: 0, y: 0 };
let originStart = { x: 0, y: 0 };

let highlightTile = null;   // { x, y }
let highlightTimer = null;  // timeout id

let pendingSlot = null;     // { x, y } when user dbl-click targets a slot

const GRID_LINE_VISIBILITY_THRESHOLD = 0.1



/**********************************************************
 * SMALL IMAGE CACHE (shared by fetch + sockets)
 **********************************************************/
const Cache = (() => {
  const map = new Map();      // key "x,y" -> entry
  const MAX_ENTRIES = 5000;   // soft cap

  function keyOf(x, y) { return `${x},${y}`; }

  function ensureThumb({ key, thumbUrl }) {
  let e = map.get(key);

  if (!e) {
    e = {
      thumbUrl, fullUrl: null,
      thumbImg: new Image(), fullImg: null,
      thumbReady: false, fullReady: false,
      loadingFull: false, lastUsed: performance.now()
    };
    e.thumbImg.decoding = 'async';
    if (!isMobileConnect) {
      e.thumbImg.loading = 'lazy'; // Only for non-mobile
    }
    e.thumbImg.onload = () => { e.thumbReady = true; touch(key); requestDraw(); };
    e.thumbImg.src = thumbUrl;
    map.set(key, e);
  } else {
    if (e.thumbUrl !== thumbUrl) {
      e.thumbUrl = thumbUrl;
      e.thumbReady = false;
      e.thumbImg = new Image();
      e.thumbImg.decoding = 'async';
      if (!isMobileConnect) {
        e.thumbImg.loading = 'lazy';
      }
      e.thumbImg.onload = () => { e.thumbReady = true; touch(key); requestDraw(); };
      e.thumbImg.src = thumbUrl;
    }
    touch(key);
  }
}

  function ensureFull({ key, fullUrl }) {
    const e = map.get(key);
    if (!e) return; // must have thumb first
    if (!fullUrl) return;
    e.fullUrl = fullUrl;

    if (e.fullReady || e.loadingFull) {
      touch(key);
      return;
    }
    e.loadingFull = true;
    e.fullImg = new Image();
    e.fullImg.decoding = 'async';
    e.fullImg.onload = () => { e.fullReady = true; e.loadingFull = false; touch(key); requestDraw(); };
    e.fullImg.src = fullUrl;
    touch(key);
  }

  function touch(key) {
    const e = map.get(key);
    if (e) e.lastUsed = performance.now();
  }

  function evictIfNeeded(viewRect /* [x0,y0,x1,y1] */) {
    if (map.size <= MAX_ENTRIES) return;

    const [vx0, vy0, vx1, vy1] = viewRect;
    const keep = new Set();
    const pad = 2;
    for (let x = Math.max(0, vx0 - pad); x <= Math.min(GRID.w - 1, vx1 + pad); x++) {
      for (let y = Math.max(0, vy0 - pad); y <= Math.min(GRID.h - 1, vy1 + pad); y++) {
        keep.add(keyOf(x, y));
      }
    }

    const arr = [];
    for (const [k, e] of map) {
      if (!keep.has(k)) arr.push([k, e.lastUsed || 0]);
    }
    arr.sort((a, b) => a[1] - b[1]);

    const toRemove = arr.slice(0, Math.max(0, map.size - MAX_ENTRIES));
    for (const [k] of toRemove) map.delete(k);
  }

  return { map, ensureThumb, ensureFull, touch, evictIfNeeded, keyOf };
})();

/**********************************************************
 * HELPERS
 **********************************************************/
// Put near your other globals/utilities
function getMinScale() {
  const widthScale = (canvas.width / dpr) / (GRID.w * GRID.slotSize);
  const heightScale = (canvas.height / dpr) / (GRID.h * GRID.slotSize);
  // Must be >= the larger axis so the viewport never exceeds the grid on either axis
  return Math.max(widthScale, heightScale);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function snapPx(pxCss) { return Math.round(pxCss * dpr) / dpr; }

function clampOrigin() {
  const tile = GRID.slotSize * scale;
  const viewTilesX = (canvas.width / dpr) / tile;
  const viewTilesY = (canvas.height / dpr) / tile;
  origin.x = Math.max(0, Math.min(GRID.w - viewTilesX, origin.x));
  origin.y = Math.max(0, Math.min(GRID.h - viewTilesY, origin.y));
}

function computeTargetOrigin(gx, gy, s) {
  const tilesWide = (canvas.width / dpr) / (GRID.slotSize * s);
  const tilesHigh = (canvas.height / dpr) / (GRID.slotSize * s);
  let ox = gx + 0.5 - tilesWide / 2;
  let oy = gy + 0.5 - tilesHigh / 2;
  ox = Math.max(0, Math.min(GRID.w - tilesWide, ox));
  oy = Math.max(0, Math.min(GRID.h - tilesHigh, oy));
  return { ox, oy, tilesWide, tilesHigh };
}

function animateToTile(gx, gy, ms = 300, targetScale = 1) {
  const startScale = scale;
  const minScale = getMinScale();                 // <-- add
  targetScale = Math.max(targetScale, minScale);  // <-- clamp floor

  const start = computeTargetOrigin(gx, gy, startScale);
  const end = computeTargetOrigin(gx, gy, targetScale);

  const startX = start.ox, startY = start.oy;
  const endX = end.ox, endY = end.oy;

  const t0 = performance.now();
  const easeInOut = (t) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function frame(t) {
    const u = Math.min(1, (t - t0) / ms);
    const k = easeInOut(u);

    scale = startScale + (targetScale - startScale) * k;
    origin.x = startX + (endX - startX) * k;
    origin.y = startY + (endY - startY) * k;

    requestDraw();
    if (u < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setHighlight(x, y, ms = 2000) {
  highlightTile = { x, y };
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => { highlightTile = null; }, ms);
}

/**********************************************************
 * LAYOUT / RESIZE
 **********************************************************/
let sidebarOpen = true;

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function updateToggleText() {
  if (isMobile()) {
    mobileHeaderToggle.innerHTML = sidebarOpen ? '👁️' : '👀';
  } else {
    toggleFeedBtn.innerHTML = sidebarOpen ? '👁️ Hide Sidebar' : '👀 Show Sidebar';
  }
}

function applySidebarState() {
  if (isMobile()) {
    // Mobile behavior
    main.classList.remove('sidebar-hidden');
    if (sidebarOpen) {
      sidebar.classList.add('open');
      feedBackdrop.classList.add('active');
      document.body.style.overflow = 'hidden';
    } else {
      sidebar.classList.remove('open');
      feedBackdrop.classList.remove('active');
      document.body.style.overflow = '';
    }
  } else {
    // Desktop behavior
    sidebar.classList.remove('open');
    feedBackdrop.classList.remove('active');
    document.body.style.overflow = '';
    if (sidebarOpen) {
      main.classList.remove('sidebar-hidden');
    } else {
      main.classList.add('sidebar-hidden');
    }
  }
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  applySidebarState();
  updateToggleText();

  // Recompute canvas size immediately and after layout/transition settles
  resize();
  requestAnimationFrame(resize);
  setTimeout(resize, 350); // matches your CSS transition timing on the sidebar
}

function resizeMinimap() {
  const r = minimap.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  minimap.width = Math.max(100, Math.floor(r.width * d));
  minimap.height = Math.max(100, Math.floor(r.height * d));
  mmCtx.setTransform(d, 0, 0, d, 0, 0);
}

function resize() {
  const wrap = document.getElementById('canvasWrap');
  const topbar = document.getElementById('topbar');
  const bottomPad = 0; // No bottom padding needed with new design

  const availH = Math.max(0, window.innerHeight - (topbar?.offsetHeight || 80) - bottomPad);
  wrap.style.height = availH + 'px';

  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampOrigin();
  resizeMinimap();
  applySidebarState();
  requestDraw();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// Handle window resize with proper state management for sidebar
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    applySidebarState();
    updateToggleText();
  }, 150);
});

const ro = new ResizeObserver(() => {
  // When #canvasWrap width/height changes because the sidebar is hidden/shown,
  // recompute backing store size and redraw.
  resize();
});
ro.observe(wrap);

/**********************************************************
 * ON-DEMAND FULL IMAGE FETCH (for a given visible tile)
 **********************************************************/
async function ensureFullOnDemand(gx, gy) {
  const key = Cache.keyOf(gx, gy);
  const e = Cache.map.get(key);
  if (!e) return;
  if (e.fullReady || e.loadingFull) return;

  try {
    const r = await fetch(`/api/slots?x0=${gx}&y0=${gy}`);
    const j = await r.json();
    const row = Array.isArray(j.rows) ? j.rows[0] : j.rows;
    if (row?.originalUrl) {
      Cache.ensureFull({ key, fullUrl: row.originalUrl });
    }
  } catch (e) {
    console.warn('grid fetch: failed', e);
  }
}

/**********************************************************
 * RENDER
 **********************************************************/
function drawMinimap() {
  const mmW = minimap.width / dpr;
  const mmH = minimap.height / dpr;

  // clear + bg
  mmCtx.clearRect(0, 0, mmW, mmH);
  mmCtx.fillStyle = '#0b1220';
  mmCtx.fillRect(0, 0, mmW, mmH);

  // letterbox fit of full grid
  const sx = mmW / GRID.w;
  const sy = mmH / GRID.h;
  const s = Math.min(sx, sy);
  const offX = (mmW - GRID.w * s) / 2;
  const offY = (mmH - GRID.h * s) / 2;

  // faint grid lines every 100 tiles
  mmCtx.strokeStyle = 'rgba(255,255,255,0.06)';
  mmCtx.lineWidth = 1;
  for (let gx = 0; gx <= GRID.w; gx += 100) {
    const x = offX + gx * s;
    mmCtx.beginPath(); mmCtx.moveTo(x, offY); mmCtx.lineTo(x, offY + GRID.h * s); mmCtx.stroke();
  }
  for (let gy = 0; gy <= GRID.h; gy += 100) {
    const y = offY + gy * s;
    mmCtx.beginPath(); mmCtx.moveTo(offX, y); mmCtx.lineTo(offX + GRID.w * s, y); mmCtx.stroke();
  }

  // --- plot occupied tiles from cache ---
  // draw tiny 1x1 (or s-sized) rects for any tile with an image loaded
  mmCtx.fillStyle = 'rgba(255,255,255,0.75)';
  const PLOT_CAP = 25000; // simple throttle for very large caches
  let plotted = 0;
  const dotW = Math.max(1, Math.floor(s));
  const dotH = Math.max(1, Math.floor(s));

  for (const [key, e] of Cache.map) {
    if (plotted >= PLOT_CAP) break;
    if (!e.thumbReady && !e.fullReady) continue;

    const [tx, ty] = key.split(',').map(Number);
    if (tx < 0 || tx >= GRID.w || ty < 0 || ty >= GRID.h) continue;

    const x = Math.floor(offX + tx * s);
    const y = Math.floor(offY + ty * s);
    mmCtx.fillRect(x, y, dotW, dotH);
    plotted++;
  }

  // viewport rectangle
  const tilesWide = (canvas.width / dpr) / (GRID.slotSize * scale);
  const tilesHigh = (canvas.height / dpr) / (GRID.slotSize * scale);

  const vx = offX + origin.x * s;
  const vy = offY + origin.y * s;
  const vw = tilesWide * s;
  const vh = tilesHigh * s;

  mmCtx.fillStyle = 'rgba(59,130,246,0.15)';
  mmCtx.fillRect(vx, vy, vw, vh);
  mmCtx.strokeStyle = 'rgba(59,130,246,0.9)';
  mmCtx.lineWidth = 2;
  mmCtx.strokeRect(vx, vy, vw, vh);
}

function drawGrid() {
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  const tileCss = GRID.slotSize * scale;
  const cols = Math.ceil((canvas.width / dpr) / tileCss) + 2;
  const rows = Math.ceil((canvas.height / dpr) / tileCss) + 2;

  const x0 = Math.max(0, Math.floor(origin.x));
  const y0 = Math.max(0, Math.floor(origin.y));
  const x1 = Math.min(GRID.w - 1, x0 + cols);
  const y1 = Math.min(GRID.h - 1, y0 + rows);

  // draw grid lines only when sufficiently zoomed in
  if (scale >= GRID_LINE_VISIBILITY_THRESHOLD) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;

    for (let gx = x0; gx <= x1; gx++) {
      const sx = snapPx((gx - origin.x) * tileCss);
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, canvas.height / dpr); ctx.stroke();
    }
    for (let gy = y0; gy <= y1; gy++) {
      const sy = snapPx((gy - origin.y) * tileCss);
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(canvas.width / dpr, sy); ctx.stroke();
    }
  }

  const devPx = tileCss * dpr;
  const integerStep = Math.abs(Math.round(devPx) - devPx) < 0.001;
  ctx.imageSmoothingEnabled = !integerStep;
  ctx.imageSmoothingQuality = 'low';

  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const key = Cache.keyOf(gx, gy);
      const e = Cache.map.get(key);
      if (!e) continue;

      if (tileCss >= LOD_SWITCH_PX && !e.fullReady) {
        if (e.fullUrl) Cache.ensureFull({ key, fullUrl: e.fullUrl });
        else ensureFullOnDemand(gx, gy);
      }

      const px = snapPx((gx - origin.x) * tileCss);
      const py = snapPx((gy - origin.y) * tileCss);

      const img =
        (tileCss >= LOD_SWITCH_PX && e.fullReady && e.fullImg) ? e.fullImg :
        (e.thumbReady && e.thumbImg) ? e.thumbImg : null;

      if (img) {
        ctx.drawImage(img, px, py, tileCss, tileCss);
        Cache.touch(key);
      }
    }
  }

  if (highlightTile) {
    const sx = (highlightTile.x - origin.x) * tileCss;
    const sy = (highlightTile.y - origin.y) * tileCss;
    ctx.save();
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 3;
    ctx.strokeRect(sx, sy, tileCss, tileCss);
    ctx.restore();
  }
}

let mmDragging = false;

function mmClientToTile(e) {
  const rect = minimap.getBoundingClientRect();
  const xCss = e.clientX - rect.left;
  const yCss = e.clientY - rect.top;

  const mmW = rect.width, mmH = rect.height;
  const sx = mmW / GRID.w, sy = mmH / GRID.h, s = Math.min(sx, sy);
  const offX = (mmW - GRID.w * s) / 2;
  const offY = (mmH - GRID.h * s) / 2;

  const gx = Math.max(0, Math.min(GRID.w, (xCss - offX) / s));
  const gy = Math.max(0, Math.min(GRID.h, (yCss - offY) / s));
  return { gx, gy };
}

minimap.addEventListener('mousedown', (e) => { mmDragging = true; mmRecenterTo(e); });
window.addEventListener('mouseup', () => { mmDragging = false; });
minimap.addEventListener('mousemove', (e) => { if (mmDragging) mmRecenterTo(e); });
minimap.addEventListener('click', mmRecenterTo);

function mmRecenterTo(e) {
  const { gx, gy } = mmClientToTile(e);
  const tilesWide = (canvas.width / dpr) / (GRID.slotSize * scale);
  const tilesHigh = (canvas.height / dpr) / (GRID.slotSize * scale);
  origin.x = gx - tilesWide / 2;
  origin.y = gy - tilesHigh / 2;
  clampOrigin();
  requestDraw();
}

function requestDraw() {
  drawGrid();
  scheduleFetch();
  drawMinimap();
}

/**********************************************************
 * VIEWPORT FETCH (thumbs) — resilient + 429 backoff
 **********************************************************/
let fetchTimer = null;
let rateBackoffMs = 0;         // grows on 429, reset on success
const BASE_DELAY_MS = 120;     // your existing delay
const MAX_BACKOFF_MS = 5000;   // cap the backoff

function scheduleFetch(extraDelay = 0) {
  clearTimeout(fetchTimer);
  const delay = BASE_DELAY_MS + rateBackoffMs + extraDelay;
  fetchTimer = setTimeout(fetchViewport, delay);
}

async function fetchViewport() {
  try {
    const cols = Math.ceil((canvas.width / dpr) / (GRID.slotSize * scale)) + 2;
    const rows = Math.ceil((canvas.height / dpr) / (GRID.slotSize * scale)) + 2;

    const x0 = Math.max(0, Math.floor(origin.x));
    const y0 = Math.max(0, Math.floor(origin.y));
    const x1 = Math.min(GRID.w - 1, x0 + cols);
    const y1 = Math.min(GRID.h - 1, y0 + rows);

    // small prefetch halo
    const PREFETCH = 12;
    const px0 = Math.max(0, x0 - PREFETCH);
    const py0 = Math.max(0, y0 - PREFETCH);
    const px1 = Math.min(GRID.w - 1, x1 + PREFETCH);
    const py1 = Math.min(GRID.h - 1, y1 + PREFETCH);

    const url = `/api/grid?x0=${px0}&y0=${py0}&x1=${px1}&y1=${py1}`;
    const res = await fetch(url);

    // Handle rate limiting & HTTP errors gracefully
    if (!res.ok) {
      if (res.status === 429) {
        // exponential-ish backoff
        rateBackoffMs = Math.min(MAX_BACKOFF_MS, Math.max(250, rateBackoffMs * 2 || 250));
        console.warn('grid fetch rate-limited (429). Backing off', rateBackoffMs, 'ms');
        scheduleFetch();   // try again later
        return;
      } else {
        console.warn('grid fetch failed:', res.status);
        // small nudge, but don’t spiral
        scheduleFetch(300);
        return;
      }
    }

    // Try to parse JSON safely
    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.warn('grid fetch: invalid JSON', e);
      scheduleFetch(300);
      return;
    }

    const rowsArr = (data && Array.isArray(data.rows)) ? data.rows : [];
    // Defensive: if server responded without rows, just stop here
    if (rowsArr.length === 0) {
      // success -> reset backoff
      rateBackoffMs = 0;
      requestDraw();  // still redraw to keep UI snappy
      return;
    }

    rowsArr.forEach(row => {
      const key = Cache.keyOf(row.x, row.y);
      Cache.ensureThumb({ key, thumbUrl: row.thumbUrl });
    });

    // success -> reset backoff
    rateBackoffMs = 0;

    Cache.evictIfNeeded([x0, y0, x1, y1]);
    requestDraw();
  } catch (err) {
    // Network / unexpected errors
    console.error('fetchViewport error:', err);
    // brief retry but don’t explode
    scheduleFetch(500);
  }
}

/**********************************************************
 * FEED UI
 **********************************************************/
function prependFeed(row) {
  const li = document.createElement('li');
  li.dataset.x = row.x;
  li.dataset.y = row.y;
  li.className = 'feed-item';
  li.setAttribute('role', 'button');
  li.tabIndex = 0;
  li.style.cursor = 'pointer';
  li.innerHTML = `
    <div class="placeholder-img">
      <img src="${row.thumbUrl}" alt="thumb" style="width: 100%; height: 100%; object-fit: cover; border-radius: 12px;"/>
    </div>
    <div class="feed-item-content">
      <div class="feed-item-coords">(${row.x}, ${row.y})</div>
      <div class="feed-item-caption">${escapeHtml(row.caption || '(no caption)')}</div>
    </div>
  `;
  feedList.prepend(li);
  while (feedList.children.length > 50) feedList.removeChild(feedList.lastChild);
}

// Sidebar toggle event listeners
toggleFeedBtn.addEventListener('click', toggleSidebar);
mobileHeaderToggle.addEventListener('click', toggleSidebar);
sidebarCloseBtn.addEventListener('click', toggleSidebar);

feedBackdrop.addEventListener('click', () => {
  if (isMobile() && sidebarOpen) {
    toggleSidebar();
  }
});

feedList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const gx = Number(li.dataset.x);
  const gy = Number(li.dataset.y);
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;

  animateToTile(gx, gy, 500, 5);
  setHighlight(gx, gy, 2000);
  if (isMobile() && sidebarOpen) toggleSidebar();
});

/**********************************************************
 * INPUT: PANNING (pointer events only)
 **********************************************************/
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
  dragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  originStart = { ...origin };
});
canvas.addEventListener('pointerup', (e) => {
  canvas.releasePointerCapture(e.pointerId);
  dragging = false;
  canvas.style.cursor = 'crosshair';
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  const tilePx = GRID.slotSize * scale;
  origin.x = originStart.x - dx / tilePx;
  origin.y = originStart.y - dy / tilePx;
  clampOrigin();
  requestDraw();
});
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

/**********************************************************
 * INPUT: ZOOM (wheel event)
 **********************************************************/
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();

  const factor = e.deltaY < 0 ? 1.1 : 0.9;

  const minScale = getMinScale();               // <-- changed
  const mouseGX = origin.x + e.offsetX / (GRID.slotSize * scale);
  const mouseGY = origin.y + e.offsetY / (GRID.slotSize * scale);

  let next = scale * factor;
  next = Math.max(minScale, Math.min(50, next)); // <-- clamp against new floor

  origin.x = mouseGX - e.offsetX / (GRID.slotSize * next);
  origin.y = mouseGY - e.offsetY / (GRID.slotSize * next);

  clampOrigin();
  scale = next;
  requestDraw();
}, { passive: false });


/**********************************************************
 * MOBILE GESTURES: pinch-to-zoom + two-finger pan
 **********************************************************/
canvas.style.touchAction = 'none'; // ensure touch events reach us

let pointers = new Map();   // Map<pointerId, {x,y}>
let isPinching = false;
let pinchState = null;      // { startDist, startScale, centerGrid }

function canvasClientToLocal(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function getCentroid() {
  const pts = [...pointers.values()];
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

function getDistance() {
  const pts = [...pointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

function beginPinch() {
  isPinching = true;
  dragging = false; // disable single-finger drag while pinching

  const startDist = getDistance();
  const centerClient = getCentroid();
  const { x: cx, y: cy } = canvasClientToLocal(centerClient.x, centerClient.y);
  const centerGrid = screenToGrid(cx, cy);

  pinchState = {
    startDist,
    startScale: scale,
    centerGrid
  };
}

function updatePinch() {
  if (!isPinching || pointers.size < 2 || !pinchState) return;

  const dist = getDistance();
  const centerClient = getCentroid();
  const { x: cx, y: cy } = canvasClientToLocal(centerClient.x, centerClient.y);

  const min = getMinScale();
  let next = pinchState.startScale * (dist / pinchState.startDist);
  next = Math.max(min, Math.min(50, next));

  // Keep the pinch center's grid coord anchored under the same screen point.
  origin.x = pinchState.centerGrid.x - cx / (GRID.slotSize * next);
  origin.y = pinchState.centerGrid.y - cy / (GRID.slotSize * next);

  scale = next;
  clampOrigin();
  requestDraw();
}

function endPinch() {
  isPinching = false;
  pinchState = null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) beginPinch();
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (isPinching) updatePinch();
});

function removePointer(e) {
  if (e.pointerType !== 'touch') return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2 && isPinching) endPinch();
}
canvas.addEventListener('pointerup', removePointer);
canvas.addEventListener('pointercancel', removePointer);

// If the tab loses focus mid-gesture, tidy up
window.addEventListener('blur', () => {
  if (isPinching) endPinch();
  pointers.clear();
});

/**********************************************************
 * UPLOADS (random or target slot via dbl-click)
 **********************************************************/
function handleUploadClick() {
  pendingSlot = null;
  fileInput.value = '';
  fileInput.click();
}

uploadBtn.addEventListener('click', handleUploadClick);
mobileUploadBtn.addEventListener('click', handleUploadClick);

// Sync caption inputs
captionInput.addEventListener('input', (e) => {
  mobileCaptionInput.value = e.target.value;
});
mobileCaptionInput.addEventListener('input', (e) => {
  captionInput.value = e.target.value;
});

function screenToGrid(px, py) {
  return {
    x: origin.x + px / (GRID.slotSize * scale),
    y: origin.y + py / (GRID.slotSize * scale),
  };
}

function snapToTile(g) {
  const x = Math.floor(g.x);
  const y = Math.floor(g.y);
  return {
    x: Math.max(0, Math.min(GRID.w - 1, x)),
    y: Math.max(0, Math.min(GRID.h - 1, y)),
  };
}

canvas.addEventListener('dblclick', async (e) => {
  try {
    const g = screenToGrid(e.offsetX, e.offsetY);
    const { x, y } = snapToTile(g);
    if (x < 0 || x >= GRID.w || y < 0 || y >= GRID.h) return;

    const res = await fetch(`/api/slots?x0=${x}&y0=${y}`);
    if (!res.ok) {
      if (res.status === 429) {
        alert('You’re doing that a bit fast—please wait a moment and try again.');
        return;
      }
      console.warn('slots lookup failed:', res.status);
      alert('Could not verify slot. Please try again.');
      return;
    }
    const data = await res.json();
    const taken = Array.isArray(data.rows) ? data.rows.length > 0 : !!data.rows;
    if (taken) { alert(`Slot (${x}, ${y}) is already taken`); return; }

    if (!confirm(`Upload to slot (${x}, ${y})?`)) return;
    pendingSlot = { x, y };
    fileInput.value = '';
    fileInput.click();
  } catch (err) {
    console.error('dblclick handler error:', err);
    alert('Something went wrong. Please try again.');
  }
});

fileInput.addEventListener('change', async () => {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];

  const fd = new FormData();
  fd.append('image', file);
  const caption = captionInput.value || mobileCaptionInput.value;
  if (caption) fd.append('caption', caption);
  if (pendingSlot) {
    fd.append('x', String(pendingSlot.x));
    fd.append('y', String(pendingSlot.y));
  }

  try {
    statusEl.textContent = 'Uploading…';
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    statusEl.textContent = `Uploaded to (${data.slot.x}, ${data.slot.y})`;
    animateToTile(data.slot.x, data.slot.y, 500, 5);
    setHighlight(data.slot.x, data.slot.y, 2000);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    pendingSlot = null;
    // Clear both caption inputs
    captionInput.value = '';
    mobileCaptionInput.value = '';
    setTimeout(() => (statusEl.textContent = ''), 2500);
  }
});

/**********************************************************
 * DATA FETCH
 **********************************************************/
async function loadFeed() {
  const res = await fetch('/api/feed?limit=50');
  const data = await res.json();
  feedList.innerHTML = '';
  data.rows.forEach(prependFeed);
}

async function fetchConfig() {
  const res = await fetch('/api/config');
  GRID = (await res.json()).grid;
  loadFeed();
}

/**********************************************************
 * SOCKETS
 **********************************************************/
/* global io */
const socket = io();
socket.on('connect', () => console.log('socket connected', socket.id));
socket.on('connect_error', (err) => console.error('socket connect_error', err));

socket.on('new_image', (row) => {
  if (!row?.thumbUrl) return;
  const key = Cache.keyOf(row.x, row.y);

  Cache.ensureThumb({ key, thumbUrl: row.thumbUrl });
  Cache.ensureFull({ key, fullUrl: row.originalUrl || row.thumbUrl });

  prependFeed({
    x: row.x,
    y: row.y,
    caption: row.caption,
    createdAt: row.createdAt,
    thumbUrl: row.thumbUrl,
    originalUrl: row.originalUrl || row.thumbUrl
  });

  requestDraw();
});

/**********************************************************
 * INIT
 **********************************************************/
canvas.style.cursor = 'crosshair';

fetchConfig().then(() => {
  resize();
  applySidebarState();
  updateToggleText();
  requestDraw();
});
