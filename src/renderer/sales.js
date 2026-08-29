
'use strict';

window.addEventListener('error', (event) => {
  alert('Error in sales.js: ' + event.message + '\nSource: ' + event.filename + ':' + event.lineno);
});

const api = window.bisonDesktop;

let orders = [];
let posSales = [];
let products = [];
let taxContext = null;
let pricingModel = 'exclusive';
let currentPage = 1;
const PAGE_LIMIT = 10;
let totalRecords = 0;
let totalPages = 1;
let hasNext = false;
let hasPrev = false;
let searchTerm = '';
let statusFilter = '';
let paymentFilter = '';
let priorityFilter = '';
let actionLoading = null;
let searchTimer = null;

let selectedCustomer = null;
let selectedProduct = null;
let orderItems = []; // { productId, productName, sku, quantity, unitPrice, totalPrice, taxRate, taxAmount }
let formProductFilter = '';

const mainArea = document.getElementById('main-area');
const viewList = document.getElementById('view-list');
const viewCreate = document.getElementById('view-create');
const tableBody = document.getElementById('table-body');
const paginationEl = document.getElementById('pagination');
const paginationInfo = document.getElementById('pagination-info');
const pgLabel = document.getElementById('pg-label');
const pgPrev = document.getElementById('pg-prev');
const pgNext = document.getElementById('pg-next');
const kpiPending = document.getElementById('kpi-pending');
const kpiProcessing = document.getElementById('kpi-processing');
const kpiDelivered = document.getElementById('kpi-delivered');
const btnCreate = document.getElementById('btn-create');
const btnRefresh = document.getElementById('btn-refresh');
const filterSearch = document.getElementById('filter-search');
const filterStatus = document.getElementById('filter-status');
const filterPayment = document.getElementById('filter-payment');
const filterPriority = document.getElementById('filter-priority');
const detailModal = document.getElementById('detail-modal');
const detailClose = document.getElementById('detail-close');
const detailOrderNum = document.getElementById('detail-order-num');
const detailCustomer = document.getElementById('detail-customer');
const detailBody = document.getElementById('detail-body');
const btnBackToPos = document.getElementById('btn-back-to-pos');
const btnLogout = document.getElementById('btn-logout');
const btnDeleteAll = document.getElementById('btn-delete-all');

// Form DOM refs
const formError = document.getElementById('form-error');
const formOk = document.getElementById('form-ok');
const btnFormCancel = document.getElementById('btn-form-cancel');
const btnSubmit = document.getElementById('btn-submit');
const customerTrigger = document.getElementById('customer-trigger');
const customerTriggerText = document.getElementById('customer-trigger-text');
const customerClear = document.getElementById('customer-clear');
const selectedBadge = document.getElementById('selected-customer-badge');
const badgeInitial = document.getElementById('badge-initial');
const badgeName = document.getElementById('badge-name');
const billingFields = document.getElementById('billing-fields');
const fSame = document.getElementById('f-same');
const prodSearch = document.getElementById('f-prod-search');
const prodSelect = document.getElementById('f-prod-select');
const prodPreview = document.getElementById('prod-preview');
const btnAddItem = document.getElementById('btn-add-item');
const itemsTableWrap = document.getElementById('items-table-wrap');
const summaryRows = document.getElementById('summary-rows');
const discountLabel = document.getElementById('discount-amount-label');
const fDtype = document.getElementById('f-dtype');

// Customer picker DOM refs
const cpickerModal = document.getElementById('cpicker-modal');
const cpickerClose = document.getElementById('cpicker-close');
const cpickerSearch = document.getElementById('cpicker-search');
const cpickerList = document.getElementById('cpicker-list');
const cpickerCount = document.getElementById('cpicker-count');
const cpickerError = document.getElementById('cpicker-error');

// ─── Utilities ────────────────────────────────────────────────────────────────
function money(n) {
  return new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
}

function computeTax(qty, unitPrice, taxRate, model) {
  const base = qty * unitPrice;
  if (!taxRate) return { taxAmount: 0, lineTotal: base };
  if (model === 'inclusive') {
    const taxAmount = base - base / (1 + taxRate / 100);
    return { taxAmount: parseFloat(taxAmount.toFixed(4)), lineTotal: base };
  }
  const taxAmount = base * (taxRate / 100);
  return { taxAmount: parseFloat(taxAmount.toFixed(4)), lineTotal: base + taxAmount };
}

function lineWithTax(item) {
  const t = computeTax(item.quantity, item.unitPrice, item.taxRate || 0, pricingModel);
  return { ...item, taxAmount: t.taxAmount, totalPrice: item.quantity * item.unitPrice };
}

function lineTotal(item) {
  return computeTax(item.quantity, item.unitPrice, item.taxRate || 0, pricingModel).lineTotal;
}

// ─── Status/payment/priority pill CSS ─────────────────────────────────────────
const STATUS_PILL = {
  Draft: 'pill pill-gray',
  Pending: 'pill pill-orange',
  Processing: 'pill pill-blue',
  Packed: 'pill pill-purple',
  Shipped: 'pill pill-indigo',
  'In Transit': 'pill pill-cyan',
  'Partially Delivered': 'pill pill-sky',
  Delivered: 'pill pill-green',
  Cancelled: 'pill pill-red',
  Returned: 'pill pill-pink',
  'On Hold': 'pill pill-yellow',
};
const PAYMENT_PILL = {
  Pending: 'pill pill-orange',
  Paid: 'pill pill-green',
  Partial: 'pill pill-blue',
  Refunded: 'pill pill-red',
  Cancelled: 'pill pill-gray',
};
const PRIORITY_PILL = {
  Low: 'pill pill-gray',
  Medium: 'pill pill-blue',
  High: 'pill pill-orange',
  Urgent: 'pill pill-red',
};

function pillClass(map, val) {
  return map[val] || 'pill pill-gray';
}

const VALID_TRANSITIONS = {
  Draft: ['Pending', 'Cancelled'],
  Pending: ['Processing', 'Cancelled'],
  Processing: ['Packed', 'Cancelled'],
  Packed: ['Shipped', 'Cancelled'],
  Shipped: ['In Transit', 'Delivered', 'Cancelled'],
  'In Transit': ['Delivered', 'Cancelled'],
  Delivered: ['Returned'],
  Cancelled: [],
  Returned: [],
  'On Hold': ['Pending', 'Processing', 'Cancelled'],
};

function getTransitions(status) {
  return VALID_TRANSITIONS[status] || [];
}

// ─── Views ────────────────────────────────────────────────────────────────────
function showListView() {
  viewList.classList.add('active');
  viewCreate.classList.remove('active');
  btnCreate.style.display = '';
  mainArea.scrollTop = 0;
}

function showCreateView() {
  viewList.classList.remove('active');
  viewCreate.classList.add('active');
  btnCreate.style.display = 'none';
  resetForm();
  mainArea.scrollTop = 0;
}

// ─── Fetch orders ─────────────────────────────────────────────────────────────
async function fetchOrders() {
  tableBody.innerHTML = `<div class="empty-state"><svg class="spin" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#014582" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg><p>Loading orders…</p></div>`;
  try {
    // Fetch Sales Orders
    const res = await api.sales.getOrders({
      page: currentPage,
      limit: PAGE_LIMIT,
      sortBy: 'orderDate',
      sortOrder: 'desc',
      orderType: 'Sales Order',
      search: searchTerm || undefined,
      status: statusFilter || undefined,
      paymentStatus: paymentFilter || undefined,
      priority: priorityFilter || undefined,
    });

    // Fetch POS Sales
    const posRes = await api.sales.getPOSSales({
      page: currentPage,
      limit: PAGE_LIMIT,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      search: searchTerm || undefined,
      status: statusFilter || undefined,
    });

    if (!res?.success) {
      tableBody.innerHTML = `<div class="empty-state" style="color:#dc2626;">${res?.message || 'Failed to load orders'}</div>`;
      return;
    }

    // Process Sales Orders
    const raw = res.data;
    if (raw && !Array.isArray(raw) && raw.data) {
      orders = raw.data;
      const pag = raw.pagination || {};
      totalRecords = pag.total || 0;
      totalPages = pag.pages || 1;
      hasNext = pag.hasNext || false;
      hasPrev = pag.hasPrev || false;
    } else if (res.pagination) {
      orders = Array.isArray(raw) ? raw : [];
      const pag = res.pagination;
      totalRecords = pag.total || 0;
      totalPages = pag.pages || 1;
      hasNext = pag.hasNext || false;
      hasPrev = pag.hasPrev || false;
    } else {
      orders = Array.isArray(raw) ? raw : [];
      totalRecords = orders.length;
      totalPages = 1; hasNext = false; hasPrev = false;
    }

    // Process POS Sales
    if (posRes?.success) {
      const posRaw = posRes.data;
      if (posRaw && !Array.isArray(posRaw) && posRaw.data) {
        posSales = posRaw.data;
      } else {
        posSales = Array.isArray(posRaw) ? posRaw : [];
      }
    } else {
      posSales = [];
    }

    // Combine both datasets
    const allRecords = [...orders, ...posSales];
    totalRecords = allRecords.length;

    // KPIs (on current page — mirrors Next.js behaviour)
    kpiPending.textContent = allRecords.filter(o => o.orderStatus === 'Pending' || o.status === 'Pending').length;
    kpiProcessing.textContent = allRecords.filter(o => o.orderStatus === 'Processing' || o.status === 'Processing').length;
    kpiDelivered.textContent = allRecords.filter(o => o.orderStatus === 'Delivered' || o.status === 'Delivered').length;

    renderTable();
    renderPagination();
  } catch (err) {
    tableBody.innerHTML = `<div class="empty-state" style="color:#dc2626;">${err.message}</div>`;
  }
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable() {
  const allRecords = [...orders, ...posSales];
  
  if (!allRecords.length) {
    tableBody.innerHTML = `<div class="empty-state"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg><p style="font-size:15px;font-weight:600;margin-bottom:4px;">No sales orders yet</p><p>Create your first sales order to get started</p></div>`;
    return;
  }

  const rows = allRecords.map((record, idx) => {
    // Check if this is a POS sale (has invoiceNumber field)
    const isPOS = record.invoiceNumber !== undefined;
    const id = record._id || record.id || '';
    
    // Map POS sale fields to order fields
    const orderNumber = isPOS ? record.invoiceNumber : (record.orderNumber || '—');
    const customerName = record.customerName || '—';
    const customerEmail = record.customerEmail || null;
    const status = isPOS ? (record.status || 'Completed') : (record.orderStatus || 'Draft');
    const paymentStatus = isPOS ? (record.paidAmount >= record.grandTotal ? 'Paid' : 'Unpaid') : (record.paymentStatus || 'Pending');
    const priority = record.priority || 'Medium';
    const total = Number(record.grandTotal || record.totalAmount || 0);
    const date = isPOS ? (record.createdAt || record.saleDate) : (record.orderDate || null);
    const isSalesOrder = !isPOS;
    
    const transitions = isSalesOrder ? getTransitions(status) : [];
    const statusOpts = [`<option value="${status}">${status}</option>`,
    ...transitions.map(s => `<option value="${s}">${s}</option>`)].join('');
    const canCancel = isSalesOrder && ['Draft', 'Pending', 'Processing'].includes(status);
    const canDelete = isSalesOrder ? ['Draft', 'Cancelled'].includes(status) : true; // POS sales can be deleted

    return `<tr data-id="${id}" data-idx="${idx}" data-type="${isPOS ? 'pos' : 'order'}">
      <td><span class="order-num">${orderNumber}</span></td>
      <td>
        <div class="customer-name">${customerName}</div>
        ${customerEmail ? `<div class="customer-email">${customerEmail}</div>` : ''}
      </td>
      <td><span class="${pillClass(STATUS_PILL, status)}">${status}</span></td>
      <td><span class="${pillClass(PAYMENT_PILL, paymentStatus)}">${paymentStatus}</span></td>
      <td><span class="${pillClass(PRIORITY_PILL, priority)}">${priority}</span></td>
      <td style="font-weight:600;color:#1e293b;">${money(total)}</td>
      <td style="color:var(--muted);font-size:12px;">${date ? new Date(date).toLocaleDateString() : '—'}</td>
      <td>
        <div class="actions-cell">
          <button class="icon-btn" title="View" data-action="view" data-idx="${idx}" data-type="${isPOS ? 'pos' : 'order'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          ${isSalesOrder ? `<select class="status-select" data-action="status" data-id="${id}" title="Change Status" ${transitions.length === 0 ? 'disabled' : ''}>
            ${statusOpts}
          </select>` : ''}
          ${canCancel ? `<button class="icon-btn warn" title="Cancel" data-action="cancel" data-id="${id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>` : ''}
          ${canDelete ? `<button class="icon-btn danger" title="Delete" data-action="delete" data-id="${id}" data-type="${isPOS ? 'pos' : 'order'}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  tableBody.innerHTML = `<table>
    <thead><tr>
      <th>Order #</th><th>Customer</th><th>Status</th><th>Payment</th>
      <th>Priority</th><th>Total</th><th>Date</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  // Wire up events on the new DOM
  tableBody.querySelectorAll('[data-action="view"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const type = btn.dataset.type;
      const record = type === 'pos' ? posSales[idx] : orders[idx];
      openDetailModal(record, type === 'pos');
    });
  });
  tableBody.querySelectorAll('[data-action="status"]').forEach(sel => {
    sel.addEventListener('change', async () => {
      await handleUpdateStatus(sel.dataset.id, sel.value);
    });
  });
  tableBody.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => handleCancelOrder(btn.dataset.id));
  });
  tableBody.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      if (type === 'pos') {
        handleDeletePOSSale(id);
      } else {
        handleDeleteOrder(id);
      }
    });
  });
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  if (totalPages <= 1) { paginationEl.style.display = 'none'; return; }
  paginationEl.style.display = 'flex';
  const from = (currentPage - 1) * PAGE_LIMIT + 1;
  const to = Math.min(currentPage * PAGE_LIMIT, totalRecords);
  paginationInfo.textContent = `Showing ${from}–${to} of ${totalRecords} orders`;
  pgLabel.textContent = `${currentPage} / ${totalPages}`;
  pgPrev.disabled = !hasPrev;
  pgNext.disabled = !hasNext;
}

