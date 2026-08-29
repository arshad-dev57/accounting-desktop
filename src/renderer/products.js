'use strict';

const api = window.bisonDesktop;

// Global error handler
window.addEventListener('error', (e) => {
  console.error('[PRODUCTS PAGE ERROR]', e.message, e.filename, e.lineno);
  const tableWrap = document.getElementById('table-wrap');
  if (tableWrap) {
    tableWrap.innerHTML = `<div class="empty" style="color: #b91c1c;">Error: ${e.message}<br>Line: ${e.lineno}</div>`;
  }
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[PRODUCTS UNHANDLED REJECTION]', e.reason);
  const tableWrap = document.getElementById('table-wrap');
  if (tableWrap) {
    tableWrap.innerHTML = `<div class="empty" style="color: #b91c1c;">Error: ${e.reason}</div>`;
  }
});

let products = [];
let categories = [];
let suppliers = [];
let settingsData = {};
let editing = null;
let currentFormTab = 'basic';

const tableWrap = document.getElementById('table-wrap');
const searchInp = document.getElementById('search');
const overlay = document.getElementById('overlay');
const modalBody = document.getElementById('modal-body');
const formContainer = document.getElementById('form-container');
const formError = document.getElementById('form-error');
const btnAdd = document.getElementById('btn-add');
const btnScan = document.getElementById('btn-scan');

function q() {
  return (searchInp.value || '').trim().toLowerCase();
}

