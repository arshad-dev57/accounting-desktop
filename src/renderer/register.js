'use strict';

const api = window.bisonDesktop;

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function fmt(n) {
  return `PKR ${money(n).toFixed(2)}`;
}

function cashierName(sale) {
  const c = sale.shift?.cashier || sale.cashier || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return name || c.email || sale.cashierName || sale.createdByName || 'Unknown';
}

function saleTotal(sale) {
  return money(sale.grandTotal ?? sale.total ?? sale.totalAmount);
}

function isCreditSale(sale) {
  const pays = sale.payments || [];
  if (pays.some((p) => String(p.paymentMethod || '').toLowerCase().includes('credit'))) return true;
  return String(sale.notes || '').toLowerCase().includes('credit sale');
}

function unwrapSales(res) {
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.data?.sales)) return res.data.sales;
  if (Array.isArray(res?.data?.data)) return res.data.data;
  return [];
}

function renderUserTable(sales) {
  const wrap = document.getElementById('user-table');
  const byUser = new Map();
  sales.forEach((s) => {
    const name = cashierName(s);
    const cur = byUser.get(name) || { name, count: 0, total: 0, credit: 0 };
    const amt = saleTotal(s);
    cur.count += 1;
    cur.total += amt;
    if (isCreditSale(s)) cur.credit += amt;
    byUser.set(name, cur);
  });
  const rows = [...byUser.values()].sort((a, b) => b.total - a.total);
  document.getElementById('kpi-users').textContent = String(rows.length);
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No cashier sales yet.</div>';
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr><th>Cashier</th><th>Sales</th><th>Total</th><th>Credit</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${r.name}</td>
      <td>${r.count}</td>
      <td>${fmt(r.total)}</td>
      <td class="credit">${fmt(r.credit)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderSalesTable(sales) {
  const wrap = document.getElementById('sales-table');
  if (!sales.length) {
    wrap.innerHTML = '<div class="empty">No POS sales found.</div>';
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr><th>Invoice</th><th>Date</th><th>Cashier</th><th>Customer</th><th>Pay</th><th>Total</th></tr></thead>
    <tbody>${sales.map((s) => {
      const methods = (s.payments || []).map((p) => p.paymentMethod).filter(Boolean).join(', ') || '—';
      const credit = isCreditSale(s);
      return `<tr>
        <td>${s.invoiceNumber || s.id || '—'}</td>
        <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
        <td>${cashierName(s)}</td>
        <td>${s.customerName || s.customer?.name || 'Walk-in'}</td>
        <td class="${credit ? 'credit' : ''}">${credit ? 'Credit' : methods}</td>
        <td>${fmt(saleTotal(s))}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

async function boot() {
  document.getElementById('btn-back').addEventListener('click', () => {
    window.location.href = './sell.html';
  });
  const res = await api.pos.listSales('page=1&limit=200');
  const sales = unwrapSales(res);
  const total = sales.reduce((sum, s) => sum + saleTotal(s), 0);
  const credit = sales.filter(isCreditSale).reduce((sum, s) => sum + saleTotal(s), 0);
  document.getElementById('kpi-count').textContent = String(sales.length);
  document.getElementById('kpi-total').textContent = fmt(total);
  document.getElementById('kpi-credit').textContent = fmt(credit);
  renderUserTable(sales);
  renderSalesTable(sales);
}

boot().catch((err) => {
  document.getElementById('sales-table').innerHTML = `<div class="empty">${err.message}</div>`;
});