// ─── Order actions ────────────────────────────────────────────────────────────
async function handleUpdateStatus(id, newStatus) {
  if (!id || !newStatus) return;
  try {
    const res = await api.sales.updateStatus(id, newStatus);
    if (!res?.success) { alert(res?.message || 'Failed to update status'); }
    fetchOrders();
  } catch (err) { alert(err.message || 'Error'); }
}

async function handleCancelOrder(id) {
  if (!confirm('Are you sure you want to cancel this order?')) return;
  try {
    const res = await api.sales.cancelOrder(id);
    if (!res?.success) { alert(res?.message || 'Failed to cancel order'); }
    fetchOrders();
  } catch (err) { alert(err.message || 'Error'); }
}

async function handleDeleteOrder(id) {
  if (!confirm('Are you sure you want to delete this order? This action cannot be undone.')) return;
  try {
    const res = await api.sales.deleteOrder(id);
    if (!res?.success) { alert(res?.message || 'Failed to delete order'); }
    fetchOrders();
  } catch (err) { alert(err.message || 'Error'); }
}

async function handleDeletePOSSale(id) {
  if (!confirm('Are you sure you want to delete this POS sale? This action cannot be undone.')) return;
  try {
    const res = await api.sales.deletePOSSale(id);
    if (!res?.success) { alert(res?.message || 'Failed to delete POS sale'); }
    fetchOrders();
  } catch (err) { alert(err.message || 'Error'); }
}

async function handleDeleteAll() {
  const allRecords = [...orders, ...posSales];
  if (!allRecords.length) {
    alert('No orders to delete.');
    return;
  }
  if (!confirm(`Are you sure you want to delete ALL ${allRecords.length} records? This action cannot be undone.`)) return;
  try {
    // Delete records one by one (API might not have bulk delete)
    let successCount = 0;
    let failCount = 0;
    for (const record of allRecords) {
      const id = record._id || record.id || '';
      const isPOS = record.invoiceNumber !== undefined;
      if (!id) continue;
      try {
        let res;
        if (isPOS) {
          res = await api.sales.deletePOSSale(id);
        } else {
          res = await api.sales.deleteOrder(id);
        }
        if (res?.success) successCount++;
        else failCount++;
      } catch (err) {
        failCount++;
      }
    }
    if (failCount > 0) {
      alert(`Deleted ${successCount} records. ${failCount} records failed to delete.`);
    } else {
      alert(`Successfully deleted all ${successCount} records.`);
    }
    fetchOrders();
  } catch (err) { alert(err.message || 'Error deleting records'); }
}

