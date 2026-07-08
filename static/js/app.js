import {
  appState, loadState, saveState, setStatus, escapeHtml, formatPrice, flag, countryCode, normalizeCountryName,
  createRetailerPill, getProductMeta, normalizeRetailerId, normalizeProductId,
} from './utils.js';
import {
  loadMeta, createJob, pollJob, loadHistory as loadHistoryApi, mapHistoryResponse, mapScrapeResult,
} from './api.js';
import { renderProductTags, renderProductSelect, renderPresets, addProduct, resetProducts, removeProduct } from './products.js';
import { renderVariationCharts } from './charts.js';

const fetchState = { selectedRetailer: 'all', selectedProduct: 'all' };
let lastPivot = null;   // { dates, rows, counts }
let lastDetail = [];    // flat rows from the most recent fetch(es), merged per product/retailer

// Local YYYY-MM-DD, used to expire the persisted "Latest Fetch Detail" table once the day rolls over.
function todayStr() {
  return new Date().toLocaleDateString('en-CA'); // en-CA formats as YYYY-MM-DD
}

// Detail-table persistence lives directly in localStorage (its own key), rather than
// going through appState/saveState — those only round-trip a fixed set of known fields,
// so a custom field like this one would silently come back empty on every reload.
const DETAIL_STORAGE_KEY = 'marketpulse_detail_cache_v1';

function loadPersistedDetail() {
  try {
    const raw = localStorage.getItem(DETAIL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && Array.isArray(parsed.rows)) ? parsed : null;
  } catch (error) {
    console.warn('[MarketPulse] Could not read persisted detail cache:', error);
    return null;
  }
}

function savePersistedDetail(rows) {
  try {
    localStorage.setItem(DETAIL_STORAGE_KEY, JSON.stringify({ date: todayStr(), rows }));
  } catch (error) {
    console.warn('[MarketPulse] Could not save detail cache:', error);
  }
}

/* ============================== TABS ============================== */

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      const id = button.getAttribute('data-tab');
      document.getElementById(`tab-${id}`)?.classList.add('active');
      if (id === 'variation') renderVariationTab();
    });
  });
}

/* ============================== HEADER ============================== */

function setDateChip() {
  const chip = document.getElementById('dateChip');
  if (chip) chip.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function updateTicker(flatRows) {
  const track = document.getElementById('tickerTrack');
  if (!track) return;
  if (!flatRows.length) { track.innerHTML = ''; return; }
  const grouped = {};
  flatRows.forEach((row) => {
    if (!row.price) return;
    (grouped[row.product] ||= []).push(row.price);
  });
  const items = Object.entries(grouped).map(([id, prices]) => {
    const meta = getProductMeta(id);
    const avg = (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
    return `<span class="tick-item"><span class="tick-name">${escapeHtml((meta.name || id).toUpperCase())}</span><span class="tick-price">${avg}</span>AED/kg</span>`;
  });
  track.innerHTML = [...items, ...items].join(''); // duplicate for a seamless scroll if you add a marquee animation
}

/* ==================== PYTHON BACKEND STATUS CARD ==================== */
/* This replaces the old "Anthropic API key" box — there's no key to store,
   we just confirm the Flask backend (running your scraper.py) is reachable. */

async function checkBackend(showToast = false) {
  const pill = document.getElementById('sourcePill');
  if (pill) { pill.textContent = 'checking…'; pill.className = 'source-pill'; }
  try {
    await loadMeta();
    if (pill) { pill.textContent = '● connected'; pill.className = 'source-pill ok'; }
    if (showToast) setStatus('✓ Python backend reachable', 'ok');
    return true;
  } catch (error) {
    if (pill) { pill.textContent = '● unreachable'; pill.className = 'source-pill err'; }
    if (showToast) setStatus(`✗ ${error.message}`, 'err');
    return false;
  }
}

/* ============================== DROPDOWNS ============================== */

function buildDropdown({ btnEl, labelEl, panelEl, items, selected, onSelect }) {
  panelEl.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'dd-item' + (item.id === 'all' ? ' all-option' : '') + (item.id === selected ? ' selected' : '');
    row.innerHTML = item.emoji ? `<span>${item.emoji}</span><span>${escapeHtml(item.name)}</span>` : `<span>${escapeHtml(item.name)}</span>`;
    row.addEventListener('click', () => {
      onSelect(item);
      labelEl.textContent = item.name;
      closeAllDropdowns();
    });
    panelEl.appendChild(row);
  });
  btnEl.onclick = (event) => {
    event.stopPropagation();
    const isOpen = panelEl.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) { panelEl.classList.add('open'); btnEl.classList.add('open'); }
  };
}

