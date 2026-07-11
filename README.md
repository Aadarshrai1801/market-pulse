# MARKETPULSE — UAE Fresh Produce

A dashboard around your Playwright scraper: a Retailer dropdown and a
Product Filter dropdown (both default to "All"), a **Fetch latest
prices** button, and a table with retailers/products down the side and
dates across the top — a running price-history matrix in AED/kg, built
from every fetch you run. Includes login, role-based access (viewer /
editor / admin), and optional "Continue with Google" sign-in.

## Files

- `scraper/` — a package, split one file per retailer so you can fix or
  extend one site without touching the others:
  - `config.py` — `SITE_SEARCH_CONFIG`. Edit search URLs/selectors here.
  - `utils.py` — shared helpers used by more than one retailer
    (`launch_stealth_browser`, `parse_weight_to_kg`, `parse_price_value`).
  - `carrefour.py`, `lulu.py`, `barakat.py`, `kibsons.py`, `unioncoop.py`
    — each has just two functions: `find_url(product_name)` and
    `scrape(url)`.
  - `excel_store.py` — `save_to_excel`, including the "update today's row
    instead of duplicating it" logic.
  - `__init__.py` — the only file anything outside `scraper/` imports
    from. Re-exports `SITE_SEARCH_CONFIG`, `find_product_url`,
    `get_product_details`, `save_to_excel`.
  - **Adding a 6th retailer:** add its config to `config.py`, create
    `scraper/newsite.py` with `find_url()`/`scrape()`, then register it
    in the two dicts at the top of `scraper/__init__.py`.
- `products_config.py` — the canonical product catalog. The frontend
  dropdown always shows/uses `name` (e.g. "Red Onion") — the **same
  keyword for every retailer**. If a specific retailer's search only
  matches a different term, add a one-line override in that product's
  `keywords` dict; the frontend never sees it, only the scraper does,
  via `get_search_keyword(product, retailer)`.
- `auth.py` — session-based login, SQLite-backed users (`users.db`),
  three roles (viewer / editor / admin), optional Google OAuth. Also
  seeds a default admin account on first run (see **Environment
  variables** below — set these before your first deploy).
- `app.py` — Flask backend:
  - `GET /api/meta` — retailer + product lists for the dropdowns.
  - `POST /api/fetch` — **synchronous.** Runs the scraper for the
    selected retailer(s) × product(s) and blocks until done. Fine for a
    single retailer/product (a few seconds); avoid it for "all"/"all"
    since the request would sit open for several minutes.
  - `POST /api/jobs` — **asynchronous.** Same inputs as `/api/fetch`,
    returns immediately with a `job_id` while scraping runs in a
    background thread. Use this for bigger requests. *(In-memory job
    store — see Deployment notes if you run more than one worker.)*
  - `GET /api/jobs/<job_id>` — poll for
    `{status: "running"|"done", completed, total, results}`.
  - `GET /api/jobs` — list recent jobs (without full results).
  - `GET /api/history` — reads `products.xlsx`, pivots it into
    `{dates, rows}`, filtered by whatever's selected in the dropdowns.
  - `POST /api/ocr` — accepts an uploaded receipt/price-list image and
    returns structured rows via the local `ocr/` module.
  - `/api/users*` — admin-only user management (create, change role,
    deactivate, reset password, delete).
- `templates/index.html` — the dashboard page. "Fetch latest prices"
  uses the async job API under the hood (submits a job, polls every
  ~1.2s, shows live "X/Y" progress).
- `templates/login.html` — sign-in page (username/password + optional
  Google button).

## Local setup

```bash
python -m venv venv
source venv/bin/activate        # on Windows: venv\Scripts\activate

pip install -r requirements.txt
playwright install chromium
```

## Environment variables

None of these are hardcoded — set them in your shell (local) or your
hosting platform's config/secrets panel (production). **Do this before
the first run on any server other machines can reach.**