// ─── Order Detail Modal ───────────────────────────────────────────────────────
function openDetailModal(record, isPOS = false) {
  const orderNumber = isPOS ? (record.invoiceNumber || '—') : (record.orderNumber || '—');
  const customerName = record.customerName || '—';
  const status = isPOS ? (record.status || 'Completed') : (record.orderStatus || 'Draft');
  const paymentStatus = isPOS ? (record.paidAmount >= record.grandTotal ? 'Paid' : 'Unpaid') : (record.paymentStatus || 'Pending');
  const date = isPOS ? (record.createdAt || record.saleDate) : (record.orderDate || null);
  const tax = Number(record.taxTotal || 0);
  const grand = Number(record.grandTotal || record.totalAmount || 0);
  const items = record.items || [];

  detailOrderNum.textContent = orderNumber;
  detailCustomer.textContent = customerName;

  const itemRows = items.map(item => `
    <tr>
      <td style="padding:8px 12px;">${item.productName || '—'}</td>
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;">${item.sku || '—'}</td>
      <td style="padding:8px 12px;text-align:right;">${item.quantity}</td>
      <td style="padding:8px 12px;text-align:right;">${money(item.unitPrice)}</td>
      <td style="padding:8px 12px;text-align:right;color:var(--muted);">
        ${item.taxRate ? item.taxRate + '%' : '—'}
        ${item.taxAmount ? `<div style="font-size:11px;">${money(item.taxAmount)}</div>` : ''}
      </td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;">
        ${money((Number(item.totalPrice) || 0) + (Number(item.taxAmount) || 0))}
      </td>
    </tr>`).join('');

  const shipping = record.shippingAddress;
  const shippingBlock = !isPOS && shipping && (shipping.street || shipping.city) ? `
    <div style="margin-top:18px;">
      <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Shipping Address</p>
      <div style="background:#f8fafc;border-radius:10px;padding:12px;font-size:13px;color:#374151;line-height:1.6;">
        ${shipping.street ? `<div>${shipping.street}</div>` : ''}
        ${shipping.city || shipping.state ? `<div>${[shipping.city, shipping.state, shipping.postalCode].filter(Boolean).join(', ')}</div>` : ''}
        ${shipping.country ? `<div>${shipping.country}</div>` : ''}
      </div>
    </div>` : '';

  detailBody.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;">
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Status</p>
        <span class="${pillClass(STATUS_PILL, status)}">${status}</span>
      </div>
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Payment</p>
        <span class="${pillClass(PAYMENT_PILL, paymentStatus)}">${paymentStatus}</span>
      </div>
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">${isPOS ? 'Sale Date' : 'Order Date'}</p>
        <p style="font-size:13px;color:#374151;">${date ? new Date(date).toLocaleDateString() : '—'}</p>
      </div>
      ${!isPOS ? `<div>
        <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Expected Delivery</p>
        <p style="font-size:13px;color:#374151;">${record.expectedDeliveryDate ? new Date(record.expectedDeliveryDate).toLocaleDateString() : 'N/A'}</p>
      </div>` : '<div></div>'}
    </div>
    <div style="margin-bottom:18px;">
      <p style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">${isPOS ? 'Sale Items' : 'Order Items'}</p>
      <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="background:#f8fafc;">
            <tr>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">Product</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">SKU</th>
              <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">Qty</th>
              <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">Price</th>
              <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">Tax</th>
              <th style="text-align:right;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows || '<tr><td colspan="6" style="padding:12px;text-align:center;color:var(--muted);">No items</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div style="text-align:right;">
      ${tax > 0 ? `<p style="font-size:13px;color:var(--muted);">GST: ${money(tax)}</p>` : ''}
      <p style="font-size:13px;color:var(--muted);">Total Amount</p>
      <p style="font-size:24px;font-weight:800;color:#1e293b;">${money(grand)}</p>
    </div>
    ${shippingBlock}
  `;

  detailModal.style.display = 'flex';
}

// ─── Form helpers ─────────────────────────────────────────────────────────────
function fval(id) { return document.getElementById(id)?.value || ''; }
function fcheck(id) { return document.getElementById(id)?.checked || false; }

function showFormError(msg) {
  formError.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${msg}`;
  formError.style.display = 'flex';
  formOk.style.display = 'none';
  mainArea.scrollTop = 0;
}

function showFormOk(msg) {
  formOk.innerHTML = `✓ ${msg}`;
  formOk.style.display = 'flex';
  formError.style.display = 'none';
}

function clearFormMessages() {
  formError.style.display = 'none';
  formOk.style.display = 'none';
}

// ─── Order items form ─────────────────────────────────────────────────────────
function getFilteredProducts() {
  if (!formProductFilter.trim()) return products;
  const q = formProductFilter.toLowerCase();
  return products.filter(p =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.sku || '').toLowerCase().includes(q)
  );
}

function rebuildProductDropdown() {
  const filtered = getFilteredProducts();
  document.getElementById('prod-dropdown-label').innerHTML =
    `Select Product${products.length === 0 ? ' <span style="font-weight:400;color:var(--muted);font-size:11px;">(loading…)</span>' : ''}`;

  prodSelect.innerHTML = '<option value="">— Select a product —</option>' +
    filtered.map(p => {
      const id = String(p._id || p.id || '');
      return `<option value="${id}">${p.name} (${p.sku}) — ${money(p.sellingPrice)} | Stock: ${p.currentStock}</option>`;
    }).join('');

  // Keep selection if still valid
  if (selectedProduct) {
    const id = String(selectedProduct._id || selectedProduct.id || '');
    if (filtered.some(p => String(p._id || p.id || '') === id)) {
      prodSelect.value = id;
    } else {
      selectedProduct = null;
    }
  }
  updateProductPreview();
}

function updateProductPreview() {
  btnAddItem.disabled = !selectedProduct;
  if (!selectedProduct) { prodPreview.style.display = 'none'; return; }
  const qty = Math.max(1, parseInt(document.getElementById('f-qty').value) || 1);
  const rate = selectedProduct.taxRate || 0;
  const t = computeTax(qty, selectedProduct.sellingPrice, rate, pricingModel);
  const stockOk = qty <= (selectedProduct.currentStock || 0);

  prodPreview.style.display = 'flex';
  prodPreview.innerHTML = `
    <span style="color:var(--muted);">Unit price: <strong style="color:#1e293b;">${money(selectedProduct.sellingPrice)}</strong></span>
    ${rate > 0 ? `<span style="color:var(--muted);">GST ${rate}%${pricingModel === 'inclusive' ? ' incl.' : ''} · <strong style="color:#1e293b;">${money(t.taxAmount)}</strong></span>` : ''}
    <span style="color:var(--muted);">× ${qty} = <strong style="color:var(--brand);">${money(t.lineTotal)}</strong></span>
    <span style="margin-left:auto;font-size:12px;">Stock: <strong style="color:${stockOk ? '#16a34a' : '#dc2626'};">${selectedProduct.currentStock} available</strong></span>
  `;
}

