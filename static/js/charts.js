import { appState, escapeHtml, normalizeProductId, normalizeRetailerId, getProductMeta } from './utils.js';

let charts = {};

export function destroyCharts() {
  Object.values(charts).forEach((chart) => chart?.destroy?.());
  charts = {};
}

export function renderVariationCharts(data30, dates, retailers, products, lookup) {
  const overviewLabels = [];
  const overviewValues = [];
  const overviewColors = [];
  let rising = 0;
  let falling = 0;
  let flat = 0;
  const overviewCtx = document.getElementById('overviewChart')?.getContext('2d');
  products.forEach((productId) => {
    const latestValues = retailers.map((retailerId) => lookup[`${dates[dates.length - 1]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0);
    const prevValues = dates.length > 1 ? retailers.map((retailerId) => lookup[`${dates[dates.length - 2]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0) : [];
    const latestAvg = latestValues.length ? latestValues.reduce((sum, row) => sum + row.price, 0) / latestValues.length : null;
    const prevAvg = prevValues.length ? prevValues.reduce((sum, row) => sum + row.price, 0) / prevValues.length : null;
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
  if (overviewCtx) {
    charts.overview = new Chart(overviewCtx, {
      type: 'bar',
      data: { labels: overviewLabels, datasets: [{ label: '% Change vs Previous Date', data: overviewValues, backgroundColor: overviewColors, borderColor: overviewColors, borderWidth: 1, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#6b8aaa', font: { size: 10 } }, grid: { color: 'rgba(30,45,61,.6)' } }, y: { ticks: { color: '#6b8aaa', font: { size: 10 }, callback: (value) => `${value > 0 ? '+' : ''}${value}%` }, grid: { color: 'rgba(30,45,61,.6)' } } } },
    });
  }

  const grid = document.getElementById('varChartsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  products.forEach((productId) => {
    const productMeta = getProductMeta(productId);
    const canvasId = `chart-${productId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const card = document.createElement('div');
    card.className = 'var-card';
    const latestValues = retailers.map((retailerId) => lookup[`${dates[dates.length - 1]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0);
    const prevValues = dates.length > 1 ? retailers.map((retailerId) => lookup[`${dates[dates.length - 2]}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]).filter((row) => row && row.price > 0) : [];
    const latestAvg = latestValues.length ? latestValues.reduce((sum, row) => sum + row.price, 0) / latestValues.length : null;
    const prevAvg = prevValues.length ? prevValues.reduce((sum, row) => sum + row.price, 0) / prevValues.length : null;
    const pct = latestAvg && prevAvg ? ((latestAvg - prevAvg) / prevAvg) * 100 : null;
    const direction = pct === null ? 'flat' : pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    const badge = direction === 'up' ? `<span class="var-badge var-badge-up">▲ ${pct.toFixed(1)}%</span>` : direction === 'down' ? `<span class="var-badge var-badge-down">▼ ${pct.toFixed(1)}%</span>` : '<span class="var-badge var-badge-flat">● Stable</span>';
    card.innerHTML = `<div class="var-card-top"><div class="var-prod">${escapeHtml(productMeta.emoji || '🛒')} ${escapeHtml(productMeta.name || productId)}</div>${badge}</div><div style="position:relative;height:220px;"><canvas id="${canvasId}"></canvas></div>`;
    grid.appendChild(card);
    const chartCtx = document.getElementById(canvasId)?.getContext('2d');
    if (!chartCtx) return;
    charts[canvasId] = new Chart(chartCtx, {
      type: document.getElementById('varChartType')?.value || 'line',
      data: { labels: dates.map((date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-AE', { day: '2-digit', month: 'short' })), datasets: retailers.map((retailerId, index) => ({ label: retailerId, data: dates.map((date) => { const row = lookup[`${date}|${normalizeRetailerId(retailerId)}|${normalizeProductId(productId)}`]; return row && row.price > 0 ? row.price : null; }), borderColor: ['#38bdf8', '#4ade80', '#fb923c', '#c084fc', '#f472b6'][index % 5], backgroundColor: 'rgba(56,189,248,0.08)', tension: 0.35, spanGaps: true })) },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: retailers.length > 1, labels: { color: '#8b949e', font: { size: 10 } } }, tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: AED ${context.raw?.toFixed(2)}` } } }, scales: { x: { ticks: { color: '#4a6580', font: { size: 9 } }, grid: { color: 'rgba(30,45,61,.5)' } }, y: { ticks: { color: '#4a6580', font: { size: 9 }, callback: (value) => `AED ${value.toFixed(2)}` }, grid: { color: 'rgba(30,45,61,.5)' } } } },
    });
  });
}