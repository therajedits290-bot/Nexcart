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
const BODY_ADMIN = 24000000;     // ~24 MB — catalogue, photos, logo and splash

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
  return { id: u.id, name: u.name, phone: u.phone, email: u.email || '',
           provider: u.provider, createdAt: u.createdAt || 0 };
}

/* Remember a customer, however they reached the shop: a device that reports its
   saved profile, an account created here, or a plain order. Matches on the
   phone number first, then the email, so the same person is never listed twice.
   Password material is never stored by this path. */
function recordCustomer(info) {
  const name = String((info && info.name) || '').trim().slice(0, 80);
  const phone = digits((info && info.phone) || '');
  const email = String((info && info.email) || '').trim().toLowerCase().slice(0, 200);
  if (!phone && !email) return null;
  db.users = db.users || [];
  let user = phone.length === 10 ? db.users.find((u) => u.phone === phone) : null;
  if (!user && email) user = db.users.find((u) => (u.email || '').toLowerCase() === email);
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
  db.banners = db.banners || [];
  db.announcements = db.announcements || [];
  db.coupons = db.coupons || [];
  if (!db.branding || typeof db.branding !== 'object') db.branding = null;
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

  /* Everything a phone needs in order to show the same shop the owner sees:
     the catalogue, the categories, and the whole admin-panel configuration —
     branding (name, logo, opening screen), offer banners, the announcement
     ticker, coupon codes and the shop rules. */
  if (p === '/api/bootstrap')
    return send(res, 200, {
      products: db.products,
      categories: db.categories,
      settings: db.settings,
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
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorised' });
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
    if (b.status) order.status = String(b.status).slice(0, 40);
    if (b.currentCity !== undefined) order.currentCity = String(b.currentCity).slice(0, 120);
    if (b.trackingId !== undefined) order.trackingId = String(b.trackingId).slice(0, 80);
    if (b.trackingDetail !== undefined) order.trackingDetail = String(b.trackingDetail).slice(0, 80);
    if (Number(b.deliveredAt)) order.deliveredAt = Number(b.deliveredAt);
    if (Array.isArray(b.timeline) && b.timeline.length) order.timeline = b.timeline.slice(-30);
    order.updatedAt = Date.now();
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