function closeAllDropdowns() {
  document.querySelectorAll('.dd-panel').forEach((panel) => panel.classList.remove('open'));
  document.querySelectorAll('.dd-btn').forEach((button) => button.classList.remove('open'));
}

function renderFetchDropdowns() {
  const retailerItems = [{ id: 'all', name: 'All Retailers' }, ...appState.meta.retailers];
  const productItems = [{ id: 'all', name: 'All Configured Products' }, ...appState.meta.products];

  buildDropdown({
    btnEl: document.getElementById('retailerBtn'),
    labelEl: document.getElementById('retailerLabel'),
    panelEl: document.getElementById('retailerPanel'),
    items: retailerItems,
    selected: fetchState.selectedRetailer,
    onSelect: (item) => { fetchState.selectedRetailer = item.id; renderFetchDropdowns(); loadPivot(); },
  });

  buildDropdown({
    btnEl: document.getElementById('productBtn'),
    labelEl: document.getElementById('productLabel'),
    panelEl: document.getElementById('productPanel'),
    items: productItems,
    selected: fetchState.selectedProduct,
    onSelect: (item) => { fetchState.selectedProduct = item.id; renderFetchDropdowns(); loadPivot(); },
  });
}

/* ============================== PIVOT TABLE ============================== */

function formatDateHeader(iso) {
  const date = new Date(`${iso}T00:00:00`);
  return {
    week: date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    day: date.toLocaleDateString('en-US', { day: '2-digit', month: 'short' }).toUpperCase(),
  };
}

function flattenPivot(payload) {
  const rows = [];
  (payload.rows || []).forEach((row) => {
    Object.entries(row.prices || {}).forEach(([date, price]) => {
      const rawOrigin = row.origins?.[date] ?? row.origin_country ?? row.originCountry ?? row.country ?? row.origin ?? '—';
      rows.push({
        date,
        retailer: row.retailer_id || row.retailer_label || 'unknown',
        product: row.product_id || row.product_label || 'unknown',
        price: Number(price) || 0,
        origin_country: normalizeCountryName(rawOrigin),
      });
    });
  });
  return rows;
}

function renderPivotTable(data) {
  const headRow = document.getElementById('headRow');
  const bodyRows = document.getElementById('bodyRows');
  const table = document.getElementById('priceTable');
  const emptyState = document.getElementById('emptyState');

  headRow.innerHTML = '';
  bodyRows.innerHTML = '';

  const { dates, rows, counts } = data;

  document.getElementById('summaryLine').innerHTML =
    `<b>${counts.dates}</b> dates <span class="sep">·</span> ` +
    `<b>${counts.products}</b> products <span class="sep">·</span> ` +
    `<b>${counts.retailers}</b> retailers <span class="sep">·</span> AED per kg`;

  if (!rows.length) {
    table.style.display = 'none';
    emptyState.style.display = 'block';
    updateStats(data, []);
    return;
  }

  table.style.display = 'table';
  emptyState.style.display = 'none';

  const productHeader = document.createElement('th');
  productHeader.className = 'row-head';
  productHeader.textContent = 'Product';
  headRow.appendChild(productHeader);

  const retailerHeader = document.createElement('th');
  retailerHeader.className = 'retailer-col';
  retailerHeader.textContent = 'Retailer';
  headRow.appendChild(retailerHeader);

  dates.forEach((iso) => {
    const { week, day } = formatDateHeader(iso);
    const header = document.createElement('th');
    header.className = 'date-col';
    header.innerHTML = `<span class="wk">${week}</span><span class="dt">${day}</span>`;
    headRow.appendChild(header);
  });

  // Group rows by product so the Product cell is shown once (spanning all its
  // retailer rows) instead of being repeated on every row.
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.product_id || row.product_label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  groups.forEach((groupRows) => {
    groupRows.forEach((row, idx) => {
      const tr = document.createElement('tr');

      if (idx === 0) {
        const productCell = document.createElement('td');
        productCell.className = 'row-head';
        productCell.rowSpan = groupRows.length;
        productCell.innerHTML = `<div class="prod-cell"><span class="emoji">${row.product_emoji || '🛒'}</span>${escapeHtml(row.product_label || row.product_id)}</div>`;
        tr.appendChild(productCell);
      }

      const retailerCell = document.createElement('td');
      retailerCell.className = 'retailer-cell';
      retailerCell.innerHTML = createRetailerPill(row.retailer_id || row.retailer_label);
      tr.appendChild(retailerCell);

      dates.forEach((iso) => {
        const td = document.createElement('td');
        const value = row.prices[iso];
        // origin can differ day to day, so look it up per-date rather than
        // once per row; falls back to a row-level field for older data shapes.
        const origin = normalizeCountryName(
          row.origins?.[iso] ?? row.origin_country ?? row.originCountry
          ?? row.country ?? row.origin ?? row.country_of_origin ?? row.countryOfOrigin ?? ''
        );
        if (value === undefined || value === null) {
          td.className = 'empty price-cell';
          td.textContent = '—';
        } else {
          td.className = 'price-cell';
          td.innerHTML = `<div class="price-num">${Number(value).toFixed(2)}</div>` +
            (origin && origin !== '—' ? `<div class="price-country" title="${escapeHtml(origin)}"><span class="origin-code">${escapeHtml(countryCode(origin))}</span></div>` : '');
        }
        tr.appendChild(td);
      });
      bodyRows.appendChild(tr);
    });
  });
}

function updateStats(pivot, flatRows) {
  document.getElementById('sRetailers').textContent = appState.meta.retailers.length || '—';
  document.getElementById('sProducts').textContent = appState.products.length || '—';
  document.getElementById('sDates').textContent = pivot?.counts?.dates ?? (pivot?.dates?.length || '—');
  const prices = flatRows.map((r) => r.price).filter((p) => p > 0);
  document.getElementById('sTotal').textContent = prices.length || '—';
  document.getElementById('sAvg').textContent = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : '—';
}

async function loadPivot() {
  try {
    const payload = await loadHistoryApi({ retailer: fetchState.selectedRetailer, product: fetchState.selectedProduct });
    console.log('[MarketPulse] GET /api/history →', payload);
    const mapped = mapHistoryResponse(payload);
    lastPivot = mapped;
    renderPivotTable(mapped);
    const flatRows = flattenPivot(mapped);
    appState.allData = flatRows;
    saveState();
    updateStats(mapped, flatRows);
    updateTicker(flatRows);
  } catch (error) {
    setStatus(`✗ ${error.message}`, 'err');
  }
}

/* ============================== DETAIL TABLE (latest fetch) ============================== */

// Search-URL patterns per retailer, used to build the "click to verify" link on each price.
// Keyed by normalized retailer id (same normalization used elsewhere via normalizeRetailerId).
const RETAILER_SEARCH_URLS = {
  carrefour: 'https://www.carrefouruae.com/mafuae/en/search?keyword=',
  lulu: 'https://www.luluhypermarket.com/en-ae/search?q=',
  barakat: 'https://www.barakatfresh.com/search?q=',
  kibsons: 'https://www.kibsons.com/search?q=',
  union_coop: 'https://www.unioncoop.ae/en/search?q=',
};

function buildVerifyUrl(retailerId, productLabel) {
  const key = normalizeRetailerId(retailerId);
  const base = RETAILER_SEARCH_URLS[key];
  if (!base) return null;
  return base + encodeURIComponent(productLabel || '');
}

// Key used to identify "the same product at the same retailer" across fetches,
// so a new fetch updates that specific row instead of adding a duplicate for
// the same product/retailer pair. A product can still have one row per retailer.
function detailRowKey(row) {
  return `${normalizeRetailerId(row.retailer)}|${normalizeProductId(row.product)}`;
}

// Best-effort timestamp for a row, used to decide which fetch of a product is newer.
function detailRowTimestamp(row) {
  const fetchedAt = row.fetched_at ? Date.parse(row.fetched_at) : NaN;
  if (!Number.isNaN(fetchedAt)) return fetchedAt;
  const dateOnly = row.date ? Date.parse(row.date) : NaN;
  return Number.isNaN(dateOnly) ? 0 : dateOnly;
}

// Merges newly fetched rows into the existing set: each (product, retailer) pair
// keeps only its single most-recently-fetched entry, so re-fetching that same
// pair replaces the old price instead of adding a duplicate row.
function mergeDetailRows(existingRows, incomingRows) {
  const map = new Map();
  const consider = (row) => {
    const key = detailRowKey(row);
    const current = map.get(key);
    if (!current || detailRowTimestamp(row) >= detailRowTimestamp(current)) {
      map.set(key, row);
    }
  };
  existingRows.forEach(consider);
  incomingRows.forEach(consider);
  return [...map.values()];
}

