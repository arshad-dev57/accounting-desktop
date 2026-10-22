/* global window, document, api, pkr, money, showToast, activeShift, saleCashier, custEsc, printHtmlDocument, custCompanyName */
/* Reports tab: period-based retail reports (sales summary, items, time,
   tenders, cashiers, customers & loyalty, returns, shift X-report).
   Raw rows come from the local DB via reports:getData; everything is
   aggregated here. Loaded after sell.js and pos-customers.js. */

'use strict';

const rptState = {
  preset: 'today',
  from: null,
  to: null,
  report: 'summary',
  data: null,
  prev: null,
  csv: null,
  title: '',
  itemQuery: '',
};

// ─── Periods ──────────────────────────────────────────────────────────────────
function rptStartOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function rptEndOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function rptRangeFor(preset) {
  const now = new Date();
  const today = rptStartOfDay(now);
  switch (preset) {
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return [y, rptEndOfDay(y)];
    }
    case 'week': {
      const start = new Date(today);
      const dow = (start.getDay() + 6) % 7; // Monday first
      start.setDate(start.getDate() - dow);
      return [start, rptEndOfDay(now)];
    }
    case 'month':
      return [new Date(today.getFullYear(), today.getMonth(), 1), rptEndOfDay(now)];
    case 'last30': {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return [start, rptEndOfDay(now)];
    }
    case 'custom': {
      const f = document.getElementById('rpt-from')?.value;
      const t = document.getElementById('rpt-to')?.value;
      const from = f ? rptStartOfDay(new Date(`${f}T00:00:00`)) : today;
      const to = t ? rptEndOfDay(new Date(`${t}T00:00:00`)) : rptEndOfDay(now);
      return from <= to ? [from, to] : [to, from];
    }
    default:
      return [today, rptEndOfDay(now)];
  }
}

function rptFmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function rptDateInput(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// ─── Normalisation ────────────────────────────────────────────────────────────
function rptTenderGroup(method) {
  const m = String(method || 'Cash').toLowerCase();
  if (m.includes('store credit')) return 'Store Credit';
  if (m.includes('loyalty') || m.includes('points')) return 'Loyalty Points';
  if (m.includes('credit') || m.includes('on account')) return 'On Account';
  if (m.includes('card')) return 'Card';
  if (m.includes('bank')) return 'Bank Transfer';
  if (m.includes('wallet') || m.includes('mobile')) return 'Mobile Wallet';
  if (m.includes('cheque')) return 'Cheque';
  return m === 'cash' ? 'Cash' : (String(method || 'Other').trim() || 'Other');
}

function rptNormalizeSale(s) {
  const lines = (s.items || []).map((i) => {
    const qty = money(i.quantity);
    const unitPrice = money(i.unitPrice);
    return {
      key: String(i.productId || i.productName || i.name || 'item').toLowerCase(),
      name: i.productName || i.name || 'Item',
      sku: i.sku || '',
      qty,
      gross: qty * unitPrice,
    };
  });
  const gross = lines.reduce((n, l) => n + l.gross, 0);
  const total = money(s.grandTotal);
  const pays = Array.isArray(s.payments) && s.payments.length
    ? s.payments
    : [{ paymentMethod: s.paymentMethod || 'Cash', amount: total }];
  const tendered = pays.reduce((n, p) => n + money(p.amount), 0);
  let change = s.changeAmount != null ? money(s.changeAmount) : Math.max(0, tendered - total);
  const tenders = pays.map((p) => {
    let amt = money(p.amount) || (pays.length === 1 ? total : 0);
    if (String(p.paymentMethod || 'Cash').toLowerCase() === 'cash' && change > 0) {
      const used = Math.min(change, amt);
      amt -= used;
      change -= used;
    }
    return { group: rptTenderGroup(p.paymentMethod), amount: amt };
  });
  return {
    id: s.id,
    invoice: s.invoiceNumber || s.id,
    at: new Date(s.createdAt || 0),
    cashier: (typeof saleCashier === 'function' ? saleCashier(s) : s.cashierName) || 'Staff',
    customerId: s.customerId || '',
    customerName: s.customerName || 'Walk-in Customer',
    lines,
    gross,
    discount: money(s.discountTotal),
    tax: money(s.taxTotal),
    total,
    tenders,
    loyaltyEarned: money(s.loyaltyEarned),
  };
}

function rptNormalizeReturn(r) {
  const items = r.items || [];
  const amount = money(r.refundAmount) || items.reduce((n, i) => n + money(i.unitPrice) * money(i.quantity), 0);
  return {
    id: r.id,
    invoice: r.invoiceNumber || r.originalSaleId || r.saleId || '—',
    at: new Date(r.createdAt || 0),
    method: rptTenderGroup(String(r.refundMethod || 'Cash').replace(/ refund$/i, '')),
    rawMethod: r.refundMethod || 'Cash',
    reason: r.reason || 'Customer return',
    customerName: r.customerName || '',
    cashier: r.cashierName || '',
    items: items.map((i) => ({
      key: String(i.productId || i.productName || i.name || 'item').toLowerCase(),
      name: i.productName || i.name || 'Item',
      qty: money(i.quantity),
      amount: money(i.unitPrice) * money(i.quantity),
    })),
    amount,
  };
}

function rptAggregate(data) {
  const sales = (data?.sales || []).map(rptNormalizeSale);
  const returns = (data?.returns || []).map(rptNormalizeReturn);
  const gross = sales.reduce((n, s) => n + s.gross, 0);
  const discounts = sales.reduce((n, s) => n + s.discount, 0);
  const tax = sales.reduce((n, s) => n + s.tax, 0);
  const totals = sales.reduce((n, s) => n + s.total, 0);
  const refunds = returns.reduce((n, r) => n + r.amount, 0);
  const itemsSold = sales.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.qty, 0), 0);
  return {
    sales,
    returns,
    gross,
    discounts,
    tax,
    refunds,
    netSales: gross - discounts - refunds,
    collected: totals - refunds,
    count: sales.length,
    avgSale: sales.length ? totals / sales.length : 0,
    itemsSold,
    unitsPerSale: sales.length ? itemsSold / sales.length : 0,
  };
}

