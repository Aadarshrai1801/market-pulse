const STORAGE_KEYS = {
  products: 'mp_products',
  data: 'mp_data',
  history: 'mp_hist',
};

export const appState = {
  products: [],
  allData: [],
  history: [],
  meta: { retailers: [], products: [] },
  currentJob: null,
  currentView: 'fetch',
};

export const DEFAULT_PRODUCTS = [
  { id: 'garlic', name: 'Garlic', emoji: '🧄' },
  { id: 'cucumber', name: 'Cucumber', emoji: '🥒' },
  { id: 'potato', name: 'Potato', emoji: '🥔' },
  { id: 'red_onion', name: 'Red Onion', emoji: '🧅' },
  { id: 'tomato', name: 'Tomato', emoji: '🍅' },
  { id: 'orange_valencia', name: 'Orange Valencia', emoji: '🍊' },
  { id: 'orange_navel', name: 'Orange Navel', emoji: '🍊' },
  { id: 'watermelon', name: 'Watermelon', emoji: '🍉' },
];

export const PRESETS = [
  { id: 'broccoli', name: 'Broccoli', emoji: '🥦' },
  { id: 'carrot', name: 'Carrot', emoji: '🥕' },
  { id: 'lettuce', name: 'Lettuce', emoji: '🥬' },
  { id: 'capsicum', name: 'Capsicum', emoji: '🫑' },
  { id: 'mango', name: 'Mango', emoji: '🥭' },
  { id: 'banana', name: 'Banana', emoji: '🍌' },
  { id: 'apple', name: 'Apple', emoji: '🍎' },
  { id: 'lemon', name: 'Lemon', emoji: '🍋' },
  { id: 'grapes', name: 'Grapes', emoji: '🍇' },
  { id: 'strawberry', name: 'Strawberry', emoji: '🍓' },
  { id: 'dates', name: 'Dates', emoji: '🌴' },
];

export function loadState() {
  try {
    const products = JSON.parse(localStorage.getItem(STORAGE_KEYS.products) || 'null');
    appState.products = Array.isArray(products) && products.length ? products : DEFAULT_PRODUCTS.slice();
  } catch {
    appState.products = DEFAULT_PRODUCTS.slice();
  }

  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEYS.data) || '[]');
    appState.allData = Array.isArray(data) ? data : [];
  } catch {
    appState.allData = [];
  }

  try {
    const history = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
    appState.history = Array.isArray(history) ? history : [];
  } catch {
    appState.history = [];
  }
}

export function saveState() {
  try {
    localStorage.setItem(STORAGE_KEYS.products, JSON.stringify(appState.products));
    localStorage.setItem(STORAGE_KEYS.data, JSON.stringify(appState.allData));
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(appState.history));
  } catch (error) {
    console.warn('Unable to persist local state:', error);
  }
}

let toastTimer = null;

// Generic status helper used across tabs. Prefers a visible #statusLine if the
// active tab has one; otherwise falls back to a small floating toast so
// products.js / sync actions always have somewhere to report to.
export function setStatus(message, type = '') {
  const line = document.getElementById('statusLine');
  if (line && document.getElementById('tab-fetch')?.classList.contains('active')) {
    line.className = 'status-line' + (type === 'err' ? ' error' : type === 'ok' ? ' ok' : '');
    line.innerHTML = message;
    return;
  }

  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:200;padding:12px 18px;border-radius:8px;font-family:inherit;font-size:12.5px;background:#121922;border:1px solid rgba(255,255,255,0.1);color:#E7ECF2;box-shadow:0 10px 30px rgba(0,0,0,0.5);transition:opacity .2s;';
    document.body.appendChild(toast);
  }
  toast.style.color = type === 'err' ? '#E2685E' : type === 'ok' ? '#4FD1A5' : '#E7ECF2';
  toast.innerHTML = message;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3200);
}

export function getRetailerLabel(retailer) {
  const normalized = normalizeRetailerId(retailer);
  const metaRetailer = appState.meta.retailers.find((entry) => normalizeRetailerId(entry.id) === normalized);
  return metaRetailer?.name || retailer || 'Retailer';
}

export function normalizeRetailerId(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeProductId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function parsePriceValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

export function formatPrice(value) {
  const parsed = parsePriceValue(value);
  return parsed === null ? '—' : parsed.toFixed(2);
}

export function toDateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function toDisplayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-AE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Canonical "popular short form" for each country, keyed by every raw variant
// that might come back from the scraper/backend (full names, alt spellings,
// official long-form names). Whatever the input looks like, this collapses
// it to one consistent display name across the whole frontend.
const COUNTRY_SHORT_NAMES = {
  'united arab emirates': 'UAE', 'uae': 'UAE', 'u.a.e': 'UAE', 'u.a.e.': 'UAE',
  'united states of america': 'USA', 'united states': 'USA', 'usa': 'USA', 'u.s.a': 'USA', 'u.s.a.': 'USA',
  'united kingdom': 'UK', 'great britain': 'UK', 'uk': 'UK',
  'kingdom of saudi arabia': 'KSA', 'saudi arabia': 'KSA', 'ksa': 'KSA',
  "people's republic of china": 'China', 'china': 'China',
  'arab republic of egypt': 'Egypt', 'egypt': 'Egypt',
  'republic of india': 'India', 'india': 'India',
  'islamic republic of pakistan': 'Pakistan', 'pakistan': 'Pakistan',
  'sultanate of oman': 'Oman', 'oman': 'Oman',
  'hashemite kingdom of jordan': 'Jordan', 'jordan': 'Jordan',
  'republic of south africa': 'South Africa', 'south africa': 'South Africa',
  'commonwealth of australia': 'Australia', 'australia': 'Australia',
  'republic of turkey': 'Turkey', 'turkiye': 'Turkey', 'türkiye': 'Turkey', 'turkey': 'Turkey',
  'kingdom of spain': 'Spain', 'spain': 'Spain',
  'kingdom of morocco': 'Morocco', 'morocco': 'Morocco',
  'islamic republic of iran': 'Iran', 'iran': 'Iran',
  'republic of kenya': 'Kenya', 'kenya': 'Kenya',
  'kingdom of the netherlands': 'Netherlands', 'netherlands': 'Netherlands', 'holland': 'Netherlands',
  'federative republic of brazil': 'Brazil', 'brazil': 'Brazil',
  'republic of peru': 'Peru', 'peru': 'Peru',
  'lebanese republic': 'Lebanon', 'lebanon': 'Lebanon',
  'republic of the philippines': 'Philippines', 'philippines': 'Philippines',
  'kingdom of thailand': 'Thailand', 'thailand': 'Thailand',
};

// Longest keys first, so "kingdom of saudi arabia" matches before a shorter
// substring accidentally would.
const COUNTRY_SHORT_NAME_KEYS = Object.keys(COUNTRY_SHORT_NAMES).sort((a, b) => b.length - a.length);

export function normalizeCountryName(country) {
  if (!country || country === '—') return '—';
  const cleaned = String(country).trim().toLowerCase().replace(/\s+/g, ' ');
  if (COUNTRY_SHORT_NAMES[cleaned]) return COUNTRY_SHORT_NAMES[cleaned];
  for (const key of COUNTRY_SHORT_NAME_KEYS) {
    if (cleaned.includes(key)) return COUNTRY_SHORT_NAMES[key];
  }
  return String(country).trim();
}

export function flag(country) {
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

// Flag *emoji* rely on the OS/browser having glyphs to combine two regional-indicator
// characters into a picture - many Windows browsers lack that font support and instead
// show the raw letters (e.g. "EG"). countryCode() returns that same 2-letter code
// directly and deliberately, so it renders as a clean, reliable text badge on every
// platform instead of an inconsistent flag-emoji fallback.
const COUNTRY_CODES = {
  China: 'CN', Egypt: 'EG', India: 'IN', Pakistan: 'PK', UAE: 'AE', Oman: 'OM', Jordan: 'JO', 'South Africa': 'ZA', Australia: 'AU', 'Saudi Arabia': 'SA', KSA: 'SA', UK: 'GB', Turkey: 'TR', Spain: 'ES', Morocco: 'MA', Iran: 'IR', Kenya: 'KE', Netherlands: 'NL', USA: 'US', Brazil: 'BR', Peru: 'PE', Lebanon: 'LB', Philippines: 'PH', Thailand: 'TH',
};

export function countryCode(country) {
  if (!country || country === '—') return '—';
  if (COUNTRY_CODES[country]) return COUNTRY_CODES[country];
  for (const [name, code] of Object.entries(COUNTRY_CODES)) {
    if (country.toLowerCase().includes(name.toLowerCase())) return code;
  }
  return country.trim().slice(0, 2).toUpperCase();
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createEmptyState(message = 'No data yet') {
  return `<div class="empty-state"><div>📡</div><div><b>${escapeHtml(message)}</b></div><div>Each fetch adds a new date column automatically</div></div>`;
}

export function createRetailerPill(retailer) {
  const normalized = normalizeRetailerId(retailer);
  const className = normalized === 'carrefour' ? 'rp-Carrefour' : normalized === 'lulu' || normalized === 'luluhypermarket' ? 'rp-LuLu' : normalized === 'kibsons' ? 'rp-Kibsons' : normalized === 'unioncoop' || normalized === 'union coop' ? 'rp-Union' : normalized === 'barakat' ? 'rp-Barakat' : '';
  return `<span class="rpill ${className}">${escapeHtml(getRetailerLabel(retailer))}</span>`;
}

export function createRetailerLink(retailer) {
  return createRetailerPill(retailer);
}

export function getCurrentSelection() {
  const retailer = document.getElementById('selR')?.value || 'all';
  const product = document.getElementById('selP')?.value || 'all';
  return { retailer, product };
}

export function getProductMeta(productId) {
  return appState.products.find((entry) => normalizeProductId(entry.id) === normalizeProductId(productId)) || appState.meta.products.find((entry) => normalizeProductId(entry.id) === normalizeProductId(productId)) || { name: productId, emoji: '🛒' };
}