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
    config = SITE_SEARCH_CONFIG[SITE]

    query = product_name.strip().replace(" ", "%20")
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel="chrome")
        page = browser.new_page()

        page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)

        links = page.locator(config["result_selector"])

        href = None

        for i in range(links.count()):
            try:
                link = links.nth(i)

                text = link.inner_text().strip().lower()
                url = link.get_attribute("href")

                if not url:
                    continue

                if product_name.lower() in text:
                    href = url
                    break

            except Exception:
                continue

        if href is None and links.count() > 0:
            href = links.first.get_attribute("href")

        browser.close()

    if not href:
        raise ValueError(f"Couldn't find '{product_name}' on Barakat.")

    if href.startswith("/"):
        href = config["base_url"].rstrip("/") + href

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
