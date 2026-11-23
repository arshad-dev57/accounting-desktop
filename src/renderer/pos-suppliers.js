/* global window, document, api, showToast, escapeHtmlAttr */
/* Suppliers tab: directory matching web warehouse suppliers, offline-first
   with push/pull via Sync. Loaded after sell.js. */

'use strict';

const suppState = {
  rows: [],
  filter: 'all',
  query: '',
  editing: null,
  mode: 'list', // list | form | detail
};

function suppEsc(v) {
  return escapeHtmlAttr(v == null ? '' : v).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function suppVal(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

async function refreshLocalSuppliersCache() {
  if (typeof window.refreshLocalSuppliers === 'function') {
    await window.refreshLocalSuppliers();
    return;
  }
  try {
    const res = await api.catalog.listSuppliers();
    if (typeof localSuppliers !== 'undefined') {
      // classic script shared scope with sell.js
      localSuppliers = Array.isArray(res?.data) ? res.data : [];
    }
  } catch (err) {
    console.warn('[suppliers] cache refresh failed', err);
  }
}

async function loadSuppliersTab() {
  const body = document.getElementById('supp-table-body');
  if (body && !suppState.rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="cust-empty">Loading suppliers…</td></tr>';
  }
  showSuppList();
  const res = await api.catalog.listSuppliers({ includeInactive: true });
  if (!res?.success) {
    if (body) {
      body.innerHTML = `<tr><td colspan="7" class="cust-empty">${suppEsc(res?.message || 'Could not load suppliers')}</td></tr>`;
    }
    return;
  }
  suppState.rows = res.data || [];
  renderSuppKpis();
  renderSuppTable();
  await refreshLocalSuppliersCache();
}

function renderSuppKpis() {
  const el = document.getElementById('supp-kpis');
  if (!el) return;
  const rows = suppState.rows;
  const active = rows.filter((r) => r.status !== 'inactive' && r.isActive !== false).length;
  const inactive = rows.length - active;
  const pending = rows.filter((r) => r.syncStatus && r.syncStatus !== 'SYNCED').length;
  el.innerHTML = `
    <div class="kpi"><span>Total Suppliers</span><b>${rows.length}</b></div>
    <div class="kpi"><span>Active</span><b class="pos">${active}</b></div>
    <div class="kpi"><span>Inactive</span><b class="${inactive ? 'neg' : ''}">${inactive}</b></div>
    <div class="kpi"><span>Pending sync</span><b>${pending}</b><small>uploads on Push / Sync</small></div>`;
}

function filteredSuppliers() {
  const q = suppState.query.trim().toLowerCase();
  return suppState.rows.filter((r) => {
    const status = r.status === 'inactive' || r.isActive === false ? 'inactive' : 'active';
    if (suppState.filter === 'active' && status !== 'active') return false;
    if (suppState.filter === 'inactive' && status !== 'inactive') return false;
    if (!q) return true;
    const hay = [r.name, r.companyName, r.phone, r.email, r.city, r.code, r.contactPerson]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    return hay.includes(q);
  });
}

function renderSuppTable() {
  const body = document.getElementById('supp-table-body');
  const count = document.getElementById('supp-count');
  if (!body) return;
  const rows = filteredSuppliers();
  if (count) count.textContent = `${rows.length} of ${suppState.rows.length}`;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="cust-empty">${
      suppState.rows.length
        ? 'No suppliers match this filter.'
        : 'No suppliers yet. Click “Add Supplier” or Pull from cloud.'
    }</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const id = r.id || r._id;
    const status = r.status === 'inactive' || r.isActive === false ? 'inactive' : 'active';
    const syncBadge = r.syncStatus && r.syncStatus !== 'SYNCED'
      ? `<span class="supp-sync-badge" title="Not yet uploaded">${suppEsc(r.syncStatus)}</span>`
      : '';
    return `
      <tr data-id="${suppEsc(id)}">
        <td>
          <div class="cust-name-cell">
            <span class="cust-avatar">${suppEsc(String(r.name || '?').slice(0, 1).toUpperCase())}</span>
            <div>
              <b>${suppEsc(r.name)}</b>
              <small>${suppEsc(r.code || r.contactPerson || '')}${syncBadge ? ' ' + syncBadge : ''}</small>
            </div>
          </div>
        </td>
        <td>${suppEsc(r.companyName || '—')}</td>
        <td>${suppEsc(r.phone || '—')}</td>
        <td>${suppEsc(r.email || '—')}</td>
        <td>${suppEsc(r.city || '—')}</td>
        <td><span class="supp-status ${status}">${status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td class="supp-actions">
          <button type="button" class="icon-btn" data-supp-view="${suppEsc(id)}" title="View">👁</button>
          <button type="button" class="icon-btn" data-supp-edit="${suppEsc(id)}" title="Edit">✎</button>
          <button type="button" class="icon-btn del" data-supp-del="${suppEsc(id)}" title="Delete">🗑</button>
        </td>
      </tr>`;
  }).join('');
}

