# Pin this to match the playwright version in requirements.txt exactly -
# a mismatch here is the most common cause of "browser not found" at deploy.
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

WORKDIR /app

# opencv-python-headless still needs these two shared libs even though
# Playwright's base image already ships Chromium + its own dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Note: no `playwright install chrome` step needed - the scraper uses
# Playwright's own bundled Chromium (already in this base image), not real
# Google Chrome, since Chromium has a smaller memory footprint that's a
# better fit for constrained hosts (e.g. Render's free/starter tiers).

# Pre-download PaddleOCR's det/rec/cls models at build time so the container
# doesn't spend 60+ seconds fetching them on every cold start (this was
# causing the 502s: gunicorn was up and "listening" but the single worker
# was still blocked downloading models on first import/request).
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='en', use_angle_cls=True)"

COPY . .

# Railway/Render inject PORT at runtime; -w 1 matters because JOBS in
# app.py is an in-memory dict - multiple worker processes would each keep
# their own copy and job polling would break.
CMD gunicorn -w 1 --timeout 120 -b 0.0.0.0:${PORT:-5000} app:app