function renderDetailTable(rows) {
  const panel = document.getElementById('detailPanel');
  const wrap = document.getElementById('detailWrap');
  const sub = document.getElementById('detailSub');
  if (!rows.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const sorted = [...rows].sort((a, b) => a.product.localeCompare(b.product) || a.retailer.localeCompare(b.retailer));
  const html = '<table class="dtbl"><thead><tr><th>Date</th><th>Product</th><th>Retailer</th><th>Price</th><th>Unit</th><th>Origin Country</th><th>Fetched At</th></tr></thead><tbody>' +
    sorted.map((item) => {
      const meta = getProductMeta(item.product);
      const verifyUrl = item.price > 0 ? buildVerifyUrl(item.retailer, meta.name || item.product) : null;
      const priceCell = item.price > 0
        ? (verifyUrl
            ? `<a class="price-badge" href="${verifyUrl}" target="_blank" rel="noopener noreferrer" title="Click to verify on ${escapeHtml(item.retailer || 'retailer')} site">
                 <span class="price-num">${formatPrice(item.price)}</span><span class="price-cur">AED</span>
                 <svg class="verify-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                   <path d="M15 3h6v6"/><path d="M10 14 21 3"/>
                 </svg>
               </a>`
            : `<div class="price-box"><span class="price-num">${formatPrice(item.price)}</span><span class="price-cur">AED</span></div>`)
        : '<span class="mu">N/A</span>';
      return `<tr>
        <td class="mu">${escapeHtml(item.date)}</td>
        <td><div class="prod-cell"><span class="prod-emoji">${meta.emoji || '🛒'}</span><span class="prod-name">${escapeHtml(meta.name || item.product)}</span></div></td>
        <td>${createRetailerPill(item.retailer)}</td>
        <td>${priceCell}</td>
        <td class="mu">per kg</td>
        <td><span style="font-size:15px;margin-right:5px;">${flag(item.origin_country)}</span><span class="mu">${escapeHtml(normalizeCountryName(item.origin_country) || '—')}</span></td>
        <td class="mu">${escapeHtml(item.fetched_at ? new Date(item.fetched_at).toLocaleTimeString('en-AE') : '—')}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
  wrap.innerHTML = html;
  sub.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · one row per product per retailer, latest fetch only · click any price to verify on retailer site`;
}

/* ============================== FETCH ACTION ============================== */

async function fetchLatestPrices() {
  const button = document.getElementById('fetchBtn');
  const statusLine = document.getElementById('statusLine');
  const errorList = document.getElementById('errorList');

  button.disabled = true;
  errorList.innerHTML = '';
  statusLine.className = 'status-line';
  statusLine.textContent = 'Starting…';

  try {
    const job = await createJob({ retailer: fetchState.selectedRetailer, product: fetchState.selectedProduct });
    console.log('[MarketPulse] POST /api/jobs →', job);
    if (!job.ok) {
      statusLine.classList.add('error');
      statusLine.textContent = job.error || 'Could not start the fetch.';
      return;
    }

    let currentJob = job;
    while (currentJob.status !== 'done') {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      currentJob = await pollJob(currentJob.job_id);
      console.log(`[MarketPulse] GET /api/jobs/${currentJob.job_id} →`, currentJob);
      if (!currentJob.ok) {
        statusLine.classList.add('error');
        statusLine.textContent = currentJob.error || 'Lost track of the job.';
        return;
      }
      statusLine.textContent = `Fetching… ${currentJob.completed}/${currentJob.total}`;
    }

    console.log('[MarketPulse] Job finished, raw results:', currentJob.results);

    const failures = currentJob.results.filter((item) => !item.ok);
    const successes = currentJob.results.length - failures.length;

    statusLine.classList.add('ok');
    statusLine.textContent = `Fetched ${successes}/${currentJob.results.length} price(s).`;

    if (failures.length) {
      console.warn('[MarketPulse] Failed items:', failures);
      errorList.innerHTML = failures
        .map((item) => `<div>⚠ ${escapeHtml(item.product_label || '')} @ ${escapeHtml(item.supermarket || '')}: ${escapeHtml(item.error || '')}</div>`)
        .join('');
    }

    const freshRows = currentJob.results.filter((item) => item.ok !== false).map((item) => mapScrapeResult(item));
    console.log('[MarketPulse] Mapped fresh rows from this fetch:', freshRows);
    lastDetail = mergeDetailRows(lastDetail, freshRows);
    savePersistedDetail(lastDetail);
    console.log('[MarketPulse] Full detail set after merge (latest price per product):', lastDetail);
    renderDetailTable(lastDetail);

    await loadPivot();
    console.log('[MarketPulse] Pivot reloaded from /api/history:', lastPivot);
  } catch (error) {
    console.error('[MarketPulse] Fetch flow threw an error:', error);
    statusLine.classList.add('error');
    statusLine.textContent = 'Request failed: ' + error.message;
  } finally {
    button.disabled = false;
  }
}

/* ============================== CSV / COPY ============================== */

function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function pivotToCsv() {
  if (!lastPivot || !lastPivot.rows.length) return '';
  const headers = ['Product', 'Retailer', ...lastPivot.dates];
  const rows = lastPivot.rows.map((row) => [
    row.product_label || row.product_id,
    row.retailer_label || row.retailer_id,
    ...lastPivot.dates.map((d) => (row.prices[d] !== undefined ? Number(row.prices[d]).toFixed(2) : '')),
  ]);
  return toCsv(headers, rows);
}

function detailToCsv() {
  if (!lastDetail.length) return '';
  const headers = ['Date', 'Product', 'Retailer', 'Price (AED)', 'Unit', 'Origin Country', 'Fetched At'];
  const rows = lastDetail.map((r) => [r.date, r.product, r.retailer, (r.price || 0).toFixed(2), r.unit || 'per kg', normalizeCountryName(r.origin_country) || '—', r.fetched_at || '']);
  return toCsv(headers, rows);
}

function wireCsvCopyButtons() {
  const wire = (csvBtnId, copyBtnId, buildCsv, filename) => {
    document.getElementById(csvBtnId)?.addEventListener('click', () => {
      const csv = buildCsv();
      if (!csv) { setStatus('Nothing to export yet.', 'err'); return; }
      downloadCsv(filename, csv);
    });
    document.getElementById(copyBtnId)?.addEventListener('click', () => {
      const csv = buildCsv();
      if (!csv) { setStatus('Nothing to copy yet.', 'err'); return; }
      navigator.clipboard.writeText(csv).then(() => setStatus('✓ Copied to clipboard', 'ok'));
    });
  };
  wire('fetchCsvBtn', 'fetchCopyBtn', pivotToCsv, 'marketpulse-prices.csv');
  wire('pivotCsvBtn', 'pivotCopyBtn', pivotToCsv, 'marketpulse-prices.csv');
  wire('detailCsvBtn', 'detailCopyBtn', detailToCsv, 'marketpulse-latest-fetch.csv');
}

/* ============================== PRODUCTS TAB ============================== */

function bindProductsTab() {
  document.getElementById('btnAddProduct')?.addEventListener('click', () => { addProduct(); refreshProductDependents(); });
  document.getElementById('btnResetProducts')?.addEventListener('click', () => { resetProducts(); refreshProductDependents(); });
  document.getElementById('newName')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addProduct(); refreshProductDependents(); }
  });
  document.getElementById('prodTags')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]');
    if (button) { removeProduct(Number(button.getAttribute('data-index'))); refreshProductDependents(); }
  });
  document.getElementById('presetRow')?.addEventListener('click', (event) => {
    const chip = event.target.closest('span[data-id]');
    if (!chip) return;
    const id = chip.getAttribute('data-id');
    const emoji = chip.getAttribute('data-emoji');
    if (appState.products.some((p) => p.id === id)) return;
    appState.products.push({ id, name: id.replace(/_/g, ' '), emoji });
    saveState();
    refreshProductDependents();
    setStatus(`✓ ${id} added`, 'ok');
  });
}

