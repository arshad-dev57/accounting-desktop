const api = window.bisonDesktop;
const TABS = ['Terminals', 'Users', 'Shifts', 'Sales', 'Returns', 'Receipt', 'Tax', 'Audit Log'];
let page = 1;
let currentTab = 'Terminals';
let locations = [];
let terminals = [];
let companyUsers = [];

function isAdminRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return r === 'admin' || r === 'owner' || r === 'superadmin' || r === 'company_admin';
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function asList(res) {
  const d = res?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.shifts)) return d.shifts;
  if (Array.isArray(d?.sales)) return d.sales;
  return [];
}

function showError(message) {
  const el = document.getElementById('error');
  if (!message) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function badge(status) {
  const s = String(status || '');
  const cls = /open|active|completed/i.test(s) ? 'ok-badge' : /suspend/i.test(s) ? 'warn-badge' : 'off-badge';
  return `<span class="badge ${cls}">${s || '—'}</span>`;
}

function userDisplayName(u) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || u.email || 'User';
}

function userLocationIds(u) {
  return (u.locations || []).map((l) => String(l.id || l.locationId || '')).filter(Boolean);
}

function usersEligibleForLocation(users, locationId) {
  const active = (users || []).filter((u) => u.isActive !== false);
  if (!locationId) return active;
  const loc = String(locationId);
  return active.filter((u) => {
    const locIds = userLocationIds(u);
    if (!locIds.length) return true;
    return locIds.includes(loc);
  });
}

function assignedUserForTerminal(users, terminalId) {
  return (users || []).find((u) => String(u.assignedTerminalId || '') === String(terminalId));
}

function renderTerminalUserOptions(users, locationId, selectedUserId) {
  const eligible = usersEligibleForLocation(users, locationId);
  return [
    '<option value="">— No user —</option>',
    ...eligible.map((u) => {
      const assignedElsewhere = u.assignedTerminalId && String(u.assignedTerminalId) !== String(selectedUserId || '');
      const suffix = assignedElsewhere && u.assignedTerminal
        ? ` (on ${u.assignedTerminal.name || u.assignedTerminal.code})`
        : '';
      const sel = selectedUserId && String(u.id) === String(selectedUserId) ? ' selected' : '';
      return `<option value="${u.id}"${sel}>${userDisplayName(u)}${suffix}</option>`;
    }),
  ].join('');
}

function openModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
}
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

function setTab(name) {
  currentTab = name;
  page = 1;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const id = {
    Terminals: 'panel-terminals',
    Users: 'panel-users',
    Shifts: 'panel-shifts',
    Sales: 'panel-sales',
    Returns: 'panel-returns',
    Receipt: 'panel-receipt',
    Tax: 'panel-tax',
    'Audit Log': 'panel-audit',
  }[name];
  document.getElementById(id).classList.add('active');
  loadTab();
}

async function loadTab() {
  showError('');
  if (currentTab === 'Terminals') return loadTerminals();
  if (currentTab === 'Users') return loadUsers();
  if (currentTab === 'Shifts') return loadShifts();
  if (currentTab === 'Sales') return loadSales();
  if (currentTab === 'Returns') return loadReturns();
  if (currentTab === 'Receipt') return loadReceipt();
  if (currentTab === 'Tax') return loadTax();
  if (currentTab === 'Audit Log') return loadAudit();
}

async function loadLocations() {
  const res = await api.pos.listLocations();
  locations = asList(res);
}

