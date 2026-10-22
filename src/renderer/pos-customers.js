/* global window, document, localStorage, api, pkr, money, showToast, escapeHtmlAttr, selectCustomer */
/* Customers tab: customer accounts with loyalty points, store credit and
   on-account (receivable) balances, plus the loyalty program settings.
   Balances live in the local customer_ledger (main process); this file only
   renders them and posts entries. Loaded after sell.js and reuses its helpers. */

'use strict';

// ─── Loyalty program rules (per terminal, like the receipt template) ─────────
(function (global) {
  var KEY = 'pos_loyalty_settings_v1';

  function defaults() {
    return {
      enabled: true,
      earnPoints: 1,          // points earned …
      earnPerAmount: 100,     // … for every this much spent
      pointValue: 1,          // currency value of 1 point when redeemed
      minRedeemPoints: 100,   // balance needed before points can be used
      maxRedeemPercent: 50,   // most of a bill that points may pay
    };
  }

  function get() {
    try {
      var stored = JSON.parse(localStorage.getItem(KEY) || '{}');
      return Object.assign(defaults(), stored);
    } catch (e) {
      return defaults();
    }
  }

  function save(next) {
    var cur = get();
    var merged = Object.assign(cur, next || {});
    merged.earnPoints = Math.max(0, Number(merged.earnPoints) || 0);
    merged.earnPerAmount = Math.max(1, Number(merged.earnPerAmount) || 1);
    merged.pointValue = Math.max(0, Number(merged.pointValue) || 0);
    merged.minRedeemPoints = Math.max(0, Math.floor(Number(merged.minRedeemPoints) || 0));
    merged.maxRedeemPercent = Math.min(100, Math.max(0, Number(merged.maxRedeemPercent) || 0));
    merged.enabled = merged.enabled !== false;
    try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch (e) { /* ignore quota */ }
    return merged;
  }

  function earnFor(amount) {
    var s = get();
    if (!s.enabled) return 0;
    return Math.floor((Number(amount) || 0) / s.earnPerAmount) * s.earnPoints;
  }

  function pointsValue(points) {
    return Math.round((Number(points) || 0) * get().pointValue * 100) / 100;
  }

  function pointsForAmount(amount) {
    var v = get().pointValue;
    return v > 0 ? Math.ceil((Number(amount) || 0) / v - 1e-9) : 0;
  }

  /** Currency the customer may pay with points on a bill of `billTotal`. */
  function maxRedeemAmount(balancePoints, billTotal) {
    var s = get();
    var pts = Math.floor(Number(balancePoints) || 0);
    if (!s.enabled || s.pointValue <= 0 || pts < s.minRedeemPoints) return 0;
    var cap = (Number(billTotal) || 0) * (s.maxRedeemPercent / 100);
    var amount = Math.min(pts * s.pointValue, cap);
    // whole points only
    return Math.floor(amount / s.pointValue) * s.pointValue;
  }

  global.PosLoyalty = {
    get: get,
    save: save,
    earnFor: earnFor,
    pointsValue: pointsValue,
    pointsForAmount: pointsForAmount,
    maxRedeemAmount: maxRedeemAmount,
  };
})(window);

// ─── Customers tab ────────────────────────────────────────────────────────────
const custState = {
  rows: [],
  filter: 'all',
  query: '',
  sort: 'name',
  selectedId: null,
  account: null,
  detailTab: 'activity',
};

const LEDGER_LABELS = {
  'POINTS:OPENING': 'Opening points',
  'POINTS:EARN': 'Points earned',
  'POINTS:REDEEM': 'Points redeemed',
  'POINTS:REVERSE': 'Points reversed (return)',
  'POINTS:ADJUST': 'Points adjustment',
  'POINTS:VOID': 'Points reversed (void)',
  'CREDIT:OPENING': 'Opening store credit',
  'CREDIT:ISSUE': 'Store credit issued',
  'CREDIT:REDEEM': 'Store credit used',
  'CREDIT:ADJUST': 'Store credit adjustment',
  'CREDIT:VOID': 'Store credit reversed (void)',
  'ACCOUNT:OPENING': 'Opening balance due',
  'ACCOUNT:CHARGE': 'Sale on account',
  'ACCOUNT:PAYMENT': 'Payment received',
  'ACCOUNT:REFUND': 'Return credited',
  'ACCOUNT:VOID': 'Sale on account voided',
};

