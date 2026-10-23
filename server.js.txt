// NEXCART backend — one file, plus an optional database.
// Render runs it with:  node server.js
//
// Env: ADMIN_KEY        (owner secret — the value the admin panel asks for)
//      DATABASE_URL     (optional. Neon / Supabase / Render Postgres. Without
//                        it data.json is used, and any restart wipes the shop)
//      DATA_DIR         (where data.json lives when there is no database)
//      GOOGLE_CLIENT_ID (optional — needed only for "Continue with Google")
//      PGSSL=off        (only for a local database that has no certificate)
//
// ---------------------------------------------------------------------------
// WHAT THIS VERSION FIXES  (v1.2.0)
//
// 1. THE "Failed to fetch" BUG.  The previous file capped EVERY request at
//    200 KB and destroyed the connection above it. The catalogue push carries
//    the product photos, and each photo is about 120 KB, so from the second
//    product onwards the upload never fitted — the socket was killed and the
//    browser could only report "Failed to fetch". Catalogue uploads are now
//    allowed up to 12 MB, and an over-sized body gets a proper 413 JSON reply
//    instead of a dead socket, so the app can show a real message.
//
// 2. Shop settings travel again. The admin PIN, delivery days, return window
//    and shipping rules are stored and handed back in /api/bootstrap, which
//    is where the app reads them from. The version stamp
//    (catalogUpdatedAt) is stored and returned too.
//
// 3. An upload is only called successful once the database write has actually
//    finished. If the database refuses it, the app is told — instead of
//    believing the shop is safely stored when it is not.
//
// 4. /api/health says where the data really lives ("postgres" or "file"), so
//    the database connection can be verified with one tap.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v1.4.0 — WEB PUSH NOTIFICATIONS (offers from admin, order updates, new-order alerts)
// ---------------------------------------------------------------------------
// v1.3.0 — LIVE SYNC + MEDIA
//   * db.rev goes up on every admin push. GET /api/version is a tiny check and
//     GET /api/stream is a Server-Sent-Events feed that tells every open app
//     the moment the owner publishes, so customers see changes in seconds.
//   * /api/bootstrap?rev=N answers {unchanged:true} when nothing moved, also
//     carries `home` (the home-screen layout) and is gzip-compressed.
//   * Product photos, banner pictures and videos are uploaded once to
//     POST /api/admin/media and served from /media/<id>.<ext> (cached, with
//     Range support for video), instead of riding inside the catalogue JSON.
// ---------------------------------------------------------------------------
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


/* ===========================================================================
   WEB PUSH  (v1.4.0) — notifications that reach a customer's phone even when
   the app is closed. Built on Node's own crypto: no extra package to install.
   VAPID keys are generated once and kept in the database (or taken from the
   VAPID_PUBLIC / VAPID_PRIVATE env vars if you prefer to set them yourself).
   =========================================================================== */
const https = require('https');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(String(str || ''), 'base64url');

function pushKeys() {
  db.vapid = db.vapid || null;
  if (process.env.VAPID_PRIVATE && process.env.VAPID_PUBLIC) {
    return { pub: process.env.VAPID_PUBLIC.trim(), priv: process.env.VAPID_PRIVATE.trim() };
  }
  if (!db.vapid || !db.vapid.pub || !db.vapid.priv) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = kp.privateKey.export({ format: 'jwk' });
    db.vapid = { pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)])), priv: j.d };
    save();
  }
  return db.vapid;
}
function vapidJwt(audience) {
  const k = pushKeys();
  const pubBuf = unb64u(k.pub);
  const keyObj = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: k.priv, x: b64u(pubBuf.subarray(1, 33)), y: b64u(pubBuf.subarray(33, 65)) },
    format: 'jwk'
  });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
                                     sub: 'mailto:' + (process.env.VAPID_SUBJECT || 'admin@nexcart.app') }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}
/* RFC 8291 "aes128gcm" encryption of the payload for one subscriber */
function pushEncrypt(sub, payload) {
  const uaPub = unb64u(sub.keys && sub.keys.p256dh), auth = unb64u(sub.keys && sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const hk = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
  const ikm = hk(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
/* resolves {ok, gone} — gone=true means the phone unsubscribed, drop it */
function pushOne(sub, payloadObj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(sub.endpoint); } catch (e) { return resolve({ ok: false, gone: true }); }
    if (u.protocol !== 'https:') return resolve({ ok: false, gone: true });
    let body;
    try { body = pushEncrypt(sub, JSON.stringify(payloadObj)); } catch (e) { return resolve({ ok: false, gone: true }); }
    let jwt; try { jwt = vapidJwt(u.origin); } catch (e) { return resolve({ ok: false, gone: false }); }
    const r = https.request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout: 15000,
      headers: {
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        TTL: '86400', Urgency: 'high',
        Authorization: 'vapid t=' + jwt + ', k=' + pushKeys().pub
      }
    }, (resp) => {
      resp.resume();
      resp.on('end', () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300,
                                      gone: resp.statusCode === 404 || resp.statusCode === 410 }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, gone: false }); });
    r.on('error', () => resolve({ ok: false, gone: false }));
    r.end(body);
  });
}
async function pushTo(subs, payloadObj) {
  let sent = 0, failed = 0; const dead = new Set();
  for (let i = 0; i < subs.length; i += 20) {
    const res = await Promise.all(subs.slice(i, i + 20).map((s) => pushOne(s, payloadObj)));
    res.forEach((r, k) => { if (r.ok) sent++; else { failed++; if (r.gone) dead.add(subs[i + k].endpoint); } });
  }
  if (dead.size) { db.pushSubs = (db.pushSubs || []).filter((s) => !dead.has(s.endpoint)); save(); }
  return { sent, failed };
}
function pushNotify(filter, payloadObj) {
  const subs = (db.pushSubs || []).filter(filter);
  if (!subs.length) return Promise.resolve({ sent: 0, failed: 0 });
  return pushTo(subs, payloadObj).catch(() => ({ sent: 0, failed: 0 }));
}
const ORDER_MSG = {
  'Placed': ['Order placed', 'We have received your order. Thank you for shopping with us!'],
  'Confirmed': ['Order confirmed', 'Your order is confirmed and is being prepared.'],
  'Packed': ['Order packed', 'Your order is packed and ready to ship.'],
  'Shipped': ['Order shipped', 'Your order is on its way.'],
  'Out for Delivery': ['Out for delivery', 'Your order will reach you today.'],
  'Delivered': ['Order delivered', 'Your order has been delivered. Enjoy!'],
  'Cancelled': ['Order cancelled', 'Your order has been cancelled.']
};

