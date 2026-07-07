import { appState, DEFAULT_PRODUCTS, PRESETS, saveState, setStatus, getProductMeta, createRetailerPill, getCurrentSelection, formatPrice, createEmptyState, escapeHtml } from './utils.js';
import { fetchPrices, createJob, pollJob, loadHistory, mapHistoryResponse } from './api.js';

let charts = {};

export function initDashboard() {
  document.getElementById('dateChip').textContent = new Date().toLocaleDateString('en-AE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  renderProductTags();
  renderProductSelect();
  renderPresets();
  updateStats();
  renderPivot();
  renderHistory();
  bindEvents();
}

export function renderProductTags() {
  const container = document.getElementById('prodTags');
  if (!container) return;
  if (!appState.products.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--muted);">No products — add below</span>';
  } else {
    container.innerHTML = appState.products.map((product, index) => `<span class="prod-tag">${escapeHtml(product.emoji || '🛒')} ${escapeHtml(product.name || product.id)}<button class="prod-tag-del" data-index="${index}" title="Remove">×</button></span>`).join('');
  }
  const countEl = document.getElementById('sProducts');
  if (countEl) countEl.textContent = appState.products.length;
}

export function renderProductSelect() {
  const select = document.getElementById('selP');
  const variationSelect = document.getElementById('varProduct');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="all">All Configured Products</option>' + appState.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.emoji || '🛒')} ${escapeHtml(product.name || product.id)}</option>`).join('');
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
  if (variationSelect) {
    const currentVarValue = variationSelect.value;
    variationSelect.innerHTML = '<option value="all">All Products</option>' + appState.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name || product.id)}</option>`).join('');
    if ([...variationSelect.options].some((option) => option.value === currentVarValue)) {
      variationSelect.value = currentVarValue;
    }
  }
}

export function renderPresets() {
  const container = document.getElementById('presetRow');
  if (!container) return;
  const active = new Set(appState.products.map((product) => product.id));
  container.innerHTML = PRESETS.filter((product) => !active.has(product.id)).map((product) => `<span class="preset-chip" data-id="${escapeHtml(product.id)}" data-emoji="${escapeHtml(product.emoji)}">${escapeHtml(product.emoji)} ${escapeHtml(product.name)}</span>`).join('');
}

export function addProduct() {
  const nameInput = document.getElementById('newName');
  const emojiInput = document.getElementById('newEmoji');
  const name = nameInput?.value.trim();
  const emoji = emojiInput?.value.trim() || '🛒';
  if (!name) return;
  if (appState.products.some((product) => product.id.toLowerCase() === name.toLowerCase())) {
    setStatus('That product is already tracked.', 'err');
    return;
  }
  appState.products.push({ id: name.toLowerCase().replace(/\s+/g, '_'), name, emoji });
  saveState();
  renderProductTags();
  renderProductSelect();
  renderPresets();
  setStatus(`✓ ${name} added to the tracked products`, 'ok');
}

export function resetProducts() {
  appState.products = DEFAULT_PRODUCTS.slice();
  saveState();
  renderProductTags();
  renderProductSelect();
  renderPresets();
  setStatus('Products reset to defaults.', 'ok');
}

export function removeProduct(index) {
  const [removed] = appState.products.splice(index, 1);
  saveState();
  renderProductTags();
  renderProductSelect();
  renderPresets();
  setStatus(`Removed ${removed?.name || 'product'} from the list.`, '');
}

export function renderPivot() {
  const wrap = document.getElementById('pivotWrap');
  if (!wrap) return;
  if (!appState.allData.length) {
    wrap.innerHTML = createEmptyState('No Data Yet');
    return;
  }

  const dates = [...new Set(appState.allData.map((row) => row.date))].sort();
  const products = appState.products.filter((product) => appState.allData.some((row) => row.product === product.id || row.product === product.name));
  const retailers = appState.meta.retailers.filter((retailer) => appState.allData.some((row) => String(row.retailer).toLowerCase() === String(retailer.id).toLowerCase()));

  const lookup = {};
  appState.allData.forEach((row) => {
    lookup[`${row.date}|${normalizeRetailerId(row.retailer)}|${normalizeProductId(row.product)}`] = row;
  });

  const dateHeaders = dates.map((date) => {
    const dt = new Date(`${date}T12:00:00`);
    return `<th class="date-th"><span class="date-th-day">${dt.toLocaleDateString('en-AE', { weekday: 'short' })}</span><span class="date-th-date">${dt.toLocaleDateString('en-AE', { day: '2-digit', month: 'short', year: '2-digit' })}</span></th>`;
  }).join('');

  let html = '<table class="pivot-table"><thead><tr><th style="text-align:left;min-width:140px;">Product</th><th style="text-align:left;min-width:120px;">Retailer</th>' + dateHeaders + '</tr></thead><tbody>';
  products.forEach((product, productIndex) => {
    retailers.forEach((retailer, retailerIndex) => {
      const cells = dates.map((date, dateIndex) => {
        const row = lookup[`${date}|${normalizeRetailerId(retailer.id)}|${normalizeProductId(product.id)}`] || lookup[`${date}|${normalizeRetailerId(retailer.id)}|${normalizeProductId(product.name)}`];
        if (!row) return '<td class="pivot-cell"><span class="pv-na">—</span></td>';
        const priceClass = 'pv-price';
        return `<td class="pivot-cell"><span class="${priceClass}">${formatPrice(row.price)}</span><span class="pv-origin">${escapeHtml(flag(row.origin_country))} ${escapeHtml(row.origin_country || '—')}</span></td>`;
      }).join('');
      const rowClass = retailerIndex === retailers.length - 1 ? ' class="prod-group-border"' : '';
      if (retailerIndex === 0) {
        html += `<tr${rowClass}><td rowspan="${retailers.length}" style="vertical-align:middle;"><div class="prod-cell"><span class="prod-emoji">${escapeHtml(product.emoji || '🛒')}</span><span class="prod-name">${escapeHtml(product.name || product.id)}</span></div></td><td>${createRetailerLink(retailer.id)}</td>${cells}</tr>`;
      } else {
        html += `<tr${rowClass}><td>${createRetailerLink(retailer.id)}</td>${cells}</tr>`;
      }
    });
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  document.getElementById('pivotSub').textContent = `${dates.length} date${dates.length !== 1 ? 's' : ''} · ${products.length} product${products.length !== 1 ? 's' : ''} · ${retailers.length} retailer${retailers.length !== 1 ? 's' : ''} · AED per kg`;
  document.getElementById('sDates').textContent = dates.length;
  document.getElementById('sRetailers').textContent = retailers.length;
}

export function renderDetailTable(rows) {
  const card = document.getElementById('detailCard');
  const detailWrap = document.getElementById('detailWrap');
  const detailSub = document.getElementById('detailSub');
  if (!card || !detailWrap || !detailSub) return;
  if (!rows?.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const sorted = [...rows].sort((a, b) => String(a.product).localeCompare(String(b.product)) || String(a.retailer).localeCompare(String(b.retailer)));
  const html = '<table class="dtbl"><thead><tr><th>Date</th><th>Product</th><th>Retailer</th><th>Price</th><th>Unit</th><th>Origin Country</th><th>Fetched At</th></tr></thead><tbody>' + sorted.map((item) => {
    const meta = getProductMeta(item.product);
    const priceCell = item.price > 0 ? `<div class="price-box"><span class="price-num">${formatPrice(item.price)}</span><span class="price-cur">AED</span></div>` : '<span style="color:var(--muted);font-size:11px;">N/A</span>';
    return `<tr><td class="mu">${escapeHtml(item.date)}</td><td><div class="prod-cell"><span class="prod-emoji">${escapeHtml(meta.emoji || '🛒')}</span><span class="prod-name">${escapeHtml(meta.name || item.product)}</span></div></td><td>${createRetailerPill(item.retailer)}</td><td>${priceCell}</td><td class="mu">per kg</td><td><span style="font-size:16px;margin-right:5px;">${escapeHtml(flag(item.origin_country))}</span><span style="font-size:12px;color:var(--muted2);">${escapeHtml(item.origin_country || '—')}</span></td><td class="mu">${escapeHtml(item.fetched_at ? new Date(item.fetched_at).toLocaleTimeString('en-AE') : '—')}</td></tr>`;
  }).join('') + '</tbody></table>';
  detailWrap.innerHTML = html;
  detailSub.textContent = `${rows[0]?.date || '—'} · ${rows.length} entries · scraped from the Flask backend`;
}

export function updateStats() {
  const totalEl = document.getElementById('sTotal');
  const avgEl = document.getElementById('sAvg');
  if (totalEl) totalEl.textContent = appState.allData.length || '—';
  const dates = [...new Set(appState.allData.map((row) => row.date))];
  const datesEl = document.getElementById('sDates');
  if (datesEl) datesEl.textContent = dates.length || '—';
  const prices = appState.allData.map((row) => row.price).filter((price) => price > 0);
  if (avgEl) {
    if (prices.length) {
      avgEl.textContent = (prices.reduce((total, value) => total + value, 0) / prices.length).toFixed(2);
    } else {
      avgEl.textContent = '—';
    }
  }
}

export function updateTicker(rows) {
  const container = document.getElementById('ticker');
  if (!container) return;
  if (!rows?.length) return;
  const grouped = {};
  rows.forEach((row) => {
    if (!grouped[row.product]) grouped[row.product] = [];
    if (row.price > 0) grouped[row.product].push(row.price);
  });
  const items = Object.entries(grouped).map(([name, prices]) => {
    const avg = (prices.reduce((sum, value) => sum + value, 0) / prices.length).toFixed(2);
    return `<span class="tick-item"><span class="tick-name">${escapeHtml(name.toUpperCase())}</span><span class="tick-price">${avg}</span><span class="tick-unit">AED/kg</span></span>`;
  });
  container.innerHTML = [...items, ...items].join('');
}

export function renderHistory() {
  const container = document.getElementById('histGrid');
  if (!container) return;
  if (!appState.history.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--muted);">No history yet.</div>';
    return;
  }
  container.innerHTML = appState.history.map((entry) => {
    const date = new Date(entry.ts || entry.dateKey);
    return `<div class="hist-card" data-date="${escapeHtml(entry.dateKey)}"><div class="hist-date">${date.toLocaleDateString('en-AE', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div><div class="hist-count">${escapeHtml(entry.count || 0)} prices</div><div class="hist-sub">${date.toLocaleTimeString('en-AE')} · click to view</div></div>`;
  }).join('');
}

export function viewDate(dateKey) {
  const rows = appState.allData.filter((row) => row.date === dateKey);
  renderDetailTable(rows);
  setStatus(`📂 Showing ${dateKey} — ${rows.length} entries`, 'info');
  document.querySelector('[data-tab="fetch"]')?.click();
  setTimeout(() => document.getElementById('detailCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

export function clearAll() {
  appState.allData = [];
  appState.history = [];
  saveState();
  updateStats();
  renderPivot();
  renderDetailTable([]);
  renderHistory();
  setStatus('All scraped data cleared from this browser.', '');
}

export async function runFetch() {
  const selection = getCurrentSelection();
  if (!appState.products.length) {
    setStatus('✗ No products configured', 'err');
    document.querySelector('[data-tab="products"]')?.click();
    return;
  }
  const button = document.getElementById('btnRun');
  if (button) {
    button.disabled = true;
    button.innerHTML = '<div class="spin"></div> Fetching…';
  }
  setStatus('<span class="spin"></span>&nbsp; Querying the Flask scraper for today\'s AED prices…', 'run');
  try {
    const rows = await fetchPrices({ retailer: selection.retailer, product: selection.product });
    const dateKey = new Date().toISOString().slice(0, 10);
    appState.allData = appState.allData.filter((row) => !(row.date === dateKey && (selection.retailer === 'all' || String(row.retailer).toLowerCase() === selection.retailer.toLowerCase())));
    appState.allData.push(...rows);
    appState.history.unshift({ ts: new Date().toISOString(), count: rows.length, dateKey });
    if (appState.history.length > 60) appState.history = appState.history.slice(0, 60);
    saveState();
    updateStats();
    renderPivot();
    renderDetailTable(rows);
    renderHistory();
    updateTicker(rows);
    setStatus(`✓ ${rows.length} prices fetched · ${dateKey} · ${new Date().toLocaleTimeString('en-AE')}`, 'ok');
  } catch (error) {
    console.error(error);
    setStatus(`✗ ${error.message}`, 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = '▶ Fetch Prices';
    }
  }
}

export async function runJobFetch() {
  const selection = getCurrentSelection();
  const button = document.getElementById('btnRun');
  if (button) {
    button.disabled = true;
    button.innerHTML = '<div class="spin"></div> Starting job…';
  }
  setStatus('<span class="spin"></span>&nbsp; Starting a background scrape job…', 'run');
  try {
    const job = await createJob({ retailer: selection.retailer, product: selection.product });
    appState.currentJob = job;
    updateJobProgress(job, true);
    await pollUntilDone(job.job_id);
  } catch (error) {
    console.error(error);
    setStatus(`✗ ${error.message}`, 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = '▶ Fetch Prices';
    }
  }
}

async function pollUntilDone(jobId) {
  const bar = document.getElementById('progBar');
  const label = document.getElementById('progLbl');
  const detail = document.getElementById('progDetail');
  const progressWrap = document.getElementById('progWrap');
  if (bar) bar.style.width = '0%';
  if (progressWrap) progressWrap.classList.add('show');
  let completed = 0;
  while (true) {
    const job = await pollJob(jobId, (data) => {
      completed = data.completed || 0;
      const total = data.total || 1;
      const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
      if (bar) bar.style.width = `${percent}%`;
      if (label) label.textContent = `Job ${data.job_id || jobId} • ${completed}/${total} completed`;
      if (detail) detail.textContent = data.status === 'running' ? 'Scraping retailer pages…' : 'Finalizing results…';
    });
    if (job.status === 'done') {
      const rows = (job.results || []).map((item) => ({
        ...item,
        date: new Date().toISOString().slice(0, 10),
        fetched_at: new Date().toISOString(),
        price: parseFloat(String(item.per_kg_price || '').match(/\d+(?:\.\d+)?/)?.[0] || '0') || 0,
      }));
      appState.allData = appState.allData.filter((row) => !(row.date === new Date().toISOString().slice(0, 10) && (row.retailer === 'all' || String(row.retailer).toLowerCase() === 'all')));
      appState.allData.push(...rows);
      appState.history.unshift({ ts: new Date().toISOString(), count: rows.length, dateKey: new Date().toISOString().slice(0, 10) });
      if (appState.history.length > 60) appState.history = appState.history.slice(0, 60);
      saveState();
      updateStats();
      renderPivot();
      renderDetailTable(rows);
      renderHistory();
      updateTicker(rows);
      if (detail) detail.textContent = `Completed • ${rows.length} rows returned`;
      setStatus(`✓ Scrape complete · ${rows.length} prices loaded`, 'ok');
      updateJobProgress(job, false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
}

export function updateJobProgress(job, isRunning) {
  const list = document.getElementById('jobsList');
  if (!list) return;
  const rows = job?.job_id ? `<div class="hist-card"><div class="hist-date">${escapeHtml(job.job_id)}</div><div class="hist-count">${job.status || 'running'}</div><div class="hist-sub">${job.total || 0} total • ${job.completed || 0} complete</div></div>` : '<div style="font-size:12px;color:var(--muted);">No jobs yet.</div>';
  list.innerHTML = rows;
}

export function renderVariation() {
  const selectRetailer = document.getElementById('varRetailer');
  const selectProduct = document.getElementById('varProduct');
  const chartType = document.getElementById('varChartType');
  if (!selectRetailer || !selectProduct || !chartType) return;
  const retailerValue = selectRetailer.value;
  const productValue = selectProduct.value;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30); const cutoffStr = cutoff.toISOString().slice(0, 10);
  const data30 = appState.allData.filter((row) => row.date >= cutoffStr && (retailerValue === 'all' || String(row.retailer).toLowerCase() === retailerValue.toLowerCase()) && (productValue === 'all' || String(row.product).toLowerCase() === productValue.toLowerCase()));
  if (!data30.length) {
    document.getElementById('varChartsGrid').innerHTML = createEmptyState('No variation data yet');
    document.getElementById('varTableCard').style.display = 'none';
    return;
  }
  const dates = [...new Set(data30.map((row) => row.date))].sort();
  const products = [...new Set(data30.map((row) => row.product))].sort();
  const retailers = [...new Set(data30.map((row) => row.retailer))].sort();
  const overviewLabels = [];
  const overviewValues = [];
  const overviewColors = [];
  let rising = 0; let falling = 0; let flat = 0;
  const lookup = {};
  data30.forEach((row) => {
    lookup[`${row.date}|${normalizeRetailerId(row.retailer)}|${normalizeProductId(row.product)}`] = row;
  });
  products.forEach((productId) => {
    const latestPrices = retailers.map((retailerId) => lookup[`${dates[dates.length - 1]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0).map((row) => row.price);
    const prevPrices = dates.length > 1 ? retailers.map((retailerId) => lookup[`${dates[dates.length - 2]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0).map((row) => row.price) : [];
    if (!latestPrices.length) return;
    const latestAvg = latestPrices.reduce((sum, value) => sum + value, 0) / latestPrices.length;
    const prevAvg = prevPrices.length ? prevPrices.reduce((sum, value) => sum + value, 0) / prevPrices.length : null;
    const pct = prevAvg ? ((latestAvg - prevAvg) / prevAvg) * 100 : 0;
    const direction = prevAvg ? (pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat') : 'flat';
    if (direction === 'up') rising += 1; else if (direction === 'down') falling += 1; else flat += 1;
    overviewLabels.push(productId);
    overviewValues.push(parseFloat(pct.toFixed(2)));
    overviewColors.push(direction === 'up' ? 'rgba(239,68,68,.8)' : direction === 'down' ? 'rgba(34,197,94,.8)' : 'rgba(107,138,170,.5)');
  });
  document.getElementById('vs-up').textContent = rising;
  document.getElementById('vs-down').textContent = falling;
  document.getElementById('vs-flat').textContent = flat;
  document.getElementById('vs-dates').textContent = dates.length;
  document.getElementById('varSub').textContent = `${dates[0]} → ${dates[dates.length - 1]} · ${dates.length} date${dates.length !== 1 ? 's' : ''}`;
  destroyCharts();
  const overviewCtx = document.getElementById('overviewChart').getContext('2d');
  charts.overview = new Chart(overviewCtx, {
    type: 'bar',
    data: { labels: overviewLabels, datasets: [{ label: '% Change vs Previous Date', data: overviewValues, backgroundColor: overviewColors, borderColor: overviewColors, borderWidth: 1, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#6b8aaa', font: { size: 10 } }, grid: { color: 'rgba(30,45,61,.6)' } }, y: { ticks: { color: '#6b8aaa', font: { size: 10 }, callback: (value) => `${value > 0 ? '+' : ''}${value}%` }, grid: { color: 'rgba(30,45,61,.6)' } } } },
  });
  const grid = document.getElementById('varChartsGrid');
  grid.innerHTML = '';
  products.forEach((productId) => {
    const productMeta = getProductMeta(productId);
    const canvasId = `chart-${productId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const latestValues = retailers.map((retailerId) => lookup[`${dates[dates.length - 1]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0);
    const prevValues = dates.length > 1 ? retailers.map((retailerId) => lookup[`${dates[dates.length - 2]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0) : [];
    const latestAvg = latestValues.length ? latestValues.reduce((sum, row) => sum + row.price, 0) / latestValues.length : null;
    const prevAvg = prevValues.length ? prevValues.reduce((sum, row) => sum + row.price, 0) / prevValues.length : null;
    const pct = latestAvg && prevAvg ? ((latestAvg - prevAvg) / prevAvg) * 100 : null;
    const direction = pct === null ? 'flat' : pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    const badge = direction === 'up' ? `<span class="var-badge var-badge-up">▲ ${pct.toFixed(1)}%</span>` : direction === 'down' ? `<span class="var-badge var-badge-down">▼ ${pct.toFixed(1)}%</span>` : '<span class="var-badge var-badge-flat">● Stable</span>';
    const card = document.createElement('div');
    card.className = 'var-card';
    card.innerHTML = `<div class="var-card-top"><div class="var-prod">${escapeHtml(productMeta.emoji || '🛒')} ${escapeHtml(productMeta.name || productId)}</div>${badge}</div><div style="position:relative;height:220px;"><canvas id="${canvasId}"></canvas></div>`;
    grid.appendChild(card);
    const chartCtx = document.getElementById(canvasId).getContext('2d');
    charts[canvasId] = new Chart(chartCtx, { type: chartType.value, data: { labels: dates.map((date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-AE', { day: '2-digit', month: 'short' })), datasets: retailers.map((retailerId, index) => ({ label: retailerId, data: dates.map((date) => { const row = lookup[`${date}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]; return row && row.price > 0 ? row.price : null; }), borderColor: ['#38bdf8', '#4ade80', '#fb923c', '#c084fc', '#f472b6'][index % 5], backgroundColor: 'rgba(56,189,248,0.08)', tension: 0.35, spanGaps: true })) }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: retailers.length > 1, labels: { color: '#8b949e', font: { size: 10 } } }, tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: AED ${context.raw?.toFixed(2)}` } } }, scales: { x: { ticks: { color: '#4a6580', font: { size: 9 } }, grid: { color: 'rgba(30,45,61,.5)' } }, y: { ticks: { color: '#4a6580', font: { size: 9 }, callback: (value) => `AED ${value.toFixed(2)}` }, grid: { color: 'rgba(30,45,61,.5)' } } } } });
  });
  buildVariationTable(data30, dates, retailers, products, lookup);
  document.getElementById('varTableCard').style.display = 'block';
}

function buildVariationTable(data30, dates, retailers, products, lookup) {
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
      let direction = '';
      if (latest && latest.price && previous && previous.price) {
        const pct = ((latest.price - previous.price) / previous.price) * 100;
        change = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
        direction = pct > 0.5 ? 'Increasing' : pct < -0.5 ? 'Decreasing' : 'Stable';
      }
      rows.push([productId, retailerId, latest?.origin_country || '', ...prices, change, direction]);
    });
  });
  const header = ['Product', 'Retailer', 'Origin Country', ...dates, 'Change %', 'Direction'];
  body.innerHTML = '<table class="vtbl"><thead><tr>' + header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('') + '</tr></thead><tbody>' + rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}

function destroyCharts() {
  Object.values(charts).forEach((chart) => chart?.destroy?.());
  charts = {};
}

export function exportVariationCSV() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30); const cutoffStr = cutoff.toISOString().slice(0, 10);
  const data30 = appState.allData.filter((row) => row.date >= cutoffStr);
  const dates = [...new Set(data30.map((row) => row.date))].sort();
  const products = [...new Set(data30.map((row) => row.product))].sort();
  const retailers = [...new Set(data30.map((row) => row.retailer))];
  const lookup = {};
  data30.forEach((row) => { lookup[`${row.date}|${normalizeRetailerId(row.retailer)}|${normalizeProductId(row.product)}`] = row; });
  const latestDate = dates[dates.length - 1];
  const previousDate = dates.length > 1 ? dates[dates.length - 2] : null;
  const rows = [];
  products.forEach((productId) => {
    retailers.forEach((retailerId) => {
      const latest = lookup[`${latestDate}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`];
      const previous = previousDate ? lookup[`${previousDate}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`] : null;
      const values = dates.map((date) => { const row = lookup[`${date}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]; return row && row.price ? row.price.toFixed(2) : ''; });
      let change = '';
      if (latest && latest.price && previous && previous.price) {
        const pct = ((latest.price - previous.price) / previous.price) * 100;
        change = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
      }
      rows.push([productId, retailerId, latest?.origin_country || '', ...values, change]);
    });
  });
  const headers = ['Product', 'Retailer', 'Origin Country', ...dates, 'Change %'];
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  exportCsv('price-variation.csv', csv);
}

function exportCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      const id = button.getAttribute('data-tab');
      document.getElementById(`tab-${id}`)?.classList.add('active');
      if (id === 'variation') renderVariation();
    });
  });
  document.getElementById('btnRun')?.addEventListener('click', runJobFetch);
  document.getElementById('btnExport')?.addEventListener('click', () => exportCsv('marketpulse-scraper.csv', buildCsv()));
  document.getElementById('btnCopy')?.addEventListener('click', copyToClipboard);
  document.getElementById('btnAddProduct')?.addEventListener('click', addProduct);
  document.getElementById('btnResetProducts')?.addEventListener('click', resetProducts);
  document.getElementById('btnExportVariation')?.addEventListener('click', exportVariationCSV);
  document.getElementById('newName')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addProduct(); } });
  document.getElementById('prodTags')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]');
    if (button) removeProduct(Number(button.getAttribute('data-index')));
  });
  document.getElementById('presetRow')?.addEventListener('click', (event) => {
    const chip = event.target.closest('span[data-id]');
    if (!chip) return;
    const id = chip.getAttribute('data-id');
    const emoji = chip.getAttribute('data-emoji');
    if (appState.products.some((product) => product.id === id)) return;
    appState.products.push({ id, name: id.replace(/_/g, ' '), emoji });
    saveState();
    renderProductTags();
    renderProductSelect();
    renderPresets();
    setStatus(`✓ ${id} added`, 'ok');
  });
  document.getElementById('histGrid')?.addEventListener('click', (event) => {
    const card = event.target.closest('.hist-card');
    if (card) viewDate(card.getAttribute('data-date'));
  });
  document.getElementById('syncBtn')?.addEventListener('click', async () => {
    try {
      const history = await loadHistory();
      const mapped = mapHistoryResponse(history);
      if (mapped.rows?.length) {
        appState.allData = mapped.rows.map((row) => ({ ...row, date: row.prices ? Object.keys(row.prices).slice(-1)[0] || new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10) }));
        appState.history = mapped.rows.slice(0, 10).map((entry) => ({ ts: new Date().toISOString(), count: 1, dateKey: entry.product_id || 'history' }));
        saveState();
        updateStats();
        renderPivot();
        renderHistory();
        setStatus('✓ Loaded history from the Flask backend', 'ok');
      } else {
        setStatus('No history data available yet.', '');
      }
    } catch (error) {
      setStatus(`✗ ${error.message}`, 'err');
    }
  });
}

function buildCsv() {
  if (!appState.allData.length) return '';
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30); const cutoffStr = cutoff.toISOString().slice(0, 10);
  const filtered = appState.allData.filter((row) => row.date >= cutoffStr);
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date) || String(a.product).localeCompare(String(b.product)) || String(a.retailer).localeCompare(String(b.retailer)));
  const header = ['Date', 'Product', 'Retailer', 'Price (AED)', 'Unit', 'Currency', 'Origin Country', 'Fetched At'];
  const rows = sorted.map((row) => [row.date, row.product, row.retailer, (row.price || 0).toFixed(2), row.unit || 'per kg', row.currency || 'AED', row.origin_country || '—', row.fetched_at ? new Date(row.fetched_at).toLocaleString('en-AE') : '']);
  return [header, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

function copyToClipboard() {
  const csv = buildCsv();
  if (!csv) {
    setStatus('No data to copy', 'err');
    return;
  }
  navigator.clipboard.writeText(csv).then(() => setStatus('✓ Copied to clipboard', 'ok'));
}

function normalizeRetailerId(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeProductId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function flag(country) {
  const FLAGS = {
    China: '🇨🇳', Egypt: '🇪🇬', India: '🇮🇳', Pakistan: '🇵🇰', UAE: '🇦🇪', Oman: '🇴🇲', Jordan: '🇯🇴', 'South Africa': '🇿🇦', Australia: '🇦🇺', 'Saudi Arabia': '🇸🇦', Turkey: '🇹🇷', Spain: '🇪🇸', Morocco: '🇲🇦', Iran: '🇮🇷', Kenya: '🇰🇪', Netherlands: '🇳🇱', USA: '🇺🇸', Brazil: '🇧🇷', Peru: '🇵🇪', Lebanon: '🇱🇧', Philippines: '🇵🇭', Thailand: '🇹🇭',
  };
  if (!country || country === '—') return '🌍';
  if (FLAGS[country]) return FLAGS[country];
  for (const [name, emoji] of Object.entries(FLAGS)) {
    if (country.toLowerCase().includes(name.toLowerCase())) return emoji;
  }
  return '🌍';
}
