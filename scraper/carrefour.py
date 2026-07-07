"""
Carrefour UAE.

Confirmed working: generic search-page flow (goto search URL, grab the
Nth matching link) plus body-text price/origin scraping on the product
page.
"""

import re
from datetime import datetime

from playwright.sync_api import sync_playwright

from .config import SITE_SEARCH_CONFIG
from .utils import launch_stealth_browser

SITE = "carrefour"


def find_url(product_name):
    config = SITE_SEARCH_CONFIG[SITE]
    result_index = config.get("result_index", 0)

    query = product_name.strip().replace(" ", "%20")
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)

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
        browser = p.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 768},
            locale="en-US",
            )
        # hide the webdriver flag so the site doesn't flag us as a bot
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        page = context.new_page()
        page.goto(url, wait_until="commit", timeout=60000)

        # page loads content async, wait until price shows up somewhere
        try:
            page.wait_for_function("document.body.innerText.includes('AED')", timeout=20000)
        except Exception:
            pass  # if it times out we'll just try to scrape whatever's there

        page.wait_for_timeout(2000)  # extra buffer, site is a bit slow to settle
        # (moved outside the except block above - it now always runs, not
        # just when the AED wait times out)

        try:
            title = page.locator("h1").first.text_content(timeout=5000).strip()  # type: ignore
        except Exception:
            title = None

        body_text = page.locator("body").inner_text()

        # grab prices from the page text
        prices_found = re.findall(r'AED\s?[\d]+\.\d{2}', body_text)
        main_price = prices_found[0] if prices_found else None

        per_unit = re.findall(
            r'AED\s?[\d]+\.\d{2}\s?(?:/|per)\s?(?:Kg|kg|g|L|l|ml|Pc|pc)',
            body_text,
            re.IGNORECASE
        )
        per_unit_price = per_unit[0] if per_unit else None

        country_of_origin = page.evaluate("""
            () => {
                const labels = Array.from(document.querySelectorAll('*'))
                    .filter(el => el.children.length === 0 && el.textContent.trim() === 'Origin');

                for (const label of labels) {
                    let container = label.parentElement;
                    for (let i = 0; i < 4 && container; i++) {
                        const flagImg = container.querySelector('img[src*="countryimages/"]');
                        if (flagImg && flagImg.getAttribute('alt') && flagImg.getAttribute('alt') !== 'Flag') {
                            return flagImg.getAttribute('alt');
                            }
                        if (container.nextElementSibling) {
                            const nextFlag = container.nextElementSibling.querySelector('img[src*="countryimages/"]');
                            if (nextFlag && nextFlag.getAttribute('alt')) {
                                    return nextFlag.getAttribute('alt');
                            }
                        }
                        container = container.parentElement;
                    }
                }
                return null;
            }
        """)

        if not country_of_origin:
            origin_match = re.search(r'Origin\s*\n\s*([A-Za-z\s]+?)\s*\n', body_text)
            country_of_origin = origin_match.group(1).strip() if origin_match else "UAE"

        browser.close()

        return {
            "product": title,
            "per_kg_price": per_unit_price,
            "country_of_origin": country_of_origin,
            "url": url,
            "supermarket": "carrefour",
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }