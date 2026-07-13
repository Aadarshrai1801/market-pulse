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

COPY . .

# Railway/Render inject PORT at runtime; -w 1 matters because JOBS in
# app.py is an in-memory dict - multiple worker processes would each keep
# their own copy and job polling would break.
CMD gunicorn -w 1 --timeout 120 -b 0.0.0.0:${PORT:-5000} app:app