# Put Your Shop Online — Step by Step (phone only, no laptop)

Everything here is done in your phone's browser. Nothing needs a computer.

---

## What is already built for you

| File | What it is |
|---|---|
| `tokri-standalone.html` | Your shop app (the customer app) |
| `server.js` | The online backend — holds products & orders for all phones |
| `api-sync.js` | Connects the app to the backend |
| `privacy-policy.html` | Required by Google Play — fill in the pink boxes |
| `play-icon-512.png` | App icon for Play Store |
| `play-feature-graphic-1024x500.png` | Play Store banner |
| `manifest.json`, `sw.js`, icons | Makes the app installable + work offline |

---

## STEP 1 — Put the files on GitHub (about 15 minutes)

1. Open **github.com** in Chrome on your phone → **Sign up** (free).
2. Tap **+** → **New repository**. Name it `nexcart`. Set it **Public**. Create.
3. Tap **Add file → Upload files**. Upload these:
   - `tokri-standalone.html`
   - `api-sync.js`
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `privacy-policy.html`
   - `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
4. Tap **Commit changes**.
5. Go to **Settings → Pages**. Under *Branch* choose **main**, folder **/ (root)**, tap **Save**.
6. Wait 1–2 minutes. Your app is now live at:
   `https://YOUR-USERNAME.github.io/nexcart/`

**Test it:** open that link in **Chrome** (not an in-app viewer).

> Why Chrome matters: your earlier screenshot showed a `content://` viewer, where saved
> data often does not persist. That is likely why your shop name and PIN behaved oddly.

---

## STEP 2 — Start the backend (about 10 minutes, free)

The backend is what lets **all phones see the same products and orders**.

1. Open **render.com** → Sign up free (you can sign in with GitHub).
2. Tap **New → Web Service**.
3. Choose your **nexcart** repository.
4. Fill in:
   - **Name:** `nexcart-api`
   - **Runtime:** Node
   - **Build Command:** *(leave empty)*
   - **Start Command:** `node server.js`
   - **Instance type:** **Free**
5. Tap **Add Environment Variable** and add:
   - Key: `ADMIN_KEY`  →  Value: *make up a long secret, e.g. `nexcart-7f3k9x2m`*
     **Write this down — the admin panel needs it.**
6. Tap **Deploy**. Wait ~2 minutes.
7. Your backend is live at something like:
   `https://nexcart-api.onrender.com`

**Test it:** open `https://nexcart-api.onrender.com/api/health` in Chrome.
You should see `{"ok":true,...}`. That means it works.

> ⚠️ **Read this.** Render's free plan does not keep files permanently. If the server
> restarts, saved orders can disappear. That is fine while testing, but **before you take
> real orders**, either add a persistent disk in Render (paid plan) or move the backend to
> a small VPS. Do not run a real shop on the free plan.

---

## STEP 3 — Connect the app to the backend (2 minutes)

1. On GitHub, open **tokri-standalone.html** → tap the **pencil** (edit).
2. Find this line near the very bottom:
   ```
   <script>window.NC_API_BASE = '';</script>
   ```
3. Put your backend URL inside the quotes:
   ```
   <script>window.NC_API_BASE = 'https://nexcart-api.onrender.com';</script>
   ```
4. Scroll down → **Commit changes**.
5. Wait 1 minute, then reload your app link.

---

## STEP 4 — Test that it is really working

1. Open your app link in Chrome.
2. Tap the logo **12 times** → enter PIN `1234` → admin panel opens.
3. It will ask for your **ADMIN_KEY**. Paste the secret from Step 2.
4. Go to **Products** → add a product. Wait ~15 seconds (it uploads automatically).
5. Open `https://your-backend-url/api/bootstrap` — your product should appear there.
6. Now place a test order in the app as a customer.
7. In the admin panel you should get a **"New order received!"** message within ~15 seconds.

That is the whole point: the order came from the server, so **another phone can see it too**.

---

## STEP 5 — Google Play Store (do this in parallel)

