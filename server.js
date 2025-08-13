import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { Server } from 'socket.io';
import http from 'http';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import crypto from 'crypto';
import mime from 'mime-types';
import 'dotenv/config';
import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import compression from 'compression';            // ★ NEW

/**********************************************************
 * APP + SOCKET
 **********************************************************/
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/**********************************************************
 * MIDDLEWARE (order matters)
 **********************************************************/
const ORIGIN_ALLOWLIST = [

  'http://localhost:8080',
  'https://omnaris.xyz',
];

const R2_DOMAIN = new URL(process.env.R2_CUSTOM_DOMAIN).host;

app.set('trust proxy', 1); // needed so req.ip honors X-Forwarded-For

// app.use(helmet({
//   crossOriginEmbedderPolicy: false, // we draw cross-origin images on canvas
//   contentSecurityPolicy: {
//     useDefaults: true,
//     directives: {
//       "default-src": ["'self'"],
//       "img-src": ["'self'", `https://${R2_DOMAIN}`, "data:"],
//       "script-src": ["'self'", "https://cdn.socket.io"],
//       "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
//       "connect-src": ["'self'", `https://${R2_DOMAIN}`],
//       "font-src": [
//         "'self'",
//         "https://fonts.gstatic.com",
//         "data:"
//       ],
//       "frame-ancestors": ["'none'"],
//       "object-src": ["'none'"],
//       "upgrade-insecure-requests": [],
//     }
//   },
//   referrerPolicy: { policy: "strict-origin-when-cross-origin" }
// }));

app.use(cors({ origin: ORIGIN_ALLOWLIST, credentials: false }));

app.use(compression({ threshold: 1024 }));       // ★ NEW (gzip/deflate/brotli if available)

app.use(express.json());
app.use(express.static('public', {                 // ★ was plain static; now with safe cache headers
  maxAge: '7d',
  immutable: true
}));

/**********************************************************
 * FILE LOGGING
 **********************************************************/
const LOG_DIR = path.resolve('logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const appLogPath = path.join(LOG_DIR, 'app.log');
const clientLogPath = path.join(LOG_DIR, 'client.log');

const appLogStream = fs.createWriteStream(appLogPath, { flags: 'a' });
const clientLogStream = fs.createWriteStream(clientLogPath, { flags: 'a' });

const ts = () => new Date().toISOString();
const writeLine = (s, l) => { try { s.write(l + '\n'); } catch {} };

function log(category, ...args) {
  const line = `[${ts()}] [${category}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(line);
  writeLine(appLogStream, line);
}
function logError(category, ...args) {
  const line = `[${ts()}] [${category}] ${args.map(a => a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.error(line);
  writeLine(appLogStream, line);
}
function logClient(obj) {
  const line = `[${ts()}] [client] ${JSON.stringify(obj)}`;
  console.log(line);
  writeLine(clientLogStream, line);
}

/**********************************************************
 * DB
 **********************************************************/
const DB_DIR = path.resolve('instance');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const dbPath = path.join(DB_DIR, 'grid.db');
const db = new Database(dbPath);

// PRAGMAs
db.pragma('page_size = 4096'); // only effective before schema exists
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');

const GRID_W = 1000;
const GRID_H = 1000;
const SLOT_SIZE = 40;
const THUMB_SIZE = 40;

db.exec(`
CREATE TABLE IF NOT EXISTS slots(
  id INTEGER PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  caption TEXT,
  created_at INTEGER NOT NULL,
  ip TEXT,
  thumb_key TEXT NOT NULL,
  orig_key TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_xy ON slots(x,y);
CREATE UNIQUE INDEX IF NOT EXISTS created_at_idx ON slots(created_at);
`);

log('boot', {
  haveAccountId: !!process.env.R2_ACCOUNT_ID,
  haveAccessKeyId: !!process.env.R2_ACCESS_KEY_ID,
  haveSecret: !!process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET
});

/**********************************************************
 * R2 / STORAGE
 **********************************************************/
export const r2Url = key => `${process.env.R2_CUSTOM_DOMAIN}/${encodeURIComponent(key)}`;

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

export async function putToR2({ key, bytes, contentType, cacheControl }) {
  const ct = contentType || mime.lookup(key) || 'application/octet-stream';
  const cc = cacheControl || 'public, max-age=31536000, immutable';
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: ct,
    CacheControl: cc
  }));
  return `${process.env.R2_PUBLIC_BASE}/${encodeURIComponent(key)}`;
}

// safe delete helper for orphan cleanup
export async function deleteFromR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  } catch {}
}

