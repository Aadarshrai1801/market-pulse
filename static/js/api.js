import { appState, setStatus, toDateKey } from './utils.js';

const API_BASE = '';

// Every API call goes through this so a lost/expired session bounces the
// user back to /login instead of the page silently failing to load data.
async function handleAuthRedirect(response) {
  if (response.status === 401) {
    let body = {};
    try { body = await response.clone().json(); } catch { /* not JSON */ }
    if (body.auth_required) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      // Never resolves - we're navigating away.
      return new Promise(() => {});
    }
  }
  return response;
}

export async function getCurrentUser() {
  const response = await fetch(`${API_BASE}/api/auth/me?_=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to check login status.');
  const data = await response.json();
  return data.user || null;
}

export async function login(username, password) {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Invalid username or password.');
  }
  return data.user;
}

export async function logout() {
  await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
}

export async function changeOwnPassword(currentPassword, newPassword) {
  const response = await fetch(`${API_BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to change password.');
  return true;
}

// Updates the logged-in user's own username and/or password in one call.
// Pass null/undefined/empty-string for newUsername or newPassword to leave
// that field unchanged. Returns the updated { id, username, role } user.
export async function updateOwnProfile(currentPassword, newUsername, newPassword) {
  const response = await fetch(`${API_BASE}/api/auth/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current_password: currentPassword,
      new_username: newUsername || undefined,
      new_password: newPassword || undefined,
    }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to update account.');
  return data.user;
}

// ---- Admin: user management ----

export async function listUsers() {
  const response = await fetch(`${API_BASE}/api/users?_=${Date.now()}`, { cache: 'no-store' });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load users.');
  return data.users;
}

export async function createUser(username, password, role) {
  const response = await fetch(`${API_BASE}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to create user.');
  return data.users;
}

export async function updateUserRole(userId, role) {
  const response = await fetch(`${API_BASE}/api/users/${userId}/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to update role.');
  return data.users;
}

export async function setUserActive(userId, isActive) {
  const response = await fetch(`${API_BASE}/api/users/${userId}/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_active: isActive }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to update user status.');
  return data.users;
}

export async function resetUserPassword(userId, password) {
  const response = await fetch(`${API_BASE}/api/users/${userId}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to reset password.');
  return true;
}

export async function deleteUser(userId) {
  const response = await fetch(`${API_BASE}/api/users/${userId}`, { method: 'DELETE' });
  await handleAuthRedirect(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to delete user.');
  return data.users;
}

export async function loadMeta() {
  const response = await fetch(`${API_BASE}/api/meta?_=${Date.now()}`, { cache: 'no-store' });
  await handleAuthRedirect(response);
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
  await handleAuthRedirect(response);

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
  await handleAuthRedirect(response);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to start the background scrape job.');
  }

  return response.json();
}

export async function pollJob(jobId, onProgress) {
  const response = await fetch(`${API_BASE}/api/jobs/${jobId}?_=${Date.now()}`, { cache: 'no-store' });
  await handleAuthRedirect(response);
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
  await handleAuthRedirect(response);
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
  await handleAuthRedirect(response);

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