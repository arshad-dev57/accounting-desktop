
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
        message: data.message || `Request failed (${res.status})`,
      };
    }
    return {
      success: true,
      data: data.data !== undefined ? data.data : data,
      pagination: data.pagination || null,
      stats: data.stats || null,
      message: data.message || '',
    };
  } catch (err) {
    return {
      success: false,
      message: err.message || 'Cannot reach the API. Check ELECTRON_API_URL.',
    };
  }
}


function getOrders(token, params = {}) {
  const qs = new URLSearchParams();
  qs.set('orderType', params.orderType || 'Sales Order');
  if (params.page)          qs.set('page', String(params.page));
  if (params.limit)         qs.set('limit', String(params.limit));
  if (params.search)        qs.set('search', params.search);
  if (params.status)        qs.set('status', params.status);
  if (params.paymentStatus) qs.set('paymentStatus', params.paymentStatus);
  if (params.priority)      qs.set('priority', params.priority);
  if (params.locationId)    qs.set('locationId', params.locationId);
  if (params.sortBy)        qs.set('sortBy', params.sortBy);
  if (params.sortOrder)     qs.set('sortOrder', params.sortOrder);
  return request(token, 'GET', `/api/orders/sales?${qs.toString()}`);
}

function createOrder(token, data) {
  return request(token, 'POST', '/api/orders/sales', data);
}

function updateOrderStatus(token, id, status, reason) {
  return request(token, 'PATCH', `/api/orders/${id}/status`, { status, reason });
}

function cancelOrder(token, id, reason) {
  return request(token, 'POST', `/api/orders/${id}/cancel`, { reason });
}

function deleteOrder(token, id) {
  return request(token, 'DELETE', `/api/orders/${id}`);
}


function getCustomers(token, params = {}) {
  const qs = new URLSearchParams();
  if (params.page)  qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  return request(token, 'GET', `/api/customers${qs.toString() ? `?${qs.toString()}` : ''}`);
}

function searchCustomers(token, q, limit = 20) {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return request(token, 'GET', `/api/customers/search?${qs.toString()}`);
}


function getProducts(token, params = {}) {
  const qs = new URLSearchParams();
  if (params.limit)      qs.set('limit', String(params.limit));
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.search)     qs.set('search', params.search);
  return request(token, 'GET', `/api/warehouse/products${qs.toString() ? `?${qs.toString()}` : ''}`);
}


function getTaxContext(token) {
  return request(token, 'GET', '/api/tax/context');
}

function getPOSSales(token, params = {}) {
  const qs = new URLSearchParams();
  if (params.page)      qs.set('page', String(params.page));
  if (params.limit)     qs.set('limit', String(params.limit));
  if (params.search)    qs.set('search', params.search);
  if (params.status)    qs.set('status', params.status);
  if (params.sortBy)    qs.set('sortBy', params.sortBy);
  if (params.sortOrder) qs.set('sortOrder', params.sortOrder);
  return request(token, 'GET', `/api/pos/sales?${qs.toString()}`);
}

function deletePOSSale(token, id) {
  return request(token, 'DELETE', `/api/pos/sales/${id}`);
}

module.exports = {
  getOrders,
  createOrder,
  updateOrderStatus,
  cancelOrder,
  deleteOrder,
  getCustomers,
  searchCustomers,
  getProducts,
  getTaxContext,
  getPOSSales,
  deletePOSSale,
};
