import os
import re
import threading
import uuid
from datetime import datetime

from flask import Flask, request, jsonify, render_template
from openpyxl import load_workbook

from scraper import (
    SITE_SEARCH_CONFIG,
    find_product_url,
    get_product_details,
    save_to_excel,
)
from products_config import PRODUCTS, PRODUCTS_BY_ID, RETAILER_LABELS, get_search_keyword

app = Flask(__name__)

RETAILERS = list(SITE_SEARCH_CONFIG.keys())
EXCEL_PATH = "products.xlsx"

# In-memory job store for the async fetch API - fine for single-device use
# (resets if the app restarts, which is expected here).
JOBS = {}
JOBS_LOCK = threading.Lock()


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _price_to_float(text):
    if not text:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)", text)
    return float(m.group(1)) if m else None


def _resolve_retailers(retailer_param):
    if not retailer_param or retailer_param == "all":
        return RETAILERS
    if retailer_param not in SITE_SEARCH_CONFIG:
        return []
    return [retailer_param]


def _resolve_products(product_param):
    if not product_param or product_param == "all":
        return PRODUCTS
    p = PRODUCTS_BY_ID.get(product_param)
    return [p] if p else []


def _scrape_one(product, retailer):
    """Run one product x retailer lookup, save it if it succeeds, and
    always return a plain-dict result (never raises)."""
    keyword = get_search_keyword(product, retailer)

    try:
        url = find_product_url(retailer, keyword)
        data = get_product_details(url, retailer)
        data["ok"] = True
        data["product_id"] = product["id"]
        data["product_label"] = product["name"]
        data["product_emoji"] = product["emoji"]

        save_to_excel(
            data,
            filepath=EXCEL_PATH,
            product_id=product["id"],
            product_label=product["name"],
        )
        return data
    except Exception as e:
        return {
            "ok": False,
            "supermarket": retailer,
            "product_id": product["id"],
            "product_label": product["name"],
            "product_emoji": product["emoji"],
            "keyword_used": keyword,
            "error": str(e),
        }


# ------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ------------------------------------------------------------------
# API: dropdown options
# ------------------------------------------------------------------

@app.route("/api/meta")
def api_meta():
    return jsonify({
        "retailers": [
            {"id": r, "name": RETAILER_LABELS.get(r, r.capitalize())}
            for r in RETAILERS
        ],
        "products": [
            {"id": p["id"], "name": p["name"], "emoji": p["emoji"]}
            for p in PRODUCTS
        ],
    })


# ------------------------------------------------------------------
# API: fetch fresh prices (runs the scraper, appends to products.xlsx)
# ------------------------------------------------------------------

@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    """
    Synchronous fetch - fine for a single retailer/product (a few seconds),
    but for bigger requests (especially "all"/"all", ~40 lookups) this
    call will sit open for minutes. Use POST /api/jobs instead for those -
    it returns immediately and you poll for progress.
    """
    payload = request.get_json(force=True, silent=True) or {}

    retailer_param = (payload.get("retailer") or "all").strip().lower()
    product_param = (payload.get("product") or "all").strip().lower()

    retailers = _resolve_retailers(retailer_param)
    products = _resolve_products(product_param)

    if not retailers:
        return jsonify({"ok": False, "error": f"Unknown retailer '{retailer_param}'."}), 400
    if not products:
        return jsonify({"ok": False, "error": f"Unknown product '{product_param}'."}), 400

    results = [
        _scrape_one(product, retailer)
        for product in products
        for retailer in retailers
    ]

    return jsonify({
        "ok": True,
        "fetched": len(results),
        "results": results,
    })


# ------------------------------------------------------------------
# API: async jobs (submit now, poll for progress/results later)
# ------------------------------------------------------------------

def _run_fetch_job(job_id, retailers, products):
    for product in products:
        for retailer in retailers:
            result = _scrape_one(product, retailer)

            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if job is None:
                    return  # job was cleared/removed while running
                job["results"].append(result)
                job["completed"] += 1

    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job["status"] = "done"
            job["finished_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@app.route("/api/jobs", methods=["POST"])
def api_create_job():
    """
    Kick off a fetch in the background and return immediately.
    Body: {"retailer": "all"|<id>, "product": "all"|<id>}
    """
    payload = request.get_json(force=True, silent=True) or {}

    retailer_param = (payload.get("retailer") or "all").strip().lower()
    product_param = (payload.get("product") or "all").strip().lower()

    retailers = _resolve_retailers(retailer_param)
    products = _resolve_products(product_param)

    if not retailers:
        return jsonify({"ok": False, "error": f"Unknown retailer '{retailer_param}'."}), 400
    if not products:
        return jsonify({"ok": False, "error": f"Unknown product '{product_param}'."}), 400

    job_id = uuid.uuid4().hex[:12]

    with JOBS_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "status": "running",
            "retailer": retailer_param,
            "product": product_param,
            "total": len(retailers) * len(products),
            "completed": 0,
            "results": [],
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "finished_at": None,
        }

    thread = threading.Thread(
        target=_run_fetch_job,
        args=(job_id, retailers, products),
        daemon=True,
    )
    thread.start()

    with JOBS_LOCK:
        total = JOBS[job_id]["total"]

    return jsonify({"ok": True, "job_id": job_id, "status": "running", "total": total}), 202