const PORT = process.env.PORT || 3000;
const KEY = process.env.ADMIN_KEY || 'changeme';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/* Request size limits. A catalogue carries the photos, so it needs room;
   everything a customer can post stays small. */
const BODY_PUBLIC = 200000;      // ~200 KB — orders, sign-up, sign-in
const BODY_ADMIN = 24000000;     // ~24 MB — catalogue, photos, logo and splash
const BODY_MEDIA = 40000000;     // ~40 MB — one photo or video as a data URL
const MEDIA_DIR = path.join(process.env.DATA_DIR || __dirname, 'media');
const MEDIA_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov'
};
const MEDIA_MAX_IMG = 8 * 1024 * 1024;
const MEDIA_MAX_VID = 30 * 1024 * 1024;
const MAX_STREAMS = 5000;

let db = { products: [], categories: [], orders: [], users: [],
           sessions: [], fails: {}, settings: {}, updatedAt: 0, catalogUpdatedAt: 0,
           rev: 0, home: null };

/* ---------------- storage ---------------- */

let pool = null;
let storage = 'file';

if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Neon and Render Postgres both require TLS. Set PGSSL=off for a local
      // database that has no certificate.
      ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
    pool.on('error', (e) => console.error('[storage] idle connection error:', e.message));
    storage = 'postgres';
  } catch (e) {
    console.error('[storage] pg module unavailable — using data.json:', e.message);
    pool = null;
  }
}