function renderItemsTable() {
  if (!orderItems.length) {
    itemsTableWrap.innerHTML = `<div class="empty-state" style="padding:24px;border:2px dashed #e2e8f0;border-radius:12px;"><p style="font-size:13px;">No items added yet. Select a product above and click "Add to Order".</p></div>`;
    renderSummary();
    return;
  }
  const rows = orderItems.map((item, i) => `
    <tr>
      <td style="font-weight:600;color:#1e293b;">${item.productName}</td>
      <td style="font-family:monospace;font-size:12px;color:var(--muted);">${item.sku}</td>
      <td style="text-align:right;color:var(--muted);">${money(item.unitPrice)}</td>
      <td style="text-align:right;">
        <input class="qty-input" type="number" min="1" value="${item.quantity}" data-qty-idx="${i}" />
      </td>
      <td style="text-align:right;">
        <input class="tax-input" type="number" min="0" step="0.1" value="${item.taxRate || 0}" data-tax-idx="${i}" title="Tax rate %" />
        ${(item.taxAmount || 0) > 0 ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">${money(item.taxAmount)}</div>` : ''}
      </td>
      <td style="text-align:right;font-weight:700;color:#1e293b;">${money(lineTotal(item))}</td>
      <td style="text-align:right;">
        <button class="remove-btn" data-remove-idx="${i}" type="button" title="Remove">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </td>
    </tr>`).join('');

  const subtotal = orderItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  itemsTableWrap.innerHTML = `
    <table class="items-table">
      <thead><tr>
        <th>Product</th><th>SKU</th><th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Qty</th><th style="text-align:right;">Tax %</th>
        <th style="text-align:right;">Total</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="5" style="text-align:right;padding:8px 12px;font-size:13px;font-weight:600;color:var(--muted);">Items Subtotal</td>
        <td style="padding:8px 12px;text-align:right;font-weight:800;color:#1e293b;">${money(subtotal)}</td>
        <td></td>
      </tr></tfoot>
    </table>`;

  // Wire qty inputs
  itemsTableWrap.querySelectorAll('[data-qty-idx]').forEach(input => {
    input.addEventListener('change', () => {
      const i = Number(input.dataset.qtyIdx);
      const qty = Math.max(1, parseInt(input.value) || 1);
      orderItems[i] = lineWithTax({ ...orderItems[i], quantity: qty });
      renderItemsTable();
    });
  });
  // Wire tax inputs
  itemsTableWrap.querySelectorAll('[data-tax-idx]').forEach(input => {
    input.addEventListener('change', () => {
      const i = Number(input.dataset.taxIdx);
      const rate = parseFloat(input.value) || 0;
      orderItems[i] = lineWithTax({ ...orderItems[i], taxRate: rate });
      renderItemsTable();
    });
  });
  // Wire remove buttons
  itemsTableWrap.querySelectorAll('[data-remove-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      orderItems.splice(Number(btn.dataset.removeIdx), 1);
      renderItemsTable();
    });
  });

  renderSummary();
}

function renderSummary() {
  const subtotal = orderItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const taxTotal = orderItems.reduce((s, i) => s + (i.taxAmount || 0), 0);
  const shippingCost = parseFloat(fval('f-scost')) || 0;
  const discountType = fval('f-dtype');
  const dval = parseFloat(fval('f-dval')) || 0;
  const discount = discountType === 'Percentage' ? (subtotal * dval / 100) : dval;
  const grand = pricingModel === 'inclusive'
    ? subtotal + shippingCost - discount
    : subtotal + taxTotal + shippingCost - discount;

  summaryRows.innerHTML = `
    <div class="summary-row"><span>Subtotal (${orderItems.length} item${orderItems.length !== 1 ? 's' : ''})</span><strong>${money(subtotal)}</strong></div>
    <div class="summary-row"><span>Shipping (${fval('f-smethod') || 'Standard'})</span><strong>${money(shippingCost)}</strong></div>
    ${taxTotal > 0 ? `<div class="summary-row"><span>GST${pricingModel === 'inclusive' ? ' (included)' : ''}</span><strong>${money(taxTotal)}</strong></div>` : ''}
    ${discount > 0 ? `<div class="summary-row"><span>Discount${discountType === 'Percentage' ? ` (${dval}%)` : ' (Fixed)'}</span><strong style="color:#dc2626;">− ${money(discount)}</strong></div>` : ''}
    <div class="summary-total"><span>Grand Total</span><strong>${money(grand)}</strong></div>
  `;
}

function addProductLine(product, qty) {
  const id = String(product._id || product.id || '');
  const existing = orderItems.findIndex(i => String(i.productId) === id);
  const taxRate = Number(product.taxRate) || 0;

  if (existing >= 0) {
    const newQty = orderItems[existing].quantity + qty;
    if (newQty > (product.currentStock || 0)) {
      showFormError(`Insufficient stock. Available: ${product.currentStock}`);
      return;
    }
    orderItems[existing] = lineWithTax({ ...orderItems[existing], quantity: newQty });
  } else {
    if (qty > (product.currentStock || 0)) {
      showFormError(`Insufficient stock. Available: ${product.currentStock}`);
      return;
    }
    orderItems.push(lineWithTax({
      productId: id, productName: product.name, sku: product.sku || '',
      quantity: qty, unitPrice: product.sellingPrice,
      totalPrice: product.sellingPrice * qty, taxRate, taxAmount: 0,
    }));
  }
  renderItemsTable();
  clearFormMessages();
}

async function loadProducts() {
  try {
    const res = await api.products.list({ limit: 500 });
    if (res?.success) {
      const raw = res.data;
      products = Array.isArray(raw) ? raw : (raw?.data || raw?.products || []);
    }
  } catch (err) {
    console.warn('[sales] products load failed', err.message);
  }
  rebuildProductDropdown();
}

// ─── Load tax context ──────────────────────────────────────────────────────────
async function loadTaxContext() {
  try {
    const res = await api.tax.getContext();
    if (res?.success) {
      taxContext = res.data;
      if (taxContext?.pricingModel) pricingModel = taxContext.pricingModel;
    }
  } catch { /* silent */ }
}

// ─── Reset form ────────────────────────────────────────────────────────────────
function resetForm() {
  clearFormMessages();
  selectedCustomer = null;
  selectedProduct = null;
  orderItems = [];
  formProductFilter = '';

  // Reset customer trigger
  customerTriggerText.textContent = 'Click to select customer…';
  customerTriggerText.style.color = '#94a3b8';
  customerTrigger.classList.remove('selected');
  customerClear.style.display = 'none';
  selectedBadge.style.display = 'none';

  // Clear text inputs
  ['f-cname', 'f-cemail', 'f-cphone', 'f-ccompany', 'f-ctaxid',
    'f-ss', 'f-sc', 'f-sst', 'f-sp',
    'f-bs', 'f-bc', 'f-bst', 'f-bp',
    'f-salesperson', 'f-delivery', 'f-coupon', 'f-scarrier', 'f-cnotes', 'f-inotes', 'f-tags'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

  // Reset selects
  document.getElementById('f-ctype').value = 'Individual';
  document.getElementById('f-sco').value = 'Pakistan';
  document.getElementById('f-bco').value = 'Pakistan';
  document.getElementById('f-otype').value = 'Standard';
  document.getElementById('f-priority').value = 'Medium';
  document.getElementById('f-source').value = 'Direct';
  document.getElementById('f-smethod').value = 'Standard';
  document.getElementById('f-pmethod').value = 'Cash';
  document.getElementById('f-pstatus').value = 'Pending';
  document.getElementById('f-dtype').value = 'Percentage';
  document.getElementById('f-scost').value = '0';
  document.getElementById('f-dval').value = '0';
  document.getElementById('f-qty').value = '1';

  fSame.checked = true;
  billingFields.style.display = 'none';

  prodPreview.style.display = 'none';
  prodSearch.value = '';
  btnAddItem.disabled = true;
  renderItemsTable();
  rebuildProductDropdown();
}

async function handleSubmit() {
  clearFormMessages();
  const customerName = fval('f-cname').trim();
  if (!customerName) { showFormError('Customer name is required'); return; }
  if (!orderItems.length) { showFormError('Please add at least one item'); return; }

  btnSubmit.disabled = true;
  btnSubmit.innerHTML = `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg> Creating…`;

  try {
    const sameShipping = fSame.checked;
    const shippingAddr = { street: fval('f-ss'), city: fval('f-sc'), state: fval('f-sst'), postalCode: fval('f-sp'), country: fval('f-sco') };
    const billingAddr = sameShipping ? shippingAddr : { street: fval('f-bs'), city: fval('f-bc'), state: fval('f-bst'), postalCode: fval('f-bp'), country: fval('f-bco') };

    const subtotal = orderItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    const taxTotalAmt = orderItems.reduce((s, i) => s + (i.taxAmount || 0), 0);
    const shippingCost = parseFloat(fval('f-scost')) || 0;
    const discountType = fval('f-dtype');
    const dval = parseFloat(fval('f-dval')) || 0;
    const discount = discountType === 'Percentage' ? (subtotal * dval / 100) : dval;
    const grand = pricingModel === 'inclusive'
      ? subtotal + shippingCost - discount
      : subtotal + taxTotalAmt + shippingCost - discount;

    const payload = {
      customerName,
      customerEmail: fval('f-cemail'),
      customerPhone: fval('f-cphone'),
      customerType: fval('f-ctype'),
      customerCompany: fval('f-ccompany'),
      customerTaxId: fval('f-ctaxid'),
      shippingAddress: shippingAddr,
      billingAddress: billingAddr,
      items: orderItems.map(item => {
        const t = lineWithTax(item);
        return { ...t, productId: String(item.productId || ''), taxRate: t.taxRate || 0, taxAmount: t.taxAmount || 0 };
      }),
      orderType: fval('f-otype'),
      priority: fval('f-priority'),
      source: fval('f-source'),
      salesPerson: fval('f-salesperson'),
      expectedDeliveryDate: fval('f-delivery') || undefined,
      shippingMethod: fval('f-smethod'),
      shippingCarrier: fval('f-scarrier'),
      shippingCost,
      paymentMethod: fval('f-pmethod'),
      paymentStatus: fval('f-pstatus'),
      couponCode: fval('f-coupon'),
      discountType,
      discountPercentage: discountType === 'Percentage' ? dval : 0,
      discountAmount: discountType === 'Fixed' ? dval : 0,
      customerNotes: fval('f-cnotes'),
      internalNotes: fval('f-inotes'),
      tags: fval('f-tags').split(',').map(t => t.trim()).filter(Boolean),
      subtotal,
      discountTotal: discount,
      taxTotal: taxTotalAmt,
      grandTotal: grand,
    };

    const res = await api.sales.createOrder(payload);
    if (!res?.success) {
      showFormError(res?.message || 'Failed to create order');
      return;
    }
    showListView();
    fetchOrders();
  } catch (err) {
    showFormError(err.message || 'An error occurred');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Create Order`;
  }
}