// ─── Small render helpers ────────────────────────────────────────────────────
function rptDelta(cur, prev) {
  if (!rptState.prev) return '';
  if (!prev) return cur ? '<small class="up">new</small>' : '';
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (!Number.isFinite(pct)) return '';
  const cls = pct >= 0 ? 'up' : 'down';
  return `<small class="${cls}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% vs previous</small>`;
}

function rptKpi(label, value, delta = '') {
  return `<div class="kpi"><span>${label}</span><b>${value}</b>${delta}</div>`;
}

function rptTable(headers, rows, opts = {}) {
  const head = headers.map((h) => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr class="${r.cls || ''}">${r.cells.map((c, i) => `<td class="${headers[i].num ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="cust-empty">${opts.empty || 'No data for this period.'}</td></tr>`;
  const foot = opts.foot
    ? `<tfoot><tr>${opts.foot.map((c, i) => `<td class="${headers[i].num ? 'num' : ''}">${c}</td>`).join('')}</tr></tfoot>`
    : '';
  return `<table class="cust-table rpt-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

/** Vertical bar chart as inline SVG (values ≥ 0). */
function rptBarChart(points, opts = {}) {
  const w = 720;
  const h = 200;
  const pad = { l: 8, r: 8, t: 14, b: 26 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = (w - pad.l - pad.r) / Math.max(1, points.length);
  const bars = points.map((p, i) => {
    const bh = ((h - pad.t - pad.b) * p.value) / max;
    const x = pad.l + i * bw + bw * 0.15;
    const y = h - pad.b - bh;
    const showLabel = points.length <= 16 || i % Math.ceil(points.length / 12) === 0;
    return `<g><title>${custEsc(p.label)}: ${custEsc(opts.format ? opts.format(p.value) : p.value)}</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="3" class="rpt-bar${p.value ? '' : ' zero'}"/>
      ${showLabel ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${h - 8}" class="rpt-axis">${custEsc(p.short || p.label)}</text>` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="rpt-chart" role="img" aria-label="${custEsc(opts.title || 'chart')}">
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" class="rpt-baseline"/>${bars}</svg>`;
}

function rptPct(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

// ─── Reports ──────────────────────────────────────────────────────────────────
function rptSummary(agg, prevAgg) {
  const p = prevAgg || {};
  const tender = rptTenderTotals(agg);
  const kpis = `
    <div class="mod-kpis">
      ${rptKpi('Net sales', pkr(agg.netSales), rptDelta(agg.netSales, p.netSales))}
      ${rptKpi('Transactions', agg.count, rptDelta(agg.count, p.count))}
      ${rptKpi('Average sale', pkr(agg.avgSale), rptDelta(agg.avgSale, p.avgSale))}
      ${rptKpi('Items sold', Math.round(agg.itemsSold * 100) / 100, rptDelta(agg.itemsSold, p.itemsSold))}
      ${rptKpi('Returns', pkr(agg.refunds), `<small>${agg.returns.length} refund(s)</small>`)}
      ${rptKpi('Discounts given', pkr(agg.discounts), `<small>${rptPct(agg.discounts, agg.gross)} of gross</small>`)}
    </div>`;
  const statement = `
    <table class="cust-table rpt-statement">
      <tbody>
        <tr><td>Gross sales</td><td class="num">${pkr(agg.gross)}</td></tr>
        <tr><td>Returns</td><td class="num neg">−${pkr(agg.refunds)}</td></tr>
        <tr><td>Discounts &amp; comps</td><td class="num neg">−${pkr(agg.discounts)}</td></tr>
        <tr class="strong"><td>Net sales</td><td class="num">${pkr(agg.netSales)}</td></tr>
        <tr><td>Tax</td><td class="num">${pkr(agg.tax)}</td></tr>
        <tr class="strong"><td>Total collected</td><td class="num">${pkr(agg.collected)}</td></tr>
      </tbody>
    </table>`;
  const tenders = rptTable(
    [{ label: 'Tender' }, { label: 'Collected', num: true }, { label: 'Refunded', num: true }, { label: 'Net', num: true }],
    tender.map((t) => ({ cells: [custEsc(t.group), pkr(t.collected), t.refunded ? `−${pkr(t.refunded)}` : '—', pkr(t.collected - t.refunded)] }))
  );
  const days = rptByDay(agg);
  const chart = days.length > 1
    ? rptBarChart(days.map((d) => ({ label: d.label, short: d.short, value: d.total })), { format: pkr, title: 'Sales by day' })
    : rptBarChart(rptByHour(agg).map((hr) => ({ label: hr.label, short: hr.short, value: hr.total })), { format: pkr, title: 'Sales by hour' });

  const top = rptItems(agg).slice(0, 5);
  rptState.csv = [
    ['Metric', 'Amount'],
    ['Gross sales', agg.gross], ['Returns', -agg.refunds], ['Discounts', -agg.discounts],
    ['Net sales', agg.netSales], ['Tax', agg.tax], ['Total collected', agg.collected],
    ['Transactions', agg.count], ['Average sale', agg.avgSale], ['Items sold', agg.itemsSold],
    [], ['Tender', 'Collected', 'Refunded', 'Net'],
    ...tender.map((t) => [t.group, t.collected, t.refunded, t.collected - t.refunded]),
  ];
  return `${kpis}
    <div class="rpt-grid-2">
      <div class="rpt-card"><h4>Sales summary</h4>${statement}</div>
      <div class="rpt-card"><h4>Payments</h4>${tenders}</div>
    </div>
    <div class="rpt-card"><h4>${days.length > 1 ? 'Sales by day' : 'Sales by hour'}</h4>${chart}</div>
    <div class="rpt-card"><h4>Top items</h4>${rptTable(
      [{ label: 'Item' }, { label: 'Qty', num: true }, { label: 'Net sales', num: true }, { label: 'Share', num: true }],
      top.map((i) => ({ cells: [custEsc(i.name), i.netQty, pkr(i.net), rptPct(i.net, agg.gross - agg.refunds)] }))
    )}</div>`;
}

function rptTenderTotals(agg) {
  const map = new Map();
  const get = (g) => {
    if (!map.has(g)) map.set(g, { group: g, collected: 0, refunded: 0, count: 0 });
    return map.get(g);
  };
  agg.sales.forEach((s) => {
    const seen = new Set();
    s.tenders.forEach((t) => {
      const row = get(t.group);
      row.collected += t.amount;
      if (!seen.has(t.group)) { row.count += 1; seen.add(t.group); }
    });
  });
  agg.returns.forEach((r) => { get(r.method).refunded += r.amount; });
  return [...map.values()].sort((a, b) => b.collected - a.collected);
}

function rptItems(agg) {
  const map = new Map();
  const get = (key, name, sku) => {
    if (!map.has(key)) map.set(key, { key, name, sku, qty: 0, gross: 0, retQty: 0, retAmount: 0, tx: 0 });
    return map.get(key);
  };
  agg.sales.forEach((s) => {
    // spread the sale discount over its lines so item net sales add up to the summary
    const share = s.gross > 0 ? s.discount / s.gross : 0;
    s.lines.forEach((l) => {
      const row = get(l.key, l.name, l.sku);
      row.qty += l.qty;
      row.gross += l.gross;
      row.disc = (row.disc || 0) + l.gross * share;
      row.tx += 1;
    });
  });
  agg.returns.forEach((r) => r.items.forEach((i) => {
    const row = get(i.key, i.name, '');
    row.retQty += i.qty;
    row.retAmount += i.amount;
  }));
  return [...map.values()].map((r) => ({
    ...r,
    disc: r.disc || 0,
    netQty: Math.round((r.qty - r.retQty) * 1000) / 1000,
    net: r.gross - (r.disc || 0) - r.retAmount,
  })).sort((a, b) => b.net - a.net);
}

function rptItemsReport(agg) {
  const q = rptState.itemQuery.trim().toLowerCase();
  const all = rptItems(agg);
  const rows = all.filter((i) => !q || i.name.toLowerCase().includes(q) || String(i.sku).toLowerCase().includes(q));
  const totalNet = all.reduce((n, i) => n + i.net, 0);
  rptState.csv = [
    ['Item', 'SKU', 'Qty sold', 'Qty returned', 'Net qty', 'Gross sales', 'Discounts', 'Returns', 'Net sales', 'Share %'],
    ...rows.map((i) => [i.name, i.sku, i.qty, i.retQty, i.netQty, i.gross, i.disc, i.retAmount, i.net, totalNet ? (i.net / totalNet) * 100 : 0]),
  ];
  return `
    <div class="rpt-toolbar"><input type="search" class="inp-search" id="rpt-item-search" placeholder="Filter items…" value="${custEsc(rptState.itemQuery)}" /><span class="cust-count">${rows.length} item(s)</span></div>
    <div class="rpt-card">${rptTable(
      [{ label: 'Item' }, { label: 'Sold', num: true }, { label: 'Returned', num: true }, { label: 'Gross sales', num: true }, { label: 'Discounts', num: true }, { label: 'Returns', num: true }, { label: 'Net sales', num: true }, { label: 'Share', num: true }],
      rows.map((i) => ({ cells: [
        `<b>${custEsc(i.name)}</b>${i.sku ? `<small>${custEsc(i.sku)}</small>` : ''}`,
        Math.round(i.qty * 1000) / 1000, i.retQty || '—', pkr(i.gross), i.disc ? `−${pkr(i.disc)}` : '—',
        i.retAmount ? `−${pkr(i.retAmount)}` : '—', `<b>${pkr(i.net)}</b>`, rptPct(i.net, totalNet),
      ] })),
      { foot: ['<b>Total</b>', Math.round(rows.reduce((n, i) => n + i.qty, 0) * 1000) / 1000, rows.reduce((n, i) => n + i.retQty, 0) || '—',
        pkr(rows.reduce((n, i) => n + i.gross, 0)), `−${pkr(rows.reduce((n, i) => n + i.disc, 0))}`,
        `−${pkr(rows.reduce((n, i) => n + i.retAmount, 0))}`, `<b>${pkr(rows.reduce((n, i) => n + i.net, 0))}</b>`, ''] }
    )}</div>`;
}

function rptByHour(agg) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    label: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`,
    short: `${h}`,
    total: 0,
    count: 0,
  }));
  agg.sales.forEach((s) => {
    const h = s.at.getHours();
    hours[h].total += s.total;
    hours[h].count += 1;
  });
  return hours;
}

function rptByDay(agg) {
  const [from, to] = [rptState.from, rptState.to];
  const out = [];
  const idx = new Map();
  for (let d = rptStartOfDay(from); d <= to; d.setDate(d.getDate() + 1)) {
    const key = rptDateInput(d);
    idx.set(key, out.length);
    out.push({
      key,
      label: d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }),
      short: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
      total: 0,
      count: 0,
      refunds: 0,
    });
    if (out.length > 400) break;
  }
  agg.sales.forEach((s) => {
    const i = idx.get(rptDateInput(s.at));
    if (i != null) { out[i].total += s.total; out[i].count += 1; }
  });
  agg.returns.forEach((r) => {
    const i = idx.get(rptDateInput(r.at));
    if (i != null) out[i].refunds += r.amount;
  });
  return out;
}

function rptTimeReport(agg) {
  const hours = rptByHour(agg);
  const days = rptByDay(agg);
  const busiest = hours.slice().sort((a, b) => b.total - a.total)[0];
  rptState.csv = [
    ['Date', 'Transactions', 'Sales', 'Refunds', 'Net'],
    ...days.map((d) => [d.key, d.count, d.total, d.refunds, d.total - d.refunds]),
    [], ['Hour', 'Transactions', 'Sales'],
    ...hours.map((h) => [h.label, h.count, h.total]),
  ];
  return `
    <div class="rpt-card"><h4>Sales by hour of day</h4>
      ${rptBarChart(hours.map((h) => ({ label: h.label, short: h.short, value: h.total })), { format: pkr, title: 'Sales by hour' })}
      <p class="cust-hint">${busiest && busiest.total ? `Busiest hour: <b>${busiest.label}</b> with ${pkr(busiest.total)} from ${busiest.count} sale(s).` : 'No sales in this period.'}</p>
    </div>
    <div class="rpt-card"><h4>Daily breakdown</h4>${rptTable(
      [{ label: 'Date' }, { label: 'Transactions', num: true }, { label: 'Sales', num: true }, { label: 'Refunds', num: true }, { label: 'Net', num: true }, { label: 'Avg sale', num: true }],
      days.slice().reverse().map((d) => ({ cells: [d.label, d.count, pkr(d.total), d.refunds ? `−${pkr(d.refunds)}` : '—', `<b>${pkr(d.total - d.refunds)}</b>`, d.count ? pkr(d.total / d.count) : '—'] }))
    )}</div>`;
}

function rptPaymentsReport(agg) {
  const rows = rptTenderTotals(agg);
  const totalNet = rows.reduce((n, r) => n + r.collected - r.refunded, 0);
  rptState.csv = [['Tender', 'Transactions', 'Collected', 'Refunded', 'Net', 'Share %'],
    ...rows.map((r) => [r.group, r.count, r.collected, r.refunded, r.collected - r.refunded, totalNet ? ((r.collected - r.refunded) / totalNet) * 100 : 0])];
  return `
    <div class="rpt-card"><h4>Payment methods</h4>${rptTable(
      [{ label: 'Tender' }, { label: 'Transactions', num: true }, { label: 'Collected', num: true }, { label: 'Refunded', num: true }, { label: 'Net', num: true }, { label: 'Share', num: true }],
      rows.map((r) => ({ cells: [custEsc(r.group), r.count, pkr(r.collected), r.refunded ? `−${pkr(r.refunded)}` : '—', `<b>${pkr(r.collected - r.refunded)}</b>`, rptPct(r.collected - r.refunded, totalNet)] })),
      { foot: ['<b>Total</b>', '', pkr(rows.reduce((n, r) => n + r.collected, 0)), `−${pkr(rows.reduce((n, r) => n + r.refunded, 0))}`, `<b>${pkr(totalNet)}</b>`, ''] }
    )}
    <p class="cust-hint">Cash is shown net of change given. <b>Store Credit</b> and <b>Loyalty Points</b> are redemptions of customer balances, not new money in. <b>On Account</b> is still owed by the customer.</p></div>`;
}

function rptCashiersReport(agg) {
  const map = new Map();
  agg.sales.forEach((s) => {
    if (!map.has(s.cashier)) map.set(s.cashier, { name: s.cashier, count: 0, total: 0, discounts: 0, items: 0, refunds: 0 });
    const r = map.get(s.cashier);
    r.count += 1;
    r.total += s.total;
    r.discounts += s.discount;
    r.items += s.lines.reduce((n, l) => n + l.qty, 0);
  });
  agg.returns.forEach((ret) => {
    const name = ret.cashier || 'Not recorded';
    if (!map.has(name)) map.set(name, { name, count: 0, total: 0, discounts: 0, items: 0, refunds: 0 });
    map.get(name).refunds += ret.amount;
  });
  const rows = [...map.values()].sort((a, b) => b.total - a.total);
  rptState.csv = [['Cashier', 'Transactions', 'Sales', 'Avg sale', 'Items', 'Discounts', 'Refunds'],
    ...rows.map((r) => [r.name, r.count, r.total, r.count ? r.total / r.count : 0, r.items, r.discounts, r.refunds])];
  return `<div class="rpt-card"><h4>Sales by cashier</h4>${rptTable(
    [{ label: 'Cashier' }, { label: 'Transactions', num: true }, { label: 'Sales', num: true }, { label: 'Avg sale', num: true }, { label: 'Items', num: true }, { label: 'Discounts', num: true }, { label: 'Refunds', num: true }],
    rows.map((r) => ({ cells: [custEsc(r.name), r.count, `<b>${pkr(r.total)}</b>`, r.count ? pkr(r.total / r.count) : '—', Math.round(r.items * 100) / 100, r.discounts ? `−${pkr(r.discounts)}` : '—', r.refunds ? `−${pkr(r.refunds)}` : '—'] }))
  )}</div>`;
}

function rptCustomersReport(agg, data) {
  const loyalty = window.PosLoyalty ? window.PosLoyalty.get() : { enabled: false };
  const names = new Map((data.customers || []).map((c) => [c.id, c]));
  const spend = new Map();
  agg.sales.forEach((s) => {
    const key = s.customerId || '__walkin';
    if (!spend.has(key)) spend.set(key, { id: s.customerId, name: s.customerId ? (names.get(s.customerId)?.name || s.customerName) : 'Walk-in customers', count: 0, total: 0 });
    const r = spend.get(key);
    r.count += 1;
    r.total += s.total;
  });
  const named = [...spend.values()].filter((r) => r.id);
  const walkin = spend.get('__walkin');
  const top = named.sort((a, b) => b.total - a.total).slice(0, 15);

  const ledger = data.ledger || [];
  const sumWhere = (fn, field) => ledger.filter(fn).reduce((n, e) => n + (Number(e[field]) || 0), 0);
  const ptsEarned = sumWhere((e) => e.kind === 'POINTS' && e.type === 'EARN', 'points');
  const ptsRedeemed = -sumWhere((e) => e.kind === 'POINTS' && e.type === 'REDEEM', 'points');
  const creditIssued = sumWhere((e) => e.kind === 'CREDIT' && e.amount > 0 && e.type !== 'OPENING', 'amount');
  const creditUsed = -sumWhere((e) => e.kind === 'CREDIT' && e.type === 'REDEEM', 'amount');
  const charged = sumWhere((e) => e.kind === 'ACCOUNT' && e.type === 'CHARGE', 'amount');
  const paid = -sumWhere((e) => e.kind === 'ACCOUNT' && e.type === 'PAYMENT', 'amount');

  const bal = data.balances || {};
  const owing = Object.entries(bal)
    .filter(([, b]) => money(b.accountBalance) > 0.009)
    .map(([id, b]) => ({ id, name: names.get(id)?.name || id, phone: names.get(id)?.phone || '', owed: money(b.accountBalance) }))
    .sort((a, b) => b.owed - a.owed);
  const pointsOutstanding = Object.values(bal).reduce((n, b) => n + Math.max(0, money(b.points)), 0);
  const creditOutstanding = Object.values(bal).reduce((n, b) => n + Math.max(0, money(b.storeCredit)), 0);
  const receivables = owing.reduce((n, r) => n + r.owed, 0);
  const namedShare = agg.count ? (named.reduce((n, r) => n + r.count, 0) / agg.count) * 100 : 0;

  rptState.csv = [
    ['Customer', 'Visits', 'Spent'], ...top.map((r) => [r.name, r.count, r.total]),
    [], ['Loyalty & balances', 'Value'],
    ['Points earned (period)', ptsEarned], ['Points redeemed (period)', ptsRedeemed],
    ['Store credit issued (period)', creditIssued], ['Store credit used (period)', creditUsed],
    ['Sold on account (period)', charged], ['Account payments (period)', paid],
    ['Points outstanding (now)', pointsOutstanding], ['Store credit outstanding (now)', creditOutstanding], ['Receivables (now)', receivables],
    [], ['Customer owing', 'Phone', 'Balance due'], ...owing.map((r) => [r.name, r.phone, r.owed]),
  ];

  return `
    <div class="mod-kpis">
      ${rptKpi('Identified sales', `${namedShare.toFixed(0)}%`, '<small>of transactions had a customer</small>')}
      ${rptKpi('Points earned / redeemed', `${Math.round(ptsEarned)} / ${Math.round(ptsRedeemed)}`, loyalty.enabled ? `<small>redeemed worth ${pkr(window.PosLoyalty.pointsValue(ptsRedeemed))}</small>` : '<small>program off</small>')}
      ${rptKpi('Store credit issued / used', `${pkr(creditIssued)} / ${pkr(creditUsed)}`)}
      ${rptKpi('On account sold / paid', `${pkr(charged)} / ${pkr(paid)}`)}
    </div>
    <div class="rpt-grid-2">
      <div class="rpt-card"><h4>Top customers</h4>${rptTable(
        [{ label: 'Customer' }, { label: 'Visits', num: true }, { label: 'Spent', num: true }],
        top.map((r) => ({ cells: [custEsc(r.name), r.count, `<b>${pkr(r.total)}</b>`] })),
        { empty: 'No named-customer sales in this period.' }
      )}${walkin ? `<p class="cust-hint">Walk-in: ${walkin.count} sale(s), ${pkr(walkin.total)}</p>` : ''}</div>
      <div class="rpt-card"><h4>Liabilities &amp; receivables (today)</h4>
        <table class="cust-table rpt-statement"><tbody>
          <tr><td>Loyalty points outstanding</td><td class="num">${Math.round(pointsOutstanding).toLocaleString()} pts${loyalty.enabled ? ` · ${pkr(window.PosLoyalty.pointsValue(pointsOutstanding))}` : ''}</td></tr>
          <tr><td>Store credit owed to customers</td><td class="num">${pkr(creditOutstanding)}</td></tr>
          <tr class="strong"><td>Owed by customers (on account)</td><td class="num">${pkr(receivables)}</td></tr>
        </tbody></table>
        ${rptTable([{ label: 'Customer owing' }, { label: 'Phone' }, { label: 'Balance due', num: true }],
          owing.slice(0, 15).map((r) => ({ cells: [custEsc(r.name), custEsc(r.phone), `<b>${pkr(r.owed)}</b>`] })),
          { empty: 'Nobody owes money.' })}
      </div>
    </div>`;
}

function rptReturnsReport(agg) {
  const byReason = new Map();
  agg.returns.forEach((r) => {
    if (!byReason.has(r.reason)) byReason.set(r.reason, { reason: r.reason, count: 0, amount: 0 });
    const x = byReason.get(r.reason);
    x.count += 1;
    x.amount += r.amount;
  });
  const reasons = [...byReason.values()].sort((a, b) => b.amount - a.amount);
  const grossTotal = agg.sales.reduce((n, s) => n + s.total, 0);
  rptState.csv = [['Date', 'Invoice', 'Customer', 'Reason', 'Refund method', 'Items', 'Amount'],
    ...agg.returns.map((r) => [r.at.toISOString(), r.invoice, r.customerName, r.reason, r.rawMethod, r.items.map((i) => `${i.name} x${i.qty}`).join('; '), r.amount])];
  return `
    <div class="mod-kpis">
      ${rptKpi('Refunds', pkr(agg.refunds), `<small>${agg.returns.length} return(s)</small>`)}
      ${rptKpi('Return rate', rptPct(agg.refunds, grossTotal), '<small>of sales value</small>')}
      ${rptKpi('Units returned', agg.returns.reduce((n, r) => n + r.items.reduce((m, i) => m + i.qty, 0), 0))}
    </div>
    <div class="rpt-grid-2">
      <div class="rpt-card"><h4>By reason</h4>${rptTable(
        [{ label: 'Reason' }, { label: 'Returns', num: true }, { label: 'Amount', num: true }],
        reasons.map((r) => ({ cells: [custEsc(r.reason), r.count, pkr(r.amount)] })), { empty: 'No returns in this period.' }
      )}</div>
      <div class="rpt-card"><h4>By refund method</h4>${rptTable(
        [{ label: 'Method' }, { label: 'Amount', num: true }],
        rptTenderTotals(agg).filter((t) => t.refunded).map((t) => ({ cells: [custEsc(t.group), pkr(t.refunded)] })), { empty: 'No refunds.' }
      )}</div>
    </div>
    <div class="rpt-card"><h4>Returns log</h4>${rptTable(
      [{ label: 'Date' }, { label: 'Invoice' }, { label: 'Customer' }, { label: 'Reason' }, { label: 'Method' }, { label: 'Items' }, { label: 'Amount', num: true }],
      agg.returns.slice().sort((a, b) => b.at - a.at).map((r) => ({ cells: [
        r.at.toLocaleString(), custEsc(r.invoice), custEsc(r.customerName || '—'), custEsc(r.reason), custEsc(r.rawMethod),
        custEsc(r.items.map((i) => `${i.name} ×${i.qty}`).join(', ')), `<b>${pkr(r.amount)}</b>`,
      ] })), { empty: 'No returns in this period.' }
    )}</div>`;
}

async function rptShiftReport() {
  if (!activeShift?.id) {
    rptState.csv = null;
    return '<div class="rpt-card"><p class="cust-hint">Open a shift to see the X-report for the current cash drawer.</p></div>';
  }
  const res = await api.pos.getShiftReport(activeShift.id);
  if (!(res?.success && res.data)) return `<div class="rpt-card"><p class="cust-hint">${custEsc(res?.message || 'Could not load the shift report')}</p></div>`;
  const r = res.data;
  const pay = Object.entries(r.paymentsBreakdown || {}).sort((a, b) => b[1] - a[1]);
  rptState.csv = [['Shift X-report', ''], ['Cashier', r.cashierName], ['Terminal', r.terminalName], ['Opened', r.openedAt],
    ['Opening cash', r.openingCash], ['Cash sales', r.cashSales], ['Cash refunds', -(r.cashRefunds || 0)], ['Paid in', r.cashIn], ['Paid out', -r.cashOut], ['Expected in drawer', r.expectedCash],
    [], ['Sales', r.totalSales], ['Returns', r.returnsTotal], ['Net', r.netSales], ['Receipts', r.salesCount],
    [], ['Tender', 'Amount'], ...pay];
  return `
    <div class="mod-kpis">
      ${rptKpi('Expected cash in drawer', pkr(r.expectedCash))}
      ${rptKpi('Sales this shift', pkr(r.totalSales), `<small>${r.salesCount || 0} receipt(s)</small>`)}
      ${rptKpi('Returns', pkr(r.returnsTotal), `<small>${r.returnsCount || 0} refund(s)</small>`)}
      ${rptKpi('Average sale', pkr(r.avgTicket))}
    </div>
    <div class="rpt-grid-2">
      <div class="rpt-card"><h4>Cash drawer</h4>
        <table class="cust-table rpt-statement"><tbody>
          <tr><td>Opening float</td><td class="num">${pkr(r.openingCash)}</td></tr>
          <tr><td>Cash sales (net of change)</td><td class="num">${pkr(r.cashSales)}</td></tr>
          <tr><td>Cash refunds</td><td class="num neg">−${pkr(r.cashRefunds || 0)}</td></tr>
          <tr><td>Paid in</td><td class="num">${pkr(r.cashIn)}</td></tr>
          <tr><td>Paid out</td><td class="num neg">−${pkr(r.cashOut)}</td></tr>
          <tr class="strong"><td>Expected in drawer</td><td class="num">${pkr(r.expectedCash)}</td></tr>
        </tbody></table>
        <p class="cust-hint">${custEsc(r.cashierName || 'Cashier')} · ${custEsc(r.terminalName || '')} · opened ${r.openedAt ? new Date(r.openedAt).toLocaleString() : '—'}</p>
      </div>
      <div class="rpt-card"><h4>Tenders this shift</h4>${rptTable(
        [{ label: 'Tender' }, { label: 'Amount', num: true }],
        pay.map(([m, a]) => ({ cells: [custEsc(m), pkr(a)] })), { empty: 'No payments yet.' }
      )}</div>
    </div>
    <div class="rpt-card"><h4>Top items this shift</h4>${rptTable(
      [{ label: 'Item' }, { label: 'Qty', num: true }, { label: 'Amount', num: true }],
      (r.topProducts || []).map((p) => ({ cells: [custEsc(p.name), p.qty, pkr(p.amount)] }))
    )}</div>`;
}

// ─── Controller ───────────────────────────────────────────────────────────────
const RPT_TITLES = {
  summary: 'Sales summary',
  items: 'Sales by item',
  time: 'Sales by time',
  payments: 'Payment methods',
  cashiers: 'Sales by cashier',
  customers: 'Customers & loyalty',
  returns: 'Returns & refunds',
  shift: 'Shift X-report',
};

async function loadReportsTab() {
  const [from, to] = rptRangeFor(rptState.preset);
  rptState.from = from;
  rptState.to = to;
  const span = to.getTime() - from.getTime() + 1;
  const prevFrom = new Date(from.getTime() - span);
  const prevTo = new Date(from.getTime() - 1);
  const rangeEl = document.getElementById('rpt-range');
  if (rangeEl) {
    const same = rptDateInput(from) === rptDateInput(to);
    rangeEl.textContent = same ? rptFmtDate(from) : `${rptFmtDate(from)} – ${rptFmtDate(to)}`;
  }
  const body = document.getElementById('rpt-body');
  if (body && !rptState.data) body.innerHTML = '<div class="cust-empty">Loading report…</div>';
  const [cur, prev] = await Promise.all([
    api.reports.getData({ from: from.toISOString(), to: to.toISOString() }),
    api.reports.getData({ from: prevFrom.toISOString(), to: prevTo.toISOString() }),
  ]);
  if (!cur?.success) {
    if (body) body.innerHTML = `<div class="cust-empty">${custEsc(cur?.message || 'Could not load report data')}</div>`;
    return;
  }
  rptState.data = cur.data;
  rptState.prev = prev?.success ? prev.data : null;
  await renderReport();
}

async function renderReport() {
  const body = document.getElementById('rpt-body');
  if (!body || !rptState.data) return;
  const agg = rptAggregate(rptState.data);
  const prevAgg = rptState.prev ? rptAggregate(rptState.prev) : null;
  rptState.title = RPT_TITLES[rptState.report] || 'Report';
  let html;
  switch (rptState.report) {
    case 'items': html = rptItemsReport(agg); break;
    case 'time': html = rptTimeReport(agg); break;
    case 'payments': html = rptPaymentsReport(agg); break;
    case 'cashiers': html = rptCashiersReport(agg); break;
    case 'customers': html = rptCustomersReport(agg, rptState.data); break;
    case 'returns': html = rptReturnsReport(agg); break;
    case 'shift': html = await rptShiftReport(); break;
    default: html = rptSummary(agg, prevAgg);
  }
  body.innerHTML = `<h3 class="rpt-title">${custEsc(rptState.title)}</h3>${html}`;
  const search = document.getElementById('rpt-item-search');
  if (search) {
    search.addEventListener('input', () => {
      rptState.itemQuery = search.value;
      const pos = search.selectionStart;
      renderReport().then(() => {
        const again = document.getElementById('rpt-item-search');
        again?.focus();
        try { again?.setSelectionRange(pos, pos); } catch { /* ignore */ }
      });
    });
  }
}

function rptCsvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportReportCsv() {
  if (!rptState.csv) {
    showToast('Nothing to export for this report', 'error');
    return;
  }
  const csv = rptState.csv.map((row) => row.map(rptCsvCell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${rptState.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${rptDateInput(rptState.from)}_${rptDateInput(rptState.to)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function printReport() {
  const body = document.getElementById('rpt-body');
  if (!body) return;
  const clone = body.cloneNode(true);
  clone.querySelectorAll('input, .rpt-toolbar').forEach((el) => el.remove());
  const range = document.getElementById('rpt-range')?.textContent || '';
  printHtmlDocument(`${rptState.title} — ${range}`, `
    <style>
      .mod-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0;}
      .kpi{border:1px solid #e2e8f0;border-radius:6px;padding:8px;} .kpi span{display:block;color:#64748b;font-size:11px;}
      .kpi b{display:block;font-size:15px;} .kpi small{color:#64748b;font-size:10px;}
      .rpt-card{margin-top:12px;break-inside:avoid;} .rpt-card h4{margin:0 0 4px;font-size:13px;}
      .rpt-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
      .rpt-chart{width:100%;height:150px;} .rpt-bar{fill:#014582;} .rpt-axis{font-size:10px;fill:#64748b;text-anchor:middle;} .rpt-baseline{stroke:#cbd5e1;}
      .strong td{font-weight:700;border-top:1px solid #94a3b8;} small{display:block;color:#64748b;} .neg{color:#b91c1c;}
      .cust-hint{color:#64748b;font-size:11px;} .rpt-title{display:none;}
    </style>
    <h1>${custEsc(custCompanyName())}</h1>
    <div class="muted">${custEsc(rptState.title)} · ${custEsc(range)} · printed ${new Date().toLocaleString()}</div>
    ${clone.innerHTML}`);
}

(function wireReportsTab() {
  document.querySelectorAll('#rpt-presets [data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    rptState.preset = btn.dataset.preset;
    document.querySelectorAll('#rpt-presets [data-preset]').forEach((b) => b.classList.toggle('active', b === btn));
    const custom = document.getElementById('rpt-custom');
    if (custom) custom.classList.toggle('open', rptState.preset === 'custom');
    if (rptState.preset === 'custom') {
      const from = document.getElementById('rpt-from');
      const to = document.getElementById('rpt-to');
      if (from && !from.value) from.value = rptDateInput(rptState.from || new Date());
      if (to && !to.value) to.value = rptDateInput(rptState.to || new Date());
      return;
    }
    loadReportsTab();
  }));
  document.getElementById('rpt-apply')?.addEventListener('click', loadReportsTab);
  document.querySelectorAll('#rpt-nav [data-report]').forEach((btn) => btn.addEventListener('click', () => {
    rptState.report = btn.dataset.report;
    document.querySelectorAll('#rpt-nav [data-report]').forEach((b) => b.classList.toggle('active', b === btn));
    renderReport();
  }));
  document.getElementById('rpt-btn-refresh')?.addEventListener('click', loadReportsTab);
  document.getElementById('rpt-btn-csv')?.addEventListener('click', exportReportCsv);
  document.getElementById('rpt-btn-print')?.addEventListener('click', printReport);
})();