### 5a. Prepare assets (ready except screenshots)
- ✅ Icon: `play-icon-512.png`
- ✅ Banner: `play-feature-graphic-1024x500.png`
- ⬜ **Screenshots:** open your app on your phone and take **4–6 screenshots**
  (home, category, product, cart, order placed). Play needs at least 2.
- ⬜ **Privacy policy:** upload `privacy-policy.html` to your GitHub repo, then use
  `https://YOUR-USERNAME.github.io/nexcart/privacy-policy.html` as the policy URL.
  **Fill in every pink box first** — Google rejects pages with missing contact details.

### 5b. Make the Play account
1. Go to **play.google.com/console** → sign up (must be 18+).
2. Pay **US$25 once** — Mastercard or Visa **debit or credit**. Prepaid cards are rejected.
3. Verify your identity — Google may ask for a government ID and a card **in your own
   legal name**. If they do not match, the fee is **not refunded**.
4. Install the **Play Console** mobile app and verify your Android device.

### 5c. Build the app file with PWABuilder (free, phone browser)
1. Open **pwabuilder.com** on your phone.
2. Enter your app URL: `https://YOUR-USERNAME.github.io/nexcart/`
3. Tap **Package for stores → Android → Generate Package**.
4. On the *Google Play* tab set:
   - **Package ID:** `com.nexcart.shop` ← **cannot be changed later**
   - **App name:** NEXCART · **Short name:** NEXCART
   - **Icon URL:** `https://YOUR-USERNAME.github.io/nexcart/play-icon-512.png`
   - **Signing key:** **New** (let PWABuilder create one)
   - **Display mode:** Standalone
5. Tap **Download Package**. You get a `.zip` with:
   - the `.aab` file → this is what you upload to Play
   - `assetlinks.json`
   - `signing.keystore` + `signing-key-info.txt`

> 🔴 **BACK UP `signing.keystore` AND `signing-key-info.txt` RIGHT NOW.**
> Email them to yourself, save in Drive. If you lose them you can **never update your app**.

### 5d. Publish
1. In Play Console: create the app, upload the `.aab`, fill in the listing.
2. **Target audience: 13+** (Play does not allow web apps to target children).
3. Fill in the **Data safety** form honestly (name, phone, address, orders — COD only).
4. Start a **closed test** and add your testers.

### 5e. The wait you cannot skip ⚠️
Google requires **12 testers who stay opted in for 14 days in a row** before you can go
public. Ask **14–15 people today** — if one drops out, the 14 days restart.

### 5f. One last fix (do not skip)
After Play re-signs your app, open **Setup → App integrity → App signing**, copy the
**SHA-256** fingerprint, paste it into the second entry of `assetlinks.json`, and re-upload
that file to `https://YOUR-USERNAME.github.io/.well-known/assetlinks.json`.
Skip this and your app shows a browser address bar or crashes.

---

## Money

| Item | Cost |
|---|---|
| GitHub hosting | Free |
| Render backend (testing) | Free |
| Play Store account | **US$25 once** (≈₹2,200) |
| Render persistent disk (needed for real orders) | ≈US$7/month |
| **Bare minimum to launch** | **≈₹2,200** |

---

## Do it in this order

| When | What |
|---|---|
| **Today** | Ask 14–15 friends to be testers |
| **Today** | Step 1 (GitHub) + test in Chrome |
| **Today** | Step 2 (Render) + Step 3 (connect) + Step 4 (test) |
| Tomorrow | Step 5a assets + 5b Play account |
| Next day | 5c PWABuilder + 5d publish to closed testing |
| +14 days | Apply for production → live in about a week |

---

## If something goes wrong

| Problem | Fix |
|---|---|
| App looks wrong / old | Hard reload: Chrome menu → Reload, or clear site data |
| Backend test fails to load | Wait — Render free services sleep; first load can take 30s |
| Admin panel will not open | Tap the logo **12 times**, or long-press it, or add **`#admin`** to the URL |
| PIN rejected | Tap **"Forgot PIN? Reset admin access"** — keeps your data, resets PIN to `1234` |
| Sync key rejected | Admin panel will ask again — paste `ADMIN_KEY` exactly |
| Orders not appearing | Check `/api/health` on your backend URL is reachable |
