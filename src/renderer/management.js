const api = window.bisonDesktop;
const TABS = ['Terminals', 'Users', 'Shifts', 'Sales', 'Returns', 'Receipt', 'Printer', 'Scanner', 'Payments', 'Tax', 'Audit Log'];
const SETTINGS_KEY = 'pos_settings_v1';

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

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

function defaultSettings() {
  return {
    receiptHeader: 'TAX INVOICE / SALES RECEIPT',
    receiptFooter: 'Thank you for shopping with us! Please visit again.',
    receiptReturnPolicy: 'Returns accepted within 7 days with original receipt.',
    receiptNotes: 'This is a computer-generated receipt.',
    thermalPaperWidthMm: 80,
    thermalPrintMode: 'browser',
    autoPrintOnSale: true,
    enableBarcodeScanner: true,
    soundOnScan: true,
    autoAddOnScan: true,
    enablePaymentTerminal: false,
    paymentTerminalModel: 'CS30G',
    paymentTerminalConnection: 'serial',
    paymentTerminalHost: '192.168.1.100',
    paymentTerminalPort: 8080,
  };
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
    Printer: 'panel-printer',
    Scanner: 'panel-scanner',
    Payments: 'panel-payments',
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
  if (currentTab === 'Printer' || currentTab === 'Scanner' || currentTab === 'Payments') return loadDevice(currentTab);
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
      <p class="muted" style="margin:0 0 12px">Optionally assign a cashier to this terminal when creating it.</p>
      <div class="form-grid">
        <input id="t-name" placeholder="Terminal name (e.g. Main Counter)" />
        <input id="t-code" placeholder="Code (e.g. TERM-01)" />
        <select id="t-location">
          <option value="">Select location…</option>
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
            <td>${t.location?.name || '—'}</td>
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
    if (!name || !code || !locationId) return showError('Name, code and location are required');
    const saveBtn = wrap.querySelector('#t-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating…';
    const res = await api.pos.createTerminal({ name, code, locationId });
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

function receiptEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RECEIPT_TOGGLES = [
  ['showLogo', 'Logo'], ['showAddress', 'Address'], ['showPhone', 'Phone'],
  ['showEmail', 'Email'], ['showWebsite', 'Website'], ['showTaxId', 'Tax ID'],
  ['showBarcode', 'Barcode'], ['showSku', 'SKU'], ['showCashier', 'Cashier'],
  ['showTerminal', 'Terminal'], ['showLoyalty', 'Loyalty points'],
];

async function loadReceipt() {
  const wrap = document.getElementById('panel-receipt');
  // LOCAL-ONLY: receipt template lives in localStorage only — never synced
  // to/from the cloud, so each device keeps its own design.
  const local = loadSettings();
  let template = { ...window.PosReceipt.loadReceiptTemplate(), ...local };

  let profile = null;
  try { profile = (await api.pos.getProfile())?.data || null; } catch { /* ignore */ }

  const field = (id, label, key, textarea) => `
    <div style="margin-bottom:10px;">
      <label class="muted">${label}</label>
      ${textarea
        ? `<textarea id="${id}" rows="3">${receiptEsc(template[key] || '')}</textarea>`
        : `<input id="${id}" value="${receiptEsc(template[key] || '')}" />`}
    </div>`;

  const toggles = RECEIPT_TOGGLES.map(([key, label]) => `
    <div class="toggle" style="gap:10px;">
      <span>${label}</span>
      <input type="checkbox" data-toggle="${key}" ${template[key] !== false ? 'checked' : ''} />
    </div>`).join('');

  wrap.innerHTML = `
    <div class="row">
      <h2>POS receipt designer</h2>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="receipt-reset">Reset defaults</button>
        <button class="btn btn-brand" id="receipt-save">Save</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start;">
      <div style="display:grid;gap:14px;">
        <div class="card">
          <h3 style="margin:0 0 10px;">Store details</h3>
          ${field('r-store-name', 'Store name (blank = company name)', 'storeName')}
          ${field('r-store-address', 'Address', 'storeAddress')}
          <div class="form-grid">
            ${field('r-phone', 'Phone', 'phone')}
            ${field('r-email', 'Email', 'email')}
            ${field('r-website', 'Website', 'website')}
            ${field('r-tax-id', 'NTN / Tax ID', 'taxId')}
          </div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 10px;">Receipt text</h3>
          ${field('r-header', 'Header', 'receiptHeader')}
          ${field('r-copy-label', 'Copy label', 'copyLabel')}
          ${field('r-footer', 'Footer', 'receiptFooter')}
          ${field('r-policy', 'Return / exchange policy', 'receiptReturnPolicy', true)}
          ${field('r-notes', 'Extra notes', 'receiptNotes', true)}
          ${field('r-served-by', 'Served by prefix', 'servedByPrefix')}
          ${field('r-powered-by', 'Bottom line', 'poweredBy')}
          <div style="margin-bottom:10px;">
            <label class="muted">Thermal paper width</label>
            <select id="r-paper-width">
              <option value="58" ${Number(template.thermalPaperWidthMm) === 58 ? 'selected' : ''}>58mm</option>
              <option value="80" ${Number(template.thermalPaperWidthMm) !== 58 ? 'selected' : ''}>80mm</option>
            </select>
          </div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 6px;">Show / hide sections</h3>
          ${toggles}
        </div>
      </div>
      <div style="position:sticky;top:16px;">
        <div class="muted" style="font-size:12px;font-weight:700;margin-bottom:8px;letter-spacing:.6px;">LIVE PREVIEW</div>
        <div style="background:#e5e7eb;border-radius:14px;padding:12px;max-height:78vh;overflow:auto;">
          <div id="receipt-preview"></div>
        </div>
      </div>
    </div>`;
  const collect = () => {
    const next = { ...template };
    const map = {
      'r-store-name': 'storeName', 'r-store-address': 'storeAddress', 'r-phone': 'phone',
      'r-email': 'email', 'r-website': 'website', 'r-tax-id': 'taxId',
      'r-header': 'receiptHeader', 'r-copy-label': 'copyLabel', 'r-footer': 'receiptFooter',
      'r-policy': 'receiptReturnPolicy', 'r-notes': 'receiptNotes',
      'r-served-by': 'servedByPrefix', 'r-powered-by': 'poweredBy',
    };
    for (const [id, key] of Object.entries(map)) {
      const el = wrap.querySelector('#' + id);
      if (el) next[key] = el.value;
    }
    const width = wrap.querySelector('#r-paper-width');
    if (width) next.thermalPaperWidthMm = Number(width.value) === 58 ? 58 : 80;
    wrap.querySelectorAll('[data-toggle]').forEach((cb) => { next[cb.dataset.toggle] = cb.checked; });
    return next;
  };

  const renderPreview = () => {
    const next = collect();
    const comp = window.PosReceipt.resolveReceiptCompany(profile, next);
    wrap.querySelector('#receipt-preview').innerHTML = window.PosReceipt.buildReceiptHtml(
      window.PosReceipt.sampleReceiptSale(), comp, next
    );
  };

  wrap.querySelectorAll('input, select, textarea').forEach((el) => {
    el.addEventListener('input', renderPreview);
    el.addEventListener('change', renderPreview);
  });
  renderPreview();

  wrap.querySelector('#receipt-save').onclick = () => {
    const body = collect();
    // LOCAL-ONLY: save to localStorage (per-device). No cloud round-trip.
    window.PosReceipt.saveReceiptTemplate(body);
    saveSettings({ ...loadSettings(), ...body });
    alert('Receipt template saved locally');
    renderPreview();
  };

  wrap.querySelector('#receipt-reset').onclick = () => {
    const defaults = window.PosReceipt.DEFAULT_RECEIPT_TEMPLATE();
    window.PosReceipt.saveReceiptTemplate(defaults);
    saveSettings({ ...loadSettings(), ...defaults });
    loadReceipt();
  };
}

function loadDevice(tab) {
  const s = loadSettings();
  const wrap = document.getElementById(`panel-${tab.toLowerCase()}`);
  if (tab === 'Printer') {
    wrap.innerHTML = `
      <div class="row"><h2>Thermal printer</h2><button class="btn btn-brand" id="save">Save</button></div>
      <div class="card">
        <div class="toggle"><span>Auto print on sale</span><input type="checkbox" id="p-auto" ${s.autoPrintOnSale ? 'checked' : ''} /></div>
        <div class="form-grid" style="margin-top:12px">
          <select id="p-width"><option value="58">58mm</option><option value="80">80mm</option></select>
          <select id="p-mode"><option value="browser">Browser print</option><option value="escpos">ESC/POS serial</option></select>
        </div>
      </div>`;
    wrap.querySelector('#p-width').value = String(s.thermalPaperWidthMm || 80);
    wrap.querySelector('#p-mode').value = s.thermalPrintMode || 'browser';
    wrap.querySelector('#save').onclick = () => {
      saveSettings({
        ...loadSettings(),
        autoPrintOnSale: wrap.querySelector('#p-auto').checked,
        thermalPaperWidthMm: Number(wrap.querySelector('#p-width').value),
        thermalPrintMode: wrap.querySelector('#p-mode').value,
      });
      alert('Printer settings saved on this desktop');
    };
  }
  if (tab === 'Scanner') {
    wrap.innerHTML = `
      <div class="row"><h2>Barcode scanner</h2><button class="btn btn-brand" id="save">Save</button></div>
      <div class="card">
        <div class="toggle"><span>Enable scanner</span><input type="checkbox" id="sc-on" ${s.enableBarcodeScanner ? 'checked' : ''} /></div>
        <div class="toggle"><span>Beep on scan</span><input type="checkbox" id="sc-sound" ${s.soundOnScan ? 'checked' : ''} /></div>
        <div class="toggle"><span>Auto-add product</span><input type="checkbox" id="sc-auto" ${s.autoAddOnScan ? 'checked' : ''} /></div>
      </div>`;
    wrap.querySelector('#save').onclick = () => {
      saveSettings({
        ...loadSettings(),
        enableBarcodeScanner: wrap.querySelector('#sc-on').checked,
        soundOnScan: wrap.querySelector('#sc-sound').checked,
        autoAddOnScan: wrap.querySelector('#sc-auto').checked,
      });
      alert('Scanner settings saved on this desktop');
    };
  }
  if (tab === 'Payments') {
    wrap.innerHTML = `
      <div class="row"><h2>Payment terminal</h2><button class="btn btn-brand" id="save">Save</button></div>
      <div class="card">
        <div class="toggle"><span>Enable card terminal</span><input type="checkbox" id="pay-on" ${s.enablePaymentTerminal ? 'checked' : ''} /></div>
        <div class="form-grid" style="margin-top:12px">
          <select id="pay-model"><option>CS30G</option><option>Generic ECR</option></select>
          <select id="pay-conn"><option value="serial">Serial</option><option value="network">Network</option><option value="sandbox">Sandbox</option></select>
          <input id="pay-host" placeholder="Host" value="${s.paymentTerminalHost || ''}" />
          <input id="pay-port" placeholder="Port" value="${s.paymentTerminalPort || 8080}" />
        </div>
      </div>`;
    wrap.querySelector('#pay-model').value = s.paymentTerminalModel || 'CS30G';
    wrap.querySelector('#pay-conn').value = s.paymentTerminalConnection || 'serial';
    wrap.querySelector('#save').onclick = () => {
      saveSettings({
        ...loadSettings(),
        enablePaymentTerminal: wrap.querySelector('#pay-on').checked,
        paymentTerminalModel: wrap.querySelector('#pay-model').value,
        paymentTerminalConnection: wrap.querySelector('#pay-conn').value,
        paymentTerminalHost: wrap.querySelector('#pay-host').value,
        paymentTerminalPort: Number(wrap.querySelector('#pay-port').value || 8080),
      });
      alert('Payment terminal settings saved on this desktop');
    };
  }
}

async function loadTax() {
  const wrap = document.getElementById('panel-tax');
  wrap.innerHTML = '<p class="muted">Loading tax context…</p>';
  const res = await api.tax.getContext();
  const ctx = res?.data || {};
  wrap.innerHTML = `
    <div class="row"><h2>POS tax compliance</h2></div>
    <p class="muted">Rates and exemptions are managed in web Tax Compliance. If tax is OFF, POS will not add tax.</p>
    <div class="kpi">
      <div><small>TAX IN FLOW</small><div><b>${ctx.enabled ? 'ON' : 'OFF'}</b></div></div>
      <div><small>CONFIGURED</small><div><b>${ctx.configured ? 'Yes' : 'Not yet'}</b></div></div>
      <div><small>REGIME</small><div><b>${ctx.regime || '—'}</b></div></div>
      <div><small>PRICING</small><div><b>${ctx.pricingModel || '—'}</b></div></div>
      <div><small>DEFAULT RATE</small><div><b>${ctx.defaultRate?.rate ?? 0}%</b></div></div>
    </div>`;
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
  document.getElementById('btn-open-pos').onclick = () => api.pos.enterShift();
  document.getElementById('btn-logout').onclick = () => api.auth.logout();
  api.auth.onExpired(() => api.auth.logout());
  await loadLocations();
  await loadTab();
}

boot().catch((err) => {
  showError(err.message);
});