/**********************************************************
 * HELPERS
 **********************************************************/
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function pickRandomEmptySlot(db, W, H, tries = 8000) {
  const exists = db.prepare('SELECT 1 FROM slots WHERE x=? AND y=?').pluck();
  for (let i = 0; i < tries; i++) {
    const x = Math.floor(Math.random() * W);
    const y = Math.floor(Math.random() * H);
    if (!exists.get(x, y)) return { x, y };
  }
  return null;
}

// PATCH: safe DB call wrapper to always return []
function safeDbQuery(fn) {
  try {
    return fn();
  } catch (err) {
    logError('db', 'query failed', err);
    return [];
  }
}

function fetchSlots({ x0, y0, x1, y1, limit, minimal = false } = {}) {
  let rows = [];
  rows = safeDbQuery(() => {
    if (limit !== undefined) {
      return db.prepare(`
        SELECT x,y,thumb_key AS filename,orig_key AS original,caption,created_at AS createdAt
        FROM slots ORDER BY created_at ASC LIMIT ?
      `).all(limit);
    } else if (x1 !== undefined && y1 !== undefined) {
      return db.prepare(`
        SELECT x,y,thumb_key AS filename,orig_key AS original,caption,created_at AS createdAt
        FROM slots
        WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?
      `).all(x0, x1, y0, y1);
    } else {
      return db.prepare(`
        SELECT x,y,thumb_key AS filename,orig_key AS original,caption,created_at AS createdAt
        FROM slots
        WHERE x = ? AND y = ?
      `).all(x0, y0);
    }
  });

  return rows.map(row => {
    const base = { x: row.x, y: row.y, thumbUrl: r2Url(row.filename) };
    if (minimal) return base;
    return { ...base, originalUrl: r2Url(row.original), caption: row.caption, createdAt: row.createdAt };
  });
}

/**********************************************************
 * RATE LIMITERS
 **********************************************************/
const commonLimiterOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  skip: (req) => req.method === 'OPTIONS',
  handler: (req, res) => res.status(429).json({ error: 'Too Many Requests' }),
};

const gridLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 2000, max: 8 });
const slotsLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 2000, max: 12 });
const feedLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 10000, max: 30 });
const clientLogLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 60000, max: 60 });
const uploadBurstLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 60000, max: 3 });
const uploadHourlyLimiter = rateLimit({ ...commonLimiterOpts, windowMs: 60 * 60000, max: 20 });

