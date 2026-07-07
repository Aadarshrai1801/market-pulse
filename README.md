# Souq Check — Price Terminal

A local dashboard around your existing Playwright scraper: a Retailer
dropdown and a Product Filter dropdown (both default to "All"), a
**Fetch latest prices** button, and a table with retailers/products down
the side and dates across the top — a running price-history matrix in
AED/kg, built from every fetch you run.

## Files

- `scraper/` — a package now, split one file per retailer so you can fix
  or extend one site without touching the others:
  - `config.py` — `SITE_SEARCH_CONFIG`. Edit search URLs/selectors here.
  - `utils.py` — shared helpers used by more than one retailer
    (`launch_stealth_browser`, `parse_weight_to_kg`, `parse_price_value`).
  - `carrefour.py`, `lulu.py`, `barakat.py`, `kibsons.py`, `unioncoop.py`
    — each has just two functions: `find_url(product_name)` and
    `scrape(url)`.
  - `excel_store.py` — `save_to_excel`, including the "update today's row
    instead of duplicating it" logic.
  - `__init__.py` — the only file anything outside `scraper/` imports
    from. It re-exports `SITE_SEARCH_CONFIG`, `find_product_url`,
    `get_product_details`, `save_to_excel` exactly as before, so `app.py`
    didn't need to change at all.
  - **Adding a 6th retailer:** add its config to `config.py`, create
    `scraper/newsite.py` with `find_url()`/`scrape()`, then register it
    in the two dicts at the top of `scraper/__init__.py`. Nothing else
    needs to change.
- `products_config.py` — the canonical product catalog. The frontend
  dropdown always shows/uses `name` (e.g. "Red Onion") — the **same
  keyword for every retailer**. If a specific retailer's search only
  matches a different term (e.g. its catalogue calls Valencia oranges
  "Valencia Orange"), you add a one-line override in that product's
  `keywords` dict; the frontend never sees it, only the scraper does, via
  `get_search_keyword(product, retailer)`.
- `app.py` — Flask backend:
  - `GET /api/meta` — retailer + product lists for the dropdowns.
  - `POST /api/fetch` — **synchronous.** Runs the scraper for the
    selected retailer(s) × product(s) and blocks until done. Fine for a
    single retailer/product (a few seconds); avoid it for "all"/"all"
    since the HTTP request would sit open for several minutes.
  - `POST /api/jobs` — **asynchronous.** Same inputs as `/api/fetch`, but
    returns immediately with a `job_id` while the scraping runs in a
    background thread. This is the one to use for bigger requests, or
    to call this app as an API from your own scripts.
  - `GET /api/jobs/<job_id>` — poll this for
    `{status: "running"|"done", completed, total, results}`.
  - `GET /api/jobs` — list recent jobs (without their full results).
  - `GET /api/history` — reads `products.xlsx`, pivots it into
    `{dates, rows}` (one row per product+retailer, one price per date),
    filtered by whatever's selected in the dropdowns.
- `templates/index.html` — the dashboard page itself. Its "Fetch latest
  prices" button uses the async job API under the hood (submits a job,
  then polls it every ~1.2s and shows live "X/Y" progress).

## Calling it as an API from your own scripts

The app binds to `127.0.0.1` only (see `app.run(...)` at the bottom of
`app.py`), so it's reachable from this device only - not your network,
not the internet. Within that, it's a plain JSON API:

```bash
# 1. kick off a job (garlic, every retailer)
curl -X POST http://127.0.0.1:5000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"retailer": "all", "product": "garlic"}'
# -> {"ok": true, "job_id": "a1b2c3d4e5f6", "status": "running", "total": 5}

# 2. poll it
curl http://127.0.0.1:5000/api/jobs/a1b2c3d4e5f6
# -> {"ok": true, "status": "running", "completed": 2, "total": 5, "results": [...]}
# ... call again until "status": "done"
```

For a single quick lookup you don't need to poll at all - `/api/fetch`
answers directly:

```bash
curl -X POST http://127.0.0.1:5000/api/fetch \
  -H "Content-Type: application/json" \
  -d '{"retailer": "carrefour", "product": "garlic"}'
```

No API key is set up since this is scoped to your own device only. If
you ever want other machines/people to reach it, that needs two changes:
change `host="127.0.0.1"` to `host="0.0.0.0"` in `app.py`, and add an API
key check (say the word and I'll wire that up) - don't open it up
without that, since it's driving a real browser against live retailer
sites on your behalf.

## Setup

```bash
cd veggie-price-comparator
python -m venv venv
source venv/bin/activate        # on Windows: venv\Scripts\activate

pip install -r requirements.txt
playwright install chromium
```

## Run

```bash
python app.py
```

Then open **<http://127.0.0.1:5000>** in your browser.

First run: the table starts empty. Pick "All Retailers" / "All Configured
Products" (or narrow it down) and click **Fetch latest prices** — each
successful lookup becomes a cell in the table, and running it again on a
different day adds a new date column, building the price history over
time.

## Notes

- Each lookup spins up a real headless Chrome via Playwright, so one
  retailer × one product takes a few seconds, and leaving both dropdowns
  on "All" runs 5 × 8 = 40 lookups one after another — figure several
  minutes. Say the word if you'd like that parallelized to speed it up.
- Barakat, Kibsons, and Union Coop selectors in `scraper/config.py` are
  marked in the comments as best-effort guesses — if a lookup fails or
  grabs the wrong product for those three, that's the place to fix it
  (inspect the live search results page and update `result_selector`);
  the retailer-specific scraping logic itself lives in that retailer's
  own file under `scraper/`.
- If Playwright can't launch Chrome, run `playwright install chromium`
  again, or drop `channel="chrome"` from the `launch()` calls in
  `scraper/utils.py` (and in `scraper/barakat.py`'s `find_url`, which
  doesn't go through `utils.launch_stealth_browser`) to use Playwright's
  bundled Chromium instead of your system Chrome.
