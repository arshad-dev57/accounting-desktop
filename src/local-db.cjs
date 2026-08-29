/**
 * local-db.cjs — Offline JSON file-based database for Bisonstechs POS Desktop.
 * Stores all caches (products, categories, customers, tax) and queues (sales, returns, shifts, held).
 * Runs completely locally on the host machine.
 */
const fs = require('fs');
const path = require('path');

let dbPath = '';

function initialize(userDataPath) {
  dbPath = userDataPath;
  // Ensure the directory exists
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }
}

// ─── HELPER FOR FILE I/O ──────────────────────────────────────────────────────
function readJson(filename, defaultValue = []) {
  if (!dbPath) return defaultValue;
  const file = path.join(dbPath, filename);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`[Local DB] Read failed for ${filename}:`, err.message);
  }
  return defaultValue;
}

function writeJson(filename, data) {
  if (!dbPath) return false;
  const file = path.join(dbPath, filename);
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[Local DB] Write failed for ${filename}:`, err.message);
    return false;
  }
}

// ─── PRODUCTS CACHE ───────────────────────────────────────────────────────────
function getProducts() {
  return readJson('cache_products.json', []);
}

function saveProducts(productsList) {
  return writeJson('cache_products.json', productsList);
}

// ─── CATEGORIES CACHE ─────────────────────────────────────────────────────────
function getCategories() {
  return readJson('cache_categories.json', []);
}

function saveCategories(categoriesList) {
  return writeJson('cache_categories.json', categoriesList);
}

// ─── CUSTOMERS CACHE ──────────────────────────────────────────────────────────
function getCustomers() {
  return readJson('cache_customers.json', []);
}

function saveCustomers(customersList) {
  return writeJson('cache_customers.json', customersList);
}

// ─── TAX CONTEXT CACHE ────────────────────────────────────────────────────────
function getTaxContext() {
  const raw = readJson('cache_tax_context.json', null);
  return raw ? normalizeTaxContext(raw) : null;
}

/** Normalize cloud/local tax payload for POS UI (enabled flag + default rate). */
function normalizeTaxContext(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: false,
      configured: false,
      defaultRate: null,
      pricingModel: 'exclusive',
      regime: null,
      countryCode: null,
      rates: [],
      profile: null,
    };
  }
  const rateObj = raw.defaultRate && typeof raw.defaultRate === 'object'
    ? raw.defaultRate
    : (Number(raw.defaultRate ?? raw.defaultTaxRate) > 0
      ? { rate: Number(raw.defaultRate ?? raw.defaultTaxRate) }
      : null);
  const rates = Array.isArray(raw.rates)
    ? raw.rates
    : (Array.isArray(raw.taxRates) ? raw.taxRates : []);
  return {
    ...raw,
    enabled: Boolean(raw.enabled ?? raw.taxEnabled ?? raw.profile?.taxEnabled),
    configured: Boolean(raw.configured ?? raw.profile),
    defaultRate: rateObj,
    pricingModel: raw.pricingModel
      || (String(raw.defaultTaxType || '').toLowerCase().includes('inclusive') ? 'inclusive' : 'exclusive'),
    regime: raw.regime || raw.profile?.regime || null,
    countryCode: raw.countryCode || raw.profile?.countryCode || null,
    rates,
    profile: raw.profile || null,
  };
}

function saveTaxContext(taxCtx) {
  return writeJson('cache_tax_context.json', normalizeTaxContext(taxCtx));
}

// ─── SALES QUEUE (TO SYNC) ────────────────────────────────────────────────────
function getSalesQueue() {
  return readJson('queue_sales.json', []);
}

function addSaleToQueue(salePayload) {
  const queue = getSalesQueue();
  // Ensure we assign a unique client-side ID for tracking
  const sale = {
    id: salePayload.id || `local-sale-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    invoiceNumber: salePayload.invoiceNumber || `POS-L-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...salePayload,
  };
  queue.push(sale);
  writeJson('queue_sales.json', queue);
  return sale;
}

function clearSalesQueue() {
  return writeJson('queue_sales.json', []);
}

function removeFromSalesQueue(ids) {
  const idSet = new Set(Array.isArray(ids) ? ids.map(String) : [String(ids)]);
  const queue = getSalesQueue();
  const remaining = queue.filter((s) => !idSet.has(String(s.id)));
  writeJson('queue_sales.json', remaining);
  return remaining.length;
}

// ─── RETURNS QUEUE (TO SYNC) ──────────────────────────────────────────────────
function getReturnsQueue() {
  return readJson('queue_returns.json', []);
}

function addReturnToQueue(returnPayload) {
  const queue = getReturnsQueue();
  const ret = {
    id: `local-return-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    createdAt: new Date().toISOString(),
    ...returnPayload,
  };
  queue.push(ret);
  writeJson('queue_returns.json', queue);
  return ret;
}

function clearReturnsQueue() {
  return writeJson('queue_returns.json', []);
}

function removeFromReturnsQueue(ids) {
  const idSet = new Set(Array.isArray(ids) ? ids.map(String) : [String(ids)]);
  const queue = getReturnsQueue();
  const remaining = queue.filter((r) => !idSet.has(String(r.id)));
  writeJson('queue_returns.json', remaining);
  return remaining.length;
}

// ─── SHIFTS LOGS & ACTIONS ─────────────────────────────────────────────────────
function getShiftsQueue() {
  return readJson('queue_shifts.json', []);
}

function addShiftActionToQueue(action) {
  const queue = getShiftsQueue();
  queue.push({
    ...action,
    timestamp: new Date().toISOString(),
  });
  writeJson('queue_shifts.json', queue);
}

function clearShiftsQueue() {
  return writeJson('queue_shifts.json', []);
}

// ─── HELD SALES (PARKED LOCALLY) ──────────────────────────────────────────────
function getHeldSales() {
  return readJson('queue_held.json', []);
}

function addHeldSale(heldPayload) {
  const list = getHeldSales();
  const held = {
    id: `local-held-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    createdAt: new Date().toISOString(),
    ...heldPayload,
  };
  list.push(held);
  writeJson('queue_held.json', list);
  return held;
}

function deleteHeldSale(id) {
  let list = getHeldSales();
  list = list.filter(item => item.id !== id);
  writeJson('queue_held.json', list);
  return true;
}

// ─── LOCATIONS CACHE ──────────────────────────────────────────────────────────
function getLocations() {
  return readJson('cache_locations.json', [{ id: 'default', name: 'Main Location', code: 'MAIN', isDefault: true, isActive: true }]);
}

function saveLocations(locationsList) {
  return writeJson('cache_locations.json', locationsList);
}

// ─── TERMINALS CACHE ──────────────────────────────────────────────────────────
function getTerminals() {
  return readJson('cache_terminals.json', [{ id: 'default-terminal', name: 'Main Terminal', code: 'TERM01', locationId: 'default', location: { id: 'default', name: 'Main Location' } }]);
}

function saveTerminals(terminalsList) {
  return writeJson('cache_terminals.json', terminalsList);
}

// ─── ACTIVE SHIFT CACHE ───────────────────────────────────────────────────────
function getActiveShift() {
  return readJson('active_shift.json', null);
}

function saveActiveShift(shift) {
  return writeJson('active_shift.json', shift);
}

// ─── SHIFTS HISTORY ───────────────────────────────────────────────────────────
function getShiftsHistory() {
  return readJson('history_shifts.json', []);
}

function addShiftToHistory(shift) {
  const history = getShiftsHistory();
  history.unshift(shift);
  writeJson('history_shifts.json', history.slice(0, 100)); // keep last 100
}

// ─── RECEIPT SETTINGS CACHE ───────────────────────────────────────────────────
function getReceiptSettings() {
  return readJson('receipt_settings.json', {
    storeName: 'Bison POS',
    address: 'Main St',
    phone: '000-000-0000',
    email: 'info@bison.com',
    website: 'www.bison.com',
    footer: 'Thank you for shopping with us!',
  });
}

function saveReceiptSettings(settings) {
  return writeJson('receipt_settings.json', settings);
}

module.exports = {
  initialize,
  getProducts,
  saveProducts,
  getCategories,
  saveCategories,
  getCustomers,
  saveCustomers,
  getTaxContext,
  saveTaxContext,
  normalizeTaxContext,
  getSalesQueue,
  addSaleToQueue,
  clearSalesQueue,
  removeFromSalesQueue,
  getReturnsQueue,
  addReturnToQueue,
  clearReturnsQueue,
  removeFromReturnsQueue,
  getShiftsQueue,
  addShiftActionToQueue,
  clearShiftsQueue,
  getHeldSales,
  addHeldSale,
  deleteHeldSale,
  getLocations,
  saveLocations,
  getTerminals,
  saveTerminals,
  getActiveShift,
  saveActiveShift,
  getShiftsHistory,
  addShiftToHistory,
  getReceiptSettings,
  saveReceiptSettings,
};
