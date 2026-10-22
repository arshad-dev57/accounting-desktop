const api = window.bisonDesktop;

let stationId = '';
let lastOrderCount = 0;
const orderVersions = new Map();

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function elapsedLabel(order) {
  const t = order.timing || {};
  const mins = t.elapsedMinutes;
  if (mins == null) return '';
  if (mins < 1) return 'just now';
  return `${mins} min`;
}

function waiterName(order) {
  const w = order.waiter;
  if (!w) return '';
  return `${w.firstName || ''} ${w.lastName || ''}`.trim();
}

function orderTypeLabel(type) {
  if (type === 'takeaway') return 'Takeaway';
  if (type === 'delivery') return 'Delivery';
  return 'Dine in';
}

function isAdminRole(role) {
  const r = String(role || '').toLowerCase();
  return ['admin', 'owner', 'superadmin', 'company_admin', 'manager'].includes(r);
}

function parseGrouped(kitchenRes) {
  const grouped = kitchenRes?.data;
  if (grouped && (grouped.newOrders || grouped.preparing || grouped.ready)) {
    return {
      newOrders: grouped.newOrders || [],
      preparing: grouped.preparing || [],
      ready: grouped.ready || [],
    };
  }
  const flat = Array.isArray(kitchenRes?.flat)
    ? kitchenRes.flat
    : Array.isArray(grouped)
      ? grouped
      : [];
  return {
    newOrders: flat.filter((o) => o.status === 'SENT'),
    preparing: flat.filter((o) => o.status === 'PREPARING'),
    ready: flat.filter((o) => o.status === 'READY'),
  };
}

function renderOrderCard(o, { showStart, showReady }) {
  orderVersions.set(o.id, o.version);
  const t = o.timing || {};
  const delayed = Boolean(t.isDelayed);
  const priority =
    o.priority && o.priority !== 'normal'
      ? `<span class="badge-priority">${String(o.priority).toUpperCase()}</span>`
      : '';
  const table = o.tableLabel ? `Table ${o.tableLabel}` : orderTypeLabel(o.orderType);
  const waiter = waiterName(o);
  return `
    <div class="card${delayed ? ' delayed' : ''}" data-id="${o.id}" data-version="${o.version || ''}">
      <div class="ticket-head">
        <div>
          <b>#${o.ticketNumber || '—'} — ${table}${priority}</b>
          <div class="meta">
            ${waiter ? `${waiter} · ` : ''}${fmtTime(o.sentAt)}
            ${t.prepMinutes != null ? ` · Kitchen ${t.prepMinutes}m` : ''}
          </div>
        </div>
        <span class="time-badge${delayed ? ' delayed' : ''}">${elapsedLabel(o) || o.status}</span>
      </div>
      <div class="lines">${(o.lines || [])
        .map((l) => {
          const station = l.kitchenStation?.name;
          return `<div>${l.quantity}× ${l.productName}${
            l.notes ? ` <em>(${l.notes})</em>` : ''
          }${station ? `<span class="station-tag"> · ${station}</span>` : ''}</div>`;
        })
        .join('')}</div>
      <div class="actions">
        ${
          showStart
            ? `<button type="button" class="btn-soft" data-action="preparing" data-id="${o.id}">Start</button>`
            : ''
        }
        ${
          showReady
            ? `<button type="button" class="btn-brand" data-action="ready" data-id="${o.id}">Mark ready</button>`
            : ''
        }
      </div>
    </div>`;
}

function renderColumn(rootId, orders, options) {
  const root = document.getElementById(rootId);
  if (!orders.length) {
    root.innerHTML = '<div class="empty-col">No orders</div>';
    return;
  }
  root.innerHTML = orders.map((o) => renderOrderCard(o, options)).join('');
}

