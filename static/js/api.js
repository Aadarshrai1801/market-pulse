import { appState, setStatus, toDateKey } from './utils.js';

const API_BASE = '';

export async function loadMeta() {
  const response = await fetch(`${API_BASE}/api/meta?_=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Unable to load retailer and product metadata from the Flask backend.');
  }
  const data = await response.json();
  appState.meta = {
    retailers: data.retailers || [],
    products: data.products || [],
  };
  return appState.meta;
}

export async function fetchPrices(payload) {
  const response = await fetch(`${API_BASE}/api/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The scrape request failed.');
  }

  const data = await response.json();
  return (data.results || []).map((item) => mapScrapeResult(item));
}

export async function createJob(payload) {
  const response = await fetch(`${API_BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to start the background scrape job.');
  }

  return response.json();
}

export async function pollJob(jobId, onProgress) {
  const response = await fetch(`${API_BASE}/api/jobs/${jobId}?_=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'The job could not be polled.');
  }

  const data = await response.json();
  if (typeof onProgress === 'function') {
    onProgress(data);
  }
  return data;
}

export async function loadHistory(payload = {}) {
  const params = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  params.set('_', String(Date.now()));
  const query = params.toString();
  const response = await fetch(`${API_BASE}/api/history?${query}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Unable to load scrape history.');
  }
  return response.json();
}

export function mapScrapeResult(item) {
  const price = parseFloat(String(item.per_kg_price || '').match(/\d+(?:\.\d+)?/)?.[0] || '0');
  const origin = item.origin_country ?? item.originCountry ?? item.country ?? item.origin
    ?? item.country_of_origin ?? item.countryOfOrigin ?? item.source_country ?? item.product_origin ?? '';
  return {
    date: toDateKey(new Date()),
    fetched_at: new Date().toISOString(),
    retailer: String(item.supermarket || '').trim(),
    product: String(item.product_label || item.product_id || '').trim(),
    price: Number.isFinite(price) ? price : 0,
    origin_country: String(origin).trim() || '—',
    unit: 'per kg',
    currency: 'AED',
    source: 'scraper',
  };
}

export async function ocrScan(file) {
  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch(`${API_BASE}/api/ocr`, {
    method: 'POST',
    body: formData, // no Content-Type header — the browser sets the multipart boundary itself
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'OCR request failed.');
  }

  return response.json(); // expected: { items: [{ product, price, confidence }], confidence }
}

export function mapHistoryResponse(data) {
  return {
    dates: data.dates || [],
    rows: (data.rows || []).map((row) => ({
      ...row,
      prices: row.prices || {},
    })),
    counts: data.counts || { dates: 0, products: 0, retailers: 0 },
  };
}