/**
 * local-db.cjs — Offline JSON file-based database for Bisonstechs POS Desktop.
 * Stores all caches (products, categories, customers, tax) and queues (sales, returns, shifts, held).
 * Runs completely locally on the host machine.
 */
const fs = require('fs');
const path = require('path');

let basePath = '';
let dbPath = '';
let activeCompanyId = '';

const DATA_FILES = [
  'cache_products.json',
  'cache_categories.json',
  'cache_customers.json',
  'cache_tax_context.json',
  'cache_locations.json',
  'cache_terminals.json',
  'queue_sales.json',
  'queue_returns.json',
  'queue_shifts.json',
  'queue_held.json',
  'active_shift.json',
  'history_shifts.json',
  'receipt_settings.json',
];

function sanitizeCompanyId(companyId) {
  return String(companyId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function companyDir(companyId) {
  return path.join(basePath, 'companies', sanitizeCompanyId(companyId));
}

function initialize(userDataPath) {
  basePath = userDataPath;
  dbPath = userDataPath;
  activeCompanyId = '';
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true });
  }
}

function getActiveCompanyId() {
  return activeCompanyId;
}

function migrateLegacyFlatFiles(companyId) {
  if (!basePath || !companyId) return;
  const marker = path.join(basePath, 'legacy_local_migrated.json');
  if (fs.existsSync(marker)) return;

  const hasLegacy = DATA_FILES.some((f) => fs.existsSync(path.join(basePath, f)));
  if (!hasLegacy) return;

  const target = companyDir(companyId);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });

  // Claim migration atomically so parallel login/boot calls do not race rename().
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify({ status: 'migrating', companyId: String(companyId) }, null, 2),
      { flag: 'wx' }
    );
  } catch {
    return;
  }

  for (const filename of DATA_FILES) {
    const src = path.join(basePath, filename);
    const dst = path.join(target, filename);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.copyFileSync(src, dst);
      try {
        fs.unlinkSync(src);
      } catch {
        /* keep src if delete fails — dst copy succeeded */
      }
    } catch (err) {
      console.warn('[Local DB] legacy migrate skip', filename, err.message);
    }
  }

  try {
    fs.writeFileSync(
      marker,
      JSON.stringify({ companyId: String(companyId), migratedAt: new Date().toISOString() }, null, 2)
    );
    console.log('[Local DB] migrated legacy flat files to company', companyId);
  } catch (err) {
    console.warn('[Local DB] legacy marker finalize failed', err.message);
  }
}