function refreshProductDependents() {
  renderProductTags();
  renderProductSelect();
  renderPresets();
  document.getElementById('sProducts').textContent = appState.products.length || '—';
}

/* ============================== PRICE VARIATION TAB ============================== */

function populateVariationSelects() {
  const varRetailer = document.getElementById('varRetailer');
  const varProduct = document.getElementById('varProduct');
  if (varRetailer) {
    const current = varRetailer.value;
    varRetailer.innerHTML = '<option value="all">All Retailers</option>' +
      appState.meta.retailers.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
    if ([...varRetailer.options].some((o) => o.value === current)) varRetailer.value = current;
  }
  renderProductSelect(); // fills #varProduct too
}

function renderVariationTab() {
  const retailerValue = document.getElementById('varRetailer')?.value || 'all';
  const productValue = document.getElementById('varProduct')?.value || 'all';
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const data30 = appState.allData.filter((row) =>
    row.date >= cutoffStr &&
    (retailerValue === 'all' || normalizeRetailerId(row.retailer) === normalizeRetailerId(retailerValue)) &&
    (productValue === 'all' || normalizeProductId(row.product) === normalizeProductId(productValue)));

  const grid = document.getElementById('varChartsGrid');
  const tableCard = document.getElementById('varTableCard');

  if (!data30.length) {
    grid.innerHTML = '<div class="empty-state">No variation data yet — fetch some prices first.</div>';
    tableCard.style.display = 'none';
    document.getElementById('vs-up').textContent = '0';
    document.getElementById('vs-down').textContent = '0';
    document.getElementById('vs-flat').textContent = '0';
    document.getElementById('vs-dates').textContent = '0';
    return;
  }

  const dates = [...new Set(data30.map((r) => r.date))].sort();
  const products = [...new Set(data30.map((r) => r.product))].sort();
  const retailers = [...new Set(data30.map((r) => r.retailer))].sort();
  const lookup = {};
  data30.forEach((row) => { lookup[`${row.date}|${normalizeRetailerId(row.retailer)}|${normalizeProductId(row.product)}`] = row; });

  renderVariationCharts(data30, dates, retailers, products, lookup);
  buildVariationTable(dates, retailers, products, lookup);
  tableCard.style.display = 'block';
}