/* One row holds the whole state object, so every other line of this file stays
   exactly as it was. */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS nexcart_state (
  id integer PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

let writeChain = Promise.resolve();
let saveErrorLogged = false;

/* Saves are chained, never parallel, so two requests can never interleave a
   half-written state. The local file is still written too — it costs nothing
   and it is what keeps this process usable if the database blips.

   queueSave() hands back a promise, so a route can wait for the database
   before telling the owner the upload worked. save() is the fire-and-forget
   form used everywhere else. */
function queueSave() {
  try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {}
  if (!pool) return Promise.resolve();
  const snapshot = JSON.stringify(db);
  const p = writeChain.then(() => pool.query(
    `INSERT INTO nexcart_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [snapshot]
  ));
  // The chain must survive a failure, or one bad write blocks every later one.
  writeChain = p.catch(() => {});
  return p;
}
const save = () => {
  queueSave()
    .then(() => { saveErrorLogged = false; })
    .catch((e) => {
      if (!saveErrorLogged) {
        console.error('[storage] save failed:', e.message);
        saveErrorLogged = true;
      }
    });
};

const rnd = (n) => crypto.randomBytes(n).toString('hex');
const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
/* Normalise a mobile number to its last 10 digits, so "+91 98765 43210",
   "098765 43210" and "9876543210" are all treated as the same account.
   Without this, a customer who types +91 gets "wrong password". */
const digits = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

function hashPass(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function sameSecret(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || '',
           provider: u.provider, createdAt: u.createdAt || 0 };
}

/* Remember a customer, however they reached the shop: a device that reports its
   saved profile, an account created here, or a plain order. Matches on the
   phone number first, then the email, so the same person is never listed twice.
   Password material is never stored by this path. */
/* The same person can reach the shop twice: once with a phone number and once
   with a Google email. Merge those two records into one, keeping the older id
   and moving any orders and sessions across, so the owner's list shows a person
   once — not two half-filled rows. */
function mergeCustomer(keep, drop) {
  if (!keep || !drop || keep === drop) return keep;
  if (!keep.phone && drop.phone) keep.phone = drop.phone;
  if (!keep.email && drop.email) keep.email = drop.email;
  if ((!keep.name || keep.name === 'Customer') && drop.name) keep.name = drop.name;
  const a = keep.createdAt || Date.now(), b2 = drop.createdAt || Date.now();
  keep.createdAt = Math.min(a, b2);
  (db.orders || []).forEach((o) => { if (o.userId === drop.id) o.userId = keep.id; });
  (db.sessions || []).forEach((x) => { if (x.userId === drop.id) x.userId = keep.id; });
  db.users = db.users.filter((u) => u !== drop);
  return keep;
}

/* Housekeeping: collapse any records that share a phone number or an email.
   Runs on its own, so duplicates created by older builds disappear as soon as
   the owner opens the Customers page. */
function dedupeUsers() {
  db.users = db.users || [];
  let merged = 0;
  let again = true;
  while (again) {
    again = false;
    for (let i = 0; i < db.users.length && !again; i++) {
      for (let j = i + 1; j < db.users.length; j++) {
        const a = db.users[i], b2 = db.users[j];
        if (!a || !b2) continue;
        const samePhone = a.phone && b2.phone && a.phone === b2.phone;
        const sameEmail = a.email && b2.email &&
                          String(a.email).toLowerCase() === String(b2.email).toLowerCase();
        if (samePhone || sameEmail) {
          const keep = (a.createdAt || 0) <= (b2.createdAt || 0) ? a : b2;
          mergeCustomer(keep, keep === a ? b2 : a);   /* removes the other row */
          merged++;
          again = true;   /* the list changed — scan it again from the top */
          break;
        }
      }
    }
  }
  if (merged) save();
  return merged;
}

function recordCustomer(info) {
  const name = String((info && info.name) || '').trim().slice(0, 80);
  const phone = digits((info && info.phone) || '');
  const email = String((info && info.email) || '').trim().toLowerCase().slice(0, 200);
  if (!phone && !email) return null;
  db.users = db.users || [];
  const byPhone = phone.length === 10 ? db.users.find((u) => u.phone === phone) : null;
  const byEmail = email ? db.users.find((u) => (u.email || '').toLowerCase() === email) : null;
  let user = byPhone || byEmail || null;
  if (byPhone && byEmail && byPhone !== byEmail) {
    const keep = (byPhone.createdAt || 0) <= (byEmail.createdAt || 0) ? byPhone : byEmail;
    user = mergeCustomer(keep, keep === byPhone ? byEmail : byPhone);
  }
  if (!user) {
    user = { id: newId('USR'), name: name || 'Customer',
             phone: phone.length === 10 ? phone : '', email,
             provider: String((info && info.provider) || 'app').slice(0, 20),
             createdAt: Date.now() };
    db.users.push(user);
  } else {
    if (name && (!user.name || user.name === 'Customer')) user.name = name;
    if (phone.length === 10 && !user.phone) user.phone = phone;
    if (email && !user.email) user.email = email;
    if (!user.createdAt) user.createdAt = Date.now();
  }
  save();
  return user;
}
function issueToken(user) {
  const token = rnd(32);
  db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 864e5 });
  db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now()).slice(-500);
  save();
  return token;
}
function userFromReq(req) {
  const h = String(req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const s = db.sessions.find((x) => x.token === token && x.expiresAt > Date.now());
  return s ? db.users.find((u) => u.id === s.userId) || null : null;
}
function send(res, code, body) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
  };
  let out = JSON.stringify(body);
  const req = res.__req;
  const ae = req ? String(req.headers['accept-encoding'] || '') : '';
  headers['Vary'] = 'Accept-Encoding';
  if (code !== 204 && out.length > 1024 && /\bgzip\b/.test(ae)) {
    try {
      out = zlib.gzipSync(Buffer.from(out), { level: 6 });
      headers['Content-Encoding'] = 'gzip';
    } catch (e) {}
  }
  headers['Content-Length'] = Buffer.byteLength(out);
  res.writeHead(code, headers);
  res.end(code === 204 ? undefined : out);
}

/* ---------------- live stream (Server-Sent Events) ---------------- */
const streams = new Set();
function broadcastRev() {
  const msg = 'event: rev\ndata: ' + JSON.stringify({ rev: db.rev }) + '\n\n';
  streams.forEach((r) => { try { r.write(msg); } catch (e) { streams.delete(r); } });
}
setInterval(() => {
  streams.forEach((r) => { try { r.write(': ping\n\n'); } catch (e) { streams.delete(r); } });
}, 20000).unref();

/* ---------------- media storage ---------------- */
const mediaCache = new Map();          // id -> { mime, data }, insertion order = LRU
let mediaCacheBytes = 0;
const MEDIA_CACHE_MAX = 40 * 1024 * 1024;
function cachePut(id, mime, data) {
  if (data.length > MEDIA_CACHE_MAX / 2) return;
  if (mediaCache.has(id)) { mediaCacheBytes -= mediaCache.get(id).data.length; mediaCache.delete(id); }
  mediaCache.set(id, { mime, data });
  mediaCacheBytes += data.length;
  while (mediaCacheBytes > MEDIA_CACHE_MAX && mediaCache.size) {
    const k = mediaCache.keys().next().value;
    mediaCacheBytes -= mediaCache.get(k).data.length;
    mediaCache.delete(k);
  }
}
function cacheGet(id) {
  const v = mediaCache.get(id);
  if (v) { mediaCache.delete(id); mediaCache.set(id, v); }
  return v || null;
}
async function mediaSave(id, mime, data) {
  if (pool) {
    await pool.query(
      `INSERT INTO nc_media (id, mime, data, created) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, mime, data, Date.now()]);
  } else {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_DIR, id), data);
    fs.writeFileSync(path.join(MEDIA_DIR, id + '.mime'), mime);
  }
  cachePut(id, mime, data);
}
async function mediaLoad(id) {
  const hit = cacheGet(id);
  if (hit) return hit;
  let rec = null;
  if (pool) {
    const r = await pool.query('SELECT mime, data FROM nc_media WHERE id = $1', [id]);
    if (r.rows.length) rec = { mime: r.rows[0].mime, data: r.rows[0].data };
  } else {
    try {
      rec = { data: fs.readFileSync(path.join(MEDIA_DIR, id)),
              mime: fs.readFileSync(path.join(MEDIA_DIR, id + '.mime'), 'utf8') };
    } catch (e) { rec = null; }
  }
  if (rec) cachePut(id, rec.mime, rec.data);
  return rec;
}
async function mediaStats() {
  if (pool) {
    const r = await pool.query('SELECT count(*)::int AS c, coalesce(sum(length(data)),0)::bigint AS b FROM nc_media');
    return { count: r.rows[0].c, bytes: Number(r.rows[0].b) };
  }
  let count = 0, bytes = 0;
  try {
    fs.readdirSync(MEDIA_DIR).forEach((n) => {
      if (n.endsWith('.mime')) return;
      count++; bytes += fs.statSync(path.join(MEDIA_DIR, n)).size;
    });
  } catch (e) {}
  return { count, bytes };
}
function serveMedia(req, res, rec, id) {
  const base = {
    'Content-Type': rec.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': '"' + id + '"',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  };
  if (String(req.headers['if-none-match'] || '').indexOf(id) !== -1) {
    res.writeHead(304, base); return res.end();
  }
  const total = rec.data.length;
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers['range'] || ''));
  if (rg && (rg[1] !== '' || rg[2] !== '')) {
    let start, end;
    if (rg[1] === '') { start = Math.max(0, total - parseInt(rg[2], 10)); end = total - 1; }
    else { start = parseInt(rg[1], 10); end = rg[2] === '' ? total - 1 : Math.min(parseInt(rg[2], 10), total - 1); }
    if (start >= total || start > end) {
      res.writeHead(416, Object.assign({}, base, { 'Content-Range': 'bytes */' + total }));
      return res.end();
    }
    res.writeHead(206, Object.assign({}, base, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': end - start + 1 }));
    return res.end(rec.data.subarray(start, end + 1));
  }
  res.writeHead(200, Object.assign({}, base, { 'Content-Length': total }));
  res.end(req.method === 'HEAD' ? undefined : rec.data);
}
/* Reads a JSON body. Above the cap the bytes are drained but not kept, and the
   caller gets { __tooBig: true } so it can answer 413 with a readable message.
   (The old version called req.destroy(), which the browser can only report as
   "Failed to fetch" — with no hint of what went wrong.) */
function readBody(req, limit) {
  const cap = limit || BODY_PUBLIC;
  return new Promise((done) => {
    let s = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      if (s.length + c.length > cap) { tooBig = true; s = ''; return; }
      s += c;
    });
    req.on('end', () => {
      if (tooBig) return done({ __tooBig: true });
      try { done(JSON.parse(s || '{}')); } catch (e) { done({}); }
    });
    req.on('error', () => done({}));
  });
}
/* v55: a key that nobody chose is not a key.
   This used to default to the literal 'changeme', so a deployment that forgot to
   set ADMIN_KEY had its admin API protected by a password printed in the source.
   Now a missing or default key fails CLOSED: every admin route refuses, with a
   message that says exactly what to fix, instead of quietly trusting everyone.

   The comparison is also timing-safe now. Node's crypto is already imported, and
   === leaks how many characters matched. */