function setCompanyScope(companyId) {
  const next = String(companyId || '').trim();
  if (!next) return false;
  if (activeCompanyId === next && dbPath === companyDir(next)) return true;

  activeCompanyId = next;
  dbPath = companyDir(next);
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }
  migrateLegacyFlatFiles(next);
  console.log('[Local DB] company scope →', next);
  return true;
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
  let invoiceNumber = salePayload.invoiceNumber;
  if (isPlaceholderInvoice(invoiceNumber)) {
    invoiceNumber = allocateInvoiceNumber().invoiceNumber;
  }
  const sale = {
    id: salePayload.id || `local-sale-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    createdAt: new Date().toISOString(),
    ...salePayload,
    invoiceNumber,
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

function patchSaleInQueue(id, patch = {}) {
  const queue = getSalesQueue();
  const idx = queue.findIndex((s) => String(s.id) === String(id));
  if (idx < 0) return null;
  queue[idx] = { ...queue[idx], ...patch };
  writeJson('queue_sales.json', queue);
  return queue[idx];
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
  return readJson('cache_terminals.json', []);
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

// ─── INVOICE / RECEIPT SERIAL NUMBERING ───────────────────────────────────────
const DEFAULT_INVOICE_SERIAL = {
  prefix: 'INV',
  nextNumber: 1,
  padLength: 6,
};

function normalizeInvoiceSerial(raw = {}) {
  const prefix = String(raw.prefix ?? DEFAULT_INVOICE_SERIAL.prefix).trim() || 'INV';
  let nextNumber = Math.floor(Number(raw.nextNumber));
  if (!Number.isFinite(nextNumber) || nextNumber < 1) nextNumber = 1;
  let padLength = Math.floor(Number(raw.padLength));
  if (!Number.isFinite(padLength) || padLength < 1) padLength = 6;
  if (padLength > 12) padLength = 12;
  return { prefix, nextNumber, padLength };
}

function getInvoiceSerialSettings() {
  return normalizeInvoiceSerial(readJson('invoice_serial.json', DEFAULT_INVOICE_SERIAL));
}

function saveInvoiceSerialSettings(settings) {
  const next = normalizeInvoiceSerial(settings);
  writeJson('invoice_serial.json', next);
  return next;
}

function formatInvoiceNumber(settings, n) {
  const cfg = normalizeInvoiceSerial(settings);
  const num = Math.max(1, Math.floor(Number(n) || 1));
  return `${cfg.prefix}${String(num).padStart(cfg.padLength, '0')}`;
}

function previewInvoiceNumber(settings) {
  const cfg = normalizeInvoiceSerial(settings || getInvoiceSerialSettings());
  return formatInvoiceNumber(cfg, cfg.nextNumber);
}

/** True when invoice looks auto/temp/empty and should be replaced by a serial. */
function isPlaceholderInvoice(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^POS-L-\d+/i.test(s)) return true;
  if (/^POS-R-\d+/i.test(s)) return true;
  if (/^local-sale-/i.test(s)) return true;
  if (/^POS-\d{8}-\d+$/i.test(s)) return true; // backend random day stamp
  return false;
}

/**
 * Atomically allocate the next receipt/invoice number for this company PC.
 * Returns { invoiceNumber, serial }.
 */
function allocateInvoiceNumber() {
  const cfg = getInvoiceSerialSettings();
  const invoiceNumber = formatInvoiceNumber(cfg, cfg.nextNumber);
  const serial = saveInvoiceSerialSettings({
    ...cfg,
    nextNumber: cfg.nextNumber + 1,
  });
  return { invoiceNumber, serial };
}

// ─── RESTAURANT TOKEN NUMBERING ───────────────────────────────────────────────
const DEFAULT_RESTAURANT_TOKEN = {
  enabled: false,
  printCustomer: true,
  printKitchen: true,
  prefix: 'T',
  nextNumber: 1,
  padLength: 3,
  resetMode: 'daily', // daily | never | shift (same as daily with hour)
  resetHour: 0,
  lastResetKey: '',
  // Token slip design (same printer / receipt-style layout)
  paperWidthMm: 80, // 58 | 80 — same thermal widths as receipt
  showLogo: true,
  showAddress: true,
  showPhone: true,
  showDateTime: true,
  showTable: true,
  showTicket: true,
  showItemsOnCustomer: false,
  showCashier: false,
  headerCustomer: 'CUSTOMER TOKEN',
  headerKitchen: 'KITCHEN TOKEN / KOT',
  copyLabel: 'TOKEN COPY',
  customerMessage: 'Please wait for your order',
  customerHint: 'Show this token when collecting',
  footerText: 'Thank you!',
  poweredBy: 'Powered by BisonTechs POS',
};

function localDateKey(d = new Date(), resetHour = 0) {
  const x = new Date(d);
  const hour = Math.min(23, Math.max(0, Math.floor(Number(resetHour) || 0)));
  // Business day flips at resetHour (e.g. 0 = midnight, 4 = 4am restaurant day)
  if (x.getHours() < hour) x.setDate(x.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function boolField(raw, key, fallback = true) {
  if (raw[key] === undefined || raw[key] === null || raw[key] === '') return fallback;
  return raw[key] === true || raw[key] === 'true' || raw[key] === 1 || raw[key] === '1';
}

function textField(raw, key, fallback = '') {
  if (raw[key] === undefined || raw[key] === null) return fallback;
  return String(raw[key]);
}

function normalizeRestaurantToken(raw = {}) {
  const prefix = String(raw.prefix ?? DEFAULT_RESTAURANT_TOKEN.prefix).trim() || 'T';
  let nextNumber = Math.floor(Number(raw.nextNumber));
  if (!Number.isFinite(nextNumber) || nextNumber < 1) nextNumber = 1;
  let padLength = Math.floor(Number(raw.padLength));
  if (!Number.isFinite(padLength) || padLength < 1) padLength = 3;
  if (padLength > 8) padLength = 8;
  let resetHour = Math.floor(Number(raw.resetHour));
  if (!Number.isFinite(resetHour) || resetHour < 0) resetHour = 0;
  if (resetHour > 23) resetHour = 23;
  const resetMode = ['daily', 'never', 'shift'].includes(String(raw.resetMode || ''))
    ? String(raw.resetMode)
    : 'daily';
  const paperWidthMm = Number(raw.paperWidthMm) === 58 ? 58 : 80;
  return {
    enabled: raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1,
    printCustomer: boolField(raw, 'printCustomer', true),
    printKitchen: boolField(raw, 'printKitchen', true),
    prefix,
    nextNumber,
    padLength,
    resetMode,
    resetHour,
    lastResetKey: String(raw.lastResetKey || ''),
    paperWidthMm,
    showLogo: boolField(raw, 'showLogo', true),
    showAddress: boolField(raw, 'showAddress', true),
    showPhone: boolField(raw, 'showPhone', true),
    showDateTime: boolField(raw, 'showDateTime', true),
    showTable: boolField(raw, 'showTable', true),
    showTicket: boolField(raw, 'showTicket', true),
    showItemsOnCustomer: boolField(raw, 'showItemsOnCustomer', false),
    showCashier: boolField(raw, 'showCashier', false),
    headerCustomer: textField(raw, 'headerCustomer', DEFAULT_RESTAURANT_TOKEN.headerCustomer).trim()
      || DEFAULT_RESTAURANT_TOKEN.headerCustomer,
    headerKitchen: textField(raw, 'headerKitchen', DEFAULT_RESTAURANT_TOKEN.headerKitchen).trim()
      || DEFAULT_RESTAURANT_TOKEN.headerKitchen,
    copyLabel: textField(raw, 'copyLabel', DEFAULT_RESTAURANT_TOKEN.copyLabel),
    customerMessage: textField(raw, 'customerMessage', DEFAULT_RESTAURANT_TOKEN.customerMessage),
    customerHint: textField(raw, 'customerHint', DEFAULT_RESTAURANT_TOKEN.customerHint),
    footerText: textField(raw, 'footerText', DEFAULT_RESTAURANT_TOKEN.footerText),
    poweredBy: textField(raw, 'poweredBy', DEFAULT_RESTAURANT_TOKEN.poweredBy),
  };
}

function getRestaurantTokenSettings() {
  return normalizeRestaurantToken(readJson('restaurant_token.json', DEFAULT_RESTAURANT_TOKEN));
}

function saveRestaurantTokenSettings(settings) {
  const next = normalizeRestaurantToken(settings);
  writeJson('restaurant_token.json', next);
  return next;
}

function formatRestaurantToken(settings, n) {
  const cfg = normalizeRestaurantToken(settings);
  const num = Math.max(1, Math.floor(Number(n) || 1));
  return `${cfg.prefix}${String(num).padStart(cfg.padLength, '0')}`;
}

function previewRestaurantToken(settings) {
  const cfg = normalizeRestaurantToken(settings || getRestaurantTokenSettings());
  if (cfg.resetMode !== 'never') {
    const key = localDateKey(new Date(), cfg.resetHour);
    if (cfg.lastResetKey !== key) return formatRestaurantToken(cfg, 1);
  }
  return formatRestaurantToken(cfg, cfg.nextNumber);
}

/** Apply daily/shift reset if needed. persist=true writes back. */
function maybeResetRestaurantToken(cfg, persist = true) {
  const settings = normalizeRestaurantToken(cfg);
  if (settings.resetMode === 'never') return settings;
  const key = localDateKey(new Date(), settings.resetHour);
  if (settings.lastResetKey === key) return settings;
  const next = {
    ...settings,
    nextNumber: 1,
    lastResetKey: key,
  };
  if (persist) saveRestaurantTokenSettings(next);
  return next;
}

function allocateRestaurantToken() {
  let cfg = maybeResetRestaurantToken(getRestaurantTokenSettings(), true);
  const tokenNumber = formatRestaurantToken(cfg, cfg.nextNumber);
  cfg = saveRestaurantTokenSettings({
    ...cfg,
    nextNumber: cfg.nextNumber + 1,
  });
  return { tokenNumber, settings: cfg };
}

function resetRestaurantTokenCounter() {
  const cfg = getRestaurantTokenSettings();
  const key = localDateKey(new Date(), cfg.resetHour);
  return saveRestaurantTokenSettings({
    ...cfg,
    nextNumber: 1,
    lastResetKey: key,
  });
}

module.exports = {
  initialize,
  setCompanyScope,
  getActiveCompanyId,
  getCompanyDataPath: () => dbPath,
  getBasePath: () => basePath,
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
  patchSaleInQueue,
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
  getInvoiceSerialSettings,
  saveInvoiceSerialSettings,
  formatInvoiceNumber,
  previewInvoiceNumber,
  isPlaceholderInvoice,
  allocateInvoiceNumber,
  getRestaurantTokenSettings,
  saveRestaurantTokenSettings,
  formatRestaurantToken,
  previewRestaurantToken,
  allocateRestaurantToken,
  maybeResetRestaurantToken,
  resetRestaurantTokenCounter,
};