@app.route("/api/jobs/<job_id>")
def api_get_job(job_id):
    """Poll this for progress/results: {status: 'running'|'done', completed, total, results}."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return jsonify({"ok": False, "error": f"Unknown job id '{job_id}'."}), 404
        # shallow copy so the caller gets a stable snapshot even if the
        # background thread is still appending to it
        snapshot = dict(job)
        snapshot["results"] = list(job["results"])

    return jsonify({"ok": True, **snapshot})


@app.route("/api/jobs")
def api_list_jobs():
    """Recent jobs, newest first (without their full result payloads)."""
    with JOBS_LOCK:
        jobs = [
            {k: v for k, v in job.items() if k != "results"}
            for job in JOBS.values()
        ]

    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return jsonify({"ok": True, "jobs": jobs})


# ------------------------------------------------------------------
# API: history matrix (product+retailer rows x date columns)
# ------------------------------------------------------------------

@app.route("/api/history")
def api_history():
    retailer_param = (request.args.get("retailer") or "all").strip().lower()
    product_param = (request.args.get("product") or "all").strip().lower()

    empty = {
        "dates": [],
        "rows": [],
        "counts": {"dates": 0, "products": 0, "retailers": 0},
    }

    if not os.path.exists(EXCEL_PATH):
        return jsonify(empty)

    wb = load_workbook(EXCEL_PATH, read_only=True)
    sheet = wb.active

    header = [c.value for c in next(sheet.iter_rows(min_row=1, max_row=1))] #type: ignore

    try:
        idx = {name: header.index(name) for name in [
            "Product ID", "Product Label", "Per Kg Price",
            "Supermarket", "Timestamp",
        ]}
    except ValueError:
        # old-format workbook without Product ID/Label columns
        return jsonify(empty)

    # cell[key=(product_id, retailer)][date_iso] = latest price that day
    cells = {}
    date_set = set()

    for row in sheet.iter_rows(min_row=2): #type: ignore
        values = [c.value for c in row]
        if len(values) <= max(idx.values()):
            continue

        product_id = values[idx["Product ID"]]
        product_label = values[idx["Product Label"]]
        retailer = values[idx["Supermarket"]]
        price_text = values[idx["Per Kg Price"]]
        timestamp = values[idx["Timestamp"]]

        if not product_id or not retailer or not timestamp:
            continue
        if product_param != "all" and product_id != product_param:
            continue
        if retailer_param != "all" and retailer != retailer_param:
            continue

        try:
            date_iso = str(timestamp)[:10]
        except Exception:
            continue

        price = _price_to_float(price_text)
        date_set.add(date_iso)

        key = (product_id, retailer)
        cells.setdefault(key, {"product_label": product_label, "prices": {}})
        # later rows overwrite earlier ones for the same day -> "latest wins"
        cells[key]["prices"][date_iso] = price

    wb.close()

    dates = sorted(date_set)

    rows = []
    for (product_id, retailer), info in sorted(cells.items(), key=lambda kv: (kv[1]["product_label"] or "", kv[0][1])):
        product = PRODUCTS_BY_ID.get(product_id, {})
        rows.append({
            "product_id": product_id,
            "product_label": info["product_label"] or product.get("name", product_id),
            "product_emoji": product.get("emoji", "🥬"),
            "retailer": retailer,
            "retailer_label": RETAILER_LABELS.get(retailer, retailer.capitalize()),
            "prices": info["prices"],
        })

    distinct_products = {r["product_id"] for r in rows}
    distinct_retailers = {r["retailer"] for r in rows}

    return jsonify({
        "dates": dates,
        "rows": rows,
        "counts": {
            "dates": len(dates),
            "products": len(distinct_products),
            "retailers": len(distinct_retailers),
        },
    })


if __name__ == "__main__":
    # host="127.0.0.1" -> only reachable from this device, never from your
    # network or the internet. threaded=True so a GET /api/jobs/<id> poll
    # can be answered while a background fetch job is still running.
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)