async function loadUsers() {
  const wrap = document.getElementById('panel-users');
  wrap.innerHTML = '<p class="muted">Loading users…</p>';
  await api.pos.refreshScopeCache();
  const [usersRes, termRes] = await Promise.all([
    api.pos.listUsers(),
    api.pos.listTerminals(),
  ]);
  if (!usersRes?.success) {
    wrap.innerHTML = `<p class="error">${usersRes?.message || 'Failed to load users'}</p>`;
    return;
  }
  terminals = asList(termRes);
  const users = asList(usersRes);
  wrap.innerHTML = `
    <div class="row">
      <h2>User terminal assignment (${users.length})</h2>
    </div>
    <p class="muted" style="margin-bottom:12px">
      Assign each cashier a POS terminal. On login they will only see that terminal, and an open shift will resume automatically.
    </p>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Locations</th>
            <th>Assigned terminal</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${users.map((u) => {
            const locNames = (u.locations || []).map((l) => l.name).filter(Boolean).join(', ') || '—';
            const opts = [
              `<option value="">— No terminal —</option>`,
              ...terminals.map((t) => {
                const label = `${t.name || t.code}${t.location?.name ? ` · ${t.location.name}` : ''}`;
                const sel = String(u.assignedTerminalId || '') === String(t.id) ? ' selected' : '';
                return `<option value="${t.id}"${sel}>${label}</option>`;
              }),
            ].join('');
            return `<tr data-user="${u.id}">
              <td>
                <strong>${u.firstName || ''} ${u.lastName || ''}</strong>
                <div class="muted">${u.email || ''}</div>
              </td>
              <td>${u.role || 'user'}</td>
              <td class="muted">${locNames}</td>
              <td><select class="user-terminal-select" data-user="${u.id}">${opts}</select></td>
              <td><button class="btn btn-brand user-terminal-save" data-user="${u.id}" type="button">Save</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="5" class="muted">No users found</td></tr>'}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('.user-terminal-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.user;
      const select = wrap.querySelector(`.user-terminal-select[data-user="${userId}"]`);
      const terminalId = select?.value || '';
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const res = await api.pos.assignUserTerminal({ userId, terminalId: terminalId || null });
      btn.disabled = false;
      btn.textContent = 'Save';
      if (!res?.success) {
        alert(res?.message || 'Could not save terminal assignment');
        return;
      }
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = 'Save'; }, 1200);
    });
  });
}