function showSuppList() {
  suppState.mode = 'list';
  suppState.editing = null;
  document.getElementById('supp-list-layout')?.classList.remove('hidden');
  document.getElementById('supp-kpis')?.classList.remove('hidden');
  const form = document.getElementById('supp-form-wrap');
  if (form) {
    form.classList.add('hidden');
    form.innerHTML = '';
  }
  closeSuppDetail();
}

function openSuppForm(supplier) {
  suppState.mode = 'form';
  suppState.editing = supplier || null;
  document.getElementById('supp-list-layout')?.classList.add('hidden');
  document.getElementById('supp-kpis')?.classList.add('hidden');
  closeSuppDetail();
  const wrap = document.getElementById('supp-form-wrap');
  if (!wrap) return;
  const s = supplier || {};
  const isEdit = !!(s.id || s._id);
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="supp-form-card">
      <div class="supp-form-head">
        <h3>${isEdit ? 'Edit Supplier' : 'Add New Supplier'}</h3>
        <button type="button" class="icon-btn" id="supp-form-close" title="Close">✕</button>
      </div>
      <div id="supp-form-error" class="supp-form-error hidden"></div>
      <form id="supp-form" class="supp-form-grid">
        <div class="supp-field">
          <label>Supplier Name *</label>
          <input id="sf-name" required value="${suppEsc(s.name || '')}" placeholder="e.g., ABC Textiles" />
        </div>
        <div class="supp-field">
          <label>Company Name</label>
          <input id="sf-companyName" value="${suppEsc(s.companyName || '')}" placeholder="e.g., ABC Textiles Pvt Ltd" />
        </div>
        <div class="supp-field">
          <label>Supplier Code</label>
          <input id="sf-code" value="${suppEsc(s.code || '')}" placeholder="Auto-generated on cloud if empty" />
        </div>
        <div class="supp-field">
          <label>Status</label>
          <select id="sf-status">
            <option value="active" ${s.status !== 'inactive' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${s.status === 'inactive' ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        <div class="supp-field">
          <label>Contact Person</label>
          <input id="sf-contactPerson" value="${suppEsc(s.contactPerson || '')}" placeholder="Full name" />
        </div>
        <div class="supp-field">
          <label>Department</label>
          <input id="sf-department" value="${suppEsc(s.department || '')}" placeholder="e.g., Sales, Procurement" />
        </div>
        <div class="supp-field">
          <label>Phone</label>
          <input id="sf-phone" value="${suppEsc(s.phone || '')}" placeholder="+92 300 1234567" />
        </div>
        <div class="supp-field">
          <label>Email</label>
          <input id="sf-email" type="email" value="${suppEsc(s.email || '')}" placeholder="info@company.com" />
        </div>
        <div class="supp-field supp-field-full">
          <label>Address</label>
          <textarea id="sf-address" rows="2" placeholder="Street address…">${suppEsc(s.address || '')}</textarea>
        </div>
        <div class="supp-field">
          <label>City</label>
          <input id="sf-city" value="${suppEsc(s.city || '')}" placeholder="City" />
        </div>
        <div class="supp-field">
          <label>Country</label>
          <input id="sf-country" value="${suppEsc(s.country || 'Pakistan')}" placeholder="Country" />
        </div>
        <div class="supp-field">
          <label>Industry</label>
          <input id="sf-industry" value="${suppEsc(s.industry || '')}" placeholder="e.g., Textile, Electronics" />
        </div>
        <div class="supp-field">
          <label>Business Type</label>
          <select id="sf-businessType">
            <option value="">Select…</option>
            ${['Sole Proprietorship', 'Partnership', 'Private Limited', 'Public Limited', 'LLC'].map((opt) =>
              `<option value="${opt}" ${s.businessType === opt ? 'selected' : ''}>${opt}</option>`
            ).join('')}
          </select>
        </div>
        <div class="supp-field">
          <label>Payment Terms</label>
          <input id="sf-paymentTerms" value="${suppEsc(s.paymentTerms || 'Net 30')}" placeholder="e.g., Net 30" />
        </div>
        <div class="supp-form-actions">
          <button type="button" class="btn-nav-action ghost" id="supp-form-cancel">Cancel</button>
          <button type="submit" class="btn-nav-action" id="supp-form-save">${isEdit ? 'Update Supplier' : 'Save Supplier'}</button>
        </div>
      </form>
    </div>`;

  document.getElementById('supp-form-close')?.addEventListener('click', showSuppList);
  document.getElementById('supp-form-cancel')?.addEventListener('click', showSuppList);
  document.getElementById('supp-form')?.addEventListener('submit', onSuppFormSubmit);
}

async function onSuppFormSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('supp-form-error');
  const name = suppVal('sf-name');
  if (!name) {
    if (errEl) {
      errEl.textContent = 'Supplier name is required';
      errEl.classList.remove('hidden');
    }
    return;
  }
  const payload = {
    id: suppState.editing?.id || suppState.editing?._id || undefined,
    name,
    companyName: suppVal('sf-companyName'),
    code: suppVal('sf-code'),
    status: document.getElementById('sf-status')?.value || 'active',
    contactPerson: suppVal('sf-contactPerson'),
    department: suppVal('sf-department'),
    phone: suppVal('sf-phone'),
    email: suppVal('sf-email'),
    address: suppVal('sf-address'),
    city: suppVal('sf-city'),
    country: suppVal('sf-country') || 'Pakistan',
    industry: suppVal('sf-industry'),
    businessType: document.getElementById('sf-businessType')?.value || '',
    paymentTerms: suppVal('sf-paymentTerms') || 'Net 30',
  };

  const saveBtn = document.getElementById('supp-form-save');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }
  try {
    const res = await api.catalog.saveSupplier(payload);
    if (!res?.success) {
      if (errEl) {
        errEl.textContent = res?.message || 'Failed to save supplier';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (typeof showToast === 'function') showToast('Supplier saved — will upload on Sync', 'success');
    await refreshLocalSuppliersCache();
    await loadSuppliersTab();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Failed to save supplier';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = payload.id ? 'Update Supplier' : 'Save Supplier';
    }
  }
}

function findSupplier(id) {
  return suppState.rows.find((r) => String(r.id || r._id) === String(id));
}

function openSuppDetail(id) {
  const s = findSupplier(id);
  const modal = document.getElementById('supp-detail-modal');
  if (!s || !modal) return;
  const status = s.status === 'inactive' || s.isActive === false ? 'Inactive' : 'Active';
  const rows = [
    ['Supplier Name', s.name],
    ['Company Name', s.companyName],
    ['Code', s.code],
    ['Status', status],
    ['Contact Person', s.contactPerson],
    ['Department', s.department],
    ['Phone', s.phone],
    ['Email', s.email],
    ['Address', s.address],
    ['City', s.city],
    ['Country', s.country],
    ['Industry', s.industry],
    ['Business Type', s.businessType],
    ['Payment Terms', s.paymentTerms],
    ['Sync', s.syncStatus || 'SYNCED'],
  ];
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  modal.innerHTML = `
    <div class="supp-modal-backdrop" data-supp-close></div>
    <div class="supp-modal-card" role="dialog">
      <div class="supp-form-head">
        <h3>Supplier Details</h3>
        <button type="button" class="icon-btn" data-supp-close title="Close">✕</button>
      </div>
      <div class="supp-detail-grid">
        ${rows.map(([label, value]) => `
          <div>
            <p class="supp-detail-label">${suppEsc(label)}</p>
            <p class="supp-detail-value">${suppEsc(value || '—')}</p>
          </div>`).join('')}
      </div>
      <div class="supp-form-actions">
        <button type="button" class="btn-nav-action ghost" data-supp-close>Close</button>
        <button type="button" class="btn-nav-action" id="supp-detail-edit">Edit</button>
      </div>
    </div>`;
  modal.querySelectorAll('[data-supp-close]').forEach((el) => {
    el.addEventListener('click', closeSuppDetail);
  });
  document.getElementById('supp-detail-edit')?.addEventListener('click', () => {
    closeSuppDetail();
    openSuppForm(s);
  });
}

function closeSuppDetail() {
  const modal = document.getElementById('supp-detail-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = '';
}

async function deleteSupp(id) {
  const s = findSupplier(id);
  if (!s) return;
  if (!window.confirm(`Delete supplier “${s.name}”? It will be removed on the next cloud sync.`)) return;
  const res = await api.catalog.deleteSupplier(id);
  if (!res?.success) {
    if (typeof showToast === 'function') showToast(res?.message || 'Delete failed', 'error');
    return;
  }
  if (typeof showToast === 'function') showToast('Supplier deleted locally — will sync on Push', 'success');
  await refreshLocalSuppliersCache();
  await loadSuppliersTab();
}

function setupSuppliersTab() {
  document.getElementById('supp-btn-refresh')?.addEventListener('click', loadSuppliersTab);
  document.getElementById('supp-btn-new')?.addEventListener('click', () => openSuppForm(null));
  document.querySelector('.tab-btn[data-tab="suppliers"]')?.addEventListener('click', loadSuppliersTab);

  document.getElementById('supp-search')?.addEventListener('input', (e) => {
    suppState.query = e.target.value || '';
    renderSuppTable();
  });

  document.getElementById('supp-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    suppState.filter = btn.getAttribute('data-filter') || 'all';
    document.querySelectorAll('#supp-filters .chip').forEach((c) => {
      c.classList.toggle('active', c === btn);
    });
    renderSuppTable();
  });

  document.getElementById('supp-table-body')?.addEventListener('click', (e) => {
    const view = e.target.closest('[data-supp-view]');
    const edit = e.target.closest('[data-supp-edit]');
    const del = e.target.closest('[data-supp-del]');
    if (view) {
      openSuppDetail(view.getAttribute('data-supp-view'));
      return;
    }
    if (edit) {
      const s = findSupplier(edit.getAttribute('data-supp-edit'));
      if (s) openSuppForm(s);
      return;
    }
    if (del) {
      void deleteSupp(del.getAttribute('data-supp-del'));
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupSuppliersTab);
} else {
  setupSuppliersTab();
}

window.PosSuppliers = {
  load: loadSuppliersTab,
  refreshCache: refreshLocalSuppliersCache,
};
