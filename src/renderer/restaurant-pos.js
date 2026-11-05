const api = window.bisonDesktop;

let stationId = '';
let lastOrderCount = 0;
let pollTimer = null;
let refreshing = false;
const orderVersions = new Map();
const POLL_MS = 4000;

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

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
      ? `<span class="badge-priority">${esc(String(o.priority).toUpperCase())}</span>`
      : '';
  const table = o.tableLabel ? `Table ${o.tableLabel}` : orderTypeLabel(o.orderType);
  const waiter = waiterName(o);
  const token = o.tokenNumber || o.token || '';
  return `
    <div class="card${delayed ? ' delayed' : ''}" data-id="${esc(o.id)}" data-version="${esc(o.version || '')}">
      <div class="ticket-head">
        <div>
          <div class="ticket-no">#${esc(o.ticketNumber || '—')}${priority}</div>
          <div class="ticket-table">${esc(table)}${token ? ` · Token ${esc(token)}` : ''}</div>
          <div class="meta">
            ${waiter ? `${esc(waiter)} · ` : ''}${esc(fmtTime(o.sentAt))}
            ${t.prepMinutes != null ? ` · Kitchen ${esc(t.prepMinutes)}m` : ''}
          </div>
        </div>
        <span class="time-badge${delayed ? ' delayed' : ''}">${esc(elapsedLabel(o) || o.status || '')}</span>
      </div>
      <div class="lines">${(o.lines || [])
        .map((l) => {
          const station = l.kitchenStation?.name;
          return `<div>
            <div class="line-row">
              <span class="qty">${esc(l.quantity)}×</span>
              <span class="name">${esc(l.productName || 'Item')}</span>
            </div>
            ${l.notes ? `<div class="line-notes">★ ${esc(l.notes)}</div>` : ''}
            ${station ? `<div class="station-tag">${esc(station)}</div>` : ''}
          </div>`;
        })
        .join('')}</div>
      ${o.notes ? `<div class="order-notes"><b>Note:</b> ${esc(o.notes)}</div>` : ''}
      <div class="actions">
        ${
          showStart
            ? `<button type="button" class="btn-soft" data-action="preparing" data-id="${esc(o.id)}">Start cooking</button>`
            : ''
        }
        ${
          showReady
            ? `<button type="button" class="btn-brand" data-action="ready" data-id="${esc(o.id)}">Mark ready</button>`
            : ''
        }
      </div>
    </div>`;
}

function renderColumn(rootId, orders, options) {
  const root = document.getElementById(rootId);
  if (!root) return;
  if (!orders.length) {
    root.innerHTML = '<div class="empty-col"><b>Queue clear</b>No orders in this stage</div>';
    return;
  }
  root.innerHTML = orders.map((o) => renderOrderCard(o, options)).join('');
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(n);
}

function renderKitchen(grouped) {
  const data = grouped || { newOrders: [], preparing: [], ready: [] };
  const newN = data.newOrders?.length || 0;
  const prepN = data.preparing?.length || 0;
  const readyN = data.ready?.length || 0;

  renderColumn('col-new', data.newOrders || [], { showStart: true, showReady: false });
  renderColumn('col-preparing', data.preparing || [], { showStart: false, showReady: true });
  renderColumn('col-ready', data.ready || [], { showStart: false, showReady: false });

  setCount('count-new', newN);
  setCount('count-prep', prepN);
  setCount('count-ready', readyN);
  setCount('kpi-new', newN);
  setCount('kpi-prep', prepN);
  setCount('kpi-ready', readyN);

  const badge = document.getElementById('new-order-badge');
  if (badge) {
    if (newN > lastOrderCount && lastOrderCount >= 0 && lastOrderCount !== newN) {
      const added = Math.max(0, newN - lastOrderCount);
      if (added > 0 && lastOrderCount > 0) {
        badge.textContent = `${added} new order${added === 1 ? '' : 's'} arrived`;
        badge.classList.remove('hidden');
      }
    }
    if (newN === 0) badge.classList.add('hidden');
  }
  lastOrderCount = newN;
}

async function loadStations() {
  const res = await api.pos.restaurantKitchenStations();
  const select = document.getElementById('station-filter');
  if (!select || !res?.success) return;
  const stations = res.data || [];
  const prev = stationId;
  select.innerHTML =
    '<option value="">All stations</option>' +
    stations.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if (prev) select.value = prev;
}

async function refreshKitchen({ quiet = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const meta = document.getElementById('sync-meta');
  const dot = document.getElementById('live-dot');
  try {
    const query = {};
    if (stationId) query.stationId = stationId;

    const kitchenRes = await api.pos.restaurantKitchenQueue(query);
    if (!kitchenRes?.success) {
      if (meta) meta.textContent = kitchenRes?.message || 'Could not load kitchen queue';
      if (dot) dot.classList.add('offline');
      return;
    }

    renderKitchen(parseGrouped(kitchenRes));
    if (dot) dot.classList.remove('offline');

    if (meta) {
      const when = kitchenRes.serverTime
        ? new Date(kitchenRes.serverTime).toLocaleTimeString()
        : new Date().toLocaleTimeString();
      meta.textContent = quiet
        ? `Live · updated ${when}`
        : `Updated ${when} · auto-refresh every ${POLL_MS / 1000}s`;
    }
  } catch (err) {
    if (meta) meta.textContent = err.message || 'Kitchen refresh failed';
    if (dot) dot.classList.add('offline');
  } finally {
    refreshing = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refreshKitchen({ quiet: true }).catch(() => {});
  }, POLL_MS);
}

function tickClock() {
  const el = document.getElementById('live-clock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
    await refreshKitchen({ quiet: true });
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-refresh')?.addEventListener('click', async () => {
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
document.getElementById('btn-logout')?.addEventListener('click', () => api.auth.logout());
document.getElementById('station-filter')?.addEventListener('change', (e) => {
  stationId = e.target.value || '';
  refreshKitchen().catch(() => {});
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshKitchen({ quiet: true }).catch(() => {});
  }
});

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);

  const session = await api.auth.getSession();
  const user = session?.user || {};
  document.getElementById('user-meta').textContent =
    `${user.firstName || ''} ${user.lastName || ''} · ${user.role || 'Kitchen'} · Kitchen display`.trim();

  if (isAdminRole(user.role)) {
    document.getElementById('btn-pos')?.classList.remove('hidden');
    document.getElementById('btn-mgmt')?.classList.remove('hidden');
  }

  await loadStations();
  // Auto-load as soon as page opens — no manual Refresh needed
  await refreshKitchen();
  startPolling();

  api.kitchen?.onNewOrder?.((payload) => {
    const badge = document.getElementById('new-order-badge');
    if (badge) {
      badge.textContent = payload?.message || payload?.title || 'New kitchen order';
      badge.classList.remove('hidden');
    }
    refreshKitchen({ quiet: true }).catch(() => {});
  });

  api.kitchen?.onNotificationsCleared?.(() => {
    document.getElementById('new-order-badge')?.classList.add('hidden');
  });

  api.kitchen?.onNotificationClick?.(() => {
    refreshKitchen().catch(() => {});
    document.getElementById('new-order-badge')?.classList.add('hidden');
  });
}

boot().catch((err) => {
  const meta = document.getElementById('sync-meta');
  if (meta) meta.textContent = err.message || 'Kitchen boot failed';
  alert(err.message);
});
