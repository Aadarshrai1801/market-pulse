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


def _parse_pack_size_to_kg(text):
    """
    Parses a pack-size string such as '500g', '1kg', '1.5 kg', '6x200g',
    '750ml', or '1L' into an equivalent weight in kilograms.

    Liquids (l/ml) are treated as 1:1 with kg (density ~1, e.g. water/milk) -
    this is an approximation and will be off for dense or light liquids
    (oil, honey, etc.), so treat converted liquid per-kg prices as indicative.

    Returns None if the text can't be confidently parsed.
    """
    if not text:
        return None

    cleaned = text.strip().lower().replace(' ', '')

    # multi-pack, e.g. "6x200g" -> 6 * 200g
    multipack_match = re.match(r'^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(kg|g|l|ml)$', cleaned)
    if multipack_match:
        count_str, amount_str, unit = multipack_match.groups()
        total = float(count_str) * float(amount_str)
    else:
        single_match = re.match(r'^(\d+(?:\.\d+)?)(kg|g|l|ml)$', cleaned)
        if not single_match:
            return None
        amount_str, unit = single_match.groups()
        total = float(amount_str)

    if unit == 'kg':
        return total
    if unit == 'g':
        return total / 1000
    if unit == 'l':
        return total  # approx: 1L ~= 1kg
    if unit == 'ml':
        return total / 1000
    return None


def find_url(product_name):
    config = SITE_SEARCH_CONFIG[SITE]
    result_index = config.get("result_index", 0)

    query = product_name.strip().replace(" ", "%20")
    search_url = config["search_url"].format(query=query)

    with sync_playwright() as p:
        browser, context, page = launch_stealth_browser(p)

        page.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(40000)

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

        # ---- price extraction ----
        # Carrefour renders the price as split spans nested INSIDE a
        # ".force-ltr" wrapper, and that whole thing sits inside an outer
        # "flex items-baseline" div alongside the per-kg text, e.g.
        #
        #   <div class="flex items-baseline">                      <- outer (has BOTH parts)
        #     <div class="flex items-baseline force-ltr">           <- inner (just the price)
        #       <div>AED</div><div>1</div><div>.95</div>
        #     </div>
        #     <div class="text-gray-600">AED 3.89/Kg</div>          <- explicit per-kg text
        #   </div>
        #
        # We target ".force-ltr" specifically so we don't accidentally pull
        # the per-kg text into the main-price parts.
        main_price = None
        try:
            price_container = page.locator("div.flex.items-baseline.force-ltr").first
            if price_container.count() > 0:
                parts = [part.strip() for part in price_container.locator("div").all_text_contents()]
                # parts -> ['AED', '1', '.95']
                if len(parts) >= 3:
                    currency = parts[0]
                    integer_part = parts[1]
                    decimal_part = parts[2].lstrip('.')
                    if integer_part and decimal_part:
                        main_price = f"{currency} {integer_part}.{decimal_part}"
        except Exception:
            main_price = None

        # fallback to plain-text regex if the DOM structure didn't match
        if not main_price:
            prices_found = re.findall(r'AED\s?[\d]+\.\d{2}', body_text)
            main_price = prices_found[0] if prices_found else None

        # ---- per-kg price: prefer Carrefour's own explicit value ----
        # Right next to the main price, Carrefour often shows its own
        # pre-computed per-unit price, e.g. "AED 3.89/Kg". That's the
        # retailer's own calculation (accounts for exact pack weight, taxes,
        # etc.) so we use it whenever it's present, and only fall back to
        # deriving one ourselves from Pack Size if it's missing.
        per_kg_price = None
        try:
            gray_divs = page.locator("div.text-gray-600")
            for i in range(gray_divs.count()):
                candidate = gray_divs.nth(i).text_content().strip() #type: ignore
                match = re.search(r'AED\s?([\d]+\.\d{2})\s?/\s?(kg|g|l|ml)', candidate, re.IGNORECASE)
                if match:
                    value, unit = match.groups()
                    unit = unit.lower()
                    value = float(value)
                    if unit == 'kg' or unit == 'l':
                        per_kg_price = f"AED {value:.2f}"
                    elif unit == 'g' or unit == 'ml':
                        # normalize a per-gram/per-ml figure up to per-kg/per-litre
                        per_kg_price = f"AED {value * 1000:.2f}"
                    else:
                        per_kg_price = main_price
                    break
        except Exception:
            per_kg_price = None

        # fallback: search flattened body text for the same "AED x.xx/Kg" pattern
        if not per_kg_price:
            explicit_match = re.search(r'AED\s?([\d]+\.\d{2})\s?/\s?(kg|g|l|ml)', body_text, re.IGNORECASE)
            if explicit_match:
                value, unit = explicit_match.groups()
                unit = unit.lower()
                value = float(value)
                if unit == 'kg' or unit == 'l':
                    per_kg_price = f"AED {value:.2f}"
                elif unit == 'g' or unit == 'ml':
                    per_kg_price = f"AED {value * 1000:.2f}"

        # ---- pack size extraction (only needed if no explicit per-kg price) ----
        # Carrefour shows the pack size in its own card, e.g.
        #   <div class="flex flex-col items-start ...">
        #     <span>Pack Size</span>
        #     <div><span class="font-bold ...">500g</span></div>
        #   </div>
        # Find the "Pack Size" label, then read the bold value next to it.
        pack_size_raw = None
        if not per_kg_price:
            try:
                label = page.locator("span", has_text=re.compile(r'^\s*Pack Size\s*$'))
                if label.count() > 0:
                    container = label.first.locator("xpath=..")
                    value_span = container.locator("span.font-bold").first
                    if value_span.count() > 0:
                        pack_size_raw = value_span.text_content().strip() #type: ignore
            except Exception:
                pack_size_raw = None

            # fallback: search the flattened body text for a pack-size-looking token
            if not pack_size_raw:
                pack_match = re.search(
                    r'Pack Size\s*\n?\s*([\d.]+\s?(?:kg|g|l|ml)|[\d.]+\s?x\s?[\d.]+\s?(?:kg|g|l|ml))',
                    body_text,
                    re.IGNORECASE,
                )
                pack_size_raw = pack_match.group(1).strip() if pack_match else None

            # ---- convert to per-kg price ourselves, since no explicit value existed ----
            pack_size_kg = _parse_pack_size_to_kg(pack_size_raw) if pack_size_raw else None
            price_value_match = re.search(r'[\d]+\.\d{2}', main_price) if main_price else None
            if price_value_match and pack_size_kg and pack_size_kg > 0:
                price_value = float(price_value_match.group())
                per_kg_value = price_value / pack_size_kg
                per_kg_price = f"AED {per_kg_value:.2f}"
            elif not per_kg_price:
                # No pack size / unit (kg, g, l, ml) could be found anywhere on the
                # page, so there's nothing to derive a per-kg price from. Fall back
                # to treating the item's normal price as its per-kg price rather
                # than leaving it blank.
                per_kg_price = main_price

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
            "price": main_price,
            "pack_size": pack_size_raw,
            "per_kg_price": per_kg_price,
            "country_of_origin": country_of_origin,
            "url": url,
            "supermarket": "carrefour",
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }