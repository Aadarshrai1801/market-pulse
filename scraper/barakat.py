"""
Barakat Fresh.

NOTE (from the original SITE_SEARCH_CONFIG comment): this site's
search_url/result_selector are a best-effort guess, not confirmed
against the live, JS-rendered search results page. If find_url() fails
or grabs the wrong link, inspect a real search results page in the
browser and update SITE_SEARCH_CONFIG["barakat"] in config.py.

find_url() intentionally uses a bare page with no custom stealth context
(unlike every other retailer here) - that's carried over as-is from the
original implementation.
"""

import re
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import SITE_SEARCH_CONFIG
from .utils import launch_stealth_browser

SITE = "barakat"


def find_url(product_name):
    """
    Barakat has no confirmed working search page (see config.py's note on
    "barakat" - the search_url/result_selector there are unverified guesses).
    Instead of searching, guess the product page URL directly from a slug
    of the product name and its common weight-variant suffixes, then
    verify each candidate by checking the page's <h1> actually contains
    the product name.
    """
    config = SITE_SEARCH_CONFIG[SITE]
    base_url = config["base_url"].rstrip("/")

    slug = (
        product_name.lower()
        .strip()
        .replace("&", "and")
        .replace(",", "")
        .replace("/", "-")
        .replace("(", "")
        .replace(")", "")
        .replace(" ", "-")
    )

    # Common plural names used by Barakat
    plural_map = {
        "potato": "potatoes",
        "onion": "onions",
        "red-onion": "onions",
        "white-onion": "onions",
    }

    if slug in plural_map:
        slug = plural_map[slug]

    candidates = [
        # plain
        f"{base_url}/{slug}.html",

        # weight variants
        f"{base_url}/{slug}-250g.html",
        f"{base_url}/{slug}-500g.html",
        f"{base_url}/{slug}-750g.html",
        f"{base_url}/{slug}-1kg.html",
        f"{base_url}/{slug}-2kg.html",

        # common config ids (discovered)
        f"{base_url}/{slug}.html?config=84",
        f"{base_url}/{slug}.html?config=162",
        f"{base_url}/{slug}.html?config=187",
        f"{base_url}/{slug}.html?config=215",
        f"{base_url}/{slug}.html?config=537",
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel="chrome")
        page = browser.new_page()

        href = None

        for candidate in candidates:
            try:
                response = page.goto(candidate, wait_until="domcontentloaded", timeout=15000)

                if response is None or response.status != 200:
                    continue

                page.wait_for_timeout(1500)

                if page.locator("h1").count() == 0:
                    continue

                title = page.locator("h1").first.inner_text().strip().lower()

                if product_name.lower() in title:
                    href = candidate
                    break

            except Exception:
                continue

        browser.close()

    if not href:
        raise ValueError(f"Couldn't find '{product_name}' on Barakat.")

    return href


def scrape(url):
    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)

        # ---------------------------------------------------------
        # PRODUCT NAME
        # ---------------------------------------------------------

        title = None

        try:
            title = page.locator("h1").first.inner_text().strip()
        except Exception:
            pass

        # ---------------------------------------------------------
        # PRICE
        # ---------------------------------------------------------

        price_value = None

        try:
            selectors = [
                "span.styles_price_value__4mAeb",
                "span.styles_price_full__opoLn",
            ]

            for selector in selectors:
                if page.locator(selector).count():
                    price_text = page.locator(selector).first.inner_text().strip()
                    m = re.search(r"(\d+(?:\.\d+)?)", price_text)
                    if m:
                        price_value = float(m.group(1))
                        break

        except Exception:
            pass

        # ---------------------------------------------------------
        # WEIGHT
        # ---------------------------------------------------------

        weight_kg = None

        try:
            selectors = [
                "span.styles_variations_value__7E9NH",
                "span.styles_configs_value_text__kjxvX",
            ]

            weight_text = None

            for selector in selectors:
                if page.locator(selector).count():
                    weight_text = page.locator(selector).first.inner_text().strip()
                    break

            if weight_text:
                m = re.search(
                    r"(\d+(?:\.\d+)?)\s*(kg|g)",
                    weight_text,
                    re.I
                )

                if m:
                    weight = float(m.group(1))
                    unit = m.group(2).lower()

                    if unit == "g":
                        weight_kg = weight / 1000
                    else:
                        weight_kg = weight

        except Exception:
            pass

        # ---------------------------------------------------------
        # PER KG PRICE
        # ---------------------------------------------------------

        per_kg_price = None

        if (
            price_value is not None
            and weight_kg is not None
            and weight_kg > 0
        ):
            perkg = price_value / weight_kg
            per_kg_price = f"AED {perkg:.2f}/kg"
        elif price_value is not None:
            # No weight found on page - fall back to the raw price
            # for this specific product instead of returning None.
            per_kg_price = f"AED {price_value:.2f}"

        # ---------------------------------------------------------
        # COUNTRY OF ORIGIN
        # ---------------------------------------------------------

        country = "United Arab Emirates"

        try:
            selectors = [
                "span.styles_badges_text__WJmpL",
                "div.styles_details_origin__6Hu0I span",
            ]

            for selector in selectors:
                if page.locator(selector).count():
                    country = page.locator(selector).first.inner_text().strip()
                    break

        except Exception:
            pass

        browser.close()

        return {
            "product": title,
            "per_kg_price": per_kg_price,
            "country_of_origin": country,
            "url": url,
            "supermarket": SITE,
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }