import { appState, DEFAULT_PRODUCTS, PRESETS, saveState, setStatus } from './utils.js';
import { createProduct, deleteProduct } from './api.js';

const TAG_COLORS = ['#3FA7FF', '#4FD1A5', '#F0A63C', '#c19bee', '#E2685E', '#22D3EE', '#f472b6', '#8dd48a'];

function tagColor(index) {
  return TAG_COLORS[index % TAG_COLORS.length];
}

export function renderProductTags() {
  const container = document.getElementById('prodTags');
  if (!container) return;
  if (!appState.products.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--muted);">No products — add below</span>';
  } else {
    container.innerHTML = appState.products.map((product, index) => `<span class="prod-tag" style="--tag-color:${tagColor(index)}">${product.emoji || '🛒'} ${product.name || product.id}<button class="prod-tag-del" data-index="${index}" title="Remove">×</button></span>`).join('');
  }
}

export function renderProductSelect() {
  const select = document.getElementById('selP');
  const variationSelect = document.getElementById('varProduct');
  if (select) {
    const currentValue = select.value;
    select.innerHTML = '<option value="all">All Configured Products</option>' + appState.products.map((product) => `<option value="${product.id}">${product.emoji || '🛒'} ${product.name || product.id}</option>`).join('');
    if ([...select.options].some((option) => option.value === currentValue)) select.value = currentValue;
  }
  if (variationSelect) {
    const variationCurrentValue = variationSelect.value;
    variationSelect.innerHTML = '<option value="all">All Products</option>' + appState.products.map((product) => `<option value="${product.id}">${product.name || product.id}</option>`).join('');
    if ([...variationSelect.options].some((option) => option.value === variationCurrentValue)) variationSelect.value = variationCurrentValue;
  }
}

export function renderPresets() {
  const container = document.getElementById('presetRow');
  if (!container) return;
  const active = new Set(appState.products.map((product) => product.id));
  container.innerHTML = PRESETS.filter((product) => !active.has(product.id)).map((product) => `<span class="preset-chip" data-id="${product.id}" data-emoji="${product.emoji}">${product.emoji} ${product.name}</span>`).join('');
}

export async function addProduct() {
  const nameInput = document.getElementById('newName');
  const emojiInput = document.getElementById('newEmoji');
  const name = nameInput?.value.trim();
  const emoji = emojiInput?.value.trim() || '🛒';
  if (!name) return;
  if (appState.products.some((product) => (product.name || product.id).toLowerCase() === name.toLowerCase())) {
    setStatus('That product is already tracked.', 'err');
    return false;
  }

  try {
    // Saved server-side (MongoDB) so it also shows up in the Fetch &
    // Analyse tab's dropdown (which reads from /api/meta) and is
    // immediately scrapable - not just added to this browser's local list.
    const product = await createProduct(name, emoji);
    appState.products.push(product);
    if (!appState.meta.products.some((p) => p.id === product.id)) {
      appState.meta.products = [...appState.meta.products, product];
    }
    saveState();
    renderProductTags();
    renderProductSelect();
    renderPresets();
    if (nameInput) nameInput.value = '';
    if (emojiInput) emojiInput.value = '';
    setStatus(`✓ ${name} added — now available in Fetch & Analyse`, 'ok');
    return true;
  } catch (error) {
    setStatus(`✗ ${error.message}`, 'err');
    return false;
  }
}

export function resetProducts() {
  appState.products = DEFAULT_PRODUCTS.slice();
  saveState();
  renderProductTags();
  renderProductSelect();
  renderPresets();
  setStatus('Products reset to defaults.', 'ok');
}

export async function removeProduct(index) {
  const [removed] = appState.products.splice(index, 1);
  saveState();
  renderProductTags();
  renderProductSelect();
  renderPresets();

  if (removed?.custom) {
    try {
      await deleteProduct(removed.id);
      appState.meta.products = appState.meta.products.filter((p) => p.id !== removed.id);
    } catch (error) {
      setStatus(`Removed locally, but couldn't delete from the server: ${error.message}`, 'err');
      return;
    }
  }
  setStatus(`Removed ${removed?.name || 'product'} from the list.`, '');
}