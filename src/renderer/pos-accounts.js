/* POS Accounts — advanced ledgers, books & reports (offline-first) */
(function initPosAccounts() {
  const api = window.bisonDesktop || window.api;
  if (!api?.pos) {
    console.warn('[accounts] bisonDesktop.pos API missing');
    return;
  }

  let currentSection = 'dashboard';
  let partyCache = { customers: [], suppliers: [] };

  const money = (n) => {
    const v = Number(n) || 0;
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const monthStart = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  };

  function toast(msg, tone) {
    if (typeof window.showToast === 'function') window.showToast(msg, tone || 'success');
    else console.log('[accounts]', msg);
  }

  function setStatus(msg, isError) {
    const el = document.getElementById('acc-status-banner');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
    el.style.color = isError ? '#b91c1c' : '#047857';
  }

  function range() {
    return {
      from: document.getElementById('acc-from')?.value || todayStr(),
      to: document.getElementById('acc-to')?.value || todayStr(),
    };
  }

  function ensureDates() {
    const from = document.getElementById('acc-from');
    const to = document.getElementById('acc-to');
    if (from && !from.value) from.value = todayStr();
    if (to && !to.value) to.value = todayStr();
    ['acc-cash-date', 'acc-exp-date', 'acc-sup-date'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = todayStr();
    });
  }

  function showSection(name) {
    currentSection = String(name || 'dashboard');
    document.querySelectorAll('.accounts-section').forEach((el) => {
      const on = el.id === `accounts-${currentSection}`;
      el.classList.toggle('hidden', !on);
      el.style.display = on ? '' : 'none';
    });
    document.querySelectorAll('[data-accounts-nav]').forEach((btn) => {
      const on = btn.getAttribute('data-accounts-nav') === currentSection;
      btn.classList.toggle('active', on);
    });
  }

  function tableHtml(cols, rows, { foot } = {}) {
    if (!rows.length) {
      return '<p class="settings-muted" style="margin:8px 0;">No records in this period.</p>';
    }
    const head = cols.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${c.label}</th>`).join('');
    const body = rows.map((r) => {
      const tds = cols.map((c) => {
        const raw = typeof c.value === 'function' ? c.value(r) : r[c.key];
        const cls = c.align === 'right' ? 'num' : '';
        const extra = typeof c.className === 'function' ? c.className(r) : (c.className || '');
        return `<td class="${cls} ${extra}">${raw ?? '—'}</td>`;
      }).join('');
      const rowCls = typeof rows._rowClass === 'function' ? '' : (r._rowClass || '');
      const attrs = r._attrs || '';
      return `<tr class="${rowCls}" ${attrs}>${tds}</tr>`;
    }).join('');
    const footHtml = foot
      ? `<tfoot><tr>${cols.map((c) => `<td class="${c.align === 'right' ? 'num' : ''}">${foot[c.key] ?? foot[c.label] ?? ''}</td>`).join('')}</tr></tfoot>`
      : '';
    return `<div class="acc-table-wrap"><table class="acc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footHtml}</table></div>`;
  }

  function amtCell(n, side) {
    const v = Number(n) || 0;
    if (!(v > 0)) return '—';
    return `<span class="${side}">${money(v)}</span>`;
  }

  async function refreshDashboard() {
    const res = await api.pos.accountsDashboard(range());
    if (!res?.success) {
      setStatus(res?.message || 'Dashboard failed', true);
      return;
    }
    setStatus('');
    const d = res.data || {};
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = money(val);
    };
    set('acc-kpi-cash', d.cashBalance);
    set('acc-kpi-bank', d.bankBalance);
    set('acc-kpi-ar', d.receivables);
    set('acc-kpi-ap', d.payables);
    set('acc-kpi-income', d.todayIncome);
    set('acc-kpi-expense', d.todayExpenses);
    set('acc-kpi-profit', d.profit);
    const pending = document.getElementById('acc-kpi-pending');
    if (pending) pending.textContent = String(d.pendingAccounts || 0);

    const flow = document.getElementById('acc-cashflow-summary');
    if (flow) {
      flow.innerHTML = `
        <div class="mod-kpis" style="margin:0;">
          <div class="kpi"><span>Opening cash</span><b>${money(d.openingCash)}</b></div>
          <div class="kpi"><span>Cash sales</span><b>${money(d.cashSales)}</b></div>
          <div class="kpi"><span>Card sales</span><b>${money(d.cardSales)}</b></div>
          <div class="kpi"><span>Bank sales</span><b>${money(d.bankSales)}</b></div>
          <div class="kpi"><span>Cash in (period)</span><b>${money(d.periodCashIn)}</b></div>
          <div class="kpi"><span>Cash out (period)</span><b>${money(d.periodCashOut)}</b></div>
        </div>`;
    }
    const recent = document.getElementById('acc-recent-activity');
    if (recent) {
      const rows = d.recent || [];
      recent.innerHTML = tableHtml(
        [
          { label: 'Date', value: (r) => String(r.date || '').slice(0, 16).replace('T', ' ') },
          { label: 'Particular', value: (r) => `${esc(r.particular)}<small>${esc(r.account)} · ${esc(r.voucher || '')}</small>` },
          { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
          { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
        ],
        rows
      );
    }
  }

  async function refreshDaybook() {
    const res = await api.pos.accountsDaybook(range());
    const el = document.getElementById('acc-daybook-table');
    if (!el) return;
    const lines = res?.data?.lines || [];
    el.innerHTML = tableHtml(
      [
        { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
        { label: 'Voucher', value: (r) => esc(r.voucher || '—') },
        { label: 'Particular', value: (r) => `${esc(r.particular)}<small>${esc(r.type)} · ${esc(r.method || '')}</small>` },
        { label: 'Account', key: 'account' },
        { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
        { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
      ],
      lines,
      {
        foot: {
          Date: 'Total',
          Debit: money(lines.reduce((n, r) => n + (Number(r.debit) || 0), 0)),
          Credit: money(lines.reduce((n, r) => n + (Number(r.credit) || 0), 0)),
        },
      }
    );
  }

  async function refreshBook(kind) {
    const res = await api.pos.accountsBook({ ...range(), book: kind });
    const el = document.getElementById(kind === 'bank' ? 'acc-bankbook-table' : 'acc-cashbook-table');
    if (!el) return;
    if (!res?.success) {
      el.innerHTML = `<p class="settings-muted">${esc(res?.message || 'Failed')}</p>`;
      return;
    }
    const d = res.data || {};
    const rows = d.rows || [];
    el.innerHTML = `
      <div class="mod-kpis" style="margin-bottom:10px;">
        <div class="kpi"><span>Opening</span><b>${money(d.opening)}</b></div>
        <div class="kpi"><span>Closing</span><b class="${d.closing >= 0 ? 'acc-bal-pos' : 'acc-bal-neg'}">${money(d.closing)}</b></div>
        <div class="kpi"><span>Entries</span><b>${rows.length}</b></div>
      </div>
      ${tableHtml(
        [
          { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
          { label: 'Particular', value: (r) => `${esc(r.particular)}<small>${esc(r.voucher || '')}</small>` },
          { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
          { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
          { label: 'Balance', value: (r) => `<b class="${r.balance >= 0 ? 'acc-bal-pos' : 'acc-bal-neg'}">${money(r.balance)}</b>`, align: 'right' },
        ],
        rows
      )}`;
  }

  async function loadParties() {
    try {
      const res = await api.customers?.listAccounts?.({ limit: 500 });
      partyCache.customers = res?.data || [];
    } catch { partyCache.customers = []; }
    try {
      const res = await api.pos.accountsList({ type: 'supplier_payment', limit: 500 });
      const names = [...new Set((res?.data || []).map((r) => r.partyName).filter(Boolean))];
      partyCache.suppliers = names;
    } catch { partyCache.suppliers = []; }
  }

  function syncLedgerPartySelect() {
    const kind = document.getElementById('acc-ledger-type')?.value;
    const sel = document.getElementById('acc-ledger-party');
    if (!sel) return;
    if (kind === 'customer') {
      sel.style.display = '';
      sel.innerHTML = partyCache.customers
        .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${money(c.balances?.accountBalance || 0)})</option>`)
        .join('') || '<option value="">No customers</option>';
    } else if (kind === 'supplier') {
      sel.style.display = '';
      sel.innerHTML = partyCache.suppliers
        .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
        .join('') || '<option value="">No suppliers yet</option>';
    } else {
      sel.style.display = 'none';
      sel.innerHTML = '';
    }
  }

  async function refreshLedger() {
    const kind = document.getElementById('acc-ledger-type')?.value || 'cash';
    const party = document.getElementById('acc-ledger-party');
    const params = { ...range(), kind };
    if (kind === 'customer') params.partyId = party?.value;
    if (kind === 'supplier') params.partyName = party?.value;
    const res = await api.pos.accountsLedger(params);
    const sum = document.getElementById('acc-ledger-summary');
    const el = document.getElementById('acc-ledger-table');
    if (!res?.success) {
      if (el) el.innerHTML = `<p class="settings-muted">${esc(res?.message || 'Failed')}</p>`;
      return;
    }
    const d = res.data || {};
    if (sum) {
      sum.innerHTML = `
        <div class="kpi"><span>Account</span><b style="font-size:15px;">${esc(d.title || kind)}</b></div>
        <div class="kpi"><span>Opening</span><b>${money(d.opening)}</b></div>
        <div class="kpi"><span>Closing</span><b class="${(d.closing || 0) >= 0 ? 'acc-bal-pos' : 'acc-bal-neg'}">${money(d.closing)}</b></div>
        <div class="kpi"><span>Lines</span><b>${(d.rows || []).length}</b></div>`;
    }
    if (el) {
      el.innerHTML = tableHtml(
        [
          { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
          { label: 'Particular', value: (r) => `${esc(r.particular)}<small>${esc(r.reference || r.voucher || '')}</small>` },
          { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
          { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
          { label: 'Balance', value: (r) => `<b>${money(r.balance)}</b>`, align: 'right' },
        ],
        d.rows || []
      );
    }
  }

  async function refreshCashList() {
    const res = await api.pos.accountsList({
      types: ['deposit', 'withdrawal', 'transfer', 'cash_deposit', 'cash_withdrawal'],
      limit: 80,
    });
    const el = document.getElementById('acc-cash-list');
    if (!el) return;
    el.innerHTML = tableHtml(
      [
        { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
        { label: 'Type', key: 'type' },
        { label: 'Amount', value: (r) => money(r.amount), align: 'right' },
        { label: 'Notes', value: (r) => esc(r.description || r.notes || '—') },
        { label: 'Sync', value: (r) => esc(r.syncStatus || 'pending') },
      ],
      res?.data || []
    );
  }

  async function refreshExpenseList() {
    const res = await api.pos.accountsList({ types: ['expense', 'income'], limit: 100 });
    const el = document.getElementById('acc-expense-list');
    if (!el) return;
    el.innerHTML = tableHtml(
      [
        { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
        { label: 'Kind', key: 'type' },
        { label: 'Category', key: 'category' },
        { label: 'Amount', value: (r) => money(r.amount), align: 'right' },
        { label: 'Method', key: 'paymentMethod' },
        { label: 'Description', value: (r) => esc(r.description || '—') },
        { label: 'Sync', value: (r) => esc(r.syncStatus || 'pending') },
      ],
      res?.data || []
    );
  }

  async function refreshCustomers() {
    const list = document.getElementById('acc-customer-list');
    const wrap = document.getElementById('acc-customer-ledger-wrap');
    if (wrap) wrap.classList.add('hidden');
    if (list) list.classList.remove('hidden');
    await loadParties();
    const rows = partyCache.customers
      .filter((c) => Number(c.balances?.accountBalance) > 0.009 || Number(c.balances?.storeCredit) > 0.009)
      .sort((a, b) => (b.balances?.accountBalance || 0) - (a.balances?.accountBalance || 0));
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<p class="settings-muted">No outstanding customer balances. Credit sales and payments appear here automatically.</p>';
      return;
    }
    list.innerHTML = tableHtml(
      [
        { label: 'Customer', value: (c) => `<b>${esc(c.name)}</b><small>${esc(c.phone || '')}</small>` },
        { label: 'Balance due', value: (c) => `<span class="acc-bal-neg">${money(c.balances?.accountBalance)}</span>`, align: 'right' },
        { label: 'Store credit', value: (c) => money(c.balances?.storeCredit), align: 'right' },
        { label: '', value: () => '<button type="button" class="btn-nav-action ghost sm acc-open-cust-ledger">Ledger</button>' },
      ],
      rows.map((c) => ({ ...c, _attrs: `data-cust-id="${esc(c.id)}" data-cust-name="${esc(c.name)}"` }))
    );
    list.querySelectorAll('.acc-open-cust-ledger').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const tr = e.target.closest('tr');
        const id = tr?.getAttribute('data-cust-id');
        const name = tr?.getAttribute('data-cust-name') || 'Customer';
        if (!id) return;
        const res = await api.pos.accountsLedger({ ...range(), kind: 'customer', partyId: id });
        list.classList.add('hidden');
        wrap?.classList.remove('hidden');
        const title = document.getElementById('acc-customer-ledger-title');
        if (title) title.textContent = `Ledger · ${name}`;
        const body = document.getElementById('acc-customer-ledger');
        if (body) {
          const d = res?.data || {};
          body.innerHTML = `
            <div class="mod-kpis">
              <div class="kpi"><span>Balance due</span><b>${money(d.closing)}</b></div>
              <div class="kpi"><span>Store credit</span><b>${money(d.balances?.storeCredit)}</b></div>
              <div class="kpi"><span>Points</span><b>${money(d.balances?.points)}</b></div>
            </div>
            ${tableHtml(
              [
                { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
                { label: 'Particular', value: (r) => `${esc(r.particular)}<small>${esc(r.reference || '')}</small>` },
                { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
                { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
                { label: 'Balance', value: (r) => money(r.balance), align: 'right' },
              ],
              d.rows || []
            )}`;
        }
      });
    });
  }

  async function refreshSuppliers() {
    const res = await api.pos.accountsList({ type: 'supplier_payment', limit: 100 });
    const el = document.getElementById('acc-supplier-list');
    if (!el) return;
    el.innerHTML = tableHtml(
      [
        { label: 'Date', value: (r) => String(r.date || '').slice(0, 10) },
        { label: 'Supplier', value: (r) => esc(r.partyName || '—') },
        { label: 'Amount', value: (r) => money(r.amount), align: 'right' },
        { label: 'Method', key: 'paymentMethod' },
        { label: 'Notes', value: (r) => esc(r.notes || r.description || '—') },
        { label: 'Sync', value: (r) => esc(r.syncStatus || 'pending') },
      ],
      res?.data || []
    );
  }

  async function refreshClosing() {
    const dash = await api.pos.accountsDashboard(range());
    const d = dash?.data || {};
    const summary = document.getElementById('acc-closing-summary');
    if (summary) {
      summary.innerHTML = `
        <div class="mod-kpis" style="margin:0;">
          <div class="kpi"><span>Opening</span><b>${money(d.openingCash)}</b></div>
          <div class="kpi"><span>Cash sales</span><b>${money(d.cashSales)}</b></div>
          <div class="kpi"><span>Card sales</span><b>${money(d.cardSales)}</b></div>
          <div class="kpi"><span>Bank sales</span><b>${money(d.bankSales)}</b></div>
          <div class="kpi"><span>Cash in</span><b>${money(d.periodCashIn)}</b></div>
          <div class="kpi"><span>Cash out</span><b>${money(d.periodCashOut)}</b></div>
        </div>`;
    }
    const hist = await api.pos.accountsClosingHistory();
    const el = document.getElementById('acc-closing-history');
    if (el) {
      el.innerHTML = tableHtml(
        [
          { label: 'Date', key: 'date' },
          { label: 'Expected', value: (r) => money(r.expectedCash), align: 'right' },
          { label: 'Actual', value: (r) => money(r.actualCash), align: 'right' },
          { label: 'Diff', value: (r) => `<span class="${Number(r.difference) ? 'acc-bal-neg' : 'acc-bal-pos'}">${money(r.difference)}</span>`, align: 'right' },
          { label: 'Notes', value: (r) => esc(r.notes || '—') },
        ],
        hist?.data || []
      );
    }
  }

  async function refreshReport() {
    const report = document.getElementById('acc-report-type')?.value || 'profit';
    const res = await api.pos.accountsReport({ ...range(), report });
    const el = document.getElementById('acc-report-body');
    if (!el) return;
    if (!res?.success) {
      el.innerHTML = `<p class="settings-muted">${esc(res?.message || 'Failed')}</p>`;
      return;
    }
    const d = res.data || {};
    const title = {
      profit: 'Profit summary',
      cashflow: 'Cash flow',
      expenses: 'Expense by category',
      salesmix: 'Sales by payment method',
      receivables: 'Receivables summary',
      payables: 'Supplier payments',
      trial: 'Account balances',
    }[report] || 'Report';

    if (report === 'trial') {
      el.innerHTML = `
        <div class="acc-report-block">
          <h4>${title} · ${esc(d.from || '')} → ${esc(d.to || '')}</h4>
          ${tableHtml(
            [
              { label: 'Account', value: (r) => esc(r.label) },
              { label: 'Debit', value: (r) => amtCell(r.debit, 'dr'), align: 'right' },
              { label: 'Credit', value: (r) => amtCell(r.credit, 'cr'), align: 'right' },
            ],
            d.rows || []
          )}
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="acc-report-block">
        <h4>${title}${d.from ? ` · ${esc(d.from)} → ${esc(d.to)}` : ''}</h4>
        ${d.note ? `<p class="settings-muted">${esc(d.note)}</p>` : ''}
        ${tableHtml(
          [
            { label: report === 'receivables' ? 'Customer' : 'Particular', value: (r) => `${esc(r.label)}${r.phone ? `<small>${esc(r.phone)}</small>` : ''}` },
            { label: 'Amount', value: (r) => `<b class="${Number(r.amount) < 0 ? 'acc-bal-neg' : ''}">${money(r.amount)}</b>`, align: 'right' },
          ],
          d.rows || [],
          d.total != null ? { foot: { Particular: 'Total', Amount: money(d.total) } } : undefined
        )}
      </div>`;
  }

  async function refreshSection(name) {
    ensureDates();
    const n = name || currentSection;
    if (n === 'dashboard') await refreshDashboard();
    else if (n === 'daybook') await refreshDaybook();
    else if (n === 'cashbook') await refreshBook('cash');
    else if (n === 'bankbook') await refreshBook('bank');
    else if (n === 'ledgers') {
      await loadParties();
      syncLedgerPartySelect();
      await refreshLedger();
    }
    else if (n === 'cash') await refreshCashList();
    else if (n === 'expenses') await refreshExpenseList();
    else if (n === 'customers') await refreshCustomers();
    else if (n === 'suppliers') await refreshSuppliers();
    else if (n === 'closing') await refreshClosing();
    else if (n === 'reports') await refreshReport();
  }

  async function refresh() {
    ensureDates();
    showSection(currentSection || 'dashboard');
    try {
      await refreshSection(currentSection || 'dashboard');
    } catch (err) {
      console.warn('[accounts] refresh failed', err);
      setStatus(err?.message || 'Accounts refresh failed', true);
    }
  }

  function printCurrent() {
    const panel = document.querySelector(`#accounts-${currentSection}`);
    if (!panel) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) {
      toast('Allow popups to print', 'error');
      return;
    }
    const { from, to } = range();
    w.document.write(`<!doctype html><html><head><title>POS Accounts</title>
      <style>
        body{font-family:system-ui,sans-serif;padding:24px;color:#0f172a}
        h1{font-size:18px;margin:0 0 4px} .meta{color:#64748b;font-size:12px;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
        th.num,td.num{text-align:right}
        .kpi{display:inline-block;margin:0 12px 12px 0;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px}
        .kpi b{display:block;font-size:16px}
        button,.acc-nav,.acc-filters,.mod-head-actions,form{display:none!important}
      </style></head><body>
      <h1>POS Accounts — ${esc(currentSection)}</h1>
      <div class="meta">Period ${esc(from)} to ${esc(to)} · Printed ${new Date().toLocaleString()}</div>
      ${panel.innerHTML}
      <script>setTimeout(()=>print(),200)<\/script>
      </body></html>`);
    w.document.close();
  }

  function wire() {
    document.querySelectorAll('[data-accounts-nav]').forEach((btn) => {
      if (btn.dataset.boundAccountsNav) return;
      btn.dataset.boundAccountsNav = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const name = btn.getAttribute('data-accounts-nav') || 'dashboard';
        showSection(name);
        void refreshSection(name);
      });
    });

    document.getElementById('acc-btn-refresh')?.addEventListener('click', () => void refresh());
    document.getElementById('acc-btn-print')?.addEventListener('click', printCurrent);
    document.getElementById('acc-filter-today')?.addEventListener('click', () => {
      const t = todayStr();
      document.getElementById('acc-from').value = t;
      document.getElementById('acc-to').value = t;
      void refreshSection(currentSection);
    });
    document.getElementById('acc-filter-month')?.addEventListener('click', () => {
      document.getElementById('acc-from').value = monthStart();
      document.getElementById('acc-to').value = todayStr();
      void refreshSection(currentSection);
    });
    document.getElementById('acc-filter-apply')?.addEventListener('click', () => void refreshSection(currentSection));
    document.getElementById('acc-ledger-type')?.addEventListener('change', () => {
      syncLedgerPartySelect();
    });
    document.getElementById('acc-ledger-load')?.addEventListener('click', () => void refreshLedger());
    document.getElementById('acc-report-type')?.addEventListener('change', () => void refreshReport());
    document.getElementById('acc-customer-ledger-back')?.addEventListener('click', () => void refreshCustomers());

    const cashForm = document.getElementById('acc-cash-form');
    if (cashForm && !cashForm.dataset.bound) {
      cashForm.dataset.bound = '1';
      cashForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const type = document.getElementById('acc-cash-type')?.value || 'deposit';
        const res = await api.pos.accountsCreate({
          type: type === 'transfer' ? 'transfer' : type,
          direction: type === 'transfer' ? 'cash_to_bank' : undefined,
          amount: Number(document.getElementById('acc-cash-amount')?.value),
          date: document.getElementById('acc-cash-date')?.value || todayStr(),
          paymentMethod: 'Cash',
          description: document.getElementById('acc-cash-notes')?.value || type,
          notes: document.getElementById('acc-cash-notes')?.value || '',
        });
        if (!res?.success) return toast(res?.message || 'Save failed', 'error');
        toast('Cash movement saved');
        cashForm.reset();
        ensureDates();
        await refreshCashList();
      });
    }

    const expForm = document.getElementById('acc-expense-form');
    if (expForm && !expForm.dataset.bound) {
      expForm.dataset.bound = '1';
      expForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const kind = document.getElementById('acc-exp-kind')?.value || 'expense';
        const res = await api.pos.accountsCreate({
          type: kind,
          category: document.getElementById('acc-exp-category')?.value || '',
          amount: Number(document.getElementById('acc-exp-amount')?.value),
          paymentMethod: document.getElementById('acc-exp-method')?.value || 'Cash',
          date: document.getElementById('acc-exp-date')?.value || todayStr(),
          description: document.getElementById('acc-exp-desc')?.value || '',
        });
        if (!res?.success) return toast(res?.message || 'Save failed', 'error');
        toast(`${kind === 'income' ? 'Income' : 'Expense'} saved`);
        expForm.reset();
        ensureDates();
        await refreshExpenseList();
      });
    }

    const supForm = document.getElementById('acc-supplier-form');
    if (supForm && !supForm.dataset.bound) {
      supForm.dataset.bound = '1';
      supForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await api.pos.accountsCreate({
          type: 'supplier_payment',
          partyName: document.getElementById('acc-sup-name')?.value || '',
          amount: Number(document.getElementById('acc-sup-amount')?.value),
          paymentMethod: document.getElementById('acc-sup-method')?.value || 'Cash',
          date: document.getElementById('acc-sup-date')?.value || todayStr(),
          notes: document.getElementById('acc-sup-notes')?.value || '',
          description: `Supplier payment · ${document.getElementById('acc-sup-name')?.value || ''}`,
        });
        if (!res?.success) return toast(res?.message || 'Save failed', 'error');
        toast('Supplier payment saved');
        supForm.reset();
        ensureDates();
        await refreshSuppliers();
      });
    }

    const closingForm = document.getElementById('acc-closing-form');
    if (closingForm && !closingForm.dataset.bound) {
      closingForm.dataset.bound = '1';
      closingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await api.pos.accountsSaveClosing({
          actualCash: Number(document.getElementById('acc-closing-actual')?.value),
          notes: document.getElementById('acc-closing-notes')?.value || '',
        });
        if (!res?.success) return toast(res?.message || 'Closing failed', 'error');
        toast(`Closing saved · difference ${money(res.data?.difference)}`);
        closingForm.reset();
        await refreshClosing();
      });
    }
  }

  document.querySelectorAll('.accounts-section').forEach((el) => {
    if (el.id !== 'accounts-dashboard') {
      el.classList.add('hidden');
      el.style.display = 'none';
    }
  });

  wire();
  ensureDates();
  showSection('dashboard');
  window.PosAccounts = { refresh, showSection, refreshSection };
  console.log('[accounts] advanced PosAccounts ready');
})();