const KEY_IS_DEFAULT = !process.env.ADMIN_KEY || process.env.ADMIN_KEY === 'changeme';
const isAdmin = (req) => {
  if (KEY_IS_DEFAULT) return false;
  const given = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  if (a.length !== b.length) return false;      // lengths differ: not our key
  return crypto.timingSafeEqual(a, b);
};

/* Verify a Google ID token without any library: check the RS256 signature
   against Google's published keys, then the audience and issuer. */
async function verifyGoogleToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed Google token');
  const [h, p, sig] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const certs = await fetch('https://www.googleapis.com/oauth2/v3/certs').then((r) => r.json());
  const jwk = (certs.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown Google signing key');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), pub, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Bad Google signature');
  if (!GOOGLE_CLIENT_ID || payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Wrong audience');
  if (!/^(https:\/\/)?accounts\.google\.com$/.test(payload.iss)) throw new Error('Wrong issuer');
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('Google token expired');
  if (!payload.email) throw new Error('No email in Google token');
  return payload;
}

/* ---------------- boot ----------------
   The database wins if it holds a state object; otherwise whatever is in
   data.json is adopted, and pushed up so the next boot finds it there. */
async function init() {
  let fromDb = null;
  let dbOk = false;
  if (pool) {
    try {
      await pool.query(CREATE_TABLE);
      await pool.query(`CREATE TABLE IF NOT EXISTS nc_media (
        id text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL, created bigint NOT NULL)`);
      const r = await pool.query('SELECT data FROM nexcart_state WHERE id = 1');
      dbOk = true;
      if (r.rows.length && r.rows[0].data && typeof r.rows[0].data === 'object') {
        fromDb = r.rows[0].data;
      }
    } catch (e) {
      console.error('[storage] could not read postgres, falling back to data.json:', e.message);
    }
  }

  if (fromDb) {
    db = Object.assign(db, fromDb);
    storage = 'postgres';
    console.log('[storage] loaded from postgres — ' + (db.products || []).length + ' products, ' +
                (db.orders || []).length + ' orders');
  } else {
    try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
    if (pool && dbOk) {
      storage = 'postgres';
      console.log('[storage] postgres is empty — seeding it from data.json');
    } else if (pool) {
      // Keep the shop running on the file, but say so plainly: /api/health
      // must never claim the database is holding data when it is not.
      storage = 'file (database unreachable)';
      console.log('[storage] postgres unreachable — running on data.json only');
    } else {
      storage = 'file';
      console.log('[storage] no database configured — using data.json');
    }
  }

  db.products = db.products || [];
  db.categories = db.categories || [];
  db.orders = db.orders || [];
  db.users = db.users || [];
  db.pushSubs = db.pushSubs || [];
  db.notifs = db.notifs || [];
  db.sessions = db.sessions || [];
  db.fails = db.fails || {};
  db.settings = db.settings || {};
  db.banners = db.banners || [];
  db.announcements = db.announcements || [];
  db.coupons = db.coupons || [];
  if (!db.branding || typeof db.branding !== 'object') db.branding = null;
  db.updatedAt = Number(db.updatedAt) || 0;
  db.catalogUpdatedAt = Number(db.catalogUpdatedAt) || 0;
  db.rev = Number(db.rev) || 0;
  if (!db.home || typeof db.home !== 'object' || Array.isArray(db.home)) db.home = null;

  // The database is empty but this install had data on disk (or this is a
  // brand-new database): seed it, and wait, so the very first upload cannot be
  // reported as saved before the row exists.
  if (pool && !fromDb) await queueSave().catch((e) => console.error('[storage] seed failed:', e.message));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.__req = req;
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (p === '/api/health')
    return send(res, 200, { ok: true, products: db.products.length, orders: db.orders.length,
                            users: db.users.length, storage: storage, rev: db.rev });

  /* ---- live sync ---- */
  if (p === '/api/version')
    return send(res, 200, { rev: db.rev, t: Date.now() });

  if (p === '/api/stream' && req.method === 'GET') {
    if (streams.size >= MAX_STREAMS) return send(res, 503, { error: 'Too many live connections' });
    try { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); } catch (e) {}
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    res.write('event: rev\ndata: ' + JSON.stringify({ rev: db.rev }) + '\n\n');
    streams.add(res);
    const drop = () => streams.delete(res);
    req.on('close', drop); req.on('error', drop); res.on('error', drop); res.on('close', drop);
    return;
  }

  /* ---- media ---- */
  if (p === '/api/admin/media' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req, BODY_MEDIA);
    if (b.__tooBig) return send(res, 413, { error: 'File too large (over 40 MB)' });
    const mm = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\s]+)$/i.exec(String(b.dataUrl || ''));
    if (!mm) return send(res, 400, { error: 'Send {dataUrl:"data:<type>;base64,..."}' });
    const mime = mm[1].toLowerCase();
    const ext = MEDIA_TYPES[mime];
    if (!ext) return send(res, 415, { error: 'Unsupported file type ' + mime });
    const data = Buffer.from(mm[2].replace(/\s+/g, ''), 'base64');
    if (!data.length) return send(res, 400, { error: 'Empty file' });
    const cap = mime.startsWith('video/') ? MEDIA_MAX_VID : MEDIA_MAX_IMG;
    if (data.length > cap)
      return send(res, 413, { error: (mime.startsWith('video/') ? 'Video' : 'Image') + ' too large (max ' + (cap >> 20) + ' MB)' });
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
    try { await mediaSave(id, mime, data); }
    catch (e) { return send(res, 500, { error: 'Could not store the file: ' + e.message }); }
    return send(res, 200, { ok: true, id, url: '/media/' + id + '.' + ext, mime, size: data.length });
  }
  if (p === '/api/admin/media-stats' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    try { return send(res, 200, await mediaStats()); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  const mt = p.match(/^\/media\/([a-f0-9]{24})(?:\.[a-z0-9]{2,5})?$/);
  if (mt && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const rec = await mediaLoad(mt[1]);
      if (!rec) return send(res, 404, { error: 'Not found' });
      return serveMedia(req, res, rec, mt[1]);
    } catch (e) { return send(res, 500, { error: 'Could not read the file' }); }
  }

  /* Everything a phone needs in order to show the same shop the owner sees:
     the catalogue, the categories, and the whole admin-panel configuration —
     branding (name, logo, opening screen), offer banners, the announcement
     ticker, coupon codes and the shop rules. */
  if (p === '/api/bootstrap' && db.rev > 0 && String(url.searchParams.get('rev') || '') === String(db.rev))
    return send(res, 200, { unchanged: true, rev: db.rev });
  if (p === '/api/bootstrap')
    return send(res, 200, {
      rev: db.rev,
      home: db.home || null,
      products: db.products,
      categories: db.categories,
      /* v55: the admin PIN is NO LONGER sent to customers.
         This endpoint has no login. Every phone that installed the app fetched
         it, so the owner's admin PIN was readable by anyone - it was in the
         network response of the shop itself. The PIN was never a server-side
         control anyway (the server checks ADMIN_KEY); it is only the gate in
         front of the admin panel ON THE OWNER'S OWN PHONE. So the correct place
         for it is that phone, and it is now kept there and nowhere else.
         The app already refuses to adopt a PIN that is not 4-10 digits, so an
         owner who set their own PIN keeps it, and a fresh install falls back to
         the documented default. Nothing else about settings changes. */
      settings: (function () {
        const safe = Object.assign({}, db.settings || {});
        delete safe.adminPin;
        return safe;
      })(),
      branding: db.branding || null,
      banners: db.banners || [],
      announcements: db.announcements || [],
      coupons: db.coupons || [],
      updatedAt: db.updatedAt,
      catalogUpdatedAt: Number(db.catalogUpdatedAt) || Number(db.updatedAt) || 0
    });

  /* Lets the app switch the Google button on by itself once the owner adds
     GOOGLE_CLIENT_ID in Render — no need to edit the app file again. */
  if (p === '/api/config')
    return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID, accounts: true });

  /* ---------------- accounts ---------------- */

  /* A customer's phone reports the profile it has saved locally. Older builds
     kept accounts on the device only, so those people never reached the server
     and the owner's Customers page stayed empty. Safe to call on every launch:
     the same person is matched and updated, never duplicated. */
  if (p === '/api/customer/sync' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const user = recordCustomer(b);
    if (!user) return send(res, 400, { error: 'A name, phone or email is required' });
    return send(res, 200, { ok: true, user: publicUser(user) });
  }

  if (p === '/api/auth/signup' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const name = String(b.name || '').trim();
    const phone = digits(b.phone);
    const password = String(b.password || '');
    if (name.length < 2) return send(res, 400, { error: 'Please enter your name' });
    if (phone.length !== 10) return send(res, 400, { error: 'Enter a 10-digit mobile number' });
    if (password.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
    if (db.users.find((u) => u.phone === phone))
      return send(res, 409, { error: 'This number already has an account. Please log in.' });
    const salt = rnd(16);
    const user = {
      id: newId('USR'), name, phone, email: '', provider: 'password',
      salt, passHash: hashPass(password, salt), createdAt: Date.now()
    };
    db.users.push(user);
    save();
    return send(res, 201, { ok: true, token: issueToken(user), user: publicUser(user) });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const phone = digits(b.phone);
    const password = String(b.password || '');
    const f = db.fails[phone] || { n: 0, until: 0 };
    if (f.until > Date.now())
      return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const user = db.users.find((u) => u.phone === phone);
    if (!user || user.provider !== 'password' || !sameSecret(hashPass(password, user.salt), user.passHash)) {
      f.n = (f.n || 0) + 1;
      if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
      db.fails[phone] = f;
      save();
      return send(res, 401, { error: 'Wrong mobile number or password' });
    }
    db.fails[phone] = { n: 0, until: 0 };
    save();
    return send(res, 200, { ok: true, token: issueToken(user), user: publicUser(user) });
  }

  if (p === '/api/auth/google' && req.method === 'POST') {
    if (!GOOGLE_CLIENT_ID) return send(res, 503, { error: 'Google sign-in is not configured yet' });
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    let payload;
    try { payload = await verifyGoogleToken(b.credential); }
    catch (e) { return send(res, 401, { error: 'Google sign-in failed: ' + e.message }); }
    const email = String(payload.email).toLowerCase();
    let user = db.users.find((u) => (u.email || '').toLowerCase() === email);
    if (!user) {
      user = { id: newId('USR'), name: payload.name || email.split('@')[0], phone: '',
               email, provider: 'google', googleSub: payload.sub, createdAt: Date.now() };
      db.users.push(user);
    }
    save();
    return send(res, 200, { ok: true, token: issueToken(user), user: publicUser(user),
                            needsPhone: !user.phone });
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const u = userFromReq(req);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, { ok: true, user: publicUser(u) });
  }

  if (p === '/api/auth/phone' && req.method === 'POST') {
    const u = userFromReq(req);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const phone = digits(b.phone);
    if (phone.length !== 10) return send(res, 400, { error: 'Enter a 10-digit mobile number' });
    const clash = db.users.find((x) => x.phone === phone && x.id !== u.id);
    if (clash) return send(res, 409, { error: 'That number is already used by another account' });
    u.phone = phone;
    save();
    return send(res, 200, { ok: true, user: publicUser(u) });
  }

  /* In-app account deletion (Google Play requires this). Removes the account,
     its sessions and push subscriptions. Order records are kept for tax and
     accounting, but the personal details on them are wiped. */
  if (p === '/api/auth/delete' && req.method === 'POST') {
    const u = userFromReq(req);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    db.users = db.users.filter((x) => x.id !== u.id);
    db.sessions = db.sessions.filter((x) => x.userId !== u.id);
    db.pushSubs = (db.pushSubs || []).filter((x) => x.userId !== u.id);
    (db.orders || []).forEach((o) => {
      if (o.userId === u.id) {
        o.userId = ''; o.customerName = 'Deleted customer'; o.customerPhone = ''; o.customerEmail = '';
        o.address = ''; o.trackKey = ''; o.clientOrderId = o.clientOrderId || '';
      }
    });
    try { await queueSave(); } catch (e) { return send(res, 500, { error: 'Could not delete right now. Please try again.' }); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const h = String(req.headers['authorization'] || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    db.sessions = db.sessions.filter((s) => s.token !== token);
    save();
    return send(res, 200, { ok: true });
  }

  /* ---------------- catalogue ---------------- */

  if (p === '/api/admin/push' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req, BODY_ADMIN);
    if (b.__tooBig) {
      return send(res, 413, {
        error: 'Catalogue too large for the server (over 24 MB). Remove a few product photos and upload again.'
      });
    }
    if (Array.isArray(b.products)) db.products = b.products;
    if (Array.isArray(b.categories)) db.categories = b.categories;

    /* When the owner's catalogue last changed.
       v54: the server now ALWAYS stamps its own clock.
       Before this it stored whatever timestamp the pushing phone sent, and a
       phone's timestamp only moves when its own copy changes - so the number
       sat in the past. Every other device compared that stale value with its
       own copy, decided the server was not newer, and refused the update.
       That is exactly why an update in the admin panel reached the owner's
       phone but not the testers' phones. The device's value is still accepted
       as a fallback if it happens to be newer than the server's own clock. */
    db.catalogUpdatedAt = Math.max(Date.now(), Number(b.catalogUpdatedAt) || 0);

    /* The admin PIN and the shop rules travel with the catalogue, so one
       change in the admin panel applies to every phone. Numbers only and
       range-checked: a bad value must never reach the storefront. */
    if (b.settings && typeof b.settings === 'object') {
      const pin = String(b.settings.adminPin || '');
      if (/^\d{4,10}$/.test(pin)) db.settings.adminPin = pin;
      const num = (v, lo, hi) => {
        const n = parseInt(v, 10);
        return (Number.isFinite(n) && n >= lo && n <= hi) ? n : null;
      };
      const dMin = num(b.settings.deliveryMinDays, 1, 60);
      const dMax = num(b.settings.deliveryMaxDays, 1, 60);
      if (dMin !== null) db.settings.deliveryMinDays = dMin;
      if (dMax !== null) db.settings.deliveryMaxDays = dMax;
      if (db.settings.deliveryMinDays && db.settings.deliveryMaxDays &&
          db.settings.deliveryMaxDays < db.settings.deliveryMinDays) {
        db.settings.deliveryMaxDays = db.settings.deliveryMinDays;
      }
      const rw = num(b.settings.returnWindowDays, 1, 30);
      if (rw !== null) db.settings.returnWindowDays = rw;
      const fs2 = num(b.settings.freeShipThreshold, 0, 100000);
      if (fs2 !== null) db.settings.freeShipThreshold = fs2;
      const sf = num(b.settings.shippingFee, 0, 10000);
      if (sf !== null) db.settings.shippingFee = sf;
      if (b.settings.theme === 'light' || b.settings.theme === 'dark') {
        db.settings.theme = b.settings.theme;
      }
      if (typeof b.settings.onlinePaymentEnabled === 'boolean') {
        db.settings.onlinePaymentEnabled = b.settings.onlinePaymentEnabled;
      }
    }

    /* Everything else the owner can change in the admin panel. These are shown
       to customers, so they have to travel too: the shop name, logo and opening
       screen (branding), the offer banners, the announcement ticker and the
       coupon codes. Each is only replaced when the phone actually sent it, so
       an older app can never blank out a newer shop. */
    if (b.branding && typeof b.branding === 'object' && !Array.isArray(b.branding)) {
      db.branding = b.branding;
    }
    if (Array.isArray(b.banners)) db.banners = b.banners;
    if (Array.isArray(b.announcements)) db.announcements = b.announcements;
    if (Array.isArray(b.coupons)) db.coupons = b.coupons;
    /* The home-screen layout (service tabs, quick tiles, sale timer, ...).
       Only replaced when the phone really sent an object. */
    if (b.home && typeof b.home === 'object' && !Array.isArray(b.home)) db.home = b.home;

    db.updatedAt = Date.now();
    db.rev = (Number(db.rev) || 0) + 1;

    /* Wait for the database before answering. If it refuses the write, say so:
       the owner must not be told the shop is safe when it is not. */
    try {
      await queueSave();
    } catch (e) {
      console.error('[storage] catalogue save failed:', e.message);
      return send(res, 500, {
        error: 'Saved on the server but the database refused it (' + e.message +
               '). Check DATABASE_URL in Render, then upload again.'
      });
    }
    broadcastRev();
    return send(res, 200, { ok: true, rev: db.rev, products: db.products.length, storage: storage });
  }

  /* ---------------- push notifications ---------------- */
  if (p === '/api/push/key' && req.method === 'GET')
    return send(res, 200, { key: pushKeys().pub });

  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readBody(req);
    const sub = b.subscription || {};
    if (!sub.endpoint || !/^https:\/\//.test(String(sub.endpoint)) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
      return send(res, 400, { error: 'Invalid subscription' });
    const user = userFromReq(req);
    const rec = { endpoint: String(sub.endpoint).slice(0, 600), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
                  userId: user ? user.id : '', admin: isAdmin(req), at: Date.now() };
    db.pushSubs = db.pushSubs || [];
    const i = db.pushSubs.findIndex((x) => x.endpoint === rec.endpoint);
    if (i >= 0) { rec.userId = rec.userId || db.pushSubs[i].userId; rec.admin = rec.admin || db.pushSubs[i].admin; db.pushSubs[i] = rec; }
    else { if (db.pushSubs.length >= 50000) db.pushSubs.shift(); db.pushSubs.push(rec); }
    save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await readBody(req);
    const ep = String((b.subscription && b.subscription.endpoint) || b.endpoint || '');
    db.pushSubs = (db.pushSubs || []).filter((x) => x.endpoint !== ep);
    save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/notify' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const subs = db.pushSubs || [];
    return send(res, 200, { subscribers: subs.length, customers: subs.filter((x) => !x.admin || x.userId).length,
                            history: (db.notifs || []).slice(0, 20) });
  }
  if (p === '/api/admin/notify' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 80), text = String(b.body || '').trim().slice(0, 240);
    if (!title) return send(res, 400, { error: 'Add a title' });
    const payload = { title, body: text, tab: ['home', 'orders', 'categories', 'cart', 'profile'].includes(b.tab) ? b.tab : 'home',
                      image: /^https?:\/\//.test(String(b.image || '')) ? String(b.image) : '', tag: 'offer-' + Date.now() };
    const r = await pushNotify(b.audience === 'admins' ? (x) => x.admin : () => true, payload);
    db.notifs = db.notifs || [];
    db.notifs.unshift({ at: Date.now(), title, body: text, sent: r.sent, failed: r.failed });
    db.notifs = db.notifs.slice(0, 50);
    save();
    return send(res, 200, { ok: true, sent: r.sent, failed: r.failed });
  }

  /* ---------------- orders ---------------- */

  if (p === '/api/orders' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const user = userFromReq(req);
    const name = String(b.customerName || (user && user.name) || '').trim();
    const phone = digits(b.customerPhone || (user && user.phone) || '');
    if (name.length < 2) return send(res, 400, { error: 'Name is required' });
    if (phone.length < 10) return send(res, 400, { error: 'Valid phone is required' });
    /* An order is proof of a customer, even with no account: record them so the
       Customers page shows real buyers, not just sign-ups. */
    if (user) { recordCustomer({ name, phone, email: user.email, provider: user.provider }); }
    else {
      recordCustomer({ name, phone, email: String(b.customerEmail || ''), provider: 'order' });
    }
    const items = [];
    let subtotal = 0;
    for (const line of (Array.isArray(b.items) ? b.items : [])) {
      const prod = db.products.find((x) => x.id === line.productId);
      if (!prod) return send(res, 400, { error: 'Unknown product' });
      const qty = Math.max(1, parseInt(line.qty, 10) || 1);
      if (Number(prod.stock) < qty) return send(res, 409, { error: 'Out of stock: ' + prod.name });
      subtotal += Number(prod.price) * qty;
      items.push({ productId: prod.id, name: prod.name, price: Number(prod.price), qty });
      prod.stock = Number(prod.stock) - qty;
    }
    if (!items.length) return send(res, 400, { error: 'Cart is empty' });
    const delivery = Number(b.delivery) || 0;
    const claimed = b.claimedTotal === undefined ? null : Number(b.claimedTotal);
    const serverTotal = subtotal + delivery;
    const order = {
      id: newId('ORD'), placedAt: Date.now(), status: 'Placed',
      userId: user ? user.id : '', customerName: name, customerPhone: phone,
      /* The customer's email, so the owner can see it in the admin panel. */
      customerEmail: String(b.customerEmail || (user && user.email) || '').slice(0, 200),
      /* The order's copy on the customer's phone: 'clientOrderId' is its number
         there, 'trackKey' is the private key it uses to ask for updates. */
      clientOrderId: String(b.clientOrderId || '').slice(0, 60),
      trackKey: String(b.trackKey || '').slice(0, 80),
      updatedAt: Date.now(),
      address: String(b.address || '').trim(), items, subtotal, delivery,
      total: serverTotal, payment: 'Cash on Delivery',
      timeline: [{ stage: 'Placed', at: Date.now(), city: '' }],
      claimedTotal: claimed, priceMismatch: claimed !== null && claimed !== serverTotal
    };
    db.orders.unshift(order);
    save();
    pushNotify((x) => x.admin, { title: 'New order ' + order.id, body: name + ' · ₹' + serverTotal + ' · ' + items.length + ' item' + (items.length === 1 ? '' : 's'), tab: 'orders', tag: 'neworder-' + order.id });
    return send(res, 201, { ok: true, order });
  }

  if (p === '/api/myorders' && req.method === 'GET') {
    const u = userFromReq(req);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, { orders: db.orders.filter((o) => o.userId === u.id) });
  }

  /* The owner's Customers page. It shows everyone who has ever opened the app
     and signed in, not only the ones who have ordered yet — otherwise a shop
     with testers but no orders looks completely empty. No password material
     ever leaves this endpoint. */
  if (p === '/api/admin/users' && req.method === 'GET') {
    /* v55: the key is checked FIRST.
       dedupeUsers() can rewrite the customer list and save it, and it used to
       run before the check - so a request with no key at all still caused a
       write. Checking first means an unauthorised caller can only ever read. */
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    /* Then merge any duplicate rows, so the owner never sees the same person
       listed twice. */
    dedupeUsers();
    const byUser = {};
    db.orders.forEach((o) => {
      if (!o.userId) return;
      const e = byUser[o.userId] || (byUser[o.userId] = { orders: 0, spend: 0, last: 0 });
      e.orders++;
      if (o.status !== 'Cancelled') e.spend += Number(o.total) || 0;
      e.last = Math.max(e.last, o.placedAt || 0);
    });
    const users = db.users.map((u) => {
      const e = byUser[u.id] || { orders: 0, spend: 0, last: 0 };
      return {
        id: u.id, name: u.name || '', phone: u.phone || '', email: u.email || '',
        provider: u.provider || 'password', createdAt: u.createdAt || 0,
        orders: e.orders, spend: e.spend, lastOrderAt: e.last
      };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return send(res, 200, { users, total: users.length });
  }

  /* Remove a customer row — for test accounts and mistakes. Orders are kept:
     they are the shop's records, and the row can be rebuilt from them. */
  if (p === '/api/admin/user/remove' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const id = String(b.id || '').trim();
    const phone = digits(b.phone || '');
    const email = String(b.email || '').trim().toLowerCase();
    const before = (db.users || []).length;
    db.users = (db.users || []).filter((u) =>
      !(id && u.id === id) &&
      !(phone.length === 10 && u.phone === phone) &&
      !(email && (u.email || '').toLowerCase() === email));
    const removed = before - db.users.length;
    if (removed) save();
    return send(res, 200, { ok: true, removed: removed });
  }

  if (p === '/api/orders' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const since = Number(url.searchParams.get('since')) || 0;
    return send(res, 200, { orders: db.orders.filter((o) => o.placedAt > since), serverTime: Date.now() });
  }

  /* The customer's phone asks about its OWN orders. It sends only the private
     trackKeys it was given when those orders were placed, so nobody can look up
     someone else's order, and the answer carries no personal details — just
     where the parcel is. This is what makes the status appear on the buyer's
     phone by itself after the owner presses "Push Update". */
  if (p === '/api/track' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const keys = (Array.isArray(b.keys) ? b.keys : [])
      .map((k) => String(k || '').slice(0, 80)).filter(Boolean).slice(0, 50);
    if (!keys.length) return send(res, 200, { orders: [] });
    const want = new Set(keys);
    const out = db.orders
      .filter((o) => o && o.trackKey && want.has(o.trackKey))
      .map((o) => ({
        key: o.trackKey,
        status: o.status,
        currentCity: o.currentCity || '',
        trackingId: o.trackingId || '',
        trackingDetail: o.trackingDetail || '',
        deliveredAt: o.deliveredAt || 0,
        timeline: Array.isArray(o.timeline) ? o.timeline : [],
        updatedAt: o.updatedAt || o.placedAt || 0
      }));
    return send(res, 200, { orders: out, serverTime: Date.now() });
  }

  const m = p.match(/^\/api\/orders\/([A-Za-z0-9]+)$/);
  if (m && req.method === 'PATCH') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const order = db.orders.find((o) => o.id === m[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    /* The owner can move the parcel: status, city, courier and the timeline the
       customer sees when they track the order. */
    const prevStatus = order.status;
    if (b.status) order.status = String(b.status).slice(0, 40);
    if (b.currentCity !== undefined) order.currentCity = String(b.currentCity).slice(0, 120);
    if (b.trackingId !== undefined) order.trackingId = String(b.trackingId).slice(0, 80);
    if (b.trackingDetail !== undefined) order.trackingDetail = String(b.trackingDetail).slice(0, 80);
    if (Number(b.deliveredAt)) order.deliveredAt = Number(b.deliveredAt);
    if (Array.isArray(b.timeline) && b.timeline.length) order.timeline = b.timeline.slice(-30);
    order.updatedAt = Date.now();
    save();
    if (order.status !== prevStatus && order.userId) {
      const msg = ORDER_MSG[order.status] || ['Order update', 'Your order is now: ' + order.status];
      pushNotify((x) => x.userId === order.userId && !x.admin,
        { title: msg[0], body: msg[1] + ' (Order ' + (order.clientOrderId || order.id) + ')', tab: 'orders', tag: 'order-' + order.id });
    }
    return send(res, 200, { ok: true, order });
  }

  send(res, 404, { error: 'Not found' });
});

server.requestTimeout = 600000;     // slow phones uploading a video need time
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;

init()
  .catch((e) => console.error('[storage] init problem (continuing):', e.message))
  .then(() => server.listen(PORT, () => {
    console.log('NEXCART backend on port ' + PORT + ' — storage: ' + storage);
    /* v55: say out loud what the admin API is protected by. Silence here is how a
       shop ends up live with no working admin access and no idea why. */
    if (KEY_IS_DEFAULT) {
      console.log('==============================================================');
      console.log(' ADMIN_KEY IS NOT SET.');
      console.log(' The admin API is refusing every request on purpose, because a');
      console.log(' key that ships in the source code is not a key.');
      console.log(' Fix: Render -> your service -> Environment -> add');
      console.log('   ADMIN_KEY = <a long random phrase only you know>');
      console.log(' then Manual Deploy. Customers are unaffected by this.');
      console.log('==============================================================');
    } else {
      console.log('Admin API: protected by ADMIN_KEY (set).');
    }
  }));
