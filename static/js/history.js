import { appState, setStatus } from './utils.js';
import { loadHistory, mapHistoryResponse } from './api.js';

export async function refreshHistory() {
  try {
    const payload = await loadHistory();
    const mapped = mapHistoryResponse(payload);
    if (mapped.rows?.length) {
      appState.allData = mapped.rows.map((row) => ({
        ...row,
        date: Object.keys(row.prices || {}).slice(-1)[0] || new Date().toISOString().slice(0, 10),
        fetched_at: new Date().toISOString(),
        price: Number(row.prices?.[Object.keys(row.prices || {}).slice(-1)[0]] ?? 0),
      }));
      appState.history = mapped.rows.slice(0, 10).map((row) => ({ ts: new Date().toISOString(), count: 1, dateKey: row.product_id || 'history' }));
      setStatus('✓ Loaded historical data from the Flask backend', 'ok');
    } else {
      setStatus('No historical data returned by the backend yet.', '');
    }
  } catch (error) {
    setStatus(`✗ ${error.message}`, 'err');
  }
}
