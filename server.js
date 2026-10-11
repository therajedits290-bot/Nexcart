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
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const BODY_ADMIN = 12000000;     // ~12 MB — the shop catalogue with its photos

let db = { products: [], categories: [], orders: [], users: [],
           sessions: [], fails: {}, settings: {}, updatedAt: 0, catalogUpdatedAt: 0 };

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
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || '', provider: u.provider };
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
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
  });
  res.end(JSON.stringify(body));
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
const isAdmin = (req) => req.headers['x-admin-key'] === KEY;

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
  db.sessions = db.sessions || [];
  db.fails = db.fails || {};
  db.settings = db.settings || {};
  db.updatedAt = Number(db.updatedAt) || 0;
  db.catalogUpdatedAt = Number(db.catalogUpdatedAt) || 0;

  // The database is empty but this install had data on disk (or this is a
  // brand-new database): seed it, and wait, so the very first upload cannot be
  // reported as saved before the row exists.
  if (pool && !fromDb) await queueSave().catch((e) => console.error('[storage] seed failed:', e.message));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (p === '/api/health')
    return send(res, 200, { ok: true, products: db.products.length, orders: db.orders.length,
                            users: db.users.length, storage: storage });

  if (p === '/api/bootstrap')
    return send(res, 200, {
      products: db.products,
      categories: db.categories,
      settings: db.settings,
      updatedAt: db.updatedAt,
      catalogUpdatedAt: Number(db.catalogUpdatedAt) || Number(db.updatedAt) || 0
    });

  /* Lets the app switch the Google button on by itself once the owner adds
     GOOGLE_CLIENT_ID in Render — no need to edit the app file again. */
  if (p === '/api/config')
    return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID, accounts: true });

  /* ---------------- accounts ---------------- */

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
        error: 'Catalogue too large for the server (over 12 MB). Remove a few product photos and upload again.'
      });
    }
    if (Array.isArray(b.products)) db.products = b.products;
    if (Array.isArray(b.categories)) db.categories = b.categories;

    /* When the owner's catalogue last changed. Sent back to every device so an
       out-of-date copy here can never overwrite a newer one on a phone. */
    if (b.catalogUpdatedAt) db.catalogUpdatedAt = Number(b.catalogUpdatedAt) || 0;
    else db.catalogUpdatedAt = Date.now();

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
    }
    db.updatedAt = Date.now();

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
    return send(res, 200, { ok: true, products: db.products.length, storage: storage });
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
      address: String(b.address || '').trim(), items, subtotal, delivery,
      total: serverTotal, payment: 'Cash on Delivery',
      claimedTotal: claimed, priceMismatch: claimed !== null && claimed !== serverTotal
    };
    db.orders.unshift(order);
    save();
    return send(res, 201, { ok: true, order });
  }

  if (p === '/api/myorders' && req.method === 'GET') {
    const u = userFromReq(req);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, { orders: db.orders.filter((o) => o.userId === u.id) });
  }

  if (p === '/api/orders' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const since = Number(url.searchParams.get('since')) || 0;
    return send(res, 200, { orders: db.orders.filter((o) => o.placedAt > since), serverTime: Date.now() });
  }

  const m = p.match(/^\/api\/orders\/([A-Za-z0-9]+)$/);
  if (m && req.method === 'PATCH') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req);
    if (b.__tooBig) return send(res, 413, { error: 'Request too large' });
    const order = db.orders.find((o) => o.id === m[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (b.status) order.status = String(b.status);
    save();
    return send(res, 200, { ok: true, order });
  }

  send(res, 404, { error: 'Not found' });
});

init()
  .catch((e) => console.error('[storage] init problem (continuing):', e.message))
  .then(() => server.listen(PORT, () => {
    console.log('NEXCART backend on port ' + PORT + ' — storage: ' + storage);
  }));