// ─── Customer picker ──────────────────────────────────────────────────────────
let cpickerCustomers = [];
let cpickerTimer = null;
let cpickerPageState = { page: 1, total: 0, hasNext: false };
let cpickerLoading = false;

async function cpickerLoad(searchQ, page = 1, append = false) {
  cpickerLoading = true;
  if (!append) {
    cpickerList.innerHTML = `<div class="empty-state" style="padding:20px;"><svg class="spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#014582" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg><p style="font-size:13px;margin-top:6px;">Loading customers…</p></div>`;
  }
  cpickerError.style.display = 'none';

  try {
    let res;
    if (searchQ && searchQ.length >= 2) {
      res = await api.customers.search(searchQ, 20);
    } else {
      res = await api.customers.list({ page, limit: 20 });
    }

    if (!res?.success) throw new Error(res?.message || 'Failed to load customers');

    const raw = res.data;
    let list, pag;
    if (raw && !Array.isArray(raw) && raw.data) {
      list = raw.data; pag = raw.pagination || {};
    } else if (res.pagination) {
      list = Array.isArray(raw) ? raw : []; pag = res.pagination;
    } else {
      list = Array.isArray(raw) ? raw : []; pag = { total: list.length, hasNext: false, page: 1 };
    }

    cpickerCustomers = append ? [...cpickerCustomers, ...list] : list;
    cpickerPageState = { page: pag.page || 1, total: pag.total || list.length, hasNext: pag.hasNext || false };
    cpickerCount.textContent = cpickerPageState.total > 0 ? `(${cpickerPageState.total} total)` : '';
    renderCpickerList();
  } catch (err) {
    cpickerError.textContent = err.message;
    cpickerError.style.display = 'block';
    if (!append) { cpickerCustomers = []; renderCpickerList(); }
  } finally {
    cpickerLoading = false;
  }
}