async function loadTerminals() {
  const wrap = document.getElementById('panel-terminals');
  wrap.innerHTML = '<p class="muted">Loading terminals…</p>';
  const [termRes, usersRes] = await Promise.all([
    api.pos.listTerminals(),
    api.pos.listUsers(),
    locations.length ? null : loadLocations(),
  ]);
  if (!termRes?.success) {
    wrap.innerHTML = `<p class="error">${termRes?.message || 'Failed to load terminals'}</p>`;
    return;
  }
  terminals = asList(termRes);
  companyUsers = usersRes?.success ? asList(usersRes) : [];
  wrap.innerHTML = `
    <div class="row">
      <h2>Terminals (${terminals.length})</h2>
      <button class="btn btn-brand" id="btn-new-terminal" type="button">+ New Terminal</button>
    </div>
    <div class="card hidden" id="create-terminal">
      <p class="muted" style="margin:0 0 12px">Warehouse is optional. Leave it blank for company-wide inventory; assign a warehouse to scope this terminal. You can also assign a cashier.</p>
      <div class="form-grid">
        <input id="t-name" placeholder="Terminal name (e.g. Main Counter)" />
        <input id="t-code" placeholder="Code (e.g. TERM-01)" />
        <select id="t-location">
          <option value="">— No warehouse (all inventory) —</option>
          ${locations.map((l) => `<option value="${l.id}">${l.name} (${l.code || l.type || ''})</option>`).join('')}
        </select>
        <select id="t-user">
          <option value="">— No user —</option>
        </select>
        <button class="btn btn-brand" id="t-save" type="button">Create</button>
        <button class="btn btn-gray" id="t-cancel" type="button">Cancel</button>
      </div>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Code</th><th>Location</th><th>Assigned user</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${terminals.map((t) => {
          const assigned = assignedUserForTerminal(companyUsers, t.id);
          return `
          <tr>
            <td><b>${t.name || ''}</b></td>
            <td>${t.code || ''}</td>
            <td>${t.location?.name || '<span class="muted">All inventory</span>'}</td>
            <td>${assigned
              ? `<strong>${userDisplayName(assigned)}</strong><div class="muted">${assigned.email || ''}</div>`
              : '<span class="muted">—</span>'}</td>
            <td>${badge(t.isActive === false ? 'Inactive' : 'Active')}</td>
            <td>
              <button class="btn ${t.isActive === false ? 'btn-green' : 'btn-red'}" data-toggle="${t.id}">${t.isActive === false ? 'Enable' : 'Disable'}</button>
              <button class="btn btn-red" data-del="${t.id}">Delete</button>
            </td>
          </tr>`;
        }).join('') || `<tr><td colspan="6" class="muted">No terminals found</td></tr>`}
      </tbody>
    </table>`;

  const locSelect = wrap.querySelector('#t-location');
  const userSelect = wrap.querySelector('#t-user');
  const refreshUserSelect = () => {
    const prev = userSelect.value;
    userSelect.innerHTML = renderTerminalUserOptions(companyUsers, locSelect.value, prev);
    if (prev && ![...userSelect.options].some((o) => o.value === prev)) userSelect.value = '';
  };
  locSelect.addEventListener('change', refreshUserSelect);
  refreshUserSelect();

  wrap.querySelector('#btn-new-terminal').onclick = () => wrap.querySelector('#create-terminal').classList.toggle('hidden');
  wrap.querySelector('#t-cancel').onclick = () => wrap.querySelector('#create-terminal').classList.add('hidden');
  wrap.querySelector('#t-save').onclick = async () => {
    const name = wrap.querySelector('#t-name').value.trim();
    const code = wrap.querySelector('#t-code').value.trim().toUpperCase();
    const locationId = wrap.querySelector('#t-location').value;
    const userId = wrap.querySelector('#t-user').value;
    if (!name || !code) return showError('Name and code are required');
    const saveBtn = wrap.querySelector('#t-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating…';
    const createBody = { name, code };
    if (locationId) createBody.locationId = locationId;
    const res = await api.pos.createTerminal(createBody);
    if (!res?.success) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create';
      return showError(res?.message || 'Create failed');
    }
    const terminalId = res.data?.id;
    if (userId && terminalId) {
      const assignRes = await api.pos.assignUserTerminal({ userId, terminalId });
      if (!assignRes?.success) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create';
        showError(`Terminal created but user assignment failed: ${assignRes?.message || 'Unknown error'}`);
        loadTerminals();
        return;
      }
    }
    saveBtn.disabled = false;
    saveBtn.textContent = 'Create';
    showError('');
    loadTerminals();
  };
  wrap.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const t = terminals.find((x) => x.id === b.dataset.toggle);
      const res = await api.pos.updateTerminal(t.id, { isActive: t.isActive === false });
      if (!res?.success) return showError(res?.message || 'Update failed');
      loadTerminals();
    };
  });
  wrap.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this terminal?')) return;
      const res = await api.pos.deleteTerminal(b.dataset.del);
      if (!res?.success) return showError(res?.message || 'Delete failed');
      loadTerminals();
    };
  });
}