function countUploadsSince({ ip, sinceMs }) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM slots WHERE ip = ? AND created_at >= ?`)
    .get(ip, Date.now() - sinceMs);
  return row?.n || 0;
}

/**********************************************************
 * ROUTES
 **********************************************************/
app.get('/api/config', (req, res) => {
  log('api', 'GET /api/config');
  res.json({ grid: { w: GRID_W, h: GRID_H, slotSize: SLOT_SIZE } });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images allowed'));
    }
    cb(null, true);
  }
});

app.post(
  '/api/upload',
  uploadBurstLimiter,
  uploadHourlyLimiter,
  upload.single('image'),
  async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');

    const DAILY_CAP = 100;
    const dailyCount = countUploadsSince({ ip, sinceMs: 24 * 60 * 60 * 1000 });
    if (dailyCount >= DAILY_CAP) {
      return res.status(429).json({ error: `Daily upload limit reached (${DAILY_CAP}/24h).` });
    }

    try {
      if (!req.file) {
        log('upload', 'no file');
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const mimeType = req.file.mimetype || '';
      if (!mimeType.startsWith('image/')) {
        log('upload', 'invalid mimetype', mimeType);
        return res.status(400).json({ error: 'Invalid file type' });
      }

      // DUPLICATE HASH CHECK (non-blocking)
      const hash = crypto.createHash('sha1').update(req.file.buffer).digest('hex');
      const existing = db.prepare('SELECT x,y FROM slots WHERE orig_key LIKE ?').get(`${hash}.orig.%`);
      // if (existing) return res.status(409).json({ error: `Duplicate image already at ${existing.x},${existing.y}` });

      const meta = await sharp(req.file.buffer).metadata();
      if ((meta.width || 0) > 4096 || (meta.height || 0) > 4096) {
        return res.status(400).json({ error: 'Image too large (max 4096px side)' });
      }

      let gx, gy;
      const { x, y, caption } = req.body;
      if (x !== undefined && y !== undefined) {
        gx = clamp(parseInt(x, 10), 0, GRID_W - 1);
        gy = clamp(parseInt(y, 10), 0, GRID_H - 1);
        const taken = db.prepare('SELECT 1 FROM slots WHERE x=? AND y=?').get(gx, gy);
        if (taken) return res.status(409).json({ error: 'Slot already taken' });
      } else {
        const spot = pickRandomEmptySlot(db, GRID_W, GRID_H);
        if (!spot) return res.status(503).json({ error: 'No free slots found' });
        gx = spot.x; gy = spot.y;
      }

      const ext = (mime.extension(mimeType) || 'bin').toLowerCase();
      const origKey = `${hash}.orig.${ext}`;
      const thumbKey = `${hash}.thumb.webp`;

      const thumbBuffer = await sharp(req.file.buffer)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
        .webp({ quality: 50 })
        .toBuffer();

      let origUrl, thumbUrl;
      try {
        [origUrl, thumbUrl] = await Promise.all([
          putToR2({ key: origKey, bytes: req.file.buffer, contentType: mimeType }),
          putToR2({ key: thumbKey, bytes: thumbBuffer, contentType: 'image/webp' })
        ]);
      } catch (err) {
        await deleteFromR2(origKey);
        await deleteFromR2(thumbKey);
        throw err;
      }

      const safeCaption = (caption ?? '').toString().slice(0, 120);
      const createdAt = Date.now();
      db.prepare(`
        INSERT INTO slots (x,y,caption,created_at,ip,thumb_key,orig_key)
        VALUES (?,?,?,?,?,?,?)
      `).run(gx, gy, safeCaption, createdAt, ip, thumbKey, origKey);

      const payload = { x: gx, y: gy, caption: safeCaption, createdAt, thumbUrl, originalUrl: origUrl };
      if (payload.x != null && payload.y != null) io.emit('new_image', payload);

      return res.json({ ok: true, slot: payload });

    } catch (err) {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 8MB)' });
      }
      logError('upload', 'error', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  }
);

app.get('/api/slots', slotsLimiter, (req, res) => {
  const x0 = clamp(parseInt(req.query.x0 ?? 0), 0, GRID_W - 1);
  const y0 = clamp(parseInt(req.query.y0 ?? 0), 0, GRID_H - 1);
  res.json({ rows: fetchSlots({ x0, y0 }) });
});

app.get('/api/grid', gridLimiter, (req, res) => {
  const x0 = clamp(parseInt(req.query.x0 ?? 0), 0, GRID_W - 1);
  const y0 = clamp(parseInt(req.query.y0 ?? 0), 0, GRID_H - 1);
  const x1 = clamp(parseInt(req.query.x1 ?? GRID_W - 1), 0, GRID_W - 1);
  const y1 = clamp(parseInt(req.query.y1 ?? GRID_H - 1), 0, GRID_H - 1);
  res.json({ rows: fetchSlots({ x0, y0, x1, y1, minimal: true }) });
});

app.get('/api/feed', feedLimiter, (req, res) => {
  const limit = clamp(parseInt(req.query.limit ?? 50), 1, 200);
  res.json({ rows: fetchSlots({ limit }) });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/log', clientLogLimiter, express.json({ limit: '256kb' }), (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const { ts: clientTs, page, ua, lang, screen, events } = req.body || {};
    logClient({ ip, clientTs, page, ua, lang, screen });
    for (const ev of (events || [])) logClient({ ip, ev });
    res.json({ ok: true });
  } catch (e) {
    logError('client-log', 'ingest error', e);
    res.status(400).json({ ok: false });
  }
});

/**********************************************************
 * SOCKET EVENTS
 **********************************************************/
io.on('connection', (socket) => {
  log('socket', 'client connected', { id: socket.id, ip: socket.handshake.address });
  socket.on('disconnect', (reason) => {
    log('socket', 'client disconnected', { id: socket.id, reason });
  });
});

/**********************************************************
 * SERVER TIMEOUTS (★ NEW)
 **********************************************************/
server.setTimeout(10_000);        // socket inactivity
server.headersTimeout = 11_000;   // header parse timeout
server.requestTimeout = 12_000;   // whole request lifetime

/**********************************************************
 * START
 **********************************************************/
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  log('boot', `One Million Images: http://localhost:${PORT}`);
  log('boot', `Grid: ${GRID_W} x ${GRID_H}`);
});
/**********************************************************
 * GRACEFUL SHUTDOWN (★ NEW)
 **********************************************************/
function shutdown(sig) {
  console.log(`[shutdown] ${sig}`);
  // stop accepting new connections
  server.close(() => {
    try { io.close(); } catch {}
    try { db.close(); } catch {}
    try { appLogStream.end(); } catch {}
    try { clientLogStream.end(); } catch {}
    process.exit(0);
  });
  // hard-exit if something hangs
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));