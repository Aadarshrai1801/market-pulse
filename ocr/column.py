"""
Simulates OCR tokens for the reported failure case and runs them through
the fixed pipeline in ocr.py, without needing PaddleOCR/paddle installed.
"""
import sys
import types

# --- stub out paddleocr / paddle so ocr.py's import succeeds ---
fake_paddleocr = types.ModuleType("paddleocr")
class _FakePaddleOCR:
    def __init__(self, *a, **k): pass
    def ocr(self, *a, **k): return [[]]
fake_paddleocr.PaddleOCR = _FakePaddleOCR
sys.modules["paddleocr"] = fake_paddleocr

fake_paddle = types.ModuleType("paddle")
fake_paddle.device = types.SimpleNamespace(
    is_compiled_with_cuda=lambda: False,
    cuda=types.SimpleNamespace(device_count=lambda: 0),
)
sys.modules["paddle"] = fake_paddle

import ocr  # noqa: E402

def tok(text, cx, cy):
    return ocr.OCRResult(text=text, confidence=0.95, bbox=[[cx-5, cy-5]]*4, center_x=cx, center_y=cy)

# Approximate x-positions modeled after the reference sheet's columns:
#   #      country   shipment   product        weight  packing   price
#   30     110       230        310-640(wide)  660     760       880
HEADER_Y = 100
rows = []

def add_row(y, idx, country, shipment, product, weight, packing, price):
    r = [tok(str(idx), 30, y), tok(country, 110, y)]
    if shipment:
        r.append(tok(shipment, 230, y))
    # Short product text sits close to the LEFT edge of the product
    # column (this is the actual bug trigger) rather than centered
    # mid-column like the header word "Product" is.
    prod_x = 320 if len(product) < 14 else 400
    r.append(tok(product, prod_x, y))
    r.append(tok(weight, 660, y))
    r.append(tok(packing, 760, y))
    r.append(tok(price, 880, y))
    rows.append(r)

# Header row
header_row = [
    tok("Country", 110, HEADER_Y), tok("of Origin", 130, HEADER_Y),
    tok("Shipment", 230, HEADER_Y), tok("By", 250, HEADER_Y),
    tok("Product", 475, HEADER_Y),
    tok("Weight", 660, HEADER_Y), tok("(Kg)", 670, HEADER_Y),
    tok("Packing", 760, HEADER_Y),
    tok("Price", 880, HEADER_Y), tok("(AED)", 890, HEADER_Y),
]
rows.append(header_row)

y = 200
add_row(y, 22, "India", "Sea", "Rk Banana (Elaichi)", "4.0", "Carton", "25.00"); y += 40
add_row(y, 23, "India", "Air", "Fresh Turmeric Root", "3.5", "Mesh Bag", "40.00"); y += 40
add_row(y, 24, "India", "Air", "Okra (Bhindi)", "4.0", "Carton", "36.00"); y += 40
add_row(y, 25, "India", "Air", "Goose Berry (Amla)", "3.5", "Mesh Bag", "22.00"); y += 40
add_row(y, 26, "India", "Air", "Ivy Gourd", "3.0", "Mesh Bag", "20.00"); y += 40
add_row(y, 27, "India", "Air", "Cluster Beans", "3.0", "Mesh Bag", "22.00"); y += 40
add_row(y, 28, "India", "Air", "Shallots (Small Onion)", "3.0", "Mesh Bag", "10.00"); y += 40

all_tokens = [t for row in rows for t in row]

result = ocr.extract_table(all_tokens)

print("\n=== STRUCTURED OUTPUT ===")
for r in result:
    print(r)

print("\n=== REVIEW LOG ===")
for entry in ocr.get_review_log():
    print(entry)

print("\n=== PASS/FAIL CHECK ===")
expected_products = [
    "Rk Banana (Elaichi)", "Fresh Turmeric Root", "Okra (Bhindi)",
    "Goose Berry (Amla)", "Ivy Gourd", "Cluster Beans",
    "Shallots (Small Onion)",
]
ok = True
for exp, got in zip(expected_products, result):
    match = exp.lower().replace(" ", "") == got["product"].lower().replace(" ", "")
    status = "OK " if match else "FAIL"
    if not match:
        ok = False
    print(f"{status} expected product={exp!r:30} got product={got['product']!r:30} shipment={got['shipment']!r}")

print("\nALL PASS" if ok else "\nSOME FAILURES")