function renderCpickerList() {
  if (!cpickerCustomers.length) {
    cpickerList.innerHTML = `<div class="empty-state" style="padding:20px;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><p style="font-size:13px;margin-top:6px;">No customers found</p></div>`;
    return;
  }
  cpickerList.innerHTML = cpickerCustomers.map((c, i) => {
    const init = (c.name || 'C').charAt(0).toUpperCase();
    const email = c.email ? `<span style="margin-right:10px;">✉ ${c.email}</span>` : '';
    const phone = c.phone ? `<span>✆ ${c.phone}</span>` : '';
    const statusBg = c.status === 'Active' ? '#f0fdf4' : '#f1f5f9';
    const statusColor = c.status === 'Active' ? '#15803d' : '#475569';
    return `<button class="cpicker-item" data-cidx="${i}" type="button">
      <div class="cpicker-avatar">${init}</div>
      <div style="min-width:0;flex:1;">
        <div class="cpicker-name">${c.name || '—'}</div>
        <div class="cpicker-meta">${email}${phone}</div>
      </div>
      <div style="flex-shrink:0;text-align:right;">
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${statusBg};color:${statusColor};">${c.status || 'Active'}</span>
        ${c.customerNumber ? `<div style="font-size:11px;color:var(--muted);font-family:monospace;margin-top:2px;">${c.customerNumber}</div>` : ''}
      </div>
    </button>`;
  }).join('') + (cpickerPageState.hasNext ? `<div id="cpicker-load-more" style="padding:10px;text-align:center;font-size:12px;color:var(--muted);">Loading more…</div>` : `<p style="text-align:center;font-size:11px;color:var(--muted);padding:8px 0;">${cpickerCustomers.length} customers shown</p>`);

  cpickerList.querySelectorAll('[data-cidx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = cpickerCustomers[Number(btn.dataset.cidx)];
      handleCustomerSelect(c);
      closeCpicker();
    });
  });

  // Infinite scroll sentinel
  if (cpickerPageState.hasNext) {
    const sentinel = document.getElementById('cpicker-load-more');
    if (sentinel) {
      const obs = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !cpickerLoading) {
          obs.disconnect();
          cpickerLoad(cpickerSearch.value.trim(), cpickerPageState.page + 1, true);
        }
      }, { threshold: 0.1 });
      obs.observe(sentinel);
    }
  }
}

function openCpicker() {
  cpickerModal.style.display = 'flex';
  cpickerCustomers = [];
  cpickerSearch.value = '';
  cpickerError.style.display = 'none';
  cpickerCount.textContent = '';
  cpickerLoad('');
  setTimeout(() => cpickerSearch.focus(), 80);
}

function closeCpicker() {
  cpickerModal.style.display = 'none';
}

function handleCustomerSelect(customer) {
  if (!customer) { resetCustomerInForm(); return; }
  selectedCustomer = customer;

  // Update trigger
  customerTriggerText.textContent = customer.name;
  customerTriggerText.style.color = '#1e293b';
  customerTrigger.classList.add('selected');
  customerClear.style.display = '';

  badgeInitial.textContent = (customer.name || 'C').charAt(0).toUpperCase();
  badgeName.innerHTML = customer.name + (customer.customerNumber ? ` <span style="font-size:11px;font-family:monospace;color:#a78bfa;">#${customer.customerNumber}</span>` : '');
  selectedBadge.style.display = 'flex';

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('f-cname', customer.name);
  set('f-cemail', customer.email);
  set('f-cphone', customer.phone);
  set('f-ccompany', customer.company);
  set('f-ctaxid', customer.taxId);
  const typeEl = document.getElementById('f-ctype');
  if (typeEl && customer.customerType) typeEl.value = customer.customerType;

  const addr = customer.address || customer.shippingAddress || customer.primaryAddress;
  if (addr) {
    set('f-ss', addr.street);
    set('f-sc', addr.city);
    set('f-sst', addr.state);
    set('f-sp', addr.postalCode);
    const sco = document.getElementById('f-sco');
    if (sco && addr.country) sco.value = addr.country;

    if (fSame.checked) {
      set('f-bs', addr.street); set('f-bc', addr.city); set('f-bst', addr.state); set('f-bp', addr.postalCode);
      const bco = document.getElementById('f-bco');
      if (bco && addr.country) bco.value = addr.country;
    }
  }

  if (!fSame.checked && customer.billingAddress) {
    const b = customer.billingAddress;
    if (b.street || b.city) {
      set('f-bs', b.street); set('f-bc', b.city); set('f-bst', b.state); set('f-bp', b.postalCode);
      const bco = document.getElementById('f-bco');
      if (bco && b.country) bco.value = b.country;
    }
  }
}

