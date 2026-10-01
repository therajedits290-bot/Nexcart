// NEXCART backend — one small file, no packages needed.
// Render runs it with:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const KEY = process.env.ADMIN_KEY || 'changeme';
const FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

let db = { products: [], categories: [], orders: [], settings: {}, updatedAt: 0 };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
// migrate older data files that have no settings bucket
if (!db.settings || typeof db.settings !== 'object') db.settings = {};
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {} };
const id = (p) => p + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
  });
  res.end(JSON.stringify(body));
}
// The cap is per-route. Public routes keep the old tight limit so nobody can
// flood them; the admin catalogue push needs room for the shop's pictures,
// which are the bulk of the payload.
const BODY_PUBLIC = 200000;        // ~200 KB - customer ordering and status updates
const BODY_ADMIN  = 12000000;      // ~12 MB - the shop catalogue with its photos
function readBody(req, limit) {
  const cap = limit || BODY_PUBLIC;
  return new Promise((done) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > cap) req.destroy(); });
    req.on('end', () => { try { done(JSON.parse(s || '{}')); } catch (e) { done({}); } });
  });
}
const isAdmin = (req) => req.headers['x-admin-key'] === KEY;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const admin = isAdmin(req);
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (p === '/api/health')
    return send(res, 200, { ok: true, products: db.products.length, orders: db.orders.length });

  if (p === '/api/bootstrap')
    return send(res, 200, { products: db.products, categories: db.categories, settings: db.settings, updatedAt: db.updatedAt });

  if (p === '/api/admin/push' && req.method === 'POST') {
    if (!admin) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req, BODY_ADMIN);
    if (Array.isArray(b.products)) db.products = b.products;
    if (Array.isArray(b.categories)) db.categories = b.categories;
    // When the owner's catalogue last changed. Sent back to every device so
    // an out-of-date copy here can never overwrite a newer one on a phone.
    if (b.catalogUpdatedAt) db.catalogUpdatedAt = Number(b.catalogUpdatedAt) || 0;
    if (b.settings && typeof b.settings === 'object') {
      const pin = String(b.settings.adminPin || '');
      if (/^\d{4,10}$/.test(pin)) db.settings.adminPin = pin;
      // Shop rules travel with the catalogue so one change in the admin panel
      // applies to every phone. Numbers only and range-checked: a bad value
      // must never be able to reach the storefront.
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
    save();
    return send(res, 200, { ok: true, products: db.products.length });
  }

  if (p === '/api/orders' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.customerName || '').trim();
    const phone = String(b.customerPhone || '').replace(/\D/g, '');
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
      id: id('ORD'), placedAt: Date.now(), status: 'Placed',
      customerName: name, customerPhone: phone,
      address: String(b.address || '').trim(), items, subtotal, delivery,
      total: serverTotal, payment: 'Cash on Delivery',
      claimedTotal: claimed, priceMismatch: claimed !== null && claimed !== serverTotal
    };
    db.orders.unshift(order);
    save();
    return send(res, 201, { ok: true, order });
  }

  if (p === '/api/orders' && req.method === 'GET') {
    if (!admin) return send(res, 401, { error: 'unauthorised' });
    const since = Number(url.searchParams.get('since')) || 0;
    return send(res, 200, {
      orders: db.orders.filter((o) => o.placedAt > since),
      serverTime: Date.now()
    });
  }

  const m = p.match(/^\/api\/orders\/([A-Za-z0-9]+)$/);
  if (m && req.method === 'PATCH') {
    if (!admin) return send(res, 401, { error: 'unauthorised' });
    const b = await readBody(req);
    const order = db.orders.find((o) => o.id === m[1]);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (b.status) order.status = String(b.status);
    save();
    return send(res, 200, { ok: true, order });
  }

  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('NEXCART backend on port ' + PORT));
