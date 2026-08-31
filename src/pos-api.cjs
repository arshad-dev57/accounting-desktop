/**
 * POS and Warehouse HTTP calls from the Electron main process.
 * Renderer never talks to the backend directly.
 */
const config = require('./config.cjs');

async function request(accessToken, method, pathname, body) {
  const base = config.resolveApiUrl();
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return {
        success: false,
        status: res.status,
        code: data.code,
        retryable: data.retryable === true || (res.status >= 500 && res.status !== 409),
        message: data.message || `Request failed (${res.status})`,
      };
    }
    return {
      success: true,
      data: data.data !== undefined ? data.data : data,
      stats: data.stats || null,
      total: data.total,
      message: data.message || '',
    };
  } catch (err) {
    return {
      success: false,
      message: err.message || 'Cannot reach the POS API. Check ELECTRON_API_URL.',
    };
  }
}

// ─── Terminals ───────────────────────────────────────────────────────────────
function listTerminals(token, locationId) {
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  return request(token, 'GET', `/api/pos/terminals${qs}`);
}

// ─── Shifts ───────────────────────────────────────────────────────────────────
function getCurrentShift(token) {
  return request(token, 'GET', '/api/pos/shifts/current');
}

function getShiftHistory(token, paramsString = '') {
  const qs = paramsString ? `?${paramsString}` : '';
  return request(token, 'GET', `/api/pos/shifts${qs}`);
}

function openShift(token, payload) {
  return request(token, 'POST', '/api/pos/shifts/open', payload);
}

function closeShift(token, shiftId, payload) {
  return request(token, 'POST', `/api/pos/shifts/${shiftId}/close`, payload);
}

function suspendShift(token, shiftId) {
  return request(token, 'POST', `/api/pos/shifts/${shiftId}/suspend`);
}

function resumeShift(token, shiftId) {
  return request(token, 'POST', `/api/pos/shifts/${shiftId}/resume`);
}

function recordCashFlow(token, payload) {
  return request(token, 'POST', '/api/pos/cash-flow', payload);
}

// ─── Products ─────────────────────────────────────────────────────────────────
function searchProducts(token, paramsString) {
  return request(token, 'GET', `/api/pos/products/search?${paramsString}`);
}

function byBarcode(token, code, locationId) {
  const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  return request(token, 'GET', `/api/pos/products/barcode/${encodeURIComponent(code)}${qs}`);
}

// ─── Sales & Returns ──────────────────────────────────────────────────────────
function completeSale(token, payload) {
  return request(token, 'POST', '/api/pos/sales', payload);
}

function holdSale(token, payload) {
  return request(token, 'POST', '/api/pos/sales/hold', payload);
}

// Held sales list
function getHeldSales(token) {
  return request(token, 'GET', '/api/pos/sales/held');
}

function deleteHeldSale(token, id) {
  return request(token, 'DELETE', `/api/pos/sales/held/${id}`);
}

function syncOfflineSales(token, payload) {
  return request(token, 'POST', '/api/pos/sales/sync', payload);
}

function checkUserStatus(token) {
  return request(token, 'GET', '/api/users/me');
}

function fetchSessionStatus(token) {
  return request(token, 'GET', '/api/users/session-status');
}

function listCompanyUsers(token) {
  return request(token, 'GET', '/api/admin/users');
}

function updateCompanyUser(token, userId, body) {
  return request(token, 'PUT', `/api/admin/users/${userId}`, body);
}

function processReturn(token, payload) {
  return request(token, 'POST', '/api/pos/returns', payload);
}

function getShiftReport(token, shiftId) {
  return request(token, 'GET', `/api/pos/reports/shift/${shiftId}`);
}

function getDailyReport(token, paramsString = '') {
  const qs = paramsString ? `?${paramsString}` : '';
  return request(token, 'GET', `/api/pos/reports/daily${qs}`);
}

function verifyManager(token, payload) {
  return request(token, 'POST', '/api/pos/auth/verify-manager', payload);
}

// ─── POS Management / Admin APIs ──────────────────────────────────────────
function createTerminal(token, body) {
  return request(token, 'POST', '/api/pos/terminals', body);
}

function updateTerminal(token, id, body) {
  return request(token, 'PUT', `/api/pos/terminals/${id}`, body);
}

function deleteTerminal(token, id) {
  return request(token, 'DELETE', `/api/pos/terminals/${id}`);
}

function reopenShift(token, id) {
  return request(token, 'POST', `/api/pos/shifts/${id}/reopen`);
}

function listSales(token, paramsString = '') {
  const qs = paramsString ? `?${paramsString}` : '';
  return request(token, 'GET', `/api/pos/sales${qs}`);
}

function getSale(token, id) {
  return request(token, 'GET', `/api/pos/sales/${id}`);
}

function voidSale(token, id, body) {
  return request(token, 'POST', `/api/pos/sales/${id}/void`, body);
}

function convertToInvoice(token, id, body) {
  return request(token, 'POST', `/api/pos/sales/${id}/convert-to-invoice`, body || {});
}

function getAuditLogs(token, paramsString = '') {
  const qs = paramsString ? `?${paramsString}` : '';
  return request(token, 'GET', `/api/pos/audit-logs${qs}`);
}

function saveReceiptSettings(token, body) {
  return request(token, 'PUT', '/api/pos/receipt-settings', body);
}


// ─── Categories (Warehouse) ──────────────────────────────────────────────────
function getCategories(token, paramsString = '') {
  const qs = paramsString ? `?${paramsString}` : '';
  return request(token, 'GET', `/api/warehouse/categories${qs}`);
}

// ─── Bulk-fetch helpers for offline sync cache refresh ────────────────────────
function locationQuery(locationId) {
  return locationId ? `&locationId=${encodeURIComponent(locationId)}` : '';
}

async function fetchAllProducts(token, locationId) {
  const loc = locationQuery(locationId);
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await request(token, 'GET', `/api/warehouse/products?limit=100&page=${page}${loc}`);
    if (!res.success) {
      if (page === 1) {
        return request(token, 'GET', `/api/pos/products/search?q=&limit=2000&includeZeroStock=true${loc}`);
      }
      break;
    }
    const rows = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  if (!all.length) {
    return request(token, 'GET', `/api/pos/products/search?q=&limit=2000&includeZeroStock=true${loc}`);
  }
  return { success: true, data: all };
}

function fetchAllCategories(token) {
  return request(token, 'GET', '/api/warehouse/categories?tree=true');
}

async function fetchAllSuppliers(token) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await request(token, 'GET', `/api/warehouse/supplier?limit=100&page=${page}`);
    if (!res.success) {
      if (page === 1) {
        return request(token, 'GET', '/api/warehouse/supplier?limit=2000');
      }
      break;
    }
    const rows = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.suppliers)
          ? res.data.suppliers
          : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return { success: true, data: all };
}

async function fetchAllCustomers(token) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await request(token, 'GET', `/api/warehouse/customers?limit=100&page=${page}`);
    if (!res.success) {
      if (page === 1) {
        return request(token, 'GET', '/api/warehouse/customers/search?q=&limit=2000');
      }
      break;
    }
    const rows = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.customers)
          ? res.data.customers
          : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  if (!all.length) {
    return request(token, 'GET', '/api/warehouse/customers/search?q=&limit=2000');
  }
  return { success: true, data: all };
}

function fetchTaxContext(token) {
  // Company tax profile from Tax Compliance (web) — same as /api/tax/context
  return request(token, 'GET', '/api/tax/context');
}