function custEsc(v) {
  return escapeHtmlAttr(v == null ? '' : v).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function custInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

function custDate(iso, withTime) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1990) return '—';
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

async function loadCustomersTab() {
  const list = document.getElementById('cust-table-body');
  if (list && !custState.rows.length) list.innerHTML = '<tr><td colspan="7" class="cust-empty">Loading customers…</td></tr>';
  const res = await api.customers.listAccounts({});
  if (!res?.success) {
    if (list) list.innerHTML = `<tr><td colspan="7" class="cust-empty">${custEsc(res?.message || 'Could not load customers')}</td></tr>`;
    return;
  }
  custState.rows = res.data || [];
  renderCustomerKpis();
  renderCustomerTable();
  if (custState.selectedId) openCustomerAccount(custState.selectedId, { keepTab: true });
}

function renderCustomerKpis() {
  const el = document.getElementById('cust-kpis');
  if (!el) return;
  const rows = custState.rows;
  const sum = (fn) => rows.reduce((n, r) => n + fn(r), 0);
  const points = sum((r) => Math.max(0, money(r.balances?.points)));
  const credit = sum((r) => Math.max(0, money(r.balances?.storeCredit)));
  const owed = sum((r) => Math.max(0, money(r.balances?.accountBalance)));
  const owing = rows.filter((r) => money(r.balances?.accountBalance) > 0.009).length;
  const loyalty = window.PosLoyalty.get();
  el.innerHTML = `
    <div class="kpi"><span>Customers</span><b>${rows.length}</b></div>
    <div class="kpi"><span>Points outstanding</span><b>${Math.round(points).toLocaleString()}</b><small>${loyalty.enabled ? `liability ${pkr(window.PosLoyalty.pointsValue(points))}` : 'program off'}</small></div>
    <div class="kpi"><span>Store credit outstanding</span><b>${pkr(credit)}</b><small>owed to customers</small></div>
    <div class="kpi"><span>Receivables (on account)</span><b>${pkr(owed)}</b><small>${owing} customer(s) owe</small></div>`;
}

function filteredCustomers() {
  const q = custState.query.trim().toLowerCase();
  let rows = custState.rows.filter((r) => {
    if (q && ![r.name, r.phone, r.email, r.companyName, r.customerNumber].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    const b = r.balances || {};
    if (custState.filter === 'owes') return money(b.accountBalance) > 0.009;
    if (custState.filter === 'credit') return money(b.storeCredit) > 0.009;
    if (custState.filter === 'points') return money(b.points) > 0;
    return true;
  });
  const by = {
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    spent: (a, b) => money(b.stats?.totalSpent) - money(a.stats?.totalSpent),
    owed: (a, b) => money(b.balances?.accountBalance) - money(a.balances?.accountBalance),
    points: (a, b) => money(b.balances?.points) - money(a.balances?.points),
    recent: (a, b) => new Date(b.stats?.lastVisit || 0) - new Date(a.stats?.lastVisit || 0),
  }[custState.sort];
  if (by) rows = rows.slice().sort(by);
  return rows;
}

function renderCustomerTable() {
  const body = document.getElementById('cust-table-body');
  const count = document.getElementById('cust-count');
  if (!body) return;
  const rows = filteredCustomers();
  if (count) count.textContent = `${rows.length} of ${custState.rows.length}`;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="cust-empty">${custState.rows.length ? 'No customers match this filter.' : 'No customers yet. Click “New customer” to add one.'}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const b = r.balances || {};
    const owed = money(b.accountBalance);
    return `
      <tr data-id="${custEsc(r.id)}" class="${r.id === custState.selectedId ? 'selected' : ''}">
        <td>
          <div class="cust-name-cell">
            <span class="cust-avatar">${custEsc(custInitials(r.name))}</span>
            <div><b>${custEsc(r.name)}</b><small>${custEsc(r.phone || r.email || r.customerNumber || '')}</small></div>
          </div>
        </td>
        <td class="num">${money(b.points) ? Math.round(money(b.points)).toLocaleString() : '—'}</td>
        <td class="num">${money(b.storeCredit) ? pkr(b.storeCredit) : '—'}</td>
        <td class="num ${owed > 0.009 ? 'neg' : ''}">${owed ? pkr(owed) : '—'}</td>
        <td class="num">${pkr(r.stats?.totalSpent)}</td>
        <td class="num">${r.stats?.visits || 0}</td>
        <td>${custDate(r.stats?.lastVisit)}</td>
      </tr>`;
  }).join('');
}

async function openCustomerAccount(id, opts = {}) {
  custState.selectedId = id;
  if (!opts.keepTab) custState.detailTab = 'activity';
  document.querySelectorAll('#cust-table-body tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
  const panel = document.getElementById('cust-detail');
  if (!panel) return;
  panel.classList.add('open');
  if (!opts.keepTab) panel.innerHTML = '<div class="cust-empty">Loading account…</div>';
  const res = await api.customers.getAccount(id);
  if (custState.selectedId !== id) return;
  if (!res?.success) {
    panel.innerHTML = `<div class="cust-empty">${custEsc(res?.message || 'Could not load account')}</div>`;
    return;
  }
  custState.account = res.data;
  renderCustomerDetail();
}

function renderCustomerDetail() {
  const panel = document.getElementById('cust-detail');
  const acc = custState.account;
  if (!panel || !acc) return;
  const c = acc.customer;
  const b = acc.balances;
  const s = acc.stats;
  const loyalty = window.PosLoyalty.get();
  const limit = money(c.creditLimit);
  const owed = money(b.accountBalance);
  const available = limit > 0 ? limit - owed : null;
  const tab = custState.detailTab;

  const ledgerRows = acc.ledger.map((e) => {
    const label = LEDGER_LABELS[`${e.kind}:${e.type}`] || `${e.kind} ${e.type}`;
    const value = e.kind === 'POINTS'
      ? `${e.points > 0 ? '+' : ''}${Math.round(e.points).toLocaleString()} pts`
      : `${e.amount > 0 ? '+' : '−'}${pkr(Math.abs(e.amount))}`;
    const tone = (e.kind === 'ACCOUNT' ? e.amount < 0 : (e.points || e.amount) > 0) ? 'pos' : 'neg';
    return `<tr>
      <td>${custDate(e.createdAt, true)}</td>
      <td><b>${custEsc(label)}</b>${e.note && e.note !== label ? `<small>${custEsc(e.note)}</small>` : ''}</td>
      <td>${custEsc(e.reference)}</td>
      <td class="num ${tone}">${value}</td>
    </tr>`;
  }).join('');

  const salesRows = acc.sales.map((sale) => `<tr>
      <td>${custDate(sale.createdAt, true)}</td>
      <td><b>${custEsc(sale.invoiceNumber)}</b><small>${custEsc(sale.payments.map((p) => p.paymentMethod).join(', '))}</small></td>
      <td class="num">${sale.itemsCount}</td>
      <td class="num">${pkr(sale.grandTotal)}</td>
      <td class="num">${sale.loyaltyEarned ? `+${sale.loyaltyEarned}` : '—'}</td>
    </tr>`).join('');

  const returnRows = acc.returns.map((r) => `<tr>
      <td>${custDate(r.createdAt, true)}</td>
      <td><b>${custEsc(r.invoiceNumber)}</b></td>
      <td>${custEsc(r.refundMethod)}</td>
      <td class="num neg">−${pkr(r.refundAmount)}</td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="cust-detail-head">
      <span class="cust-avatar lg">${custEsc(custInitials(c.name))}</span>
      <div style="flex:1;min-width:0;">
        <h3>${custEsc(c.name)}</h3>
        <p>${[c.phone, c.email, c.companyName].filter(Boolean).map(custEsc).join(' · ') || 'No contact details'}</p>
      </div>
      <button type="button" class="btn-nav-action ghost sm" id="cust-btn-edit">Edit</button>
      <button type="button" class="cust-close" id="cust-btn-close" title="Close">✕</button>
    </div>

    <div class="cust-balances">
      <div class="cust-bal ${loyalty.enabled ? '' : 'muted'}">
        <span>Loyalty points</span>
        <b>${Math.round(money(b.points)).toLocaleString()}</b>
        <small>${loyalty.enabled ? `worth ${pkr(window.PosLoyalty.pointsValue(b.points))}` : 'program is off'}</small>
      </div>
      <div class="cust-bal">
        <span>Store credit</span>
        <b>${pkr(b.storeCredit)}</b>
        <small>available to spend</small>
      </div>
      <div class="cust-bal ${owed > 0.009 ? 'warn' : ''}">
        <span>${owed < -0.009 ? 'Account in credit' : 'Balance due'}</span>
        <b>${pkr(Math.abs(owed))}</b>
        <small>${limit > 0 ? `limit ${pkr(limit)} · ${available >= 0 ? `${pkr(available)} free` : `${pkr(-available)} over`}` : 'no credit limit set'}</small>
      </div>
    </div>

    <div class="cust-actions">
      <button type="button" class="btn-nav-action" id="cust-btn-sell">Start sale</button>
      <button type="button" class="btn-nav-action ghost" id="cust-btn-payment" ${owed > 0.009 ? '' : 'disabled'}>Receive payment</button>
      <button type="button" class="btn-nav-action ghost" id="cust-btn-credit">Issue store credit</button>
      <button type="button" class="btn-nav-action ghost" id="cust-btn-points">Adjust points</button>
      <button type="button" class="btn-nav-action ghost" id="cust-btn-statement">Print statement</button>
    </div>

    <div class="cust-stats">
      <div><span>Visits</span><b>${s.visits}</b></div>
      <div><span>Total spent</span><b>${pkr(s.totalSpent)}</b></div>
      <div><span>Avg. ticket</span><b>${pkr(s.avgTicket)}</b></div>
      <div><span>Last visit</span><b>${custDate(s.lastVisit)}</b></div>
    </div>

    <div class="cust-subtabs">
      <button type="button" data-ctab="activity" class="${tab === 'activity' ? 'active' : ''}">Account activity</button>
      <button type="button" data-ctab="sales" class="${tab === 'sales' ? 'active' : ''}">Purchases (${acc.sales.length})</button>
      <button type="button" data-ctab="returns" class="${tab === 'returns' ? 'active' : ''}">Returns (${acc.returns.length})</button>
    </div>
    <div class="cust-subpanel">
      ${tab === 'activity' ? `<table class="cust-table compact"><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th class="num">Change</th></tr></thead>
        <tbody>${ledgerRows || '<tr><td colspan="4" class="cust-empty">No account activity yet.</td></tr>'}</tbody></table>` : ''}
      ${tab === 'sales' ? `<table class="cust-table compact"><thead><tr><th>Date</th><th>Invoice</th><th class="num">Items</th><th class="num">Total</th><th class="num">Points</th></tr></thead>
        <tbody>${salesRows || '<tr><td colspan="5" class="cust-empty">No purchases on this terminal yet.</td></tr>'}</tbody></table>` : ''}
      ${tab === 'returns' ? `<table class="cust-table compact"><thead><tr><th>Date</th><th>Invoice</th><th>Refund method</th><th class="num">Amount</th></tr></thead>
        <tbody>${returnRows || '<tr><td colspan="4" class="cust-empty">No returns.</td></tr>'}</tbody></table>` : ''}
    </div>`;

  panel.querySelectorAll('[data-ctab]').forEach((btn) => btn.addEventListener('click', () => {
    custState.detailTab = btn.dataset.ctab;
    renderCustomerDetail();
  }));
  document.getElementById('cust-btn-close').addEventListener('click', closeCustomerDetail);
  document.getElementById('cust-btn-edit').addEventListener('click', () => openCustomerForm(c));
  document.getElementById('cust-btn-sell').addEventListener('click', () => startSaleForCustomer(c));
  document.getElementById('cust-btn-payment').addEventListener('click', () => openLedgerForm('PAYMENT'));
  document.getElementById('cust-btn-credit').addEventListener('click', () => openLedgerForm('CREDIT'));
  document.getElementById('cust-btn-points').addEventListener('click', () => openLedgerForm('POINTS'));
  document.getElementById('cust-btn-statement').addEventListener('click', printCustomerStatement);
}

function closeCustomerDetail() {
  custState.selectedId = null;
  custState.account = null;
  const panel = document.getElementById('cust-detail');
  if (panel) {
    panel.classList.remove('open');
    panel.innerHTML = '';
  }
  document.querySelectorAll('#cust-table-body tr.selected').forEach((tr) => tr.classList.remove('selected'));
}

function startSaleForCustomer(c) {
  document.querySelector('.tab-btn[data-tab="sell"]')?.click();
  if (typeof selectCustomer === 'function') selectCustomer(c);
}

// ─── Modal helper ─────────────────────────────────────────────────────────────
function custModal({ title, body, confirmLabel = 'Save', danger = false, onConfirm }) {
  const overlay = document.createElement('div');
  overlay.className = 'cust-modal-overlay';
  overlay.innerHTML = `
    <div class="cust-modal" role="dialog" aria-modal="true">
      <div class="cust-modal-head"><h3>${custEsc(title)}</h3><button type="button" class="cust-close" data-close>✕</button></div>
      <div class="cust-modal-body">${body}</div>
      <div class="cust-modal-error" hidden></div>
      <div class="cust-modal-foot">
        <button type="button" class="btn-nav-action ghost" data-close>Cancel</button>
        <button type="button" class="btn-nav-action ${danger ? 'danger' : ''}" data-confirm>${custEsc(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const errEl = overlay.querySelector('.cust-modal-error');
  overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const confirmBtn = overlay.querySelector('[data-confirm]');
  confirmBtn.addEventListener('click', async () => {
    errEl.hidden = true;
    confirmBtn.disabled = true;
    try {
      const err = await onConfirm(overlay);
      if (err) {
        errEl.textContent = err;
        errEl.hidden = false;
      } else {
        close();
      }
    } finally {
      confirmBtn.disabled = false;
    }
  });
  setTimeout(() => overlay.querySelector('input, select, textarea')?.focus(), 30);
  return overlay;
}

function openCustomerForm(existing) {
  const c = existing || {};
  const isNew = !existing;
  custModal({
    title: isNew ? 'New customer' : `Edit ${c.name}`,
    confirmLabel: isNew ? 'Create customer' : 'Save changes',
    body: `
      <div class="cust-form-grid">
        <label class="span2">Full name *<input id="cf-name" value="${custEsc(c.name || '')}" /></label>
        <label>Phone<input id="cf-phone" value="${custEsc(c.phone || '')}" /></label>
        <label>Email<input id="cf-email" type="email" value="${custEsc(c.email || '')}" /></label>
        <label>Company<input id="cf-company" value="${custEsc(c.companyName || '')}" /></label>
        <label>Tax ID / NTN<input id="cf-tax" value="${custEsc(c.taxId || '')}" /></label>
        <label>Credit limit (on account)<input id="cf-limit" type="number" min="0" step="0.01" value="${money(c.creditLimit) || ''}" placeholder="0 = no limit" /></label>
        <label>When over the limit
          <select id="cf-policy">
            <option value="WARN" ${String(c.creditPolicy || 'WARN').toUpperCase() === 'WARN' ? 'selected' : ''}>Warn cashier</option>
            <option value="BLOCK" ${String(c.creditPolicy).toUpperCase() === 'BLOCK' ? 'selected' : ''}>Block the sale</option>
            <option value="ALLOW" ${String(c.creditPolicy).toUpperCase() === 'ALLOW' ? 'selected' : ''}>Allow</option>
          </select>
        </label>
        <label class="span2">Notes<textarea id="cf-notes" rows="2">${custEsc(c.notes || '')}</textarea></label>
      </div>`,
    onConfirm: async (root) => {
      const val = (id) => root.querySelector(id).value.trim();
      const patch = {
        name: val('#cf-name'),
        phone: val('#cf-phone'),
        email: val('#cf-email'),
        companyName: val('#cf-company'),
        taxId: val('#cf-tax'),
        creditLimit: Number(val('#cf-limit')) || 0,
        creditPolicy: val('#cf-policy'),
        notes: val('#cf-notes'),
      };
      if (!patch.name) return 'Customer name is required.';
      let res;
      if (isNew) {
        res = await api.pos.createCustomer({ ...patch, customerType: 'Individual' });
      } else {
        res = await api.customers.update(c.id, patch);
      }
      if (!res?.success) return res?.message || 'Could not save customer';
      showToast(isNew ? 'Customer created' : 'Customer updated', 'success');
      if (isNew && res.data?.id) custState.selectedId = res.data.id;
      await loadCustomersTab();
      return '';
    },
  });
}

function openLedgerForm(kind) {
  const acc = custState.account;
  if (!acc) return;
  const c = acc.customer;
  const b = acc.balances;
  let title;
  let body;
  if (kind === 'PAYMENT') {
    title = 'Receive payment';
    body = `
      <p class="cust-hint">${custEsc(c.name)} owes <b>${pkr(b.accountBalance)}</b>.</p>
      <div class="cust-form-grid">
        <label>Amount received<input id="lf-amount" type="number" min="0" step="0.01" value="${money(b.accountBalance).toFixed(2)}" /></label>
        <label>Method
          <select id="lf-method"><option>Cash</option><option>Card</option><option>Bank Transfer</option><option>Mobile Wallet</option><option>Cheque</option></select>
        </label>
        <label class="span2">Note<input id="lf-note" placeholder="Optional" /></label>
      </div>`;
  } else if (kind === 'CREDIT') {
    title = 'Store credit';
    body = `
      <p class="cust-hint">Current store credit: <b>${pkr(b.storeCredit)}</b>. Store credit is money you owe the customer — it is spent at checkout like cash.</p>
      <div class="cust-form-grid">
        <label>Action
          <select id="lf-action"><option value="CREDIT_ISSUE">Issue credit (add)</option><option value="CREDIT_REMOVE">Correct / remove credit</option></select>
        </label>
        <label>Amount<input id="lf-amount" type="number" min="0" step="0.01" /></label>
        <label class="span2">Reason<input id="lf-note" placeholder="e.g. Goodwill for late delivery" /></label>
      </div>`;
  } else {
    title = 'Adjust loyalty points';
    body = `
      <p class="cust-hint">Current balance: <b>${Math.round(money(b.points))} points</b>. Every adjustment is kept in the account history.</p>
      <div class="cust-form-grid">
        <label>Action
          <select id="lf-action"><option value="ADD">Add points</option><option value="REMOVE">Remove points</option></select>
        </label>
        <label>Points<input id="lf-points" type="number" min="0" step="1" /></label>
        <label class="span2">Reason *<input id="lf-note" placeholder="e.g. Birthday bonus" /></label>
      </div>`;
  }
  custModal({
    title,
    body,
    confirmLabel: kind === 'PAYMENT' ? 'Record payment' : 'Save',
    onConfirm: async (root) => {
      const q = (sel) => root.querySelector(sel);
      const note = q('#lf-note')?.value.trim() || '';
      let entry;
      if (kind === 'PAYMENT') {
        entry = { action: 'PAYMENT', amount: Number(q('#lf-amount').value), method: q('#lf-method').value, note };
      } else if (kind === 'CREDIT') {
        const amount = Number(q('#lf-amount').value) || 0;
        entry = q('#lf-action').value === 'CREDIT_ISSUE'
          ? { action: 'CREDIT_ISSUE', amount, note }
          : { action: 'CREDIT_ADJUST', amount: -amount, note };
      } else {
        const pts = Math.floor(Number(q('#lf-points').value) || 0);
        entry = { action: 'POINTS_ADJUST', points: q('#lf-action').value === 'ADD' ? pts : -pts, note };
      }
      const res = await api.customers.postEntry({ ...entry, customerId: c.id });
      if (!res?.success) return res?.message || 'Could not save';
      showToast('Saved to customer account', 'success');
      if (kind === 'PAYMENT') printPaymentReceipt(c, entry, res.data);
      await loadCustomersTab();
      return '';
    },
  });
}

function openLoyaltySettings() {
  const s = window.PosLoyalty.get();
  custModal({
    title: 'Loyalty program',
    confirmLabel: 'Save program',
    body: `
      <label class="cust-switch"><input type="checkbox" id="ls-enabled" ${s.enabled ? 'checked' : ''} /> Loyalty program is active</label>
      <div class="cust-form-grid">
        <label>Points earned<input id="ls-earn" type="number" min="0" step="1" value="${s.earnPoints}" /></label>
        <label>…for every (amount spent)<input id="ls-per" type="number" min="1" step="1" value="${s.earnPerAmount}" /></label>
        <label>Value of 1 point when redeemed<input id="ls-value" type="number" min="0" step="0.01" value="${s.pointValue}" /></label>
        <label>Minimum points to redeem<input id="ls-min" type="number" min="0" step="1" value="${s.minRedeemPoints}" /></label>
        <label>Max share of a bill paid with points (%)<input id="ls-max" type="number" min="0" max="100" step="1" value="${s.maxRedeemPercent}" /></label>
      </div>
      <p class="cust-hint" id="ls-preview"></p>`,
    onConfirm: async (root) => {
      const q = (sel) => root.querySelector(sel);
      window.PosLoyalty.save({
        enabled: q('#ls-enabled').checked,
        earnPoints: q('#ls-earn').value,
        earnPerAmount: q('#ls-per').value,
        pointValue: q('#ls-value').value,
        minRedeemPoints: q('#ls-min').value,
        maxRedeemPercent: q('#ls-max').value,
      });
      showToast('Loyalty program saved', 'success');
      renderCustomerKpis();
      renderCustomerDetail();
      return '';
    },
  });
  const preview = () => {
    const earn = Number(document.getElementById('ls-earn').value) || 0;
    const per = Number(document.getElementById('ls-per').value) || 1;
    const value = Number(document.getElementById('ls-value').value) || 0;
    const back = per > 0 ? (earn * value / per) * 100 : 0;
    document.getElementById('ls-preview').innerHTML =
      `A ${pkr(1000)} purchase earns <b>${Math.floor(1000 / per) * earn} points</b> worth ${pkr(Math.floor(1000 / per) * earn * value)} — customers get about <b>${back.toFixed(2)}%</b> back.`;
  };
  ['ls-earn', 'ls-per', 'ls-value'].forEach((id) => document.getElementById(id)?.addEventListener('input', preview));
  preview();
}

// ─── Printing ─────────────────────────────────────────────────────────────────
function custCompanyName() {
  try {
    const tpl = window.PosReceipt ? window.PosReceipt.loadReceiptTemplate() : {};
    // eslint-disable-next-line no-undef
    const company = window.PosReceipt ? window.PosReceipt.resolveReceiptCompany(typeof companyProfile !== 'undefined' ? companyProfile : null, tpl) : {};
    return company.name || 'Store';
  } catch (e) {
    return 'Store';
  }
}

function printHtmlDocument(title, inner) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${custEsc(title)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;font-size:12px;}
      h1{font-size:18px;margin:0 0 2px;} h2{font-size:14px;margin:18px 0 6px;}
      .muted{color:#64748b;} table{width:100%;border-collapse:collapse;margin-top:6px;}
      th,td{border-bottom:1px solid #e2e8f0;padding:6px 4px;text-align:left;} th{background:#f1f5f9;}
      .num{text-align:right;} .grid{display:flex;gap:12px;margin-top:12px;}
      .box{flex:1;border:1px solid #e2e8f0;border-radius:6px;padding:8px;} .box b{display:block;font-size:15px;margin-top:2px;}
      @page{margin:14mm;}
    </style></head><body>${inner}</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0;';
  document.body.appendChild(frame);
  frame.contentDocument.open();
  frame.contentDocument.write(html);
  frame.contentDocument.close();
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 4000);
  }, 300);
}

function printCustomerStatement() {
  const acc = custState.account;
  if (!acc) return;
  const c = acc.customer;
  const b = acc.balances;
  const rows = acc.ledger.filter((e) => e.kind !== 'POINTS').slice().reverse();
  let running = 0;
  const lines = rows.map((e) => {
    if (e.kind === 'ACCOUNT') running += e.amount;
    const label = LEDGER_LABELS[`${e.kind}:${e.type}`] || e.type;
    return `<tr><td>${custDate(e.createdAt)}</td><td>${custEsc(label)}</td><td>${custEsc(e.reference)}</td>
      <td class="num">${e.kind === 'ACCOUNT' && e.amount > 0 ? pkr(e.amount) : ''}</td>
      <td class="num">${e.kind === 'ACCOUNT' && e.amount < 0 ? pkr(-e.amount) : ''}</td>
      <td class="num">${e.kind === 'CREDIT' ? `${e.amount > 0 ? '+' : '−'}${pkr(Math.abs(e.amount))}` : ''}</td>
      <td class="num">${e.kind === 'ACCOUNT' ? pkr(running) : ''}</td></tr>`;
  }).join('');
  printHtmlDocument(`Statement — ${c.name}`, `
    <h1>${custEsc(custCompanyName())}</h1>
    <div class="muted">Customer statement · printed ${new Date().toLocaleString()}</div>
    <h2>${custEsc(c.name)}</h2>
    <div class="muted">${[c.phone, c.email, c.companyName].filter(Boolean).map(custEsc).join(' · ')}</div>
    <div class="grid">
      <div class="box">Balance due<b>${pkr(b.accountBalance)}</b></div>
      <div class="box">Store credit<b>${pkr(b.storeCredit)}</b></div>
      <div class="box">Loyalty points<b>${Math.round(b.points)}</b></div>
      <div class="box">Credit limit<b>${money(c.creditLimit) ? pkr(c.creditLimit) : 'None'}</b></div>
    </div>
    <h2>Account activity</h2>
    <table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="num">Charges</th><th class="num">Payments</th><th class="num">Store credit</th><th class="num">Balance due</th></tr></thead>
    <tbody>${lines || '<tr><td colspan="7" class="muted">No activity.</td></tr>'}</tbody></table>`);
}

function printPaymentReceipt(c, entry, balances) {
  printHtmlDocument('Payment receipt', `
    <h1>${custEsc(custCompanyName())}</h1>
    <div class="muted">Payment receipt · ${new Date().toLocaleString()}</div>
    <h2>Received from ${custEsc(c.name)}</h2>
    <div class="grid">
      <div class="box">Amount received<b>${pkr(entry.amount)}</b></div>
      <div class="box">Method<b>${custEsc(entry.method)}</b></div>
      <div class="box">Balance remaining<b>${pkr(balances?.accountBalance)}</b></div>
    </div>
    ${entry.note ? `<p>${custEsc(entry.note)}</p>` : ''}`);
}

// ─── Wiring ───────────────────────────────────────────────────────────────────
(function wireCustomersTab() {
  const search = document.getElementById('cust-search');
  let t = null;
  search?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      custState.query = search.value;
      renderCustomerTable();
    }, 120);
  });
  document.querySelectorAll('#cust-filters [data-filter]').forEach((btn) => btn.addEventListener('click', () => {
    custState.filter = btn.dataset.filter;
    document.querySelectorAll('#cust-filters [data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
    renderCustomerTable();
  }));
  document.getElementById('cust-sort')?.addEventListener('change', (e) => {
    custState.sort = e.target.value;
    renderCustomerTable();
  });
  document.getElementById('cust-table-body')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openCustomerAccount(tr.dataset.id);
  });
  document.getElementById('cust-btn-new')?.addEventListener('click', () => openCustomerForm(null));
  document.getElementById('cust-btn-loyalty')?.addEventListener('click', openLoyaltySettings);
  document.getElementById('cust-btn-refresh')?.addEventListener('click', loadCustomersTab);
  document.querySelector('.tab-btn[data-tab="customers"]')?.addEventListener('click', loadCustomersTab);
})();
