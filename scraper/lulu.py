"""
LuLu Hypermarket.

Confirmed working. Search is special-cased here (unlike the other sites)
because LuLu's results only appear after actually typing into the
on-page search box and pressing Enter, rather than a plain search URL.
"""

import re
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import SITE_SEARCH_CONFIG
from .utils import launch_stealth_browser, parse_weight_to_kg, parse_price_value

SITE = "lulu"

KNOWN_COUNTRIES = [
    "India", "China", "Pakistan", "Egypt", "Iran", "Turkey", "Jordan", "Oman", "UAE",
    "United Arab Emirates", "Saudi Arabia", "South Africa", "Netherlands", "USA",
    "United States", "Australia", "New Zealand", "Spain", "Italy", "France", "Mexico",
    "Lebanon", "Syria", "Morocco", "Sri Lanka", "Thailand", "Vietnam", "Philippines"
]


from urllib.parse import quote

def find_url(product_name):
    config = SITE_SEARCH_CONFIG[SITE]
    result_index = config.get("result_index", 0)

    query = quote(product_name.strip())
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(
            search_url,
            wait_until="domcontentloaded",
            timeout=60000
        )

        page.wait_for_selector(
            config["result_selector"],
            timeout=15000
        )

        links = page.locator(config["result_selector"])

        href = None

        if links.count() > result_index:
            href = links.nth(result_index).get_attribute("href")

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
        page.wait_for_timeout(3000)

        # try to expand any collapsed "details"/"specifications"/"information"
        # section - a lot of the origin/per-unit data tends to live there and
        # doesn't show up in body text until it's clicked open
        expand_labels = [
            "Product Details", "Specifications", "Product Information",
            "Details", "Information", "Additional Information",
        ]
        for label in expand_labels:
            try:
                el = page.get_by_text(label, exact=False).first
                if el.is_visible(timeout=1000):
                    el.click(timeout=1000)
                    page.wait_for_timeout(500)
            except Exception:
                pass

        body_text = page.locator("body").inner_text()

        # PRODUCT NAME
        title = None

        selectors = [
            "h1",
            "[data-testid='product-title']",
            "[data-testid='product-name']",
            "[class*='product-title']",
            "[class*='ProductTitle']"
        ]

        for selector in selectors:
            try:
                text = page.locator(selector).first.inner_text().strip()
                if text:
                    title = text
                    break
            except Exception:
                pass

        # PRICE

        price = None
        price_value = None

        try:
            price_text = page.locator("[data-testid='price']").inner_text().strip()

            price_value = float(price_text)
            price = f"AED {price_value:.2f}"

        except Exception:
            try:
                body_text = page.locator("body").inner_text()
                match = re.search(r"\d+\.\d{2}", body_text)

                if match:
                    price_value = float(match.group())
                    price = f"AED {price_value:.2f}"

            except Exception:
                pass

        # UNIT / PACK SIZE + PER-KG PRICE
        # Lulu doesn't show a "AED x.xx/Kg" string like Carrefour does - the
        # pack size (e.g. "200 g") is only in the title, so we parse that
        # ourselves and calculate the per-kg price from the actual price.
        value, unit = parse_weight_to_kg(title or "")

        if value is None:
            # fall back to searching the whole page text in case the size
            # is shown somewhere else (e.g. a variant selector) but not in <h1>
            value, unit = parse_weight_to_kg(body_text)

        if price_value is None:
            price_value = parse_price_value(price)

        per_kg_price = None
        if value and price_value is not None:

            if unit == "kg":
                per_kg_price = f"AED {price_value / value:.2f}/kg"

            elif unit == "l":
                per_kg_price = f"AED {price_value / value:.2f}/L"

        # COUNTRY OF ORIGIN
        country_of_origin = "United Arab Emirates"

        if title:
            lower_title = title.lower()

            for country in KNOWN_COUNTRIES:
                if country.lower() in lower_title:
                    country_of_origin = country
                    break

        browser.close()

        return {
            "product": title,
            "per_kg_price": per_kg_price,
            "country_of_origin": country_of_origin,
            "url": url,
            "supermarket": "lulu",
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