// ─── Customers (Warehouse) ───────────────────────────────────────────────────
function searchCustomers(token, q, limit = 10) {
  return request(token, 'GET', `/api/warehouse/customers/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

function createCustomer(token, payload) {
  return request(token, 'POST', '/api/warehouse/customers', payload);
}

function getCustomerCreditInfo(token, customerId) {
  return request(token, 'GET', `/api/warehouse/customers/${customerId}/credit-info`);
}

// ─── Receipt & Profile Settings ──────────────────────────────────────────────
function listLocations(token) {
  return request(token, 'GET', '/api/warehouse/locations');
}

function getReceiptSettings(token) {
  return request(token, 'GET', '/api/pos/receipt-settings');
}

function pullMasterData(token, cursor, limit) {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (limit) qs.set('limit', String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request(token, 'GET', `/api/pos/sync/master-data${suffix}`);
}

/**
 * Local -> Cloud push of offline-created/edited catalog records.
 * Body: { records: { categories, subcategories, products } } — every record must
 * carry a stable client-generated `syncId`. Returns a syncId -> cloudId mapping.
 */
function pushMasterData(token, records) {
  return request(token, 'POST', '/api/pos/sync/master-data/push', { records });
}

/**
 * Combined bidirectional sync (Local -> Cloud -> Local) in a single call.
 * Pushes the supplied pending `records`, then returns the full merged cloud
 * catalog (categories, subcategories, products) plus the syncId -> cloudId map.
 */
function publishMasterData(token, records, opts = {}) {
  const body = { records };
  return request(token, 'POST', '/api/pos/sync/master-data/sync', body);
}

/**
 * Lightweight connectivity probe. Any HTTP response from the configured API
 * host means we are "online" for sync purposes (even 4xx/5xx).
 * Localhost ECONNREFUSED is NOT "no internet" — surface the real API URL.
 */
async function checkConnectivity(token) {
  const base = config.resolveApiUrl();
  const probes = [`${base}/`, `${base}/api/health/prisma`];
  let lastErr = 'unreachable';

  for (const url of probes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { success: true, status: res.status, online: true, apiUrl: base };
    } catch (err) {
      clearTimeout(timer);
      const code = err?.cause?.code || err?.code || '';
      if (err?.name === 'AbortError') lastErr = 'timed out after 12s';
      else if (code === 'ECONNREFUSED') lastErr = 'connection refused — server not running';
      else if (code === 'ENOTFOUND') lastErr = 'DNS lookup failed';
      else if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') lastErr = 'network unreachable';
      else lastErr = code || err.message || 'Offline';
    }
  }

  const isLocal = /127\.0\.0\.1|localhost/i.test(base);
  const hint = isLocal
    ? 'Start the local backend on this port, or set ELECTRON_API_URL to your cloud API in .env.'
    : 'Check ELECTRON_API_URL and that the API is reachable.';

  return {
    success: false,
    online: false,
    apiUrl: base,
    message: `Cannot reach API at ${base} (${lastErr}). ${hint}`,
  };
}

function getProfile(token) {
  return request(token, 'GET', '/api/profile');
}

// ─── Restaurant orders (Flow #2) ─────────────────────────────────────────────
function getKitchenOrders(token) {
  return request(token, 'GET', '/api/pos/restaurant/orders/kitchen');
}

function getReadyOrders(token) {
  return request(token, 'GET', '/api/pos/restaurant/orders/ready');
}

function markRestaurantPreparing(token, orderId) {
  return request(token, 'POST', `/api/pos/restaurant/orders/${orderId}/preparing`);
}

function markRestaurantReady(token, orderId) {
  return request(token, 'POST', `/api/pos/restaurant/orders/${orderId}/ready`);
}

function markRestaurantPaid(token, orderId, body = {}) {
  return request(token, 'POST', `/api/pos/restaurant/orders/${orderId}/paid`, body);
}

function createRestaurantOrder(token, body) {
  return request(token, 'POST', '/api/pos/restaurant/orders', body);
}

module.exports = {
  listTerminals,
  getCurrentShift,
  getShiftHistory,
  openShift,
  closeShift,
  suspendShift,
  resumeShift,
  recordCashFlow,
  searchProducts,
  byBarcode,
  completeSale,
  holdSale,
  getHeldSales,
  deleteHeldSale,
  syncOfflineSales,
  processReturn,
  getShiftReport,
  getDailyReport,
  verifyManager,
  getCategories,
  searchCustomers,
  createCustomer,
  getCustomerCreditInfo,
  listLocations,
  getReceiptSettings,
  pullMasterData,
  pushMasterData,
  publishMasterData,
  checkConnectivity,
  getProfile,
  // POS Management APIs
  createTerminal,
  updateTerminal,
  deleteTerminal,
  reopenShift,
  listSales,
  getSale,
  voidSale,
  convertToInvoice,
  getAuditLogs,
  saveReceiptSettings,
  // Bulk-fetch helpers
  fetchAllProducts,
  fetchAllCategories,
  getKitchenOrders,
  getReadyOrders,
  markRestaurantPreparing,
  markRestaurantReady,
  markRestaurantPaid,
  createRestaurantOrder,
  fetchAllSuppliers,
  fetchAllCustomers,
  fetchTaxContext,
  checkUserStatus,
  fetchSessionStatus,
  listCompanyUsers,
  updateCompanyUser,
};