function render() {
  const rows = products.filter((p) =>
    `${p.name} ${p.sku} ${p.barcodeNumber || p.barcode}`.toLowerCase().includes(q())
  );
  if (!rows.length) {
    tableWrap.innerHTML = '<div class="empty">No products found</div>';
    return;
  }
  tableWrap.innerHTML = `<table>
    <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Supplier</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead>
    <tbody>${rows.map((p) => `<tr>
      <td style="font-family:monospace;font-size:12px;">${p.sku || '—'}</td>
      <td><b>${p.name || '—'}</b></td>
      <td>${p.categoryName || '—'}</td>
      <td>${p.supplierName || '—'}</td>
      <td>${Number(p.sellingPrice || 0).toFixed(2)}</td>
      <td>${Number(p.currentStock || 0).toLocaleString()}</td>
      <td>
        <button class="icon-btn" data-edit="${p.id || p._id}">✎</button>
        <button class="icon-btn" data-del="${p.id || p._id}">🗑</button>
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function loadSettings() {
  try {
    const res = await api.catalog.list();
    const catalog = res?.data || [];
    categories = Array.isArray(catalog) ? catalog : [];

    try {
      const suppliersRes = await api.catalog.listSuppliers();
      suppliers = Array.isArray(suppliersRes?.data) ? suppliersRes.data : [];
    } catch (err) {
      console.error('Failed to load suppliers', err);
      suppliers = [];
    }

    settingsData = {
      productType: [{ _id: '1', name: 'Raw Material' }, { _id: '2', name: 'Finished Good' }, { _id: '3', name: 'Service' }],
      stockUnit: [{ _id: '1', name: 'Pcs' }, { _id: '2', name: 'KG' }, { _id: '3', name: 'Meter' }, { _id: '4', name: 'Box' }],
      weightUnit: [{ _id: '1', name: 'KG' }, { _id: '2', name: 'LB' }, { _id: '3', name: 'Gram' }],
      dimensionUnit: [{ _id: '1', name: 'cm' }, { _id: '2', name: 'inch' }, { _id: '3', name: 'mm' }],
      size: [{ _id: '1', name: 'S' }, { _id: '2', name: 'M' }, { _id: '3', name: 'L' }, { _id: '4', name: 'XL' }],
      shippingClass: [{ _id: '1', name: 'Standard' }, { _id: '2', name: 'Express' }, { _id: '3', name: 'Heavy' }],
      taxType: [{ _id: '1', name: 'Exclusive' }, { _id: '2', name: 'Inclusive' }],
      rackLocation: [{ _id: '1', name: 'A1' }, { _id: '2', name: 'A2' }, { _id: '3', name: 'B1' }],
      zone: [{ _id: '1', name: 'Zone A' }, { _id: '2', name: 'Zone B' }, { _id: '3', name: 'Zone C' }],
      storageCondition: [{ _id: '1', name: 'Ambient' }, { _id: '2', name: 'Cold' }, { _id: '3', name: 'Frozen' }],
    };
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function catId(item) {
  return String(item?._id || item?.id || '');
}

function getSubCategories(categoryId) {
  const cat = categories.find(c => catId(c) === String(categoryId || ''));
  return cat?.subCategories || cat?.children || [];
}

function resolveParentCategoryId(product) {
  const raw = String(product?.categoryId || product?.category || '');
  if (!raw) return '';
  if (categories.some((c) => catId(c) === raw)) return raw;
  for (const c of categories) {
    const subs = c.subCategories || c.children || [];
    if (subs.some((s) => catId(s) === raw)) return catId(c);
  }
  return raw;
}

function fillCategorySelects(selectedCat, selectedSub) {
  const catSel = document.getElementById('f-category');
  const subSel = document.getElementById('f-subcategory');
  if (!catSel || !subSel) return;
  const catValue = selectedCat || '';
  const subValue = selectedSub || '';
  catSel.innerHTML = '<option value="">Select category...</option>' +
    categories.map((c) =>
      `<option value="${catId(c)}" ${catId(c) === catValue ? 'selected' : ''}>${escapeAttr(c.name)}</option>`
    ).join('');
  const subs = getSubCategories(catSel.value);
  subSel.innerHTML = '<option value="">Select sub-category...</option>' +
    subs.map((s) =>
      `<option value="${catId(s)}" ${catId(s) === subValue ? 'selected' : ''}>${escapeAttr(s.name)}</option>`
    ).join('');
  const addSubBtn = document.getElementById('btn-add-subcategory');
  if (addSubBtn) addSubBtn.disabled = !catSel.value;
}

async function reloadCategories() {
  const res = await api.catalog.list();
  categories = Array.isArray(res?.data) ? res.data : [];
}

let quickAddKind = 'category';

function openQuickAdd(kind) {
  const parentId = document.getElementById('f-category')?.value || '';
  if (kind === 'subcategory' && !parentId) {
    formError.textContent = 'Select a category first';
    return;
  }
  quickAddKind = kind;
  formError.textContent = '';
  document.getElementById('quick-add-title').textContent =
    kind === 'subcategory' ? 'Add sub-category' : 'Add category';
  document.getElementById('quick-add-name').value = '';
  document.getElementById('quick-add-error').textContent = '';
  document.getElementById('quick-add-overlay').classList.add('show');
  setTimeout(() => document.getElementById('quick-add-name').focus(), 30);
}

function closeQuickAdd() {
  document.getElementById('quick-add-overlay')?.classList.remove('show');
}

async function saveQuickAdd() {
  const name = document.getElementById('quick-add-name').value.trim();
  const errEl = document.getElementById('quick-add-error');
  if (!name) {
    errEl.textContent = 'Name is required';
    return;
  }
  const parentId = document.getElementById('f-category')?.value || '';
  if (quickAddKind === 'subcategory' && !parentId) {
    errEl.textContent = 'Select a category first';
    return;
  }
  errEl.textContent = '';
  const saveBtn = document.getElementById('quick-add-save');
  saveBtn.disabled = true;
  try {
    const res = quickAddKind === 'subcategory'
      ? await api.catalog.saveSubcategory({ name, categoryId: parentId })
      : await api.catalog.saveCategory({ name });
    if (!res?.success) {
      errEl.textContent = res?.message || 'Save failed';
      return;
    }
    const createdId = String(res?.data?.id || res?.data?._id || '');
    await reloadCategories();
    if (quickAddKind === 'category') fillCategorySelects(createdId, '');
    else fillCategorySelects(parentId, createdId);
    closeQuickAdd();
  } catch (err) {
    errEl.textContent = err.message || 'Save failed';
  } finally {
    saveBtn.disabled = false;
  }
}

function bindCategoryQuickAdd() {
  document.getElementById('btn-add-category')?.addEventListener('click', () => openQuickAdd('category'));
  document.getElementById('btn-add-subcategory')?.addEventListener('click', () => openQuickAdd('subcategory'));
  document.getElementById('f-category')?.addEventListener('change', () => {
    fillCategorySelects(document.getElementById('f-category').value, '');
  });
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function generateLocalSku() {
  const name = document.getElementById('f-name')?.value.trim() || 'PRD';
  const prefix = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'PRD';
  return `${prefix}-${Date.now().toString().slice(-6)}`;
}

function ensureSkuValue() {
  const skuEl = document.getElementById('f-sku');
  let sku = skuEl?.value.trim() || '';
  if (!sku) {
    sku = generateLocalSku();
    if (skuEl) skuEl.value = sku;
  }
  return sku;
}

function codeTaken(kind, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return false;
  const selfId = String(editing?.id || editing?._id || '');
  return products.some((p) => {
    if (selfId && String(p.id || p._id || '') === selfId) return false;
    const val = kind === 'barcode'
      ? String(p.barcodeNumber || p.barcode || '')
      : String(p.qrCode || p.qr_code || '');
    return val.trim().toLowerCase() === needle;
  });
}

function uniqueFromSku(kind) {
  const sku = ensureSkuValue();
  let code = sku;
  let n = 1;
  while (codeTaken(kind, code)) {
    n += 1;
    code = `${sku}-${n}`;
  }
  return code;
}

function codePreviewHtml(value, emptyText) {
  if (!value) return `<span>${emptyText}</span>`;
  return `<b>${escapeAttr(value)}</b><span>Ready for POS / sales scanning</span>`;
}

function refreshCodePreviews() {
  const barcode = document.getElementById('f-barcode')?.value.trim() || '';
  const qr = document.getElementById('f-qr-code')?.value.trim() || '';
  const sku = document.getElementById('f-sku')?.value.trim() || '';
  const barcodePreview = document.getElementById('barcode-live-preview');
  const qrPreview = document.getElementById('qr-live-preview');
  if (barcodePreview) {
    barcodePreview.innerHTML = codePreviewHtml(barcode, 'Scan a barcode or auto-generate from SKU');
  }
  if (qrPreview) {
    qrPreview.innerHTML = codePreviewHtml(qr, 'Scan a QR or auto-generate from SKU');
  }
  const barcodeDisplay = document.getElementById('barcode-display');
  if (barcodeDisplay) {
    barcodeDisplay.innerHTML = barcode || sku
      ? `<div style="font-family: monospace; font-size: 24px; font-weight: 700; color: #1a1a1a; letter-spacing: 2px;">${escapeAttr(barcode || sku)}</div><div style="margin-top: 8px; font-size: 12px; color: #6b7280;">CODE128</div>`
      : '<div style="color: #9ca3af; font-size: 14px;">No barcode assigned</div>';
  }
  const qrDisplay = document.getElementById('qr-display');
  if (qrDisplay) {
    qrDisplay.innerHTML = qr
      ? `<div style="font-family: monospace; font-size: 20px; font-weight: 700; color: #1a1a1a; letter-spacing: 1px;">${escapeAttr(qr)}</div><div style="margin-top: 8px; font-size: 12px; color: #6b7280;">QR Code</div>`
      : '<div style="color: #9ca3af; font-size: 14px;">No QR code assigned</div>';
  }
}

function setCodeField(kind, value) {
  const code = window.normalizeScanCode ? window.normalizeScanCode(value) : String(value || '').trim();
  const input = document.getElementById(kind === 'barcode' ? 'f-barcode' : 'f-qr-code');
  if (input) input.value = code;
  if (kind === 'qr') {
    editing = editing || {};
    editing.qrCode = code;
  }
  refreshCodePreviews();
  if (code && codeTaken(kind, code)) {
    formError.textContent = `This ${kind === 'barcode' ? 'barcode' : 'QR'} is already used by another product.`;
  } else if (/already used/.test(formError.textContent || '')) {
    formError.textContent = '';
  }
}

function scanInto(kind) {
  if (typeof window.openCodeScanner !== 'function') {
    const code = prompt(kind === 'barcode' ? 'Scan or enter barcode:' : 'Scan or enter QR / barcode:');
    if (code) setCodeField(kind, code);
    return;
  }
  window.openCodeScanner({
    title: kind === 'barcode' ? 'Scan barcode' : 'Scan QR / barcode',
    onScan: (code) => setCodeField(kind, code),
  });
}

function autoGenerate(kind) {
  setCodeField(kind, uniqueFromSku(kind));
}

function switchFormTab(tab) {
  currentFormTab = tab;
  document.querySelectorAll('.form-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.form-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
  refreshCodePreviews();
}

function bindCodeActions() {
  document.getElementById('btn-scan-barcode-basic')?.addEventListener('click', () => scanInto('barcode'));
  document.getElementById('btn-auto-barcode')?.addEventListener('click', () => autoGenerate('barcode'));
  document.getElementById('btn-scan-qr-basic')?.addEventListener('click', () => scanInto('qr'));
  document.getElementById('btn-auto-qr')?.addEventListener('click', () => autoGenerate('qr'));
  document.getElementById('f-barcode')?.addEventListener('input', refreshCodePreviews);
  document.getElementById('f-qr-code')?.addEventListener('input', refreshCodePreviews);
  document.getElementById('btn-scan-barcode')?.addEventListener('click', () => scanInto('barcode'));
  document.getElementById('btn-auto-barcode-tab')?.addEventListener('click', () => autoGenerate('barcode'));
  document.getElementById('btn-scan-qr-tab')?.addEventListener('click', () => scanInto('qr'));
  document.getElementById('btn-auto-qr-tab')?.addEventListener('click', () => autoGenerate('qr'));
}

function renderForm() {
  const selectedCat = resolveParentCategoryId(editing);
  const selectedSub = String(editing?.subcategoryId || editing?.subCategoryId || editing?.subCategory || '');
  const subCategories = selectedCat ? getSubCategories(selectedCat) : [];
  const barcodeValue = editing?.barcodeNumber || editing?.barcode || '';
  const qrValue = editing?.qrCode || editing?.qr_code || '';

  formContainer.innerHTML = `
    <h3>${editing ? 'Edit Product' : 'Add Product'}</h3>
    
    <div class="form-tabs">
      <button class="form-tab ${currentFormTab === 'basic' ? 'active' : ''}" data-tab="basic">Basic Info</button>
      <button class="form-tab ${currentFormTab === 'pricing' ? 'active' : ''}" data-tab="pricing">Pricing & Stock</button>
      <button class="form-tab ${currentFormTab === 'category' ? 'active' : ''}" data-tab="category">Category & Supplier</button>
      <button class="form-tab ${currentFormTab === 'warehouse' ? 'active' : ''}" data-tab="warehouse">Warehouse</button>
      <button class="form-tab ${currentFormTab === 'physical' ? 'active' : ''}" data-tab="physical">Physical</button>
      <button class="form-tab ${currentFormTab === 'expiry' ? 'active' : ''}" data-tab="expiry">Expiry & Batch</button>
      <button class="form-tab ${currentFormTab === 'shipping' ? 'active' : ''}" data-tab="shipping">Shipping</button>
      <button class="form-tab ${currentFormTab === 'barcode' ? 'active' : ''}" data-tab="barcode">Barcode</button>
      <button class="form-tab ${currentFormTab === 'custom' ? 'active' : ''}" data-tab="custom">Custom</button>
    </div>
    
    <form id="product-form">
      <!-- Basic Info Tab -->
      <div class="form-panel ${currentFormTab === 'basic' ? 'active' : ''}" data-panel="basic">
        <div class="form-grid">
          <div class="field">
            <label>Product Name *</label>
            <input type="text" id="f-name" value="${escapeAttr(editing?.name || '')}" required />
          </div>
          <div class="field">
            <label>SKU *</label>
            <input type="text" id="f-sku" value="${escapeAttr(editing?.sku || '')}" required />
          </div>
          <div class="code-card">
            <div class="code-card-head">
              <div>
                <label>Barcode</label>
                <p>Scan an existing product barcode, or auto-generate from SKU. This number is used on sales.</p>
              </div>
              <div class="code-card-actions">
                <button type="button" class="btn-scan" id="btn-scan-barcode-basic">📷 Scan</button>
                <button type="button" class="btn-auto" id="btn-auto-barcode">🔄 Auto generate</button>
              </div>
            </div>
            <div class="field" style="margin:0;">
              <label>Barcode number</label>
              <input type="text" id="f-barcode" value="${escapeAttr(barcodeValue)}" placeholder="Scan or auto-generate a barcode" />
            </div>
            <div class="code-preview" id="barcode-live-preview">${barcodeValue ? `<b>${escapeAttr(barcodeValue)}</b><span>Ready for POS / sales scanning</span>` : '<span>Scan a barcode or auto-generate from SKU</span>'}</div>
            ${barcodeValue ? '<div class="code-ok">Barcode ready for POS / sales scanning.</div>' : ''}
          </div>
          <div class="code-card">
            <div class="code-card-head">
              <div>
                <label>Product QR</label>
                <p>Scan an existing QR, or auto-generate from SKU. This number is used on sales.</p>
              </div>
              <div class="code-card-actions">
                <button type="button" class="btn-scan" id="btn-scan-qr-basic">📷 Scan QR</button>
                <button type="button" class="btn-auto" id="btn-auto-qr">🔄 Auto generate</button>
              </div>
            </div>
            <div class="field" style="margin:0;">
              <label>QR number</label>
              <input type="text" id="f-qr-code" value="${escapeAttr(qrValue)}" placeholder="Scan or auto-generate a QR number" />
            </div>
            <div class="code-preview" id="qr-live-preview">${qrValue ? `<b>${escapeAttr(qrValue)}</b><span>Ready for POS / sales scanning</span>` : '<span>Scan a QR or auto-generate from SKU</span>'}</div>
            ${qrValue ? '<div class="code-ok">QR ready for POS / sales scanning.</div>' : ''}
          </div>
          <div class="field">
            <label>Product Type</label>
            <select id="f-product-type">
              <option value="">Select type...</option>
              ${(settingsData.productType || []).map(t => `<option value="${t.name}" ${editing?.productType === t.name ? 'selected' : ''}>${t.name}</option>`).join('')}
            </select>
          </div>
          <div class="field full-width">
            <label>Description</label>
            <textarea id="f-description">${escapeAttr(editing?.description || '')}</textarea>
          </div>
          <div class="field full-width">
            <label>Tags</label>
            <input type="text" id="f-tags" value="${escapeAttr(Array.isArray(editing?.tags) ? editing.tags.join(', ') : editing?.tags || '')}" placeholder="e.g., cotton, grade-a" />
          </div>
        </div>
      </div>
      
      <!-- Pricing & Stock Tab -->
      <div class="form-panel ${currentFormTab === 'pricing' ? 'active' : ''}" data-panel="pricing">
        <div class="form-grid">
          <div class="field">
            <label>Cost Price *</label>
            <input type="number" step="0.01" id="f-cost-price" value="${editing?.costPrice || ''}" required />
          </div>
          <div class="field">
            <label>Selling Price *</label>
            <input type="number" step="0.01" id="f-selling-price" value="${editing?.sellingPrice || ''}" required />
          </div>
          <div class="field">
            <label>Landing Cost</label>
            <input type="number" step="0.01" id="f-landing-cost" value="${editing?.landingCost || ''}" />
          </div>
          <div class="field">
            <label>Currency *</label>
            <select id="f-currency">
              <option value="PKR" ${editing?.currency === 'PKR' ? 'selected' : ''}>PKR</option>
              <option value="USD" ${editing?.currency === 'USD' ? 'selected' : ''}>USD</option>
              <option value="EUR" ${editing?.currency === 'EUR' ? 'selected' : ''}>EUR</option>
              <option value="GBP" ${editing?.currency === 'GBP' ? 'selected' : ''}>GBP</option>
            </select>
          </div>
          <div class="field">
            <label>Tax Rate (%)</label>
            <input type="number" step="0.01" id="f-tax-rate" value="${editing?.taxRate || ''}" />
          </div>
          <div class="field">
            <label>Tax Type</label>
            <select id="f-tax-type">
              <option value="">Select type...</option>
              ${(settingsData.taxType || []).map(t => `<option value="${t.name}" ${editing?.taxType === t.name ? 'selected' : ''}>${t.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Stock Unit</label>
            <select id="f-stock-unit">
              <option value="">Select unit...</option>
              ${(settingsData.stockUnit || []).map(u => `<option value="${u.name}" ${editing?.stockUnit === u.name ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Current Stock</label>
            <input type="number" id="f-current-stock" value="${editing?.currentStock || 0}" ${editing ? 'readonly' : ''} />
          </div>
          <div class="field">
            <label>Minimum Stock</label>
            <input type="number" id="f-minimum-stock" value="${editing?.minimumStock || ''}" />
          </div>
          <div class="field">
            <label>Maximum Stock</label>
            <input type="number" id="f-maximum-stock" value="${editing?.maximumStock || ''}" />
          </div>
        </div>
      </div>
      
      <!-- Category & Supplier Tab -->
      <div class="form-panel ${currentFormTab === 'category' ? 'active' : ''}" data-panel="category">
        <div class="form-grid">
          <div class="field">
            <label>Category *</label>
            <div class="select-add">
              <select id="f-category" required>
                <option value="">Select category...</option>
                ${categories.map((c) => `<option value="${catId(c)}" ${catId(c) === selectedCat ? 'selected' : ''}>${escapeAttr(c.name)}</option>`).join('')}
              </select>
              <button type="button" class="btn-plus" id="btn-add-category" title="Add category">+</button>
            </div>
          </div>
          <div class="field">
            <label>Sub-Category</label>
            <div class="select-add">
              <select id="f-subcategory">
                <option value="">${selectedCat ? 'Select sub-category...' : 'Select category first'}</option>
                ${subCategories.map((s) => `<option value="${catId(s)}" ${catId(s) === selectedSub ? 'selected' : ''}>${escapeAttr(s.name)}</option>`).join('')}
              </select>
              <button type="button" class="btn-plus" id="btn-add-subcategory" title="Add sub-category" ${selectedCat ? '' : 'disabled'}>+</button>
            </div>
          </div>
          <div class="field">
            <label>Brand</label>
            <input type="text" id="f-brand" value="${escapeAttr(editing?.brand || editing?.brandName || '')}" />
          </div>
          <div class="field">
            <label>Model Number</label>
            <input type="text" id="f-model-number" value="${escapeAttr(editing?.modelNumber || '')}" />
          </div>
          <div class="field">
            <label>Supplier *</label>
            <select id="f-supplier" required>
              <option value="">Select supplier...</option>
              ${suppliers.map(s => `<option value="${s._id || s.id}" ${(editing?.supplierId === s._id || editing?.supplierId === s.id) ? 'selected' : ''}>${escapeAttr(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Supplier SKU</label>
            <input type="text" id="f-supplier-sku" value="${escapeAttr(editing?.supplierSku || '')}" />
          </div>
          <div class="field">
            <label>Lead Time (Days)</label>
            <input type="number" id="f-lead-time" value="${editing?.leadTime || editing?.leadTimeDays || ''}" />
          </div>
          <div class="field">
            <label>Reorder Point</label>
            <input type="number" id="f-reorder-point" value="${editing?.reorderPoint || ''}" />
          </div>
        </div>
      </div>
      
      <!-- Warehouse Tab -->
      <div class="form-panel ${currentFormTab === 'warehouse' ? 'active' : ''}" data-panel="warehouse">
        <div class="form-grid">
          <div class="field">
            <label>Rack Location</label>
            <select id="f-rack-location">
              <option value="">Select rack...</option>
              ${(settingsData.rackLocation || []).map(r => `<option value="${r.name}" ${editing?.rackLocation === r.name ? 'selected' : ''}>${r.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Zone</label>
            <select id="f-zone">
              <option value="">Select zone...</option>
              ${(settingsData.zone || []).map(z => `<option value="${z.name}" ${editing?.zone === z.name ? 'selected' : ''}>${z.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Pallet Number</label>
            <input type="text" id="f-pallet-number" value="${escapeAttr(editing?.palletNumber || '')}" />
          </div>
          <div class="field">
            <label>Shelf Number</label>
            <input type="text" id="f-shelf-number" value="${escapeAttr(editing?.shelfNumber || '')}" />
          </div>
          <div class="field">
            <label>Storage Condition</label>
            <select id="f-storage-condition">
              <option value="">Select condition...</option>
              ${(settingsData.storageCondition || []).map(s => `<option value="${s.name}" ${editing?.storageCondition === s.name ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Temp Min (°C)</label>
            <input type="number" id="f-temp-min" value="${editing?.tempMin || editing?.temperatureMin || ''}" />
          </div>
          <div class="field">
            <label>Temp Max (°C)</label>
            <input type="number" id="f-temp-max" value="${editing?.tempMax || editing?.temperatureMax || ''}" />
          </div>
        </div>
      </div>
      
      <!-- Physical Tab -->
      <div class="form-panel ${currentFormTab === 'physical' ? 'active' : ''}" data-panel="physical">
        <div class="form-grid">
          <div class="field">
            <label>Weight</label>
            <input type="number" step="0.01" id="f-weight" value="${editing?.weight || ''}" />
          </div>
          <div class="field">
            <label>Weight Unit</label>
            <select id="f-weight-unit">
              ${(settingsData.weightUnit || []).map(u => `<option value="${u.name}" ${editing?.weightUnit === u.name ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Dimension Unit</label>
            <select id="f-dimension-unit">
              ${(settingsData.dimensionUnit || []).map(u => `<option value="${u.name}" ${editing?.dimensionUnit === u.name ? 'selected' : ''}>${u.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Length</label>
            <input type="number" id="f-length" value="${editing?.length || ''}" />
          </div>
          <div class="field">
            <label>Width</label>
            <input type="number" id="f-width" value="${editing?.width || ''}" />
          </div>
          <div class="field">
            <label>Height</label>
            <input type="number" id="f-height" value="${editing?.height || ''}" />
          </div>
          <div class="field">
            <label>Color</label>
            <input type="text" id="f-color" value="${escapeAttr(editing?.color || '')}" />
          </div>
          <div class="field">
            <label>Size</label>
            <select id="f-size">
              <option value="">Select size...</option>
              ${(settingsData.size || []).map(s => `<option value="${s.name}" ${editing?.size === s.name ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Material</label>
            <input type="text" id="f-material" value="${escapeAttr(editing?.material || '')}" />
          </div>
          <div class="field">
            <label>Finish</label>
            <input type="text" id="f-finish" value="${escapeAttr(editing?.finish || '')}" />
          </div>
        </div>
      </div>
      
      <!-- Expiry & Batch Tab -->
      <div class="form-panel ${currentFormTab === 'expiry' ? 'active' : ''}" data-panel="expiry">
        <div class="field-group">
          <h4>Tracking Flags</h4>
          <div class="form-grid">
            <div class="checkbox-group">
              <input type="checkbox" id="f-has-expiry" ${editing?.hasExpiry ? 'checked' : ''} />
              <label for="f-has-expiry">Has Expiry</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="f-is-batch-managed" ${editing?.isBatchManaged ? 'checked' : ''} />
              <label for="f-is-batch-managed">Batch Managed</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="f-is-serial-managed" ${editing?.isSerialManaged ? 'checked' : ''} />
              <label for="f-is-serial-managed">Serial Managed</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="f-is-expiry-managed" ${editing?.isExpiryManaged ? 'checked' : ''} />
              <label for="f-is-expiry-managed">Expiry Managed</label>
            </div>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Expiry Date</label>
            <input type="date" id="f-expiry-date" value="${editing?.expiryDate ? String(editing.expiryDate).slice(0, 10) : ''}" />
          </div>
          <div class="field">
            <label>Manufacturing Date</label>
            <input type="date" id="f-manufacturing-date" value="${editing?.manufacturingDate ? String(editing.manufacturingDate).slice(0, 10) : ''}" />
          </div>
          <div class="field">
            <label>Batch Number</label>
            <input type="text" id="f-batch-number" value="${escapeAttr(editing?.batchNumber || '')}" />
          </div>
          <div class="field">
            <label>Shelf Life (Days)</label>
            <input type="number" id="f-shelf-life" value="${editing?.shelfLife || editing?.shelfLifeDays || ''}" />
          </div>
        </div>
        <div class="field-group">
          <h4>Bulk Management (Cotton/Fabric)</h4>
          <div class="form-grid">
            <div class="checkbox-group">
              <input type="checkbox" id="f-is-bulk-managed" ${editing?.isBulkManaged ? 'checked' : ''} />
              <label for="f-is-bulk-managed">Bulk Managed</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="f-has-individual-tracking" ${editing?.hasIndividualTracking ? 'checked' : ''} />
              <label for="f-has-individual-tracking">Individual Tracking</label>
            </div>
            <div class="field">
              <label>Bulk Unit</label>
              <select id="f-bulk-unit">
                <option value="Bale" ${editing?.bulkUnit === 'Bale' ? 'selected' : ''}>Bale</option>
                <option value="Box" ${editing?.bulkUnit === 'Box' ? 'selected' : ''}>Box</option>
                <option value="Roll" ${editing?.bulkUnit === 'Roll' ? 'selected' : ''}>Roll</option>
                <option value="Pallet" ${editing?.bulkUnit === 'Pallet' ? 'selected' : ''}>Pallet</option>
              </select>
            </div>
            <div class="field">
              <label>Default Batch Quantity</label>
              <input type="number" id="f-default-batch-quantity" value="${editing?.defaultBatchQuantity || editing?.defaultQuantityPerBatch || ''}" />
            </div>
          </div>
        </div>
      </div>
      
      <!-- Shipping Tab -->
      <div class="form-panel ${currentFormTab === 'shipping' ? 'active' : ''}" data-panel="shipping">
        <div class="form-grid">
          <div class="field">
            <label>HS Code</label>
            <input type="text" id="f-hs-code" value="${escapeAttr(editing?.hsCode || '')}" />
          </div>
          <div class="field">
            <label>Country of Origin</label>
            <select id="f-country-of-origin">
              <option value="Pakistan" ${editing?.countryOfOrigin === 'Pakistan' ? 'selected' : ''}>Pakistan</option>
              <option value="China" ${editing?.countryOfOrigin === 'China' ? 'selected' : ''}>China</option>
              <option value="USA" ${editing?.countryOfOrigin === 'USA' ? 'selected' : ''}>USA</option>
              <option value="Turkey" ${editing?.countryOfOrigin === 'Turkey' ? 'selected' : ''}>Turkey</option>
              <option value="India" ${editing?.countryOfOrigin === 'India' ? 'selected' : ''}>India</option>
            </select>
          </div>
          <div class="field">
            <label>Shipping Class</label>
            <select id="f-shipping-class">
              <option value="">Select class...</option>
              ${(settingsData.shippingClass || []).map(s => `<option value="${s.name}" ${editing?.shippingClass === s.name ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Freight Class</label>
            <input type="text" id="f-freight-class" value="${escapeAttr(editing?.freightClass || '')}" />
          </div>
          <div class="field">
            <label>Stacking Limit</label>
            <input type="number" id="f-stacking-limit" value="${editing?.stackingLimit || ''}" />
          </div>
          <div class="checkbox-group">
            <input type="checkbox" id="f-dangerous-goods" ${editing?.dangerousGoods ? 'checked' : ''} />
            <label for="f-dangerous-goods">Dangerous Goods</label>
          </div>
          <div class="field">
            <label>UN Number</label>
            <input type="text" id="f-un-number" value="${escapeAttr(editing?.unNumber || '')}" />
          </div>
          <div class="field full-width">
            <label>Handling Instructions</label>
            <input type="text" id="f-handling-instructions" value="${escapeAttr(editing?.handlingInstructions || '')}" />
          </div>
        </div>
      </div>
      
      <!-- Barcode Tab -->
      <div class="form-panel ${currentFormTab === 'barcode' ? 'active' : ''}" data-panel="barcode">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div style="text-align: center;">
            <h4 style="font-size: 11px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">Barcode</h4>
            <div id="barcode-display" style="border: 2px dashed #e5e7eb; border-radius: 12px; padding: 24px; background: #f9fafb; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              ${editing?.barcodeNumber || editing?.barcode || editing?.sku ? `
                <div style="font-family: monospace; font-size: 24px; font-weight: 700; color: #1a1a1a; letter-spacing: 2px;">${escapeAttr(editing?.barcodeNumber || editing?.barcode || editing?.sku)}</div>
                <div style="margin-top: 8px; font-size: 12px; color: #6b7280;">CODE128</div>
              ` : `<div style="color: #9ca3af; font-size: 14px;">No barcode assigned</div>`}
            </div>
            <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px; text-align: left;">
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span style="color: #6b7280;">Barcode No.</span>
                <span style="font-family: monospace; color: #1f2937;">${escapeAttr(editing?.barcodeNumber || editing?.barcode || editing?.sku || '—')}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span style="color: #6b7280;">Format</span>
                <span style="color: #1f2937;">CODE128</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span style="color: #6b7280;">SKU</span>
                <span style="font-family: monospace; color: #1f2937;">${escapeAttr(editing?.sku || '—')}</span>
              </div>
            </div>
            <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button type="button" id="btn-scan-barcode" class="btn-scan">📷 Scan</button>
              <button type="button" id="btn-auto-barcode-tab" class="btn-auto">🔄 Auto generate</button>
              <button type="button" id="btn-print-barcode" style="padding: 8px 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; font-weight: 600; font-size: 12px; cursor: pointer;">🖨 Print</button>
            </div>
          </div>
          <div style="text-align: center;">
            <h4 style="font-size: 11px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;">QR Code</h4>
            <div id="qr-display" style="border: 2px dashed #e5e7eb; border-radius: 12px; padding: 24px; background: #f9fafb; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
              ${editing?.qrCode || editing?.qr_code ? `
                <div style="font-family: monospace; font-size: 20px; font-weight: 700; color: #1a1a1a; letter-spacing: 1px;">${escapeAttr(editing?.qrCode || editing?.qr_code)}</div>
                <div style="margin-top: 8px; font-size: 12px; color: #6b7280;">QR Code</div>
              ` : `<div style="color: #9ca3af; font-size: 14px;">No QR code assigned</div>`}
            </div>
            <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px; text-align: left;">
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span style="color: #6b7280;">QR Code</span>
                <span style="font-family: monospace; color: #1f2937;">${escapeAttr(editing?.qrCode || editing?.qr_code || '—')}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span style="color: #6b7280;">SKU</span>
                <span style="font-family: monospace; color: #1f2937;">${escapeAttr(editing?.sku || '—')}</span>
              </div>
            </div>
            <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button type="button" id="btn-scan-qr-tab" class="btn-scan">📷 Scan QR</button>
              <button type="button" id="btn-auto-qr-tab" class="btn-auto">🔄 Auto generate</button>
              <button type="button" id="btn-print-qr" style="padding: 8px 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; font-weight: 600; font-size: 12px; cursor: pointer;">🖨 Print</button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Custom Tab -->
      <div class="form-panel ${currentFormTab === 'custom' ? 'active' : ''}" data-panel="custom">
        <div class="field-group">
          <h4>Warranty & Return</h4>
          <div class="form-grid">
            <div class="field">
              <label>Warranty Period</label>
              <input type="number" id="f-warranty-period" value="${editing?.warrantyPeriod || ''}" />
            </div>
            <div class="field">
              <label>Warranty Unit</label>
              <select id="f-warranty-unit">
                <option value="Days" ${editing?.warrantyUnit === 'Days' ? 'selected' : ''}>Days</option>
                <option value="Months" ${editing?.warrantyUnit === 'Months' || !editing?.warrantyUnit ? 'selected' : ''}>Months</option>
                <option value="Years" ${editing?.warrantyUnit === 'Years' ? 'selected' : ''}>Years</option>
              </select>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="f-is-returnable" ${editing?.isReturnable !== false ? 'checked' : ''} />
              <label for="f-is-returnable">Is Returnable</label>
            </div>
            <div class="field">
              <label>Return Days</label>
              <input type="number" id="f-return-days" value="${editing?.returnDays || '7'}" />
            </div>
          </div>
        </div>
        <div class="field-group">
          <h4>Additional Notes</h4>
          <textarea id="f-notes" rows="3">${escapeAttr(editing?.notes || '')}</textarea>
        </div>
      </div>
      
      <div class="modal-actions">
        <button type="button" class="btn btn-gray" id="btn-cancel">Cancel</button>
        <button type="submit" class="btn btn-brand">${editing ? 'Update Product' : 'Save Product'}</button>
      </div>
    </form>
  `;

  document.querySelectorAll('.form-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchFormTab(btn.dataset.tab));
  });
  bindCodeActions();
  bindCategoryQuickAdd();

  document.getElementById('product-form').addEventListener('submit', handleFormSubmit);
  document.getElementById('btn-cancel').addEventListener('click', closeForm);

  const printBtn = document.getElementById('btn-print-barcode');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      const barcodeValue = document.getElementById('f-barcode').value || editing?.barcodeNumber || editing?.barcode || editing?.sku || '';
      const productName = editing?.name || document.getElementById('f-name').value || 'Product';
      if (!barcodeValue) { alert('No barcode to print. Please scan or enter a barcode first.'); return; }
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(`<html><head><title>Barcode - ${productName}</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;}.barcode{font-family:monospace;font-size:48px;font-weight:700;letter-spacing:4px;margin:20px 0;}.name{font-size:18px;color:#555;}</style></head><body><div class="barcode">${barcodeValue}</div><div class="name">${productName}</div></body></html>`);
      win.document.close();
      win.print();
    });
  }

  const printQrBtn = document.getElementById('btn-print-qr');
  if (printQrBtn) {
    printQrBtn.addEventListener('click', () => {
      const qrValue = document.getElementById('f-qr-code')?.value.trim() || editing?.qrCode || editing?.qr_code || '';
      const productName = editing?.name || document.getElementById('f-name').value || 'Product';
      if (!qrValue) { alert('No QR code to print.'); return; }
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(`<html><head><title>QR - ${productName}</title><style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;}.qr{font-family:monospace;font-size:32px;font-weight:700;letter-spacing:2px;margin:20px 0;word-break:break-all;max-width:400px;text-align:center;}.name{font-size:18px;color:#555;}</style></head><body><div class="qr">${qrValue}</div><div class="name">${productName}</div></body></html>`);
      win.document.close();
      win.print();
    });
  }
}

function openForm(product) {
  editing = product;
  currentFormTab = 'basic';
  formError.textContent = '';
  overlay.classList.add('show');
  renderForm();
}

function closeForm() {
  closeQuickAdd();
  overlay.classList.remove('show');
  editing = null;
  currentFormTab = 'basic';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  formError.textContent = '';

  const payload = {
    id: editing?.id || editing?._id,
    name: document.getElementById('f-name').value.trim(),
    sku: document.getElementById('f-sku').value.trim(),
    barcodeNumber: document.getElementById('f-barcode').value.trim(),
    barcode: document.getElementById('f-barcode').value.trim(),
    qrCode: document.getElementById('f-qr-code')?.value.trim() || '',
    productType: document.getElementById('f-product-type').value,
    description: document.getElementById('f-description').value.trim(),
    tags: document.getElementById('f-tags').value.trim(),
    costPrice: Number(document.getElementById('f-cost-price').value) || 0,
    sellingPrice: Number(document.getElementById('f-selling-price').value) || 0,
    landingCost: Number(document.getElementById('f-landing-cost').value) || 0,
    currency: document.getElementById('f-currency').value,
    taxRate: Number(document.getElementById('f-tax-rate').value) || 0,
    taxType: document.getElementById('f-tax-type').value,
    stockUnit: document.getElementById('f-stock-unit').value,
    currentStock: Number(document.getElementById('f-current-stock').value) || 0,
    minimumStock: Number(document.getElementById('f-minimum-stock').value) || 0,
    maximumStock: Number(document.getElementById('f-maximum-stock').value) || 0,
    categoryId: document.getElementById('f-category').value,
    subcategoryId: document.getElementById('f-subcategory').value,
    subCategory: document.getElementById('f-subcategory').value,
    brand: document.getElementById('f-brand').value.trim(),
    modelNumber: document.getElementById('f-model-number').value.trim(),
    supplierId: document.getElementById('f-supplier').value,
    supplierName: (suppliers.find((s) => String(s.id || s._id) === document.getElementById('f-supplier').value) || {}).name || '',
    supplierSku: document.getElementById('f-supplier-sku').value.trim(),
    leadTime: Number(document.getElementById('f-lead-time').value) || 0,
    reorderPoint: Number(document.getElementById('f-reorder-point').value) || 0,
    rackLocation: document.getElementById('f-rack-location').value,
    zone: document.getElementById('f-zone').value,
    palletNumber: document.getElementById('f-pallet-number').value.trim(),
    shelfNumber: document.getElementById('f-shelf-number').value.trim(),
    storageCondition: document.getElementById('f-storage-condition').value,
    tempMin: Number(document.getElementById('f-temp-min').value) || 0,
    tempMax: Number(document.getElementById('f-temp-max').value) || 0,
    weight: Number(document.getElementById('f-weight').value) || 0,
    weightUnit: document.getElementById('f-weight-unit').value,
    dimensionUnit: document.getElementById('f-dimension-unit').value,
    length: Number(document.getElementById('f-length').value) || 0,
    width: Number(document.getElementById('f-width').value) || 0,
    height: Number(document.getElementById('f-height').value) || 0,
    color: document.getElementById('f-color').value.trim(),
    size: document.getElementById('f-size').value,
    material: document.getElementById('f-material').value.trim(),
    finish: document.getElementById('f-finish').value.trim(),
    hasExpiry: document.getElementById('f-has-expiry').checked,
    isBatchManaged: document.getElementById('f-is-batch-managed').checked,
    isSerialManaged: document.getElementById('f-is-serial-managed').checked,
    isExpiryManaged: document.getElementById('f-is-expiry-managed').checked,
    expiryDate: document.getElementById('f-expiry-date').value,
    manufacturingDate: document.getElementById('f-manufacturing-date').value,
    batchNumber: document.getElementById('f-batch-number').value.trim(),
    shelfLife: Number(document.getElementById('f-shelf-life').value) || 0,
    isBulkManaged: document.getElementById('f-is-bulk-managed').checked,
    hasIndividualTracking: document.getElementById('f-has-individual-tracking').checked,
    bulkUnit: document.getElementById('f-bulk-unit').value,
    defaultBatchQuantity: Number(document.getElementById('f-default-batch-quantity').value) || 0,
    hsCode: document.getElementById('f-hs-code').value.trim(),
    countryOfOrigin: document.getElementById('f-country-of-origin').value,
    shippingClass: document.getElementById('f-shipping-class').value,
    freightClass: document.getElementById('f-freight-class').value.trim(),
    stackingLimit: Number(document.getElementById('f-stacking-limit').value) || 0,
    dangerousGoods: document.getElementById('f-dangerous-goods').checked,
    unNumber: document.getElementById('f-un-number').value.trim(),
    handlingInstructions: document.getElementById('f-handling-instructions').value.trim(),
    warrantyPeriod: Number(document.getElementById('f-warranty-period').value) || 0,
    warrantyUnit: document.getElementById('f-warranty-unit').value,
    isReturnable: document.getElementById('f-is-returnable').checked,
    returnDays: Number(document.getElementById('f-return-days').value) || 7,
    notes: document.getElementById('f-notes').value.trim(),
  };

  if (!payload.name) { formError.textContent = 'Product name is required'; return; }
  if (!payload.sku) { formError.textContent = 'SKU is required'; return; }
  if (!payload.categoryId) { formError.textContent = 'Category is required'; return; }
  if (!payload.supplierId) { formError.textContent = 'Supplier is required'; return; }

  try {
    const res = await api.catalog.saveProduct(payload);
    if (!res?.success) {
      formError.textContent = res?.message || 'Save failed';
      return;
    }
    closeForm();
    await reload();
  } catch (err) {
    formError.textContent = err.message || 'Save failed';
  }
}

async function reload() {
  console.log('[products] reload called');
  tableWrap.innerHTML = '<div class="empty">Loading...</div>';

  let res;
  try {
    res = await api.catalog.listProducts();
  } catch (err) {
    console.error('[products] api.catalog.listProducts() threw:', err);
    tableWrap.innerHTML = `<div class="empty" style="color:#b91c1c;">Error: ${err.message}</div>`;
    return;
  }

  console.log('[products] API response:', res);

  if (!res?.success) {
    console.error('[products] API failed:', res?.message);
    tableWrap.innerHTML = `<div class="empty" style="color:#b91c1c;">${res?.message || 'Failed to load products'}</div>`;
    return;
  }

  products = Array.isArray(res?.data) ? res.data : [];
  console.log('[products] products loaded:', products.length);

  // If empty, show message — user should press Sync to load from cloud
  if (products.length === 0) {
    console.warn('[products] No products found — use Sync button to load from cloud');
  }


  // Render ZAROOR karo
  render();
}

searchInp.addEventListener('input', render);
btnAdd.addEventListener('click', () => openForm(null));
document.getElementById('btn-back').addEventListener('click', () => {
  window.location.href = './sell.html';
});
document.getElementById('btn-categories').addEventListener('click', () => {
  window.location.href = './categories.html?t=' + Date.now();
});

async function lookupScannedProduct(code) {
  const res = await api.pos.byBarcode(code);
  if (res?.success && res?.data) {
    openForm(res.data);
    return;
  }
  alert(`No product found for: ${code}`);
}

btnScan.addEventListener('click', () => {
  if (typeof window.openCodeScanner === 'function') {
    window.openCodeScanner({
      title: 'Scan product barcode / QR',
      onScan: (code) => lookupScannedProduct(code).catch((err) => alert(`Scan failed: ${err.message}`)),
    });
    return;
  }
  const code = prompt('Scan or enter barcode/QR code:');
  if (code) lookupScannedProduct(code).catch((err) => alert(`Scan failed: ${err.message}`));
});

// Hardware scanner listener
let scanBuffer = '';
let scanTimeout = null;
document.addEventListener('keydown', (e) => {
  if (overlay.classList.contains('show')) return;
  clearTimeout(scanTimeout);
  scanTimeout = setTimeout(() => { scanBuffer = ''; }, 100);
  if (e.key === 'Enter' && scanBuffer.length > 0) {
    e.preventDefault();
    const code = scanBuffer;
    scanBuffer = '';
    api.pos.byBarcode(code).then(res => {
      if (res?.success && res?.data) openForm(res.data);
      else alert(`No product found for: ${code}`);
    }).catch(err => alert(`Scan failed: ${err.message}`));
    return;
  }
  if (e.key.length === 1) scanBuffer += e.key;
});

tableWrap.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const delBtn = e.target.closest('[data-del]');
  if (editBtn) {
    const id = editBtn.getAttribute('data-edit');
    const product = products.find(p => (p.id || p._id) === id);
    if (product) openForm(product);
  }
  if (delBtn && confirm('Delete this product?')) {
    const id = delBtn.getAttribute('data-del');
    await api.catalog.deleteProduct(id);
    await reload();
  }
});

document.getElementById('quick-add-cancel')?.addEventListener('click', closeQuickAdd);
document.getElementById('quick-add-save')?.addEventListener('click', () => { void saveQuickAdd(); });
document.getElementById('quick-add-name')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void saveQuickAdd(); }
});
document.getElementById('quick-add-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'quick-add-overlay') closeQuickAdd();
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeForm();
});

// ─── BOOT ───────────────────────────────────────────────────────────────────
// bisonLocation guard — agar available nahi toh directly load karo
async function initLocationPicker() {
  const select = document.getElementById('location-select');

  // Guard: agar bisonLocation ya select element nahi hai toh skip
  if (!select || !window.bisonLocation) {
    console.warn('[products] bisonLocation not available, skipping location picker');
    return;
  }

  try {
    // Load from local cache — no live API call
    const locRes = await api.pos.listLocations();
    const locations = Array.isArray(locRes?.data) ? locRes.data : [];
    const chosen = bisonLocation.fillLocationSelect(
      select,
      locations,
      bisonLocation.getStoredLocationId(),
      { allowAll: false }
    );
    bisonLocation.setStoredLocationId(chosen);

    select.addEventListener('change', async () => {
      const locationId = bisonLocation.effectiveId(select.value);
      bisonLocation.setStoredLocationId(select.value);
      // No live API sync on location change — just reload local catalog
      bisonLocation.setLastSyncedLocationId(locationId);
      await loadSettings();
      await reload();
    });


    // NOTE: No automatic location refresh on load. Previously this triggered a
    // full catalog refresh (clearCatalog + keepOnlyProductIds for that location),
    // which could wipe the local products list before the page even rendered —
    // making the page look empty even though the sell screen has data. Offline-first:
    // show the local catalog immediately. The user can still switch location
    // explicitly, which then syncs via the change handler above.
    bisonLocation.setLastSyncedLocationId(bisonLocation.effectiveId(chosen) || '');
  } catch (err) {
    console.error('[products] initLocationPicker failed:', err);
    // Silently continue — load karta rahega
  }
}

// Offline-first: load products from the local catalog immediately.
// Do NOT block on the location picker / cloud sync — the sell screen shows local
// data right away, and so must this page. Previously reload() was chained after
// the location sync, so a slow/hanging sync kept the products list empty.
reload().catch((err) => {
  tableWrap.innerHTML = `<div class="empty" style="color:#b91c1c;">${err.message}</div>`;
});

// Location picker + settings load in the background, off the critical path.
initLocationPicker()
  .then(() => loadSettings())
  .catch((err) => console.error('[products] boot error (non-fatal):', err));