function resetCustomerInForm() {
  selectedCustomer = null;
  customerTriggerText.textContent = 'Click to select customer…';
  customerTriggerText.style.color = '#94a3b8';
  customerTrigger.classList.remove('selected');
  customerClear.style.display = 'none';
  selectedBadge.style.display = 'none';
  ['f-cname', 'f-cemail', 'f-cphone', 'f-ccompany', 'f-ctaxid'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-ctype').value = 'Individual';
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
async function runCatalogSync() {
  const overlay = document.getElementById('sync-overlay');
  const msg = document.getElementById('sync-overlay-msg');
  const btn = document.getElementById('btn-sync');
  if (btn) btn.disabled = true;
  if (overlay) overlay.classList.add('show');
  if (msg) msg.textContent = 'Pulling latest categories, subcategories and products from the cloud.';
  try {
    const locationId = window.bisonLocation
      ? bisonLocation.effectiveId(bisonLocation.getStoredLocationId())
      : '';
    const catalog = await api.pos.syncMasterData({ refresh: true, locationId, skipReload: true });
    if (msg) msg.textContent = 'Refreshing products and orders…';
    await Promise.all([loadProducts(), fetchOrders()]);
    const n = catalog?.counts?.products || 0;
    if (catalog?.success) {
      if (msg) msg.textContent = `Synced · ${n} products ready.`;
      if (viewCreate.classList.contains('active')) {
        showFormOk(`Catalog synced · ${n} products`);
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else {
      if (msg) msg.textContent = catalog?.message || 'Sync incomplete';
      if (viewCreate.classList.contains('active')) {
        showFormError(catalog?.message || 'Sync incomplete');
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  } catch (err) {
    if (msg) msg.textContent = err.message || 'Sync failed';
    if (viewCreate.classList.contains('active')) {
      showFormError(err.message || 'Sync failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  } finally {
    if (overlay) overlay.classList.remove('show');
    if (btn) btn.disabled = false;
  }
}

document.getElementById('btn-sync').addEventListener('click', runCatalogSync);

btnBackToPos.addEventListener('click', () => {
  window.location.href = './sell.html';
});
btnLogout.addEventListener('click', () => api.auth.logout());
btnDeleteAll.addEventListener('click', handleDeleteAll);
api.auth.onExpired(() => api.auth.logout());

btnCreate.addEventListener('click', () => { showCreateView(); loadProducts(); loadTaxContext(); });

btnRefresh.addEventListener('click', () => { currentPage = 1; fetchOrders(); });

filterSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchTerm = filterSearch.value.trim(); currentPage = 1; fetchOrders(); }, 300);
});
filterStatus.addEventListener('change', () => { statusFilter = filterStatus.value; currentPage = 1; fetchOrders(); });
filterPayment.addEventListener('change', () => { paymentFilter = filterPayment.value; currentPage = 1; fetchOrders(); });
filterPriority.addEventListener('change', () => { priorityFilter = filterPriority.value; currentPage = 1; fetchOrders(); });

pgPrev.addEventListener('click', () => { if (hasPrev) { currentPage--; fetchOrders(); } });
pgNext.addEventListener('click', () => { if (hasNext) { currentPage++; fetchOrders(); } });

detailClose.addEventListener('click', () => { detailModal.style.display = 'none'; });
detailModal.addEventListener('click', e => { if (e.target === detailModal) detailModal.style.display = 'none'; });

// Form events
btnFormCancel.addEventListener('click', showListView);
btnSubmit.addEventListener('click', handleSubmit);

// Customer picker
customerTrigger.addEventListener('click', openCpicker);
customerClear.addEventListener('click', resetCustomerInForm);
cpickerClose.addEventListener('click', closeCpicker);
cpickerModal.addEventListener('click', e => { if (e.target === cpickerModal) closeCpicker(); });
cpickerSearch.addEventListener('input', () => {
  clearTimeout(cpickerTimer);
  cpickerTimer = setTimeout(() => cpickerLoad(cpickerSearch.value.trim()), 300);
});

// Billing checkbox
fSame.addEventListener('change', () => { billingFields.style.display = fSame.checked ? 'none' : 'grid'; });

// Product search filter
prodSearch.addEventListener('input', () => {
  formProductFilter = prodSearch.value;
  rebuildProductDropdown();
});

// Product select
prodSelect.addEventListener('change', () => {
  const id = prodSelect.value;
  if (!id) { selectedProduct = null; updateProductPreview(); return; }
  selectedProduct = products.find(p => String(p._id || p.id || '') === id) || null;
  if (selectedProduct) prodSearch.value = '';
  updateProductPreview();
});

// Qty input change (update preview)
document.getElementById('f-qty').addEventListener('input', updateProductPreview);

// Add item
btnAddItem.addEventListener('click', () => {
  if (!selectedProduct) { showFormError('Please select a product'); return; }
  const qty = Math.max(1, parseInt(document.getElementById('f-qty').value) || 1);
  if (qty < 1) { showFormError('Quantity must be at least 1'); return; }
  addProductLine(selectedProduct, qty);
  selectedProduct = null;
  prodSelect.value = '';
  document.getElementById('f-qty').value = '1';
  updateProductPreview();
});

// Discount type label
fDtype.addEventListener('change', () => {
  discountLabel.textContent = fDtype.value === 'Percentage' ? 'Discount %' : 'Discount Amount';
  renderSummary();
});

// Shipping cost / discount value → re-render summary
['f-scost', 'f-dval', 'f-smethod'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', renderSummary);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const session = await api.auth.getSession();
  const user = session?.user || {};
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '';
  if (name) document.getElementById('top-meta').textContent = name;

  await fetchOrders();
}

boot().catch(err => {
  tableBody.innerHTML = `<div class="empty-state" style="color:#dc2626;">${err.message}</div>`;
});