async function loadShifts() {
  const wrap = document.getElementById('panel-shifts');
  wrap.innerHTML = '<p class="muted">Loading shifts…</p>';
  const res = await api.pos.getShiftHistory(`page=${page}&limit=15`);
  if (!res?.success) {
    wrap.innerHTML = `<p class="error">${res?.message || 'Failed to load shifts'}</p>`;
    return;
  }
  const rows = asList(res);
  wrap.innerHTML = `
    <div class="row"><h2>Shift History</h2></div>
    <table>
      <thead><tr><th>Cashier</th><th>Terminal</th><th>Status</th><th>Opening</th><th>Actual</th><th>Opened</th><th>Closed</th><th></th></tr></thead>
      <tbody>
        ${rows.map((s) => `
          <tr>
            <td>${[s.cashier?.firstName, s.cashier?.lastName].filter(Boolean).join(' ') || '—'}</td>
            <td>${s.terminal?.name || '—'}</td>
            <td>${badge(s.status)}</td>
            <td>${money(s.openingCash)}</td>
            <td>${s.actualCash == null ? '—' : money(s.actualCash)}</td>
            <td>${s.openedAt ? new Date(s.openedAt).toLocaleString() : '—'}</td>
            <td>${s.closedAt ? new Date(s.closedAt).toLocaleString() : '—'}</td>
            <td>${s.status === 'Closed' ? `<button class="btn btn-brand" data-reopen="${s.id}">Reopen</button>` : ''}</td>
          </tr>`).join('') || `<tr><td colspan="8" class="muted">No shifts</td></tr>`}
      </tbody>
    </table>
    <div class="pager">
      <button class="btn btn-gray" id="prev">Prev</button>
      <span class="muted">Page ${page}</span>
      <button class="btn btn-gray" id="next">Next</button>
    </div>`;
  wrap.querySelectorAll('[data-reopen]').forEach((b) => {
    b.onclick = async () => {
      const res2 = await api.pos.reopenShift(b.dataset.reopen);
      if (!res2?.success) return showError(res2?.message || 'Reopen failed');
      loadShifts();
    };
  });
  wrap.querySelector('#prev').onclick = () => { page = Math.max(1, page - 1); loadShifts(); };
  wrap.querySelector('#next').onclick = () => { page += 1; loadShifts(); };
}

async function loadSales(status = '') {
  const wrap = document.getElementById('panel-sales');
  wrap.innerHTML = '<p class="muted">Loading sales…</p>';
  const qs = new URLSearchParams({ page: String(page), limit: '15' });
  if (status) qs.set('status', status);
  const res = await api.pos.listSales(qs.toString());
  if (!res?.success) {
    wrap.innerHTML = `<p class="error">${res?.message || 'Failed to load sales'}</p>`;
    return;
  }
  const rows = asList(res);
  wrap.innerHTML = `
    <div class="row">
      <h2>Sales</h2>
      <select id="sale-status">
        <option value="">All</option>
        <option value="Completed">Completed</option>
        <option value="Held">Held</option>
        <option value="Voided">Voided</option>
        <option value="Returned">Returned</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th><th></th></tr></thead>
      <tbody>
        ${rows.map((s) => `
          <tr>
            <td>${s.invoiceNumber || s.id}</td>
            <td>${s.customerName || 'Walk-in'}</td>
            <td>${money(s.grandTotal ?? s.total)}</td>
            <td>${badge(s.status)}</td>
            <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
            <td>
              <button class="btn btn-gray" data-view="${s.id}">View</button>
              ${s.status === 'Completed' ? `<button class="btn btn-red" data-void="${s.id}">Void</button>` : ''}
            </td>
          </tr>`).join('') || `<tr><td colspan="6" class="muted">No sales</td></tr>`}
      </tbody>
    </table>
    <div class="pager">
      <button class="btn btn-gray" id="prev">Prev</button>
      <span class="muted">Page ${page}</span>
      <button class="btn btn-gray" id="next">Next</button>
    </div>`;
  wrap.querySelector('#sale-status').value = status;
  wrap.querySelector('#sale-status').onchange = (e) => { page = 1; loadSales(e.target.value); };
  wrap.querySelector('#prev').onclick = () => { page = Math.max(1, page - 1); loadSales(status); };
  wrap.querySelector('#next').onclick = () => { page += 1; loadSales(status); };
  wrap.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = async () => {
      const r = await api.pos.getSale(b.dataset.view);
      const sale = r?.data || {};
      openModal(`
        <h3>Invoice ${sale.invoiceNumber || ''}</h3>
        <p class="muted">${sale.customerName || 'Walk-in'} · ${money(sale.grandTotal ?? sale.total)}</p>
        <table>${(sale.items || []).map((i) => `<tr><td>${i.productName}</td><td>${i.quantity}</td><td>${money(i.lineTotal || i.unitPrice)}</td></tr>`).join('')}</table>
        <div style="margin-top:12px"><button class="btn btn-gray" id="m-close">Close</button></div>`);
      document.getElementById('m-close').onclick = closeModal;
    };
  });
  wrap.querySelectorAll('[data-void]').forEach((b) => {
    b.onclick = async () => {
      const reason = prompt('Void reason');
      if (!reason) return;
      const res2 = await api.pos.voidSale(b.dataset.void, { reason });
      if (!res2?.success) return showError(res2?.message || 'Void failed');
      loadSales(status);
    };
  });
}

async function loadReturns() {
  const wrap = document.getElementById('panel-returns');
  wrap.innerHTML = '<p class="muted">Loading completed sales…</p>';
  const res = await api.pos.listSales(`page=${page}&limit=15&status=Completed`);
  const rows = asList(res);
  wrap.innerHTML = `
    <div class="row"><h2>Returns</h2></div>
    <p class="muted">Select a completed sale to process a full or partial return.</p>
    <table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Date</th><th></th></tr></thead>
      <tbody>
        ${rows.map((s) => `
          <tr>
            <td>${s.invoiceNumber || ''}</td>
            <td>${s.customerName || 'Walk-in'}</td>
            <td>${money(s.grandTotal ?? s.total)}</td>
            <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
            <td><button class="btn btn-red" data-ret="${s.id}">Return</button></td>
          </tr>`).join('') || `<tr><td colspan="5" class="muted">No completed sales</td></tr>`}
      </tbody>
    </table>`;
  wrap.querySelectorAll('[data-ret]').forEach((b) => {
    b.onclick = async () => {
      const r = await api.pos.getSale(b.dataset.ret);
      const sale = r?.data || {};
      openModal(`
        <h3>Return ${sale.invoiceNumber || ''}</h3>
        ${(sale.items || []).map((i) => `
          <div class="toggle">
            <span>${i.productName} (sold ${i.quantity})</span>
            <input type="number" min="0" max="${i.quantity}" value="${i.quantity}" data-pid="${i.productId}" style="width:80px" />
          </div>`).join('')}
        <select id="refund-method"><option>Cash</option><option>Card</option><option>Bank Transfer</option></select>
        <textarea id="ret-reason" placeholder="Return reason"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-gray" id="m-close">Cancel</button>
          <button class="btn btn-red" id="m-go">Confirm Return</button>
        </div>`);
      document.getElementById('m-close').onclick = closeModal;
      document.getElementById('m-go').onclick = async () => {
        const returnItems = [...document.querySelectorAll('#modal-body [data-pid]')].map((inp) => ({
          productId: inp.dataset.pid,
          quantity: Number(inp.value || 0),
        })).filter((x) => x.quantity > 0);
        const reason = document.getElementById('ret-reason').value.trim();
        if (!reason) return alert('Return reason is required');
        const res2 = await api.pos.processReturn({
          originalSaleId: sale.id,
          returnItems,
          refundMethod: document.getElementById('refund-method').value,
          reason,
        });
        if (!res2?.success) return alert(res2?.message || 'Return failed');
        closeModal();
        loadReturns();
      };
    };
  });
}

async function loadReceipt() {
  if (window.ManagementReceiptEditor?.load) {
    return window.ManagementReceiptEditor.load();
  }
  document.getElementById('panel-receipt').innerHTML =
    '<p class="error">Receipt editor failed to load.</p>';
}

async function loadTax() {
  const wrap = document.getElementById('panel-tax');
  wrap.innerHTML = '<p class="muted">Loading tax context…</p>';

  const refresh = async () => {
    const res = await api.tax.refreshContext().catch(() => api.tax.getContext());
    return res?.data || {};
  };

  let ctx = {};
  try {
    const res = await api.tax.getContext();
    ctx = res?.data || {};
  } catch (err) {
    wrap.innerHTML = `<p class="error">${err.message || 'Failed to load tax'}</p>`;
    return;
  }

  const rates = Array.isArray(ctx.rates) ? ctx.rates : [];
  const ratesHtml = rates.length
    ? `<table style="margin-top:12px"><thead><tr><th>Type</th><th>Rate</th><th>Pricing</th></tr></thead><tbody>
      ${rates
        .map(
          (r) => `<tr>
            <td>${r.taxTypeName || r.taxTypeCode || '—'}</td>
            <td>${Number(r.rate || 0)}%</td>
            <td>${r.pricingModel || ctx.pricingModel || '—'}</td>
          </tr>`
        )
        .join('')}</tbody></table>`
  : '<p class="muted">No tax rates yet. Configure in Tax Compliance.</p>';

  wrap.innerHTML = `
    <div class="row">
      <h2>POS tax compliance</h2>
      <button type="button" class="btn btn-gray" id="tax-refresh">↻ Refresh</button>
    </div>
    <p class="muted" style="line-height:1.5;max-width:640px">
      Rates, inclusive/exclusive pricing and exemptions are managed in Tax Compliance.
      If taxation is <b>OFF</b>, POS will not add tax on sales.
    </p>
    <div class="card tax-toggle-card ${ctx.enabled ? 'tax-on' : ''}" id="tax-toggle-card">
      <div class="tax-toggle-inner">
        <div>
          <p style="margin:0;font-weight:700;color:#0f172a">Use taxation in this company</p>
          <p class="muted" id="tax-toggle-hint" style="margin:6px 0 0;font-size:13px"></p>
        </div>
        <button type="button" class="tax-switch ${ctx.enabled ? 'on' : ''}" id="tax-toggle" aria-pressed="${ctx.enabled ? 'true' : 'false'}">
          <span class="tax-switch-knob"></span>
        </button>
      </div>
      <p id="tax-toggle-err" class="hidden" style="margin:10px 0 0;font-size:13px;color:#dc2626"></p>
    </div>
    <div class="kpi" style="margin-top:16px">
      <div><small>TAX IN FLOW</small><div><b id="tax-kpi-enabled">${ctx.enabled ? 'ON' : 'OFF'}</b></div></div>
      <div><small>CONFIGURED</small><div><b id="tax-kpi-config">${ctx.configured ? 'Yes' : 'Not yet'}</b></div></div>
      <div><small>REGIME</small><div><b id="tax-kpi-regime">${ctx.regime || '—'}</b></div></div>
      <div><small>PRICING</small><div><b id="tax-kpi-pricing">${ctx.pricingModel || '—'}</b></div></div>
      <div><small>DEFAULT RATE</small><div><b id="tax-kpi-rate">${ctx.defaultRate?.rate ?? 0}%</b></div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin:0 0 8px;font-size:14px">Tax rates</h3>
      ${ratesHtml}
    </div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button type="button" class="btn btn-brand" id="tax-open-web">Open Tax Compliance (web)</button>
    </div>`;

  const hint = document.getElementById('tax-toggle-hint');
  const setHint = (enabled) => {
    hint.textContent = enabled
      ? 'ON — VAT/GST/sales tax applies in POS, sales, purchases, inventory and accounting.'
      : 'OFF — no tax is calculated or shown anywhere in this company’s flow.';
  };
  setHint(!!ctx.enabled);

  const paint = (c) => {
    document.getElementById('tax-kpi-enabled').textContent = c.enabled ? 'ON' : 'OFF';
    document.getElementById('tax-kpi-config').textContent = c.configured ? 'Yes' : 'Not yet';
    document.getElementById('tax-kpi-regime').textContent = c.regime || '—';
    document.getElementById('tax-kpi-pricing').textContent = c.pricingModel || '—';
    document.getElementById('tax-kpi-rate').textContent = `${c.defaultRate?.rate ?? 0}%`;
    const card = document.getElementById('tax-toggle-card');
    const sw = document.getElementById('tax-toggle');
    card?.classList.toggle('tax-on', !!c.enabled);
    sw?.classList.toggle('on', !!c.enabled);
    sw?.setAttribute('aria-pressed', c.enabled ? 'true' : 'false');
    setHint(!!c.enabled);
  };

  document.getElementById('tax-refresh')?.addEventListener('click', async () => {
    ctx = await refresh();
    paint(ctx);
  });

  document.getElementById('tax-toggle')?.addEventListener('click', async () => {
    const errEl = document.getElementById('tax-toggle-err');
    const btn = document.getElementById('tax-toggle');
    errEl.classList.add('hidden');
    const next = !ctx.enabled;
    btn.disabled = true;
    const res = await api.tax.setEnabled(next);
    btn.disabled = false;
    if (!res?.success) {
      errEl.textContent = res?.message || 'Could not update tax setting';
      errEl.classList.remove('hidden');
      return;
    }
    ctx = res.data || (await refresh());
    paint(ctx);
  });

  document.getElementById('tax-open-web')?.addEventListener('click', () => {
    api.app?.openExternal?.('https://app.bisonstechs.com/tax');
  });
}

async function loadAudit() {
  const wrap = document.getElementById('panel-audit');
  wrap.innerHTML = '<p class="muted">Loading audit log…</p>';
  const res = await api.pos.getAuditLogs(`page=${page}&limit=20`);
  const rows = asList(res);
  wrap.innerHTML = `
    <div class="row"><h2>Audit log</h2></div>
    <table>
      <thead><tr><th>Action</th><th>User</th><th>Details</th><th>Date</th></tr></thead>
      <tbody>
        ${rows.map((l) => `
          <tr>
            <td>${l.action || l.type || '—'}</td>
            <td>${l.user?.email || l.userName || '—'}</td>
            <td>${l.details || l.message || '—'}</td>
            <td>${l.createdAt ? new Date(l.createdAt).toLocaleString() : '—'}</td>
          </tr>`).join('') || `<tr><td colspan="4" class="muted">No audit records</td></tr>`}
      </tbody>
    </table>
    <div class="pager">
      <button class="btn btn-gray" id="prev">Prev</button>
      <span class="muted">Page ${page}</span>
      <button class="btn btn-gray" id="next">Next</button>
    </div>`;
  wrap.querySelector('#prev').onclick = () => { page = Math.max(1, page - 1); loadAudit(); };
  wrap.querySelector('#next').onclick = () => { page += 1; loadAudit(); };
}

async function boot() {
  const session = await api.auth.getSession();
  if (!isAdminRole(session?.user?.role) && !session?.isAdmin) {
    alert('POS Management is only available to admin users.');
    await api.pos.enterShift();
    return;
  }
  document.getElementById('subtitle').textContent =
    `${[session.user?.firstName, session.user?.lastName].filter(Boolean).join(' ') || session.user?.email || 'Admin'} · POS Management`;
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = TABS.map((t) => `<button class="tab ${t === 'Terminals' ? 'active' : ''}" data-tab="${t}" type="button">${t}</button>`).join('');
  tabs.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.getElementById('btn-open-pos').onclick = async () => {
    const shiftRes = await api.pos.getCurrentShift();
    const open = shiftRes?.data?.status === 'Open';
    if (open) {
      await api.pos.enterSell();
    } else {
      await api.pos.enterShift();
    }
  };
  document.getElementById('btn-logout').onclick = () => api.auth.logout();
  await loadLocations();
  await loadTab();
}

boot().catch((err) => {
  showError(err.message);
});