| Variable | Required? | Purpose |
|---|---|---|
| `SECRET_KEY` | **Yes, in production** | Signs session cookies. Without it, a random key is generated and cached to a local `secret.key` file — fine on a machine with persistent disk, but if your host's filesystem is ephemeral (most PaaS/containers), a new key is generated on every restart and **all users get logged out**. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Recommended | Sets the first admin account's credentials on first run (instead of the `admin` / `admin123` default). Set these *before* the first request ever hits the app in production. |
| `USERS_DB_PATH` | Optional | Path to the SQLite users database. Defaults to `users.db` in the working directory. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Optional | Enables the "Continue with Google" button. Create credentials at the [Google Cloud Console](https://console.cloud.google.com/apis/credentials); `GOOGLE_REDIRECT_URI` must exactly match an authorized redirect URI there, e.g. `https://yourdomain.com/auth/google/callback`. |
| `GOOGLE_DEFAULT_ROLE` | Optional | Role assigned to new accounts created via Google sign-in. Defaults to `viewer`. |

Keep these in a local `.env` (not committed) for development, and in
your host's secret manager for production — never commit real values.

## Run (development)

```bash
python app.py
```

Then open **<http://127.0.0.1:5000>**. This mode uses Flask's built-in
dev server with `debug=True` — reloads on file changes, but **must not**
be used for anything reachable outside your own machine (see
Deployment).

First run: the table starts empty. Pick "All Retailers" / "All
Configured Products" (or narrow it down) and click **Fetch latest
prices** — each successful lookup becomes a cell in the table, and
running it again on a different day adds a new date column, building
price history over time.

## Deployment

Before pointing a real domain at this app:

1. **Turn off debug mode.** `app.run(..., debug=True)` exposes an
   interactive debugger on any unhandled error — that's remote code
   execution for anyone who can trigger one. In production, don't call
   `app.run()` at all; run through a WSGI server instead:

   ```bash
   gunicorn -w 2 -b 0.0.0.0:$PORT app:app
   ```

2. **Set `SECRET_KEY` and `ADMIN_USERNAME`/`ADMIN_PASSWORD`** as real
   environment variables (see table above) before the first deploy.
3. **Enforce secure cookies** once you're serving over HTTPS, by adding
   to `app.py`:

   ```python
   app.config["SESSION_COOKIE_SECURE"] = True
   app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
   ```

4. **Persistent storage.** `users.db`, `products.xlsx`, `secret.key`,
   and `uploads/` are plain local files. Confirm your host gives you a
   persistent volume, or move `users.db`/`products.xlsx` to a proper
   hosted database — otherwise data disappears on redeploy/restart.
5. **Single worker, or externalize job state.** `JOBS` in `app.py` is
   an in-memory dict. With more than one gunicorn worker/process, a job
   started on one worker won't be visible when another worker handles
   the poll request. Either run `-w 1`, or move `JOBS` to Redis/a DB if
   you need to scale.
6. **Playwright needs a real headless Chromium on the host**
   (`playwright install --with-deps chromium`). Confirm your hosting
   tier supports this — it's memory/CPU heavier than a typical web
   dyno.
7. **Rate-limit `/api/auth/login`** (e.g. with `Flask-Limiter`) — it's
   currently unthrottled and brute-forceable.
8. Double-check `.gitignore` excludes `secret.key`, `users.db`,
   `uploads/`, and `products.xlsx` so none of them end up in a public
   repo.

## Notes

- Each lookup spins up a real headless Chrome via Playwright, so one
  retailer × one product takes a few seconds, and leaving both
  dropdowns on "All" runs 5 × 8 = 40 lookups one after another — figure
  several minutes.
- Barakat, Kibsons, and Union Coop selectors in `scraper/config.py` are
  marked as best-effort guesses — if a lookup fails or grabs the wrong
  product for those three, inspect the live search results page and
  update `result_selector` in that retailer's own file under
  `scraper/`.
- If Playwright can't launch Chrome, run `playwright install chromium`
  again, or drop `channel="chrome"` from the `launch()` calls in
  `scraper/utils.py` (and in `scraper/barakat.py`'s `find_url`) to use
  Playwright's bundled Chromium instead of your system Chrome.
