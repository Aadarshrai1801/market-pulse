"""
Small helpers shared by more than one retailer module. Nothing here is
retailer-specific - if it only applies to one site, it belongs in that
site's own file instead.
"""

import re

STEALTH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def launch_stealth_browser(playwright):
    browser = playwright.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    )

    context = browser.new_context(
        user_agent=STEALTH_USER_AGENT,
        viewport={"width": 1366, "height": 768},
        locale="en-US",
    )

    context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined
        });
    """)

    page = context.new_page()

    return browser, context, page


def parse_weight_to_kg(text):
    """
    Returns:
        (value, unit_type)

    unit_type is:
        "kg" -> value is in kilograms
        "l"  -> value is in litres

    Examples:
        "500g"          -> (0.5, "kg")
        "2 kg"          -> (2.0, "kg")
        "400ml"         -> (0.4, "l")
        "1.5L"          -> (1.5, "l")
        "2 x 400 ml"    -> (0.8, "l")
    """

    if not text:
        return None, None

    text = str(text)

    # -------------------------
    # Multipack
    # 2 x 400 ml
    # 3x250g
    # -------------------------

    multi = re.search(
        r'(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|gm|gram|grams|l|lt|ltr|litre|liter|litres|liters|ml)\b',
        text,
        re.IGNORECASE
    )

    if multi:

        count = int(multi.group(1))
        value = float(multi.group(2))
        unit = multi.group(3).lower()

        total = count * value

    else:

        single = re.search(
            r'(\d+(?:\.\d+)?)\s*(kg|g|gm|gram|grams|l|lt|ltr|litre|liter|litres|liters|ml)\b',
            text,
            re.IGNORECASE
        )

        if not single:
            return None, None

        total = float(single.group(1))
        unit = single.group(2).lower()

    # -------------------------
    # Weight
    # -------------------------

    if unit == "kg":
        return total, "kg"

    if unit in ("g", "gm", "gram", "grams"):
        return total / 1000, "kg"

    # -------------------------
    # Volume
    # -------------------------

    if unit in ("l", "lt", "ltr", "litre", "liter", "litres", "liters"):
        return total, "l"

    if unit == "ml":
        return total / 1000, "l"

    return None, None


def parse_price_value(price_text):
    """Pull the numeric amount out of a price string like 'AED 3.99' -> 3.99."""
    if not price_text:
        return None
    match = re.search(r'\d+(?:\.\d+)?', price_text)
    return float(match.group()) if match else None
