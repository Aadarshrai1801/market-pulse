# Canonical product catalog shown in the frontend dropdown.
#
# The frontend ALWAYS shows the same product names.
# Each supermarket can use its own search keyword internally.

PRODUCTS = [
    {
        "id": "garlic",
        "name": "Garlic",
        "emoji": "🧄",
        "keywords": {
            "barakat": "Garlic",
            "kibsons": "garlic",
            "unioncoop": "Garlic",
            "carrefour": "Garlic",
            "lulu": "Ginger Garlic",
        },
    },
    {
        "id": "cucumber",
        "name": "Cucumber",
        "emoji": "🥒",
        "keywords": {
            "barakat": "Cucumber",
            "kibsons": "Cucumber",
            "unioncoop": "cucumber",
            "carrefour": "cucumber",
            "lulu": "Cucumber",
        },
    },
    {
        "id": "potato",
        "name": "Potato",
        "emoji": "🥔",
        "keywords": {
            "barakat": "Potatoes",
            "kibsons": " potatoes",
            "unioncoop": "potato",
            "carrefour": "Potato",
            "lulu": "Potato",
        },
    },
    {
        "id": "red_onion",
        "name": "Red Onion",
        "emoji": "🧅",
        "keywords": {
            "barakat": "onions",
            "kibsons": "Red Onion",
            "unioncoop": "red onion",
            "carrefour": "onion",
            "lulu": "red onion",
        },
    },
    {
        "id": "tomato",
        "name": "Tomato",
        "emoji": "🍅",
        "keywords": {
            "barakat": "Tomato",
            "kibsons": "Tomato",
            "unioncoop": "tomato plum roma",
            "carrefour": "Tomato",
            "lulu": "Tomato",
        },
    },
    {
        "id": "orange_valencia",
        "name": "Orange Valencia",
        "emoji": "🍊",
        "keywords": {
            "barakat": "Valencia Orange",
            "kibsons": "Valencia Orange",
            "unioncoop": "orange valencia",
            "carrefour": "Valencia Orange",
            "lulu": "Valencia Orange",
        },
    },
    {
        "id": "orange_navel",
        "name": "Orange Navel",
        "emoji": "🍊",
        "keywords": {
            "barakat": "Navel Orange",
            "kibsons": "Navel Orange",
            "unioncoop": "orange navel",
            "carrefour": "Orange Navel",
            "lulu": "Navel Orange",
        },
    },
    {
        "id": "watermelon",
        "name": "Watermelon",
        "emoji": "🍉",
        "keywords": {
            "barakat": "Watermelon Juice",
            "kibsons": "watermelon",
            "unioncoop": "Watermelon",
            "carrefour": "watermelon-long-green",
            "lulu": "Watermelon saudi",
        },
    },
]

# Dictionary for quick lookup
PRODUCTS_BY_ID = {p["id"]: p for p in PRODUCTS}

# Retailer names shown in the frontend
RETAILER_LABELS = {
    "carrefour": "Carrefour",
    "lulu": "LuLu Hypermarket",
    "barakat": "Barakat",
    "kibsons": "Kibsons",
    "unioncoop": "Union Coop",
}


def get_search_keyword(product, retailer):
    """
    Returns the keyword that should be searched on a particular retailer.
    Falls back to the frontend product name if no retailer-specific keyword exists.
    """
    return product.get("keywords", {}).get(retailer, product["name"])