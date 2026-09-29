# NEXCART — Online Store App

A complete shopping app. No build step, no install, no framework.
Everything is plain HTML, CSS and JavaScript.

**👉 To put this online and on Google Play, follow `PHONE_STEPS.md`.**
It is written for a phone with no laptop.

---

## What is in this folder

| File | Purpose | Where it goes |
|---|---|---|
| `tokri-standalone.html` | The whole app (HTML + CSS + JS in one file) | Web host |
| `index.html` | Opens the app — the address customers visit | Web host |
| `api-sync.js` | Connects the app to the backend | Web host |
| `manifest.json` | App name, colours, icons (makes it installable) | Web host |
| `sw.js` | Service worker — offline support | Web host |
| `privacy-policy.html` | Required by Google Play. **Fill in the pink boxes.** | Web host |
| `.gitignore` | Stops private order data reaching GitHub | Repo root |
| `icon-192.png`, `icon-512.png` | App icons | Web host |
| `icon-maskable-512.png` | Adaptive icon for Android | Web host |
| `play-icon-512.png` | Play Store listing icon | Play Console |
| `play-feature-graphic-1024x500.png` | Play Store banner | Play Console |
| `server.js` | **The backend** — holds products & orders for all phones | Backend host |
| `PHONE_STEPS.md` | The full step-by-step guide | — |

Keep `manifest.json`, `sw.js` and the `icon-*.png` files in the **same folder** as
`tokri-standalone.html`, or the app will not install properly.

---

## Two ways to run it

**Offline only (no backend set up yet)**
Open `index.html` in a browser. Everything works — browsing, cart, COD checkout,
order tracking, reviews, admin panel. Data is saved in the browser's local storage,
so it lives on **one device only**.

**Online (shared with everyone)**
Set your backend URL in `tokri-standalone.html`:

```html
<script>window.NC_API_BASE = 'https://your-backend-url';</script>
```

Now products and orders are shared, so your phone and your customers' phones all
see the same thing. Until you set this, the app runs exactly as above — nothing breaks.

---

## Admin panel (hidden)

Tap the **logo (top-left) 12 times**, or **press and hold it for ~1.2 seconds**, or
open the app with **`#admin`** on the end of the URL.

Default PIN: **`1234`** — change it in Admin → Settings.
Forgot it? Tap **"Forgot PIN? Reset admin access"** on the PIN screen. That resets the
PIN while keeping your products, orders and branding.

| Tab | What you can do |
|---|---|
| **Dashboard** | Orders, revenue, customers, low-stock alerts |
| **Products** | Add / edit / delete, photos, sizes, stock |
| **Categories** | Add / edit / delete, emoji or icon, image |
| **Orders** | Set status, city, tracking ID, courier |
| **Customers** | Repeat buyers, lifetime value, order history |
| **Offers** | Hero banners, announcement ticker, coupons |
| **Branding** | App name, tagline, logo, brand colour |
| **Settings** | Admin PIN, payment methods, return window, delivery threshold |

---

## The backend (`server.js`)

Zero dependencies — no `npm install` needed.

Run it locally:

```bash
ADMIN_KEY=your-secret node server.js
```

Environment variables:

| Variable | Meaning |
|---|---|
| `ADMIN_KEY` | Secret the admin panel sends. **Change it.** |
| `DATA_DIR` | Where `data.json` is stored. Point at a persistent disk. |
| `PORT` | Set automatically by most hosts. |

### Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Is the server alive? |
| GET | `/api/bootstrap` | public | Products + categories for the app |
| POST | `/api/orders` | public | Customer places an order |
| GET | `/api/orders?since=` | admin | New orders since a timestamp |
| PATCH | `/api/orders/:id` | admin | Update an order's status |
| POST | `/api/admin/push` | admin | Upload the catalogue from the app |

Admin requests need the header `x-admin-key: <ADMIN_KEY>`.

### Security notes

- Prices are **recalculated on the server** from its own product list. The phone sends
  only product ID and quantity, so a tampered price cannot get through.
- Because Cash on Delivery may involve coupons the server does not know about, the
  app's figure is stored alongside as `claimedTotal`, and `priceMismatch` is set when
  the two disagree. Discrepancies are **visible to you**, not silently accepted.
- Stock is decremented on the server, so two people cannot buy the last item.

### ⚠️ Before you take real orders

`data.json` holds customer names, phone numbers and addresses.

1. **Never upload `data.json` to GitHub.** The included `.gitignore` prevents it.
2. Free hosting plans often have **no persistent disk** — orders can be lost when the
   service restarts. Add a persistent disk or use a small VPS before going live.
3. Set a long, random `ADMIN_KEY`.

---

## Browsing without an account

Customers can browse the whole store without logging in. Login is asked for **only**
when it is genuinely needed:

| Action | Login required? |
|---|---|
| Browse products, categories, search | No |
| Product details, reviews | No |
| Add to cart, view cart, apply coupons | No |
| **Place an order (checkout)** | **Yes** |
| **Wishlist** | **Yes** |
| **Profile / my orders** | **Yes** |
| **Write a review** | **Yes** |

---

## One order per product (Flipkart style)

If the cart has several products, checkout creates **one order per product** — each with
its own order ID, status and tracking timeline, so items can be tracked and returned
separately. The coupon discount is split proportionally and delivery is charged once,
so the totals always add up.

---

## Honest limitations

- **Payment** — Cash on Delivery only. Online payment is not implemented.
- **OTP** — the login OTP is shown on screen (demo mode). Real SMS needs a paid gateway.
- **Admin security** — the PIN hides the screen; it is not real protection. Anyone with
  the device can read local storage. Real security needs server-side admin login.
- **Privacy policy** — a template. Have it reviewed before you publish.
- **Product images** — demo products use placeholder photos. Upload real ones in
  Admin → Products.
