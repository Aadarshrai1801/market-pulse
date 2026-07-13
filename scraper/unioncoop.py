"""
Union Coop.

NOTE: result_selector for this site is now "a.product-item-link", matching
Magento 2's default catalog-search results markup (confirmed by the product
URL pattern, e.g. https://www.unioncoop.ae/orange-navel-...html). If this
still fails, check the debug print below for the page title/url that was
actually reached — that usually tells you if it's a selector mismatch or a
bot-block/redirect.
"""

import re
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import SITE_SEARCH_CONFIG
from .utils import launch_stealth_browser

SITE = "unioncoop"

KNOWN_COUNTRIES = [
    "India", "China", "Pakistan", "Egypt", "Iran", "Turkey", "Jordan", "Oman", "UAE",
    "United Arab Emirates", "Saudi Arabia", "South Africa", "Netherlands", "USA",
    "United States", "Australia", "New Zealand", "Spain", "Italy", "France", "Mexico",
    "Lebanon", "Syria", "Morocco", "Sri Lanka", "Thailand", "Vietnam", "Philippines"
]


def find_url(product_name):
    config = SITE_SEARCH_CONFIG[SITE]

    query = product_name.strip().replace(" ", "%20")
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(
            search_url,
            wait_until="domcontentloaded",
            timeout=600000
        )

        page.wait_for_timeout(4000)

        href = None

        # Use the selector that actually works
        links = page.locator("a.result")

        count = links.count()

        for i in range(count):

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

        # Fallback to first result
        if href is None and count > 0:
            href = links.first.get_attribute("href")

        if href is None:
            print(
                f"[unioncoop] 0 results for '{product_name}' — "
                f"page title: {page.title()!r}, url: {page.url}"
            )

        browser.close()

    if not href:
        raise ValueError(f"Couldn't find '{product_name}' on {SITE}.")

    if href.startswith("/"):
        href = config["base_url"].rstrip("/") + href

    return href


def scrape(url):
    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=True,
            channel="chrome"
        )

        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 768},
            locale="en-US",
        )

        context.add_init_script("""
            Object.defineProperty(navigator,'webdriver',{
                get:()=>undefined
            });
        """)

        page = context.new_page()

        page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=60000
        )

        page.wait_for_timeout(3000)

        # ---------------------------------------------------------
        # PRODUCT NAME
        # ---------------------------------------------------------

        title = None

        try:
            title = page.locator("span.base").first.inner_text().strip()
        except Exception:
            pass

        # ---------------------------------------------------------
        # COUNTRY OF ORIGIN
        # ---------------------------------------------------------

        country_of_origin = "United Arab Emirates"

        original_title = title  # Keep original title for weight extraction

        if original_title:
            lower_title = original_title.lower()

            for country in KNOWN_COUNTRIES:
                if country.lower() in lower_title:
                    country_of_origin = country
                    break

            # Remove country from display title only
            title = original_title

            for country in KNOWN_COUNTRIES:
                title = re.sub(
                    rf"\s*-\s*{re.escape(country)}",
                    "",
                    title,
                    flags=re.IGNORECASE
                )

            # Remove trailing weight from display title
            title = re.sub(
                r"\s*-\s*\d+(?:\.\d+)?\s*(kg|g)\b",
                "",
                title,
                flags=re.IGNORECASE
            ).strip()

        # ---------------------------------------------------------
        # PER KG PRICE
        # ---------------------------------------------------------

        per_kg_price = None

        try:

            price_box = page.locator(
                "div.price-box.price-final_price"
            ).first

            box_text = price_box.inner_text().strip()

            # ------------------------
            # PRODUCT PRICE
            # ------------------------

            price = None

            # Best source
            try:
                price = float(
                    price_box.locator("[data-price-amount]").first.get_attribute("data-price-amount") #type: ignore
                )
            except:
                pass

            # Fallback
            if price is None:

                price_text = price_box.locator(
                    "span.price.price-currency-symbol"
                ).first.inner_text().strip()

                match = re.search(
                    r"([\d.]+)",
                    price_text
                )

                if match:
                    price = float(match.group(1))

            if price is None:
                raise Exception("Price not found")

            # ------------------------
            # Already per Kg
            # Example:
            # AED 4.95 / Kg
            # ------------------------

            if re.search(r"/\s*kg\b", box_text, re.IGNORECASE):

                per_kg_price = f"AED {price:.2f}/kg"

            else:

                # ------------------------
                # Weight from price section
                # Example:
                # /500g
                # /100g
                # /2kg
                # ------------------------

                weight_match = re.search(
                    r"/\s*(\d+(?:\.\d+)?)\s*(kg|g)\b",
                    box_text,
                    re.IGNORECASE
                )

                # ------------------------
                # If not found, extract from ORIGINAL title
                # ------------------------

                if not weight_match and original_title:

                    weight_match = re.search(
                        r"(\d+(?:\.\d+)?)\s*(kg|g)\b",
                        original_title,
                        re.IGNORECASE
                    )

                if weight_match:

                    weight = float(weight_match.group(1))
                    unit = weight_match.group(2).lower()

                    if unit == "g":
                        weight /= 1000

                    if weight > 0:
                        per_kg_price = f"AED {price / weight:.2f}/kg"

        except Exception as e:
            print(f"[unioncoop] Price Error: {e}")

        browser.close()

        return {

            "product": title,
            "per_kg_price": per_kg_price,
            "country_of_origin": country_of_origin,
            "url": url,
            "supermarket": "unioncoop",
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

        }