function renderKitchen(grouped) {
  const data = grouped || { newOrders: [], preparing: [], ready: [] };
  renderColumn('col-new', data.newOrders || [], { showStart: true, showReady: false });
  renderColumn('col-preparing', data.preparing || [], { showStart: false, showReady: true });
  renderColumn('col-ready', data.ready || [], { showStart: false, showReady: false });

  const total =
    (data.newOrders?.length || 0) + (data.preparing?.length || 0) + (data.ready?.length || 0);
  const newCount = data.newOrders?.length || 0;
  const badge = document.getElementById('new-order-badge');
  if (badge) {
    if (newCount > lastOrderCount && lastOrderCount > 0) {
      badge.textContent = `${newCount} new order${newCount === 1 ? '' : 's'}`;
      badge.classList.remove('hidden');
    } else if (newCount === 0) {
      badge.classList.add('hidden');
    }
  }
  lastOrderCount = newCount;
}

async function loadStations() {
  const res = await api.pos.restaurantKitchenStations();
  const select = document.getElementById('station-filter');
  if (!select || !res?.success) return;
  const stations = res.data || [];
  select.innerHTML =
    '<option value="">All stations</option>' +
    stations.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
}

async function refreshKitchen() {
  const query = {};
  if (stationId) query.stationId = stationId;

  const kitchenRes = await api.pos.restaurantKitchenQueue(query);
  if (!kitchenRes?.success) {
    const meta = document.getElementById('sync-meta');
    if (meta) meta.textContent = kitchenRes?.message || 'Could not load kitchen queue';
    return;
  }

  renderKitchen(parseGrouped(kitchenRes));

  const meta = document.getElementById('sync-meta');
  if (meta) {
    const when = kitchenRes.serverTime
      ? new Date(kitchenRes.serverTime).toLocaleTimeString()
      : new Date().toLocaleTimeString();
    meta.textContent = `Updated ${when} · click Refresh for latest`;
  }
}

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    const payload = { orderId: id, expectedVersion: orderVersions.get(id) };
    const res =
      action === 'preparing'
        ? await api.pos.restaurantMarkPreparing(payload)
        : await api.pos.restaurantMarkReady(payload);
    if (!res?.success) {
      alert(res?.message || 'Action failed');
      return;
    }
    await refreshKitchen();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Refreshing…';
  try {
    await refreshKitchen();
    document.getElementById('new-order-badge')?.classList.add('hidden');
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
});
document.getElementById('btn-pos')?.addEventListener('click', () => api.pos.enterSell());
document.getElementById('btn-mgmt')?.addEventListener('click', () => api.pos.enterManagement());
document.getElementById('btn-logout').addEventListener('click', () => api.auth.logout());
document.getElementById('station-filter')?.addEventListener('change', (e) => {
  stationId = e.target.value || '';
});

async function boot() {
  const session = await api.auth.getSession();
  const user = session?.user || {};
  document.getElementById('user-meta').textContent =
    `${user.firstName || ''} ${user.lastName || ''} · ${user.role || 'Kitchen'} · Kitchen display`.trim();

  if (isAdminRole(user.role)) {
    document.getElementById('btn-pos')?.classList.remove('hidden');
    document.getElementById('btn-mgmt')?.classList.remove('hidden');
  }

  await loadStations();
  const meta = document.getElementById('sync-meta');
  if (meta) meta.textContent = 'Click Refresh to load orders · live alerts from server';

  api.kitchen?.onNewOrder?.((payload) => {
    const badge = document.getElementById('new-order-badge');
    if (!badge) return;
    badge.textContent = payload?.message || payload?.title || 'New kitchen order';
    badge.classList.remove('hidden');
  });

  api.kitchen?.onNotificationsCleared?.(() => {
    document.getElementById('new-order-badge')?.classList.add('hidden');
  });

  api.kitchen?.onNotificationClick?.(() => {
    refreshKitchen();
    document.getElementById('new-order-badge')?.classList.add('hidden');
  });
}

boot().catch((err) => alert(err.message));
