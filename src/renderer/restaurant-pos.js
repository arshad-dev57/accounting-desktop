const api = window.bisonDesktop;

let pollTimer = null;

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isAdminRole(role) {
  const r = String(role || '').toLowerCase();
  return ['admin', 'owner', 'superadmin', 'company_admin', 'manager'].includes(r);
}

function renderKitchen(orders) {
  const root = document.getElementById('kitchen-list');
  if (!orders.length) {
    root.innerHTML =
      '<div class="empty">No orders in kitchen queue. Waiters send orders from the mobile pick app.</div>';
    return;
  }
  root.innerHTML = orders
    .map(
      (o) => `
    <div class="card" data-id="${o.id}">
      <div class="ticket-head">
        <div>
          <b>Ticket #${o.ticketNumber || '—'} · ${o.tableLabel || o.orderType || 'Order'}</b>
          <div class="meta">${fmtTime(o.sentAt)} · ${o.status}</div>
        </div>
        <span class="badge sent">${o.status}</span>
      </div>
      <div class="lines">${(o.lines || [])
        .map(
          (l) =>
            `<div>${l.quantity}× ${l.productName}${l.notes ? ` <em>(${l.notes})</em>` : ''}</div>`
        )
        .join('')}</div>
      <div class="actions">
        ${
          o.status === 'SENT'
            ? `<button type="button" class="btn-soft" data-action="preparing" data-id="${o.id}">Start</button>`
            : ''
        }
        <button type="button" class="btn-brand" data-action="ready" data-id="${o.id}">Mark ready</button>
      </div>
    </div>`
    )
    .join('');
}

async function refreshKitchen() {
  const kitchenRes = await api.pos.restaurantKitchenQueue();
  if (kitchenRes?.success) renderKitchen(kitchenRes.data || []);
}

document.getElementById('kitchen-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    const res =
      action === 'preparing'
        ? await api.pos.restaurantMarkPreparing(id)
        : await api.pos.restaurantMarkReady(id);
    if (!res?.success) alert(res?.message || 'Action failed');
    await refreshKitchen();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-refresh').addEventListener('click', () => refreshKitchen());
document.getElementById('btn-pos')?.addEventListener('click', () => api.pos.enterSell());
document.getElementById('btn-mgmt')?.addEventListener('click', () => api.pos.enterManagement());
document.getElementById('btn-logout').addEventListener('click', () => api.auth.logout());

async function boot() {
  const session = await api.auth.getSession();
  const user = session?.user || {};
  document.getElementById('user-meta').textContent =
    `${user.firstName || ''} ${user.lastName || ''} · ${user.role || 'Kitchen'} · Kitchen display`.trim();

  if (isAdminRole(user.role)) {
    document.getElementById('btn-pos')?.classList.remove('hidden');
    document.getElementById('btn-mgmt')?.classList.remove('hidden');
  }

  await refreshKitchen();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshKitchen, 5000);
}

boot().catch((err) => alert(err.message));