function buildVariationTable(dates, retailers, products, lookup) {
  const body = document.getElementById('varTableBody');
  if (!body) return;
  const latestDate = dates[dates.length - 1];
  const previousDate = dates.length > 1 ? dates[dates.length - 2] : null;
  const rows = [];
  products.forEach((productId) => {
    retailers.forEach((retailerId) => {
      const latest = lookup[`${latestDate}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`];
      const previous = previousDate ? lookup[`${previousDate}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`] : null;
      const prices = dates.map((date) => {
        const row = lookup[`${date}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`];
        return row && row.price ? row.price.toFixed(2) : '';
      });
      let change = '';
      if (latest?.price && previous?.price) {
        const pct = ((latest.price - previous.price) / previous.price) * 100;
        change = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
      }
      rows.push([productId, retailerId, normalizeCountryName(latest?.origin_country) || '', ...prices, change]);
    });
  });
  const header = ['Product', 'Retailer', 'Origin Country', ...dates, 'Change %'];
  body.innerHTML = '<table class="vtbl"><thead><tr>' + header.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';

  document.getElementById('btnExportVariation').onclick = () => {
    const csv = toCsv(header, rows);
    downloadCsv('price-variation.csv', csv);
  };
}

/* ============================== INIT ============================== */

async function init() {
  loadState();
  setDateChip();
  bindTabs();
  bindProductsTab();
  wireCsvCopyButtons();

  refreshProductDependents();

  const persisted = loadPersistedDetail();
  if (persisted && persisted.date === todayStr() && persisted.rows.length) {
    lastDetail = persisted.rows;
    renderDetailTable(lastDetail);
  } else {
    lastDetail = [];
    if (persisted) savePersistedDetail([]); // stale (previous day) cache — clear it out
    // #detailPanel already starts hidden (inline style in index.html), nothing else to clear.
  }

  document.getElementById('syncBtn')?.addEventListener('click', async (event) => {
    event.currentTarget.classList.add('loading');
    await checkBackend();
    await loadPivot();
    populateVariationSelects();
    event.currentTarget.classList.remove('loading');
    setStatus('✓ Synced with the Flask backend', 'ok');
  });
  document.getElementById('testConnBtn')?.addEventListener('click', () => checkBackend(true));
  document.getElementById('fetchBtn')?.addEventListener('click', fetchLatestPrices);

  document.getElementById('varRetailer')?.addEventListener('change', renderVariationTab);
  document.getElementById('varProduct')?.addEventListener('change', renderVariationTab);
  document.getElementById('varChartType')?.addEventListener('change', renderVariationTab);

  document.addEventListener('click', closeAllDropdowns);

  await checkBackend();
  const meta = await loadMeta().catch(() => ({ retailers: [], products: [] }));
  appState.meta = meta;
  renderFetchDropdowns();
  populateVariationSelects();
  await loadPivot();
}

init();