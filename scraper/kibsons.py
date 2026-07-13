"""
Kibsons.

NOTE (from the original SITE_SEARCH_CONFIG comment): this site's
search_url/result_selector are a best-effort guess, not confirmed
against the live, JS-rendered search results page. If find_url() fails
or grabs the wrong link, inspect a real search results page in the
browser and update SITE_SEARCH_CONFIG["kibsons"] in config.py.
"""

import re
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import SITE_SEARCH_CONFIG
from .utils import launch_stealth_browser, parse_weight_to_kg

SITE = "kibsons"


def find_url(product_name):
    config = SITE_SEARCH_CONFIG[SITE]

    query = product_name.strip().replace(" ", "%20")
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(50000)

        links = page.locator(config["result_selector"])

        matches = []

        for i in range(links.count()):
            try:
                link = links.nth(i)

                text = link.inner_text().strip().lower()
                url = link.get_attribute("href")

                if not url:
                    continue

                score = 0

                if product_name.lower() in text:
                    score += 2

                if product_name.lower().replace(" ", "-") in url.lower():
                    score += 2

                if score > 0:
                    matches.append((score, url))

            except Exception:
                continue

        matches.sort(reverse=True)
        href = matches[0][1] if matches else None

        browser.close()

    if not href:
        raise ValueError(f"Couldn't find '{product_name}' on {SITE}.")

    if href.startswith("/"):
        href = config["base_url"].rstrip("/") + href

    return href


def scrape(url):
    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)

        # ---------------------------------------------------------
        # PRODUCT NAME
        # ---------------------------------------------------------
        title = None

        try:
            title = page.locator("h1").first.inner_text().strip()
        except Exception:
            pass

        # ---------------------------------------------------------
        # PRODUCT WEIGHT (Example: 100g)
        # ---------------------------------------------------------
        weight_kg = None

        try:
            weight_text = page.locator(
                "div.tw-text-primary.tw-py-1"
            ).first.inner_text().strip()

            weight_kg, _ = parse_weight_to_kg(weight_text)

        except Exception:
            pass

        # ---------------------------------------------------------
        # PRODUCT PRICE (Example: 9.95/pack)
        # ---------------------------------------------------------
        price_value = None

        try:
            price_text = page.locator(
                "p.tw-font-\\[600\\]"
            ).first.inner_text().strip()

            match = re.search(r"\d+(?:\.\d+)?", price_text)

            if match:
                price_value = float(match.group())

        except Exception:
            pass

        # ---------------------------------------------------------
        # PER KG PRICE
        # ---------------------------------------------------------
        per_kg_price = None

        if weight_kg is not None and price_value is not None:
            per_kg = price_value / weight_kg
            per_kg_price = f"AED {per_kg:.2f}/kg"

        # ---------------------------------------------------------
        # COUNTRY OF ORIGIN
        # ---------------------------------------------------------
        country = None

        try:
            country = page.locator(
                "div.tw-text-green.tw-uppercase"
            ).first.inner_text().strip()

        except Exception:
            pass

        browser.close()

        return {
            "product": title,
            "per_kg_price": per_kg_price,
            "country_of_origin": country,
            "url": url,
            "supermarket": "kibsons",
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
