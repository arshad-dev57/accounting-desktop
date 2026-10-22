
'use strict';
window.__bootSteps = ['sell.js loaded'];
window.addEventListener('error', (event) => {
  window.__bootSteps.push('ERROR: ' + event.message + ' @ ' + event.filename + ':' + event.lineno);
  console.error('[POS JS Error]', event.message, event.filename, event.lineno);
});
window.addEventListener('unhandledrejection', (event) => {
  window.__bootSteps.push('UNHANDLED REJECTION: ' + (event.reason?.message || event.reason));
});

const api = window.bisonDesktop;

function isAdminRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return r === 'admin' || r === 'owner' || r === 'superadmin' || r === 'company_admin';
}

function isManagerRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return isAdminRole(r) || r === 'manager';
}

function isKitchenRole(role) {
  return String(role || '').toLowerCase().trim() === 'kitchen';
}

function resolvePosMode(user) {
  return String(user?.posMode || user?.company?.posMode || 'retail').toLowerCase();
}

function restaurantMoney(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function restaurantFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let restaurantReadyPoll = null;
let isRestaurantPos = false;
const restaurantOrderVersions = new Map();
const restaurantReadyFilters = {
  tableLabel: '',
  orderType: '',
  ticketNumber: '',
};

function restaurantWaiterName(order) {
  const w = order?.waiter;
  if (!w) return '';
  return `${w.firstName || ''} ${w.lastName || ''}`.trim();
}

function restaurantOrderTypeLabel(type) {
  if (type === 'takeaway') return 'Takeaway';
  if (type === 'delivery') return 'Delivery';
  return 'Dine in';
}

function showToast(message, type = 'info') {
  console.log('[POS]', message);
  try {
    let toast = document.getElementById('pos-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pos-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:4000;padding:10px 18px;border-radius:6px;color:#fff;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,0.3);max-width:90%;';
      document.body.appendChild(toast);
    }
    toast.style.background = type === 'error' ? '#dc2626' : (type === 'success' ? '#15803d' : '#334155');
    toast.textContent = String(message);
    toast.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.display = 'none'; }, 3500);
  } catch (err) {
    console.log('[POS toast fallback]', message);
  }
}

function currentLocationId() {
  // Optional stamp from active terminal only — catalog is company-wide
  return currentTerminal?.locationId || currentTerminal?.location?.id || '';
}

function applyCompanyBranding(profile) {
  const name =
    profile?.companyName ||
    profile?.company?.name ||
    profile?.organizationName ||
    profile?.businessDetails?.companyName ||
    profile?.businessDetails?.businessName ||
    '';
  const logo =
    profile?.logo ||
    profile?.company?.logo ||
    profile?.businessDetails?.logo ||
    '';

  const brandEl = document.getElementById('company-brand-name') || document.querySelector('.top-brand b');
  if (brandEl && name) {
    brandEl.textContent = name;
  }

  const logoEl = document.getElementById('company-logo');
  if (logoEl) {
    if (logo) {
      logoEl.src = logo;
      logoEl.alt = name || 'Company';
      logoEl.classList.remove('hidden');
    } else {
      logoEl.removeAttribute('src');
      logoEl.classList.add('hidden');
    }
  }

  try {
    document.title = name ? `${name} POS` : 'POS';
  } catch (_) { /* ignore */ }
}

async function initLocationPicker() {
  // Warehouse location picker removed — POS is company-scoped
}

function applySelectedLocation(id) {
  selectedLocation = currentTerminal?.location || (id ? { id } : {});
}

async function onLocationChanged() {
  // no-op: catalog is always company-wide
}

// State management
let activeShift = null;
let currentCashier = null;
let currentTerminal = null;
let selectedLocation = null;
let locationList = [];
let companyProfile = null;
let taxContext = null;

let categories = [];
let activeParent = null;
let subcategories = [];
let selectedCategoryId = 'All';
let products = [];
let cart = [];
let selectedCustomer = null;
let customerCreditInfo = null;
let overallDiscount = 0;
let cartDiscountAmount = 0;
let discountMode = 'pct';

let payments = [];
let focusedPaymentIndex = 0;
let submittingSale = false;
let lastSale = null;

let posSettings = {
  enableBarcodeScanner: true,
  enablePaymentTerminal: false,
  autoPrintOnSale: false,
  loyaltyEnabled: true,
};

const liveClockEl = document.getElementById('live-clock');
const cashierMetaEl = document.getElementById('cashier-meta');
const terminalBadgeEl = document.getElementById('terminal-badge');
const offlineBadgeEl = document.getElementById('offline-badge');

const tabButtons = document.querySelectorAll('.tab-btn');
const viewPanels = document.querySelectorAll('.view-panel');

const productSearchInp = document.getElementById('product-search');
const barcodeScanInp = document.getElementById('barcode-scan-box');
const categoriesTabsBar = document.getElementById('categories-tabs-bar');
const mainCategoriesGrid = document.getElementById('main-categories-grid');
const productsGrid = document.getElementById('products-grid');

const cartQtyCountEl = document.getElementById('cart-qty-count');
const btnClearCart = document.getElementById('btn-clear-cart');
const customerSearchInp = document.getElementById('customer-search-input');
const customerDropdown = document.getElementById('customer-dropdown-results');
const custCreditInfoCard = document.getElementById('cust-credit-info-card');

const customLineNameInp = document.getElementById('custom-line-name');
const customLinePriceInp = document.getElementById('custom-line-price');
const customLineQtyInp = document.getElementById('custom-line-qty');
const btnAddCustomLine = document.getElementById('btn-add-custom-line');

const cartItemsListContainer = document.getElementById('cart-items-list-container');
const cartSubtotalEl = document.getElementById('cart-subtotal');
const cartDiscountValueEl = document.getElementById('cart-discount-value');
const taxSummaryRow = document.getElementById('tax-summary-row');
const taxRegimeLabel = document.getElementById('tax-regime-label');
const cartTaxValueEl = document.getElementById('cart-tax-value');
const cartGrandTotalEl = document.getElementById('cart-grand-total');
const btnCheckoutTrigger = document.getElementById('btn-checkout-trigger');
const checkoutGrandTotalEl = document.getElementById('checkout-grand-total');
const btnHoldSaleTrigger = document.getElementById('btn-hold-sale-trigger');
const btnKickDrawer = document.getElementById('btn-kick-drawer');
const modalCloseShift = document.getElementById('modal-close-shift');
const modalCashFlow = document.getElementById('modal-cash-flow');
const checkoutModalOverlay = document.getElementById('checkout-modal-overlay');
const modalAddCustomer = document.getElementById('modal-add-customer');
const modalReceipt = document.getElementById('modal-receipt');
const modalManagerPin = document.getElementById('modal-manager-pin');

let customerSearchTimeout = null;

function receiptTpl() {
  return window.PosReceipt ? window.PosReceipt.loadReceiptTemplate() : {};
}

function isAskCashReceived() {
  return !!receiptTpl().askCashReceived;
}

function shouldAskCashReceived() {
  if (!isAskCashReceived()) return false;
  const method = String(payments[0]?.paymentMethod || 'Cash').toLowerCase();
  return method === 'cash';
}

function updateReceiptLogoPreview(logo) {
  const wrap = document.getElementById('rset-logo-preview-wrap');
  const img = document.getElementById('rset-logo-preview');
  const hidden = document.getElementById('rset-store-logo');
  const urlInp = document.getElementById('rset-logo-url');
  if (hidden) hidden.value = logo || '';
  if (urlInp) {
    urlInp.value = logo && !String(logo).startsWith('data:') ? logo : '';
  }
  if (wrap && img) {
    if (logo) {
      img.src = logo;
      wrap.style.display = 'flex';
    } else {
      img.removeAttribute('src');
      wrap.style.display = 'none';
    }
  }
}

function collectReceiptSettingsForm() {
  const next = { ...receiptTpl() };
  const map = {
    'rset-header': 'receiptHeader',
    'rset-footer': 'receiptFooter',
    'rset-policy': 'receiptReturnPolicy',
    'rset-notes': 'receiptNotes',
    'rset-store-name': 'storeName',
    'rset-store-address': 'storeAddress',
    'rset-phone': 'phone',
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) next[key] = el.value;
  }
  const hiddenLogo = document.getElementById('rset-store-logo');
  const urlLogo = document.getElementById('rset-logo-url');
  const fromHidden = hiddenLogo?.value || '';
  const fromUrl = (urlLogo?.value || '').trim();
  next.storeLogo = fromUrl || fromHidden || '';
  if (next.storeLogo) next.showLogo = true;
  const width = document.getElementById('rset-paper-width');
  if (width) next.thermalPaperWidthMm = Number(width.value) === 58 ? 58 : 80;
  const ask = document.getElementById('rset-ask-cash');
  if (ask) next.askCashReceived = ask.checked;
  document.querySelectorAll('[data-rset-toggle]').forEach((cb) => {
    next[cb.dataset.rsetToggle] = cb.checked;
  });
  return next;
}

function renderReceiptSettingsPreview() {
  const box = document.getElementById('receipt-settings-preview');
  if (!box || !window.PosReceipt) return;
  const next = collectReceiptSettingsForm();
  const company = window.PosReceipt.resolveReceiptCompany(companyProfile, next);
  box.innerHTML = window.PosReceipt.buildReceiptHtml(
    window.PosReceipt.sampleReceiptSale(),
    company,
    next
  );
}

function fillReceiptSettingsForm() {
  const tpl = receiptTpl();
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v || '';
  };
  setVal('rset-header', tpl.receiptHeader);
  setVal('rset-footer', tpl.receiptFooter);
  setVal('rset-policy', tpl.receiptReturnPolicy);
  setVal('rset-notes', tpl.receiptNotes);
  setVal('rset-store-name', tpl.storeName);
  setVal('rset-store-address', tpl.storeAddress);
  setVal('rset-phone', tpl.phone);
  updateReceiptLogoPreview(tpl.storeLogo || '');
  const width = document.getElementById('rset-paper-width');
  if (width) width.value = Number(tpl.thermalPaperWidthMm) === 58 ? '58' : '80';
  const ask = document.getElementById('rset-ask-cash');
  if (ask) ask.checked = !!tpl.askCashReceived;
  document.querySelectorAll('[data-rset-toggle]').forEach((cb) => {
    cb.checked = tpl[cb.dataset.rsetToggle] !== false;
  });
  const logoFile = document.getElementById('rset-logo-file');
  if (logoFile && !logoFile.dataset.bound) {
    logoFile.dataset.bound = '1';
    logoFile.addEventListener('change', () => {
      const file = logoFile.files && logoFile.files[0];
      logoFile.value = '';
      if (!file) return;
      if (file.size > 1.5 * 1024 * 1024) {
        alert('Logo must be under 1.5 MB');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        updateReceiptLogoPreview(String(reader.result || ''));
        const showLogo = document.querySelector('[data-rset-toggle="showLogo"]');
        if (showLogo) showLogo.checked = true;
        renderReceiptSettingsPreview();
      };
      reader.readAsDataURL(file);
    });
  }
  const logoRemove = document.getElementById('rset-logo-remove');
  if (logoRemove && !logoRemove.dataset.bound) {
    logoRemove.dataset.bound = '1';
    logoRemove.addEventListener('click', () => {
      updateReceiptLogoPreview('');
      const urlInp = document.getElementById('rset-logo-url');
      if (urlInp) urlInp.value = '';
      renderReceiptSettingsPreview();
    });
  }
  const logoUrl = document.getElementById('rset-logo-url');
  if (logoUrl && !logoUrl.dataset.bound) {
    logoUrl.dataset.bound = '1';
    logoUrl.addEventListener('input', () => {
      const v = logoUrl.value.trim();
      if (v) updateReceiptLogoPreview(v);
      renderReceiptSettingsPreview();
    });
  }
  renderReceiptSettingsPreview();
}

function saveReceiptSettings() {
  if (!window.PosReceipt) {
    alert('Receipt helper not loaded');
    return;
  }
  window.PosReceipt.saveReceiptTemplate(collectReceiptSettingsForm());
  renderReceiptSettingsPreview();
  alert('Receipt settings saved on this computer');
}

function loadLocalSettings() {
  try {
    const raw = localStorage.getItem('pos_settings');
    if (raw) {
      posSettings = { ...posSettings, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('[POS Settings] Load failed', e);
  }

  // Wire to Settings form
  document.getElementById('settings-enable-scanner').checked = posSettings.enableBarcodeScanner;
  document.getElementById('settings-enable-terminal').checked = posSettings.enablePaymentTerminal;
  document.getElementById('settings-enable-thermal').checked = posSettings.autoPrintOnSale;
  fillReceiptSettingsForm();
}

function saveLocalSettings() {
  posSettings.enableBarcodeScanner = document.getElementById('settings-enable-scanner').checked;
  posSettings.enablePaymentTerminal = document.getElementById('settings-enable-terminal').checked;
  posSettings.autoPrintOnSale = document.getElementById('settings-enable-thermal').checked;

  localStorage.setItem('pos_settings', JSON.stringify(posSettings));
  alert('Settings saved successfully!');
}

document.getElementById('btn-save-settings').addEventListener('click', saveLocalSettings);
document.getElementById('btn-save-receipt-settings')?.addEventListener('click', saveReceiptSettings);
document.getElementById('receipt-settings-card')?.addEventListener('input', renderReceiptSettingsPreview);
document.getElementById('receipt-settings-card')?.addEventListener('change', renderReceiptSettingsPreview);

function specItem(label, value) {
  return `<div class="spec-item"><span>${label}</span><b>${value || '—'}</b></div>`;
}

async function loadMachineInfo() {
  const osEl = document.getElementById('machine-os');
  const specsEl = document.getElementById('machine-specs');
  const storageEl = document.getElementById('app-storage-specs');
  if (!osEl || !specsEl) return;
  try {
    const info = await api.app.getInfo();
    const pc = info.computer || {};
    const mem = pc.memory || {};
    const disk = info.disk || {};
    const store = info.storage || {};
    osEl.textContent = `${pc.platform || ''} ${pc.osRelease || ''} · ${pc.arch || ''}`.trim();
    specsEl.innerHTML = [
      specItem('Computer', pc.hostname),
      specItem('User', pc.username),
      specItem('Processor', pc.cpu),
      specItem('CPU cores', pc.cores),
      specItem('Memory', `${mem.usedLabel || '—'} / ${mem.totalLabel || '—'}`),
      specItem('App version', info.version || info.app?.version),
    ].join('');
    const diskPct = Math.min(100, Number(disk.percentUsed) || 0);
    const memPct = Math.min(100, Number(mem.percentUsed) || 0);
    document.getElementById('disk-used-label').textContent = `${disk.usedLabel || '—'} (${diskPct}%)`;
    document.getElementById('disk-free-label').textContent = `Free ${disk.freeLabel || '—'}`;
    document.getElementById('disk-total-label').textContent = `Total ${disk.totalLabel || '—'}`;
    document.getElementById('disk-used-bar').style.width = `${diskPct}%`;
    document.getElementById('mem-used-label').textContent = `${mem.usedLabel || '—'} (${memPct}%)`;
    document.getElementById('mem-free-label').textContent = `Free ${mem.freeLabel || '—'}`;
    document.getElementById('mem-total-label').textContent = `Total ${mem.totalLabel || '—'}`;
    document.getElementById('mem-used-bar').style.width = `${memPct}%`;
    document.getElementById('app-data-used').textContent = store.appDataLabel || '—';
    document.getElementById('app-install-size').textContent = store.installLabel || '—';
    if (storageEl) {
      storageEl.innerHTML = [
        specItem('Product catalog', store.catalogLabel),
        specItem('Offline cache', store.cacheLabel),
        specItem('Pending queues', store.queueLabel),
        specItem('Session / window', store.sessionLabel),
      ].join('');
    }
    const pathEl = document.getElementById('app-data-path');
    if (pathEl) pathEl.textContent = store.userDataPath || '';
  } catch (err) {
    osEl.textContent = err.message || 'Could not read machine details';
  }
  try { await loadDriveBackupSettings(); } catch (e) { console.warn('backup settings', e); }
}

function formatBackupWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function renderBackupStatus(data) {
  const guideEl = document.getElementById('backup-guide');
  const statusEl = document.getElementById('backup-status-line');
  if (guideEl && data?.guide?.points) {
    guideEl.innerHTML = `<b>${data.guide.title || 'Guide'}</b><ol>${data.guide.points.map((p) => `<li>${p}</li>`).join('')}</ol>`;
  }
  if (statusEl) {
    const conn = data.connected
      ? `Connected as <b>${data.accountEmail || 'Google account'}</b>`
      : 'Not connected to Google Drive';
    const oauth = data.hasOAuthConfig ? 'OAuth credentials ready' : 'OAuth Client ID/Secret missing';
    const last = data.lastBackupAt
      ? `Last backup: ${formatBackupWhen(data.lastBackupAt)} (${data.lastBackupStatus || '—'})`
      : 'No backup yet';
    const err = data.lastBackupError ? `<br><span style="color:#b91c1c;">${data.lastBackupError}</span>` : '';
    statusEl.innerHTML = `${conn} · ${oauth}<br>${last}${err}<br>Drive folder: <b>${data.folderName || 'Bisonstechs POS Backups'}</b>`;
  }
  const en = document.getElementById('backup-enabled');
  if (en) en.checked = Boolean(data.enabled);
  const times = data.times || ['08:00', '14:00', '22:00'];
  ['backup-time-1', 'backup-time-2', 'backup-time-3'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.value = times[i] || '';
  });
  const cid = document.getElementById('backup-client-id');
  if (cid && data.clientId) cid.value = data.clientId;
}

async function loadDriveBackupSettings() {
  if (!api?.backup?.getStatus) return;
  const res = await api.backup.getStatus();
  if (!res?.success) throw new Error(res?.message || 'Failed to load backup settings');
  renderBackupStatus(res.data || {});
}

async function saveDriveBackupSettings() {
  const times = [
    document.getElementById('backup-time-1')?.value,
    document.getElementById('backup-time-2')?.value,
    document.getElementById('backup-time-3')?.value,
  ].filter(Boolean);
  const payload = {
    enabled: Boolean(document.getElementById('backup-enabled')?.checked),
    times,
    clientId: document.getElementById('backup-client-id')?.value || '',
  };
  const secret = document.getElementById('backup-client-secret')?.value || '';
  if (secret.trim()) payload.clientSecret = secret.trim();
  const res = await api.backup.saveSettings(payload);
  if (!res?.success) {
    alert(res?.message || 'Failed to save');
    return;
  }
  if (document.getElementById('backup-client-secret')) {
    document.getElementById('backup-client-secret').value = '';
  }
  renderBackupStatus(res.data || {});
  alert('Backup settings saved on this computer');
}

async function connectGoogleDrive() {
  const statusEl = document.getElementById('backup-status-line');
  if (statusEl) statusEl.textContent = 'Opening Google sign-in in your browser…';
  const res = await api.backup.connect();
  if (!res?.success) {
    alert(res?.message || 'Google connect failed');
    await loadDriveBackupSettings();
    return;
  }
  renderBackupStatus(res.data || {});
  alert('Google Drive connected');
}

async function disconnectGoogleDrive() {
  if (!confirm('Disconnect Google Drive from this POS?')) return;
  const res = await api.backup.disconnect();
  if (!res?.success) {
    alert(res?.message || 'Disconnect failed');
    return;
  }
  renderBackupStatus(res.data || {});
}

async function runBackupNow() {
  const statusEl = document.getElementById('backup-status-line');
  if (statusEl) statusEl.textContent = 'Uploading backup to Google Drive…';
  const res = await api.backup.runNow();
  if (!res?.success) {
    alert(res?.message || 'Backup failed');
    await loadDriveBackupSettings();
    return;
  }
  await loadDriveBackupSettings();
  alert('Backup uploaded to Google Drive');
}

async function refreshDriveBackupList() {
  const select = document.getElementById('backup-restore-select');
  if (!select) return;
  select.innerHTML = '<option value="">Loading…</option>';
  const res = await api.backup.list();
  if (!res?.success) {
    select.innerHTML = '<option value="">— Failed to load —</option>';
    alert(res?.message || 'Could not list backups');
    return;
  }
  const files = res.data || [];
  if (!files.length) {
    select.innerHTML = '<option value="">— No backups found —</option>';
    return;
  }
  select.innerHTML = files
    .map((f) => {
      const when = formatBackupWhen(f.createdTime || f.modifiedTime);
      const sizeKb = f.size ? `${Math.round(f.size / 1024)} KB` : '';
      return `<option value="${f.id}">${when} — ${f.name}${sizeKb ? ` (${sizeKb})` : ''}</option>`;
    })
    .join('');
}

async function restoreSelectedBackup() {
  const fileId = document.getElementById('backup-restore-select')?.value;
  if (!fileId) {
    alert('Select a backup from the list first');
    return;
  }
  const ok = confirm(
    'Restore this backup?\n\nThis overwrites POS data on THIS computer only.\nYour cloud/Railway server will NOT change.\nA local safety zip is created first when possible.'
  );
  if (!ok) return;
  const statusEl = document.getElementById('backup-status-line');
  if (statusEl) statusEl.textContent = 'Restoring from Google Drive…';
  const res = await api.backup.restore(fileId);
  if (!res?.success) {
    alert(res?.message || 'Restore failed');
    await loadDriveBackupSettings();
    return;
  }
  alert(res.data?.message || 'Restore complete. Reloading…');
  window.location.reload();
}

document.getElementById('btn-backup-save')?.addEventListener('click', () => {
  saveDriveBackupSettings().catch((e) => alert(e.message || 'Save failed'));
});
document.getElementById('btn-backup-connect')?.addEventListener('click', () => {
  connectGoogleDrive().catch((e) => alert(e.message || 'Connect failed'));
});
document.getElementById('btn-backup-disconnect')?.addEventListener('click', () => {
  disconnectGoogleDrive().catch((e) => alert(e.message || 'Disconnect failed'));
});
document.getElementById('btn-backup-now')?.addEventListener('click', () => {
  runBackupNow().catch((e) => alert(e.message || 'Backup failed'));
});
document.getElementById('btn-backup-refresh-list')?.addEventListener('click', () => {
  refreshDriveBackupList().catch((e) => alert(e.message || 'List failed'));
});
document.getElementById('btn-backup-restore')?.addEventListener('click', () => {
  restoreSelectedBackup().catch((e) => alert(e.message || 'Restore failed'));
});

// Boot Check
async function boot() {
  window.__bootSteps.push('boot start');
  try { loadLocalSettings(); } catch (e) { window.__bootSteps.push('loadLocalSettings err: ' + e.message); }

  await setupRestaurantUi();

  // 1. Get shift
  window.__bootSteps.push('calling getCurrentShift');
  const res = await api.pos.getCurrentShift();
  if (!res?.success || !res?.data || res.data.status !== 'Open') {
    // If no active shift, redirect to shift gate
    window.location.href = './shift.html';
    return;
  }

  activeShift = res.data;
  window.__bootSteps.push('getCurrentShift done: ' + res.success + ' ' + res.data?.status);
  currentCashier = activeShift.cashier || {};
  currentTerminal = activeShift.terminal || {};
  selectedLocation = currentTerminal.location || {};
  window.__bootSteps.push('shift context ready');

  // Don't auto-sync on boot - let user manually sync or sync in background
  // This prevents app from getting stuck on slow network
  window.__bootSteps.push('about to getProfile');

  // Get Company profile info
  const profRes = await api.pos.getProfile();
  window.__bootSteps.push('getProfile done: ' + profRes?.success);
  if (profRes?.success) {
    companyProfile = profRes.data;
    applyCompanyBranding(companyProfile);
  }

  // Get Tax context (company Tax Compliance from web → local cache)
  const taxRes = await api.tax.getContext();
  window.__bootSteps.push('getTaxContext done: ' + taxRes?.success + ' enabled=' + taxRes?.data?.enabled);
  if (taxRes?.success) {
    taxContext = taxRes.data;
  } else {
    taxContext = { enabled: false, configured: false };
  }
  applyCompanyTaxUi();
  window.__bootSteps.push('about loadCategories');

  // Set top information
  cashierMetaEl.textContent = `Cashier: ${[currentCashier.firstName, currentCashier.lastName].filter(Boolean).join(' ') || currentCashier.email || 'Cashier'}`;

  terminalBadgeEl.textContent = currentTerminal.location?.name
    ? `${currentTerminal.name || 'Terminal'} · ${currentTerminal.location.name}`
    : `${currentTerminal.name || 'Terminal'} · All inventory`;

  setInterval(() => {
    const d = new Date();
    liveClockEl.textContent = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }, 1000);

  setupTabs();

  const stashed = readStashedCatalog();
  if (stashed && stashed.length) {
    categories = stashed;
    renderCategoryLayout();
  }
  await loadCategories();

  updateOfflineCount();
}

async function setupRestaurantUi() {
  let session;
  try {
    session = await api.auth.getSession();
  } catch {
    return;
  }
  const user = session?.user || {};
  if (resolvePosMode(user) !== 'restaurant') return;

  isRestaurantPos = true;
  applyRestaurantBranding(user);

  if (isKitchenRole(user.role)) {
    await api.pos.enterRestaurantPos('kitchen');
    return;
  }

  document.getElementById('tab-btn-ready-orders')?.classList.remove('hidden');
  const readyTabLabel = document.querySelector('#tab-btn-ready-orders span');
  if (readyTabLabel) readyTabLabel.textContent = 'Ready orders';

  const kitchenBtn = document.getElementById('btn-kitchen-display');
  if (kitchenBtn && isManagerRole(user.role)) {
    kitchenBtn.classList.remove('hidden');
    kitchenBtn.addEventListener('click', () => api.pos.enterRestaurantPos('kitchen'));
  }

  document.getElementById('btn-send-kitchen')?.addEventListener('click', () => {
    sendCartToKitchen().catch((err) => showToast(err.message, 'error'));
  });

  document.getElementById('btn-refresh-ready-orders')?.addEventListener('click', () => {
    refreshRestaurantReadyOrders().catch((err) => showToast(err.message, 'error'));
  });

  ['ready-filter-table', 'ready-filter-type', 'ready-filter-ticket'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      restaurantReadyFilters.tableLabel =
        document.getElementById('ready-filter-table')?.value?.trim() || '';
      restaurantReadyFilters.orderType =
        document.getElementById('ready-filter-type')?.value || '';
      restaurantReadyFilters.ticketNumber =
        document.getElementById('ready-filter-ticket')?.value?.trim() || '';
      refreshRestaurantReadyOrders().catch(() => {});
    });
  });

  document.getElementById('ready-orders-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="pay-ready"]');
    if (!btn || btn.disabled) return;
    await payRestaurantReadyOrder(btn);
  });

  if (restaurantReadyPoll) clearInterval(restaurantReadyPoll);
  restaurantReadyPoll = setInterval(() => {
    const panel = document.getElementById('tab-ready-orders');
    if (panel?.classList.contains('active')) {
      refreshRestaurantReadyOrders().catch(() => {});
    }
  }, 5000);
}

function applyRestaurantBranding(user) {
  document.documentElement.classList.add('pos-mode-restaurant');
  document.body.classList.add('pos-mode-restaurant');
  const brand = document.getElementById('company-brand-name') || document.querySelector('.top-brand b');
  const companyName =
    companyProfile?.companyName ||
    companyProfile?.company?.name ||
    companyProfile?.organizationName ||
    '';
  if (brand) brand.textContent = companyName ? `${companyName} · Restaurant` : 'Restaurant POS';
  document.getElementById('restaurant-mode-badge')?.classList.remove('hidden');
  document.getElementById('restaurant-order-panel')?.classList.remove('hidden');

  const sellTab = document.querySelector('.tab-btn[data-tab="sell"] span');
  if (sellTab) sellTab.textContent = 'New order';

  const tableInp = document.getElementById('restaurant-table');
  if (tableInp && !tableInp.value) tableInp.value = '1';
}

function newRestaurantClientRequestId() {
  return `pos-d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function sendCartToKitchen() {
  if (!isRestaurantPos) return;
  if (!cart.length) {
    showToast('Add at least one item to the cart', 'error');
    return;
  }

  const btn = document.getElementById('btn-send-kitchen');
  const prevLabel = btn?.textContent || 'Send to Kitchen';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending to kitchen…';
  }

  try {
    const lines = cart.map((item) => ({
      productId: item.productId || null,
      productName: item.productName,
      sku: item.sku || '',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      notes: item.lineNotes || '',
    }));

    const res = await api.pos.restaurantCreateOrder({
      tableLabel: document.getElementById('restaurant-table')?.value?.trim() || '',
      orderType: document.getElementById('restaurant-order-type')?.value || 'dine_in',
      notes: document.getElementById('restaurant-notes')?.value?.trim() || '',
      locationId: currentLocationId() || undefined,
      shiftId: activeShift?.id || undefined,
      terminalId: activeShift?.terminalId || undefined,
      clientRequestId: newRestaurantClientRequestId(),
      lines,
    });

    if (!res?.success) {
      throw new Error(res?.message || 'Could not send order to kitchen');
    }

    const ticket = res.data?.ticketNumber ?? res.data?.ticket ?? '—';
    showToast(`Sent to kitchen · Ticket #${ticket}`, 'success');
    cart.length = 0;
    renderCartList();
    const notesEl = document.getElementById('restaurant-notes');
    if (notesEl) notesEl.value = '';
  } finally {
    if (btn) {
      btn.textContent = prevLabel;
      btn.disabled = cart.length === 0;
    }
  }
}

function renderRestaurantReadyOrders(orders) {
  const root = document.getElementById('ready-orders-list');
  if (!root) return;

  let list = orders || [];
  if (restaurantReadyFilters.tableLabel) {
    const q = restaurantReadyFilters.tableLabel.toLowerCase();
    list = list.filter((o) => String(o.tableLabel || '').toLowerCase().includes(q));
  }
  if (restaurantReadyFilters.orderType) {
    list = list.filter((o) => o.orderType === restaurantReadyFilters.orderType);
  }
  if (restaurantReadyFilters.ticketNumber) {
    list = list.filter((o) =>
      String(o.ticketNumber || '').includes(restaurantReadyFilters.ticketNumber)
    );
  }

  if (!list.length) {
    root.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--muted);">No orders ready for payment.</div>';
    return;
  }

  root.innerHTML = list
    .map((o) => {
      restaurantOrderVersions.set(o.id, o.version);
      const t = o.timing || {};
      const waiter = restaurantWaiterName(o);
      const served = o.servedAt ? ' · Served' : '';
      return `
    <div class="ready-order-card" data-id="${o.id}" data-version="${o.version || ''}">
      <div class="ticket-head">
        <div>
          <b>Ticket #${o.ticketNumber || '—'} · ${o.tableLabel ? `Table ${o.tableLabel}` : restaurantOrderTypeLabel(o.orderType)}</b>
          <div style="font-size:12px;color:var(--muted);">
            Ready ${restaurantFmtTime(o.readyAt)}
            ${waiter ? ` · ${waiter}` : ''}${served}
            ${t.totalMinutes != null ? ` · ${t.totalMinutes} min total` : ''}
          </div>
        </div>
        <span class="badge-ready">${o.servedAt ? 'SERVED' : 'READY'}</span>
      </div>
      <div class="lines">${(o.lines || [])
        .map((l) => `<div>${l.quantity}× ${l.productName} — ${restaurantMoney(l.lineTotal)}</div>`)
        .join('')}</div>
      <div><strong>Total: ${restaurantMoney(o.grandTotal)}</strong></div>
      <div class="pay-row">
        <label style="font-size:12px;font-weight:600;">Cash received</label>
        <input type="number" min="0" step="0.01" ${isAskCashReceived() ? 'value="" placeholder="Customer paid"' : `value="${Number(o.grandTotal || 0).toFixed(2)}"`} data-cash="${o.id}" />
        <button type="button" class="btn-pay-ready" data-action="pay-ready" data-id="${o.id}">Take payment</button>
      </div>
    </div>`;
    })
    .join('');
}

async function refreshRestaurantReadyOrders() {
  const query = {};
  if (restaurantReadyFilters.tableLabel) query.tableLabel = restaurantReadyFilters.tableLabel;
  if (restaurantReadyFilters.orderType) query.orderType = restaurantReadyFilters.orderType;
  const res = await api.pos.restaurantReadyQueue(query);
  if (res?.success) renderRestaurantReadyOrders(res.data || []);
}

async function payRestaurantReadyOrder(btn) {
  const orderId = btn.dataset.id;
  const card = btn.closest('.ready-order-card');
  const cashInp = card?.querySelector(`input[data-cash="${orderId}"]`);
  const paid = parseFloat(cashInp?.value || '0') || 0;

  const readyRes = await api.pos.restaurantReadyQueue();
  const order = (readyRes?.data || []).find((o) => o.id === orderId);
  if (!order) {
    showToast('Order no longer ready', 'error');
    return;
  }
  if (paid < Number(order.grandTotal || 0)) {
    showToast(`Need at least ${restaurantMoney(order.grandTotal)}`, 'error');
    return;
  }
  if (!activeShift?.terminalId) {
    showToast('Open shift first', 'error');
    return;
  }

  btn.disabled = true;
  try {
    const saleId = `POS-R-${Date.now()}`;
    const payload = {
      id: saleId,
      terminalId: activeShift.terminalId,
      shiftId: activeShift.id,
      locationId: activeShift.locationId || currentLocationId() || undefined,
      invoiceNumber: saleId,
      customerName: order.tableLabel ? `Table ${order.tableLabel}` : 'Restaurant guest',
      restaurantOrderId: order.id,
      items: (order.lines || []).map((l) => ({
        productId: l.productId,
        productName: l.productName,
        sku: l.sku || '',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: 0,
        taxRate: 0,
      })),
      payments: [{ paymentMethod: 'Cash', amount: paid, reference: '' }],
      discountTotal: 0,
      taxTotal: Number(order.taxTotal || 0),
      notes: `Restaurant ticket #${order.ticketNumber || ''}`,
    };

    const localRes = await api.pos.completeSale(payload);
    if (!localRes?.success) {
      showToast(localRes?.message || 'Could not save sale locally', 'error');
      return;
    }

    const markRes = await api.pos.restaurantMarkPaid({
      orderId,
      posSaleId: saleId,
      expectedVersion: restaurantOrderVersions.get(orderId) ?? order.version,
      paymentIdempotencyKey: saleId,
    });
    if (!markRes?.success) {
      console.warn('Order paid locally but API mark failed:', markRes?.message);
    }

    const saleData = localRes.data || payload;
    const grandTotal = Number(order.grandTotal || 0);
    const subtotal = (order.lines || []).reduce(
      (sum, l) => sum + Number(l.lineTotal || (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0)),
      0
    );

    openSaleReceipt(saleData, {
      subtotal,
      grandTotal,
      taxTotal: Number(order.taxTotal || 0),
      discountTotal: 0,
      paidAmount: paid,
      changeAmount: Math.max(0, paid - grandTotal),
      payments: payload.payments,
      notes: `Restaurant ticket #${order.ticketNumber || ''}${order.tableLabel ? ` · Table ${order.tableLabel}` : ''}`.trim(),
      receiptTitle: 'RESTAURANT RECEIPT',
    });

    showToast('Payment saved. Receipt ready — sync when online.', 'success');
    await refreshRestaurantReadyOrders();
    updateOfflineCount();
  } finally {
    btn.disabled = false;
  }
}

function applyCompanyTaxUi() {
  const enabled = Boolean(taxContext?.enabled);
  const taxRow = document.getElementById('tax-summary-row');
  if (taxRow && !enabled) taxRow.style.display = 'none';

  const taxFields = document.getElementById('pf-tax-fields');
  if (taxFields) taxFields.style.display = enabled ? 'contents' : 'none';

  const banner = document.getElementById('tax-status-banner');
  if (banner) {
    if (enabled) {
      const rate = resolveTaxRate(taxContext?.defaultRate);
      banner.style.display = 'block';
      banner.textContent = `Company tax ON · ${taxContext.regime || 'Tax'} · default ${rate}% (${taxContext.pricingModel || 'exclusive'})`;
    } else {
      banner.style.display = 'none';
    }
  }
}

async function refreshCompanyTaxContext() {
  try {
    const res = typeof api.tax.refreshContext === 'function'
      ? await api.tax.refreshContext()
      : await api.tax.getContext();
    if (res?.success && res.data) {
      taxContext = res.data;
      applyCompanyTaxUi();
      calculateTotals();
    }
  } catch (err) {
    console.warn('[tax] refresh failed', err);
  }
}

function setupTabs() {
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;

      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      viewPanels.forEach(panel => {
        panel.classList.remove('active');
        if (panel.id === `tab-${targetTab}`) {
          panel.classList.add('active');
        }
      });

      if (targetTab === 'reports') { try { loadShiftReports(); } catch (e) { console.warn('loadShiftReports not defined', e); } }
      if (targetTab === 'sales') { try { loadSalesRegister(); } catch (e) { console.warn('loadSalesRegister not defined', e); } }
      if (targetTab === 'categories') { try { loadLocalCatalog(); } catch (e) { console.warn('loadLocalCatalog not defined', e); } }
      if (targetTab === 'products') { try { loadLocalProducts(); } catch (e) { console.warn('loadLocalProducts not defined', e); } }
      if (targetTab === 'settings') {
        try { loadMachineInfo(); } catch (e) { console.warn('loadMachineInfo not defined', e); }
        try { fillReceiptSettingsForm(); } catch (e) { console.warn('fillReceiptSettingsForm not defined', e); }
      }
      if (targetTab === 'stock') { try { loadStockPanel(); } catch (e) { console.warn('loadStockPanel not defined', e); } }
      if (targetTab === 'returns') { try { loadReturnHistory(); } catch (e) { console.warn('loadReturnHistory not defined', e); } }
      if (targetTab === 'ready-orders') { try { refreshRestaurantReadyOrders(); } catch (e) { console.warn('refreshRestaurantReadyOrders not defined', e); } }
      if (targetTab === 'sell') {
        setTimeout(() => barcodeScanInp?.focus(), 50);
      }
    });
  });
}

// Offline sync helper — reads pending queue counts from main process
async function updateOfflineCount() {
  try {
    const res = await api.pos.getSyncStatus();
    const data = res?.data || {};
    const count = data.catalogPending || data.totalPending || 0;
    const btnSync = document.getElementById('btn-sync-offline');
    if (!btnSync) return;
    btnSync.style.display = 'flex';
    const badge = document.getElementById('sync-count');
    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (err) {
    console.warn('[sync] getSyncStatus error:', err);
  }
}

// Wire up the Sync button
(function wireSync() {
  const btnSync = document.getElementById('btn-sync-offline');
  if (!btnSync) return;
  btnSync.addEventListener('click', async () => {
    const overlay = document.getElementById('sync-overlay');
    const msg = document.getElementById('sync-overlay-msg');
    btnSync.disabled = true;
    if (overlay) overlay.classList.add('show');

    try {
      // ── STEP 1: Upload all queued offline sales FIRST ──────────────────────
      if (msg) msg.textContent = 'Uploading pending sales to the cloud…';
      let salesResult = null;
      try {
        salesResult = await api.pos.syncOfflineSales();
      } catch (_) { /* ignore — e.g. no internet */ }

      // ── STEP 2: Refresh catalog (skipReload so main process does not
      //   issue its own reloadIgnoringCache before sales upload finishes) ────
      if (msg) msg.textContent = 'Pulling the latest catalog from the cloud…';
      const catalog = await api.pos.syncMasterData({
        refresh: true,
        skipReload: true,
      });

      if (catalog?.offline || catalog?.code === 'OFFLINE') {
        showToast(catalog?.message || 'Cannot reach the API server. Sync skipped.', 'error');
        if (overlay) overlay.classList.remove('show');
        await updateOfflineCount();
        return;
      }

      if (catalog?.success) {
        const n = catalog.counts?.products || 0;
        const c = catalog.counts?.categories || 0;
        const u = catalog.counts?.customers || 0;

        // Build sales sync summary for toast
        let salesToast = '';
        const saleResults = Array.isArray(salesResult?.data?.sales?.data)
          ? salesResult.data.sales.data
          : [];
        if (saleResults.length > 0) {
          const synced  = saleResults.filter(r => r.status === 'success').length;
          const skipped = saleResults.filter(r => r.status === 'skipped').length;
          const failed  = saleResults.filter(r => r.status === 'failed').length;
          if (synced > 0 || skipped > 0) {
            salesToast = ` · ${synced} sale(s) uploaded`;
            if (skipped > 0) salesToast += `, ${skipped} already on cloud`;
          }
          if (failed > 0) salesToast += `, ${failed} failed (will retry)`;
        }

        // Build returns sync summary for toast
        const returnResults = Array.isArray(salesResult?.data?.returns?.data)
          ? salesResult.data.returns.data
          : [];
        if (returnResults.length > 0) {
          const rSynced  = returnResults.filter(r => r.status === 'success').length;
          const rSkipped = returnResults.filter(r => r.status === 'skipped').length;
          const rFailed  = returnResults.filter(r => r.status === 'failed').length;
          if (rSynced > 0 || rSkipped > 0) {
            salesToast += ` · ${rSynced} return(s) uploaded`;
            if (rSkipped > 0) salesToast += `, ${rSkipped} already on cloud`;
          }
          if (rFailed > 0) salesToast += `, ${rFailed} return(s) failed (will retry)`;
        }

        showToast(`Cloud catalog synced · ${c} categories, ${n} products, ${u} customers${salesToast}`, 'success');
        if (overlay) overlay.classList.remove('show');
        await applySyncedCatalog(catalog);
        try { await refreshCompanyTaxContext(); } catch (_) { /* ignore */ }
        window.location.replace(`./sell.html?ts=${Date.now()}`);
        return;
      } else {
        showToast(catalog?.message || 'Sync incomplete', 'error');
      }
    } catch (err) {
      showToast(err.message || 'Sync failed', 'error');
    } finally {
      if (overlay) overlay.classList.remove('show');
      btnSync.disabled = false;
      await updateOfflineCount();
    }
  });
})();


function categoryIdOf(cat) {
  return String(cat?.id || cat?._id || '');
}

function categoryChildren(cat) {
  return (cat?.children || cat?.subCategories || []).filter(c => !!categoryIdOf(c));
}

function rootCategories(tree) {
  if (!tree || !tree.length) return [];
  const hasNested = tree.some(c => categoryChildren(c).length > 0);
  if (hasNested) return tree.filter(c => !!categoryIdOf(c));
  return tree.filter(c => !c.parentId && !!categoryIdOf(c));
}

function unwrapCategoryTree(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.tree)) return res.tree;
  if (Array.isArray(res?.data?.data)) return res.data.data;
  return [];
}

function readStashedCatalog() {
  try {
    const raw = sessionStorage.getItem('pos_synced_catalog');
    if (!raw) return null;
    sessionStorage.removeItem('pos_synced_catalog');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function applySyncedCatalog(catalog) {
  let tree = unwrapCategoryTree(catalog);
  if (!tree.length) {
    const res = await api.pos.getCategories('tree=true');
    tree = unwrapCategoryTree(res);
  }
  categories = tree;
  try {
    sessionStorage.setItem('pos_synced_catalog', JSON.stringify(tree));
  } catch { /* ignore quota */ }
  activeParent = null;
  subcategories = [];
  selectedCategoryId = 'All';
  products = [];
  if (productSearchInp) productSearchInp.value = '';
  renderCategoryLayout();
}

async function loadCategories() {
  // Load from local SQLite first
  let res = await api.catalog.list();
  let tree = Array.isArray(res?.data) ? res.data : [];

  // If local is empty, show a message — user should use Sync button to load from cloud
  if (!tree.length) {
    console.warn('[POS] Local catalog empty — use Sync button to load from cloud');
    // Leave tree empty; the empty state will be rendered below
  }


  // Never blank the grid on a transient failure — keep whatever categories we
  // already have rendered (stash/local replica) instead of showing an empty page.
  if (tree.length || !categories.length) {
    categories = tree;
  }
  renderCategoryLayout();
}

function renderCategoryLayout() {
  if (!categoriesTabsBar || !mainCategoriesGrid || !productsGrid) return;
  categoriesTabsBar.innerHTML = '';

  if (activeParent) {
    const crumbsContainer = document.createElement('div');
    crumbsContainer.className = 'crumbs-container';
    crumbsContainer.style.display = 'flex';
    crumbsContainer.style.alignItems = 'center';
    crumbsContainer.style.gap = '6px';
    crumbsContainer.style.marginBottom = '8px';
    crumbsContainer.style.flexWrap = 'wrap';

    const rootCrumb = document.createElement('span');
    rootCrumb.className = 'category-crumb';
    rootCrumb.innerHTML = '<span style="color: var(--brand); font-weight: bold; cursor: pointer;">Categories</span>';
    rootCrumb.addEventListener('click', goToCategories);
    crumbsContainer.appendChild(rootCrumb);

    const separator = document.createElement('span');
    separator.textContent = '>';
    separator.style.color = '#cbd5e1';
    crumbsContainer.appendChild(separator);

    const parentCrumb = document.createElement('span');
    parentCrumb.className = 'category-crumb active';
    parentCrumb.textContent = activeParent.name;
    crumbsContainer.appendChild(parentCrumb);

    const selectedSub = subcategories.find(c => categoryIdOf(c) === selectedCategoryId);
    if (selectedSub) {
      const sep2 = document.createElement('span');
      sep2.textContent = '>';
      sep2.style.color = '#cbd5e1';
      crumbsContainer.appendChild(sep2);

      const subCrumb = document.createElement('span');
      subCrumb.className = 'category-crumb active';
      subCrumb.textContent = selectedSub.name;
      crumbsContainer.appendChild(subCrumb);
    }

    categoriesTabsBar.appendChild(crumbsContainer);

    const pills = [{ id: categoryIdOf(activeParent), name: 'All' }, ...subcategories];
    const tabsRow = document.createElement('div');
    tabsRow.className = 'subcategories-tabs-row';
    tabsRow.style.display = 'flex';
    tabsRow.style.gap = '8px';
    tabsRow.style.overflowX = 'auto';
    tabsRow.style.paddingBottom = '8px';
    tabsRow.style.width = '100%';

    pills.forEach((cat) => {
      const catId = categoryIdOf(cat);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `category-tab-btn ${selectedCategoryId === catId ? 'selected' : ''}`;
      btn.textContent = cat.name;
      btn.addEventListener('click', () => handleCategorySelect(catId));
      tabsRow.appendChild(btn);
    });
    categoriesTabsBar.appendChild(tabsRow);

    // Hide categories grid, show products grid
    mainCategoriesGrid.style.display = 'none';
    productsGrid.style.display = 'grid';

  } else {
    categoriesTabsBar.innerHTML = `<span class="category-crumb active">All Categories</span>`;

    mainCategoriesGrid.innerHTML = '';
    const mains = rootCategories(categories);
    if (mains.length === 0) {
      mainCategoriesGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 24px;">No categories found</div>';
    } else {
      mains.forEach(cat => {
        const card = document.createElement('div');
        card.className = 'category-card';
        card.innerHTML = `
          <span style="font-size:32px; color: var(--brand);">📁</span>
          <span><b>${cat.name}</b></span>
        `;
        card.addEventListener('click', () => openMainCategory(cat));
        mainCategoriesGrid.appendChild(card);
      });
    }

    productsGrid.style.display = 'none';
    mainCategoriesGrid.style.display = 'grid';
  }
}

function openMainCategory(cat) {
  const kids = categoryChildren(cat);
  activeParent = cat;
  subcategories = kids;
  selectedCategoryId = categoryIdOf(cat);
  productSearchInp.value = '';
  renderCategoryLayout();
  loadCategoryProducts(selectedCategoryId);
}

function goToCategories() {
  activeParent = null;
  subcategories = [];
  selectedCategoryId = 'All';
  productSearchInp.value = '';
  products = [];
  renderCategoryLayout();
}

function handleCategorySelect(catId) {
  selectedCategoryId = catId;
  renderCategoryLayout();
  loadCategoryProducts(catId);
}

async function loadCategoryProducts(categoryId) {
  const locationId = currentLocationId() || '';

  productsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 48px;"><span class="spinner-sm" style="border-top-color: var(--brand); width: 24px; height: 24px;"></span> Loading products...</div>';

  // Load from local SQLite first
  let res = await api.catalog.listProducts();
  let productList = Array.isArray(res?.data) ? res.data : [];

  // Filter by category if specified
  if (categoryId && categoryId !== 'All') {
    productList = productList.filter(p => p.categoryId === categoryId || p.category_id === categoryId);
  }

  if (productList.length) {
    products = productList;
    renderProducts();
  } else {
    // If local is empty, show message — user should use Sync button
    console.warn('[POS] Local products empty — use Sync button to load from cloud');
    productsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 24px;">No products found — use Sync to load from cloud</div>`;
  }
}

function renderProducts() {
  productsGrid.innerHTML = '';
  mainCategoriesGrid.style.display = 'none';
  productsGrid.style.display = 'grid';

  if (products.length === 0) {
    productsGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 48px;">
        <span style="font-size: 40px; opacity: 0.5;">📦</span>
        <p style="margin-top: 8px;">No products found</p>
        <button type="button" class="btn-clear-cart" style="display: inline-block; margin-top: 12px; background-color: var(--brand); color: #fff; padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer;" id="btn-back-to-categories-empty">Back to Categories</button>
      </div>
    `;
    document.getElementById('btn-back-to-categories-empty').addEventListener('click', goToCategories);
    return;
  }

  // Go back button inside products view to quickly reset
  const backCard = document.createElement('div');
  backCard.className = 'prod-card';
  backCard.style.justifyContent = 'center';
  backCard.style.alignItems = 'center';
  backCard.innerHTML = `
    <span style="font-size: 28px;">📂</span>
    <b>All Categories</b>
  `;
  backCard.addEventListener('click', goToCategories);
  productsGrid.appendChild(backCard);

  products.forEach(p => {
    const card = document.createElement('div');
    card.className = 'prod-card';
    const img = p.mainImage || p.image || '';
    const imgSrc = String(img).replace(/"/g, '&quot;');
    card.innerHTML = `
      <div class="prod-card-img">
        ${img ? `<img src="${imgSrc}" alt="${p.name}" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline';" />` : ''}
        <span style="font-size: 28px; ${img ? 'display: none;' : ''}">📦</span>
      </div>
      <b>${p.name}</b>
      <span>SKU: ${p.sku || 'N/A'}</span>
      <div class="prod-card-price">${pkr(p.sellingPrice)}</div>
      <div class="prod-card-stock" style="color: ${p.currentStock <= 0 ? '#ef4444' : p.currentStock <= 5 ? '#f59e0b' : '#10b981'}">
        Stock: ${p.currentStock || 0}
      </div>
    `;
    card.addEventListener('click', () => addProductToCart(p));
    productsGrid.appendChild(card);
  });
}

// Live Search with Debounce
productSearchInp?.addEventListener('input', () => {
  const query = productSearchInp.value.trim();
  if (customerSearchTimeout) clearTimeout(customerSearchTimeout);

  if (!query) {
    if (!activeParent) {
      renderCategoryLayout();
    } else {
      loadCategoryProducts(selectedCategoryId);
    }
    return;
  }

  customerSearchTimeout = setTimeout(async () => {
    const locationId = currentLocationId() || '';
    const payload = {
      query: query,
      limit: '50',
      locationId: locationId
    };
    if (activeParent) {
      payload.categoryId = selectedCategoryId;
    }

    productsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 48px;"><span class="spinner-sm" style="border-top-color: var(--brand); width: 24px; height: 24px;"></span> Searching products...</div>';

    const res = await api.pos.searchProducts(payload);
    if (res?.success && Array.isArray(res.data)) {
      products = res.data;
      renderProducts();
    } else {
      productsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #ef4444; padding: 24px;">${res?.message || 'Error searching products'}</div>`;
    }
  }, 300);
});

function playScanBeep(ok = true) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = ok ? 980 : 240;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, ok ? 80 : 160);
  } catch { /* ignore */ }
}

function setScanStatus(message, kind = '') {
  const wrap = document.getElementById('barcode-scan-status');
  const text = document.getElementById('barcode-scan-status-text');
  if (text) text.textContent = message;
  if (wrap) wrap.className = `scan-status ${kind}`.trim();
}

function isSellTabActive() {
  return document.getElementById('tab-sell')?.classList.contains('active');
}

function isProductsTabActive() {
  return document.getElementById('tab-products')?.classList.contains('active');
}

function isStockTabActive() {
  return document.getElementById('tab-stock')?.classList.contains('active');
}

function isReturnsTabActive() {
  return document.getElementById('tab-returns')?.classList.contains('active');
}

function isPosOverlayOpen() {
  return [
    'checkout-modal-overlay',
    'modal-close-shift',
    'modal-cash-flow',
    'modal-add-customer',
    'modal-receipt',
    'modal-manager-pin',
    'cat-overlay',
    'prod-overlay',
    'prod-quick-overlay',
  ].some((id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const display = window.getComputedStyle(el).display;
    return display && display !== 'none';
  });
}

function normalizeScanInput(code) {
  if (typeof window.normalizeScanCode === 'function') return window.normalizeScanCode(code);
  return String(code || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function routeScannedCode(code) {
  const trimmed = normalizeScanInput(code);
  if (!trimmed) return;

  if (isReturnsTabActive()) {
    const searchInp = document.getElementById('return-search-invoice');
    if (searchInp) {
      searchInp.value = trimmed;
      document.getElementById('btn-search-return')?.click();
    }
    return;
  }
  if (isProductsTabActive()) {
    const scanInp = document.getElementById('prod-barcode-scan');
    const searchInp = document.getElementById('prod-search');
    if (searchInp) {
      searchInp.value = trimmed;
      renderLocalProducts();
    }
    if (scanInp) {
      scanInp.style.borderColor = '#22c55e';
      scanInp.style.background = '#f0fdf4';
      setTimeout(() => { scanInp.style.borderColor = ''; scanInp.style.background = '#fff'; }, 800);
    }
    return;
  }
  if (isStockTabActive()) {
    const scanInp = document.getElementById('stock-barcode-scan');
    if (scanInp) {
      scanInp.value = trimmed;
      const matched = localProducts.find((p) =>
        [p.barcode, p.barcodeNumber, p.sku, p.qrCode, p.qr_code]
          .some((v) => String(v || '').trim() === trimmed)
      );
      if (matched) {
        applyStockProductSelection(matched);
        showStockFormAlert('Product matched successfully!', 'success');
      } else {
        showStockFormAlert(`No local product found for barcode/SKU: ${trimmed}`, 'error');
      }
      scanInp.style.borderColor = '#22c55e';
      scanInp.style.background = '#f0fdf4';
      setTimeout(() => { scanInp.style.borderColor = ''; scanInp.style.background = '#fff'; }, 800);
    }
    return;
  }
  void applyScannedCode(trimmed);
}

async function applyScannedCode(code) {
  const trimmed = normalizeScanInput(code);
  if (!trimmed) return;
  if (posSettings.enableBarcodeScanner === false) return;
  if (barcodeScanInp) barcodeScanInp.value = '';
  if (productSearchInp && productSearchInp.value.trim() === trimmed) productSearchInp.value = '';
  setScanStatus(`Looking up ${trimmed}…`);
  try {
    const locationId = currentLocationId() || '';
    const res = await api.pos.byBarcode(trimmed, locationId);
    const product = res?.success ? res.data : null;
    if (!product) {
      playScanBeep(false);
      setScanStatus(`No product found for ${trimmed}`, 'error');
      barcodeScanInp?.focus();
      return;
    }
    addProductToCart(product);
    playScanBeep(true);
    setScanStatus(`Added ${product.name}`, 'ok');
    barcodeScanInp?.focus();
  } catch (err) {
    playScanBeep(false);
    setScanStatus(err.message || 'Scan failed', 'error');
  }
}

function attachHidBarcodeScanner() {
  let buffer = '';
  let lastAt = 0;
  let timer = null;
  const MIN_LEN = 3;
  // Fallback for wedge scanners that do not send Enter; must be long enough for full code
  const IDLE_MS = 450;

  const clearBuffer = () => {
    buffer = '';
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flushBuffer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const code = buffer.trim();
    buffer = '';
    if (code.length < MIN_LEN) return;
    routeScannedCode(code);
  };

  document.addEventListener('keydown', (e) => {
    if (posSettings.enableBarcodeScanner === false) return;
    const onScanTab = isSellTabActive() || isProductsTabActive() || isStockTabActive() || isReturnsTabActive();
    if (!onScanTab || isPosOverlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const target = e.target;
    const tag = String(target?.tagName || '').toLowerCase();
    const isScanField = target?.dataset?.posScan === '1' || target?.id === 'barcode-scan-box';

    if (tag === 'textarea') return;

    const isEnter = e.key === 'Enter' || e.key === 'NumpadEnter';

    // Dedicated scan inputs: use the field value on Enter (most reliable for USB scanners)
    if (isScanField) {
      if (isEnter || e.key === 'Tab') {
        const typed = String(target.value || '').trim();
        if (!typed) return;
        e.preventDefault();
        e.stopPropagation();
        target.value = '';
        clearBuffer();
        routeScannedCode(typed);
      }
      return;
    }

    // Normal text/search/number fields (product search, qty, etc.): never treat as HID wedge
    if (tag === 'input' || tag === 'select') {
      clearBuffer();
      return;
    }

    if (isEnter || e.key === 'Tab') {
      if (buffer.trim().length >= MIN_LEN) {
        e.preventDefault();
        e.stopPropagation();
        flushBuffer();
      } else {
        clearBuffer();
      }
      return;
    }

    if (e.key.length !== 1) return;

    const now = Date.now();
    buffer += e.key;
    lastAt = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushBuffer, IDLE_MS);
  }, true);
}

attachHidBarcodeScanner();
setTimeout(() => barcodeScanInp?.focus(), 200);

// ─── CART persistence ────────────────────────────────────────────────────────
const POS_CURRENCY = 'PKR';

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Display money amounts in PKR across POS UI */
function pkr(n) {
  return `${POS_CURRENCY} ${money(n).toFixed(2)}`;
}

function lineAmount(item) {
  const price = money(item.unitPrice ?? item.price);
  const qty = money(item.quantity);
  return price * qty;
}

function calculateTotals() {
  const subtotal = cart.reduce((acc, item) => acc + lineAmount(item), 0);

  // Calculate discount
  let discountTotal = 0;
  if (discountMode === 'pct') {
    discountTotal = money(((money(subtotal) * money(overallDiscount)) / 100).toFixed(2));
  } else {
    discountTotal = Math.min(money(cartDiscountAmount), money(subtotal));
  }

  // Calculate tax
  let taxTotal = 0;
  const regime = taxContext?.regime || 'GST';
  const pricingModel = taxContext?.pricingModel || 'exclusive';

  cart.forEach(item => {
    // calculate line-item tax
    const linePrice = lineAmount(item);
    const lineDisc = (linePrice * (item.discount || 0)) / 100;
    const netLinePrice = linePrice - lineDisc;

    let lineTax = 0;
    if (taxContext?.enabled) {
      const rate = resolveTaxRate(item.taxRate);
      if (pricingModel === 'inclusive') {
        lineTax = netLinePrice - (netLinePrice / (1 + (rate / 100)));
      } else {
        lineTax = (netLinePrice * rate) / 100;
      }
    }
    item.taxAmount = money(lineTax);
    taxTotal += item.taxAmount;
  });

  const finalTax = money(taxTotal.toFixed(2));

  // grand total
  let grandTotal = 0;
  if (pricingModel === 'inclusive') {
    grandTotal = subtotal - discountTotal;
  } else {
    grandTotal = subtotal - discountTotal + finalTax;
  }
  grandTotal = money(Math.max(0, money(grandTotal)).toFixed(2));

  // update DOM
  const qtyTotal = money(cart.reduce((acc, item) => acc + money(item.quantity), 0));
  if (cartQtyCountEl) cartQtyCountEl.textContent = qtyTotal;
  const itemsQtyEl = document.getElementById('cart-items-qty-total');
  if (itemsQtyEl) itemsQtyEl.textContent = String(qtyTotal);
  if (cartSubtotalEl) cartSubtotalEl.textContent = `${pkr(subtotal)}`;
  if (cartDiscountValueEl) cartDiscountValueEl.textContent = `-${pkr(discountTotal)}`;

  if (taxContext?.enabled && finalTax > 0) {
    if (taxSummaryRow) taxSummaryRow.style.display = 'flex';
    if (taxRegimeLabel) taxRegimeLabel.textContent = `${regime}${pricingModel === 'inclusive' ? ' (incl.)' : ''}`;
    if (cartTaxValueEl) cartTaxValueEl.textContent = `${pkr(finalTax)}`;
  } else if (taxSummaryRow) {
    taxSummaryRow.style.display = 'none';
  }

  if (cartGrandTotalEl) cartGrandTotalEl.textContent = `${pkr(grandTotal)}`;
  if (checkoutGrandTotalEl) checkoutGrandTotalEl.textContent = `${pkr(grandTotal)}`;

  const disabled = cart.length === 0;
  if (btnCheckoutTrigger) btnCheckoutTrigger.disabled = disabled;
  const btnCreditSale = document.getElementById('btn-credit-sale-trigger');
  if (btnCreditSale) btnCreditSale.disabled = disabled;
  if (btnHoldSaleTrigger) btnHoldSaleTrigger.disabled = disabled;
  if (btnClearCart) btnClearCart.style.display = disabled ? 'none' : 'block';
  const btnSendKitchen = document.getElementById('btn-send-kitchen');
  if (btnSendKitchen && isRestaurantPos) btnSendKitchen.disabled = disabled;

  return { subtotal, discountTotal, taxTotal: finalTax, grandTotal };
}

function resolveTaxRate(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'object') {
    raw = raw.rate ?? raw.value ?? raw.percentage ?? raw.taxRate ?? 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function isFractionalUnitName(unit) {
  const u = String(unit || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!u) return false;
  if (/^(KG|KGS|G|GS|GRAM|GRAMS|KILOGRAM|KILOGRAMS|LTR|L|LITRE|LITER|LITRES|LITERS|ML|M|MTR|METER|METRE)$/.test(u)) return true;
  return u.includes('KILO') || u.includes('GRAM') || u.includes('LITR') || u.includes('MILLI') || u.includes('METR');
}

function weightQuickAmounts(unit) {
  const u = String(unit || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (u === 'G' || u.includes('GRAM')) return [50, 100, 250, 500, 750, 1000];
  if (u === 'ML' || u.includes('MILLI')) return [50, 100, 250, 500, 750, 1000];
  return [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 5];
}

function formatSellQty(qty, unit) {
  const n = Number(qty) || 0;
  const text = Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  const u = String(unit || '').trim();
  return u ? `${text} ${u}` : text;
}

function resolveUom(p = {}) {
  const stockUnit = String(p.stockUnitName || p.stockUnit || 'Pcs').trim() || 'Pcs';
  const salesUnit = String(p.salesUnitName || p.unitName || stockUnit).trim() || stockUnit;
  const salesFactor = Number(p.salesConversionFactor) > 0 ? Number(p.salesConversionFactor) : 1;
  const allowFractional = Boolean(
    p.allowFractionalQty || isFractionalUnitName(stockUnit) || isFractionalUnitName(salesUnit)
  );
  return { stockUnit, salesUnit, salesFactor, allowFractional, step: allowFractional ? 0.1 : 1 };
}

/** POS keeps 3 decimals so 1.5 KG works even if product was saved as Pcs. */
function normalizeCartQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1000) / 1000;
}

function maxSellable(p) {
  const uom = resolveUom(p);
  const avail = Number(p.availableStock ?? p.currentStock ?? 0) || 0;
  if (uom.salesFactor <= 0) return 0;
  return normalizeCartQty(Math.max(0, avail / uom.salesFactor));
}

function commitProductQtyToCart(p, rawQty, mode = 'add') {
  const uom = resolveUom(p);
  const maxQty = maxSellable(p);
  const qty = normalizeCartQty(rawQty);

  if (maxQty <= 0) {
    showToast(`⚠️ Cannot add ${p.name} - Out of stock!`, 'error');
    return false;
  }
  if (qty <= 0) {
    showToast(`Enter a valid quantity in ${uom.salesUnit}`, 'error');
    return false;
  }
  if (qty > maxQty + 1e-9) {
    showToast(`Only ${formatSellQty(maxQty, uom.salesUnit)} available`, 'error');
    return false;
  }

  const fractional = uom.allowFractional || Math.abs(qty - Math.round(qty)) > 1e-9;
  const existing = cart.find((item) => item.productId === p.id);
  if (existing) {
    const nextQty = mode === 'edit' ? qty : normalizeCartQty(existing.quantity + qty);
    if (nextQty > maxQty + 1e-9) {
      showToast(`Cannot add more. Stock limit reached for ${p.name}!`, 'error');
      return false;
    }
    existing.quantity = nextQty;
    existing.unitName = uom.salesUnit;
    existing.stockUnitName = uom.stockUnit;
    existing.salesConversionFactor = uom.salesFactor;
    existing.allowFractionalQty = fractional || Boolean(existing.allowFractionalQty);
    existing.lineTotal = existing.quantity * existing.unitPrice;
  } else {
    const rate = resolveTaxRate(p.taxRate)
      || (taxContext?.enabled ? resolveTaxRate(taxContext.defaultRate) : 0);
    const unitPrice = Number(p.sellingPrice || p.price || 0) || 0;
    cart.push({
      productId: p.id,
      productName: p.name,
      sku: p.sku || '',
      quantity: qty,
      unitPrice,
      discount: 0,
      taxRate: taxContext?.enabled ? rate : 0,
      taxAmount: 0,
      lineTotal: unitPrice * qty,
      currentStock: p.currentStock ?? p.availableStock ?? 0,
      availableStock: p.availableStock ?? p.currentStock ?? 0,
      unitName: uom.salesUnit,
      stockUnitName: uom.stockUnit,
      salesConversionFactor: uom.salesFactor,
      allowFractionalQty: fractional,
      isCustom: false,
    });
  }
  renderCartList();
  return true;
}

function promptProductQty(p, mode = 'add') {
  const uom = resolveUom(p);
  const maxQty = maxSellable(p);
  if (maxQty <= 0) {
    showToast(`⚠️ Cannot add ${p.name} - Out of stock!`, 'error');
    return;
  }

  document.getElementById('pos-qty-prompt')?.remove();
  const existing = cart.find((item) => item.productId === p.id);
  const quick = uom.allowFractional ? weightQuickAmounts(uom.salesUnit) : [1, 2, 3, 5, 10];
  const initial = mode === 'edit' && existing ? String(existing.quantity) : (uom.allowFractional ? '' : '1');

  const overlay = document.createElement('div');
  overlay.id = 'pos-qty-prompt';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:20px;width:100%;max-width:360px;box-shadow:0 20px 50px rgba(0,0,0,0.25);">
      <h3 style="margin:0 0 4px;font-size:18px;color:#0f172a;">${mode === 'edit' ? 'Edit quantity' : 'Enter quantity'}</h3>
      <p style="margin:0 0 12px;color:#64748b;font-size:13px;">${p.name || ''}</p>
      <p style="margin:0 0 12px;color:#94a3b8;font-size:12px;">
        Price ${pkr(Number(p.sellingPrice || p.price || 0))} / ${uom.salesUnit}
        · Available ${formatSellQty(maxQty, uom.salesUnit)}
      </p>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input id="pos-qty-input" type="number" min="0.001" step="0.001" inputmode="decimal"
          value="${initial}" placeholder="${uom.allowFractional ? 'e.g. 1.5' : 'e.g. 1'}"
          style="flex:1;border:2px solid #014582;border-radius:12px;padding:12px;font-size:24px;font-weight:700;text-align:center;outline:none;" />
        <div style="min-width:56px;display:flex;align-items:center;justify-content:center;background:#e0f2fe;color:#014582;border-radius:12px;font-weight:700;font-size:13px;">
          ${uom.salesUnit}
        </div>
      </div>
      <div id="pos-qty-quick" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;"></div>
      <p id="pos-qty-error" style="display:none;color:#dc2626;font-size:12px;margin:0 0 10px;"></p>
      <div style="display:flex;gap:8px;">
        <button type="button" id="pos-qty-cancel" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;font-weight:600;cursor:pointer;">Cancel</button>
        <button type="button" id="pos-qty-ok" style="flex:1;padding:10px;border:none;border-radius:12px;background:#014582;color:#fff;font-weight:700;cursor:pointer;">
          ${mode === 'edit' ? 'Update' : 'Add to cart'}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#pos-qty-input');
  const errEl = overlay.querySelector('#pos-qty-error');
  const quickEl = overlay.querySelector('#pos-qty-quick');
  quick.forEach((q) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = formatSellQty(q, uom.salesUnit);
    btn.style.cssText = 'padding:6px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-size:12px;font-weight:600;cursor:pointer;';
    btn.addEventListener('click', () => {
      input.value = String(q);
      errEl.style.display = 'none';
      input.focus();
    });
    quickEl.appendChild(btn);
  });

  const close = () => overlay.remove();
  const submit = () => {
    const ok = commitProductQtyToCart(p, parseFloat(input.value), mode);
    if (ok) close();
    else {
      errEl.textContent = `Enter a valid qty in ${uom.salesUnit} (max ${formatSellQty(maxQty, uom.salesUnit)})`;
      errEl.style.display = 'block';
    }
  };

  overlay.querySelector('#pos-qty-cancel').addEventListener('click', close);
  overlay.querySelector('#pos-qty-ok').addEventListener('click', submit);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function addProductToCart(p) {
  promptProductQty(p, 'add');
}

function renderCartList() {
  cartItemsListContainer.innerHTML = '';

  cart.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'cart-item-row';
    row.innerHTML = `
      <div class="cart-item-row-top">
        <div class="cart-item-info">
          <b>${item.productName}</b>
          <span>${formatSellQty(item.quantity, item.unitName || 'Pcs')} × ${pkr(item.unitPrice)}</span>
        </div>
        <div class="cart-item-total">${pkr(Number(item.unitPrice || 0) * Number(item.quantity || 0))}</div>
      </div>
      <div class="cart-item-controls">
        <div class="cart-item-qty">
          <button class="btn-qty btn-minus" data-idx="${index}">-</button>
          <button type="button" class="btn-edit-qty" data-idx="${index}" title="Edit quantity"
            style="min-width:72px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;font-weight:700;cursor:pointer;font-size:12px;">
            ${formatSellQty(item.quantity, item.unitName || 'Pcs')}
          </button>
          <button class="btn-qty btn-plus" data-idx="${index}">+</button>
        </div>
        <div class="cart-item-disc">
          <span>Disc %:</span>
          <input type="number" class="inp-item-disc" data-idx="${index}" value="${item.discount || 0}" min="0" max="100" />
          <button style="border:none;background:transparent;color:#ef4444;font-weight:bold;cursor:pointer;" class="btn-remove-item" data-idx="${index}">✕</button>
        </div>
      </div>
    `;

    // Wire listeners
    const step = resolveUom(item).step;
    row.querySelector('.btn-minus').addEventListener('click', () => {
      const next = normalizeCartQty(item.quantity - step);
      if (next > 0) {
        item.quantity = next;
        item.lineTotal = item.quantity * item.unitPrice;
      } else {
        cart.splice(index, 1);
      }
      renderCartList();
    });

    row.querySelector('.btn-plus').addEventListener('click', () => {
      const maxQty = maxSellable(item);
      const next = normalizeCartQty(item.quantity + step);
      if (!item.isCustom && next > maxQty + 1e-9) {
        showToast(`Stock limit for ${item.productName}`, 'error');
        return;
      }
      item.quantity = next;
      item.allowFractionalQty = Boolean(item.allowFractionalQty) || Math.abs(next - Math.round(next)) > 1e-9;
      item.lineTotal = item.quantity * item.unitPrice;
      renderCartList();
    });

    row.querySelector('.btn-edit-qty')?.addEventListener('click', () => {
      if (item.isCustom) return;
      promptProductQty({
        id: item.productId,
        name: item.productName,
        sku: item.sku,
        sellingPrice: item.unitPrice,
        currentStock: item.currentStock,
        availableStock: item.availableStock,
        taxRate: item.taxRate,
        salesUnitName: item.unitName,
        stockUnitName: item.stockUnitName,
        salesConversionFactor: item.salesConversionFactor,
        allowFractionalQty: item.allowFractionalQty,
      }, 'edit');
    });

    row.querySelector('.inp-item-disc').addEventListener('change', (e) => {
      const val = parseFloat(e.target.value) || 0;
      item.discount = Math.min(Math.max(0, val), 100);
      calculateTotals();
    });

    row.querySelector('.btn-remove-item').addEventListener('click', () => {
      cart.splice(index, 1);
      renderCartList();
    });

    cartItemsListContainer.appendChild(row);
  });

  calculateTotals();
}

function parseCustomPrice() {
  const raw = String(customLinePriceInp?.value || '').replace(/[^0-9.]/g, '');
  const price = parseFloat(raw);
  return Number.isFinite(price) ? price : 0;
}

function parseCustomQty() {
  const qty = Math.max(0.001, parseFloat(String(customLineQtyInp?.value || '1')) || 1);
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

function updateCustomLinePreview() {
  const el = document.getElementById('custom-line-total');
  if (!el) return;
  const price = parseCustomPrice();
  const qty = parseCustomQty();
  el.textContent = `${pkr(price * qty)}`;
}

if (customLinePriceInp) customLinePriceInp.addEventListener('input', updateCustomLinePreview);
if (customLineQtyInp) customLineQtyInp.addEventListener('input', updateCustomLinePreview);
if (customLineNameInp) {
  customLineNameInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnAddCustomLine?.click();
  });
}
if (customLinePriceInp) {
  customLinePriceInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnAddCustomLine?.click();
  });
}
if (customLineQtyInp) {
  customLineQtyInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnAddCustomLine?.click();
  });
}
updateCustomLinePreview();

btnAddCustomLine?.addEventListener('click', () => {
  const name = (customLineNameInp?.value || '').trim();
  const price = parseCustomPrice();
  const qty = parseCustomQty();

  if (!name) {
    alert('Please enter an item name.');
    return;
  }
  if (price <= 0) {
    alert('Please enter a price greater than 0.');
    customLinePriceInp?.focus();
    return;
  }

  cart.push({
    productId: `custom-${Date.now()}`,
    productName: name,
    sku: 'CUSTOM',
    quantity: qty,
    unitPrice: price,
    discount: 0,
    taxRate: taxContext?.enabled ? resolveTaxRate(taxContext?.defaultRate) : 0,
    taxAmount: 0,
    lineTotal: price * qty,
    currentStock: 9999,
    isCustom: true
  });

  customLineNameInp.value = '';
  customLinePriceInp.value = '';
  customLineQtyInp.value = '1';
  updateCustomLinePreview();
  renderCartList();
});

// Clear Cart button
btnClearCart.addEventListener('click', () => {
  cart = [];
  selectedCustomer = null;
  customerCreditInfo = null;
  overallDiscount = 0;
  cartDiscountAmount = 0;
  document.getElementById('cart-discount-input').value = 0;
  customerSearchInp.value = '';
  custCreditInfoCard.style.display = 'none';
  renderCartList();
});

// Overall discount inputs
document.getElementById('cart-discount-mode').addEventListener('change', (e) => {
  discountMode = e.target.value;
  calculateTotals();
});

document.getElementById('cart-discount-input').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value) || 0;
  if (discountMode === 'pct') {
    overallDiscount = val;
  } else {
    cartDiscountAmount = val;
  }
  calculateTotals();
});

// ─── CUSTOMERS AUTCOMPLETE ───────────────────────────────────────────────────
customerSearchInp.addEventListener('input', () => {
  const query = customerSearchInp.value.trim();
  if (customerSearchTimeout) clearTimeout(customerSearchTimeout);

  if (query.length < 2) {
    customerDropdown.style.display = 'none';
    return;
  }

  customerSearchTimeout = setTimeout(async () => {
    const res = await api.pos.searchCustomers(query, 10);
    customerDropdown.innerHTML = '';

    if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
      res.data.forEach(c => {
        const item = document.createElement('div');
        item.className = 'cust-item';
        item.innerHTML = `
          <b>${c.name}</b>
          <span>Phone: ${c.phone || 'N/A'} | Email: ${c.email || 'N/A'}</span>
        `;
        item.addEventListener('click', () => {
          selectCustomer(c);
        });
        customerDropdown.appendChild(item);
      });
      customerDropdown.appendChild(createAddNewCustomerBtn(query));
      customerDropdown.style.display = 'block';
    } else {
      customerDropdown.appendChild(createAddNewCustomerBtn(query));
      customerDropdown.style.display = 'block';
    }
  }, 300);
});

function createAddNewCustomerBtn(query) {
  const btn = document.createElement('div');
  btn.className = 'cust-item';
  btn.style.textAlign = 'center';
  btn.style.fontWeight = 'bold';
  btn.style.color = 'var(--brand)';
  btn.innerHTML = `+ Add "${query}" as New Customer`;
  btn.addEventListener('click', () => {
    customerDropdown.style.display = 'none';
    document.getElementById('cust-new-name').value = query;
    modalAddCustomer.style.display = 'flex';
  });
  return btn;
}

async function selectCustomer(c) {
  selectedCustomer = c;
  customerCreditInfo = null;
  customerSearchInp.value = c.name;
  customerDropdown.style.display = 'none';
  custCreditInfoCard.style.display = 'none';
}

// Click anywhere closes autocomplete customer dropdown
document.addEventListener('click', (e) => {
  if (!customerSearchInp.contains(e.target) && !customerDropdown.contains(e.target)) {
    customerDropdown.style.display = 'none';
  }
});

// Add customer modal handling
document.getElementById('btn-add-customer-cancel').addEventListener('click', () => modalAddCustomer.style.display = 'none');
document.getElementById('btn-add-customer-no').addEventListener('click', () => modalAddCustomer.style.display = 'none');
document.getElementById('btn-add-customer-yes').addEventListener('click', async () => {
  const name = document.getElementById('cust-new-name').value.trim();
  const email = document.getElementById('cust-new-email').value.trim();
  const phone = document.getElementById('cust-new-phone').value.trim();
  const company = document.getElementById('cust-new-company').value.trim();
  const type = document.getElementById('cust-new-type').value;

  if (!name) {
    alert('Customer name is required!');
    return;
  }

  const payload = {
    name,
    email: email || undefined,
    phone: phone || undefined,
    company: company || undefined,
    customerType: type
  };

  const res = await api.pos.createCustomer(payload);
  if (res?.success && res.data) {
    selectCustomer(res.data);
    modalAddCustomer.style.display = 'none';
  } else {
    alert(res?.message || 'Could not create customer');
  }
});

function isCreditMethod(method) {
  return String(method || '').toLowerCase().includes('credit');
}

function saleHasCredit() {
  return payments.some((p) => isCreditMethod(p.paymentMethod) && money(p.amount) > 0);
}

function canSellOnCredit(amount) {
  if (!selectedCustomer?.id) {
    alert('Select a customer first to sell on credit.');
    return false;
  }
  const limit = money(customerCreditInfo?.creditLimit);
  const available = money(customerCreditInfo?.availableCredit);
  if (limit > 0 && amount > available + 0.009) {
    alert(`Credit limit exceeded. Available: ${pkr(available)}`);
    return false;
  }
  return true;
}

function highlightPayQuick(method) {
  document.querySelectorAll('.pay-quick').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-method') === method);
  });
}

function cashReceivedStartAmount(method, grandTotal) {
  if (isAskCashReceived() && String(method || 'Cash').toLowerCase() === 'cash') return 0;
  return grandTotal;
}

function setCheckoutMethod(method) {
  const totals = calculateTotals();
  if (isCreditMethod(method) && !canSellOnCredit(totals.grandTotal)) return;
  payments = [{
    paymentMethod: method,
    amount: cashReceivedStartAmount(method, totals.grandTotal),
    reference: '',
  }];
  focusedPaymentIndex = 0;
  renderPaymentSplitRows();
  updateCheckoutChange();
}

function openCheckout(method) {
  const totals = calculateTotals();
  if (isCreditMethod(method) && !canSellOnCredit(totals.grandTotal)) return;

  const custEl = document.getElementById('checkout-customer-label');
  if (custEl) custEl.textContent = selectedCustomer?.name || 'Walk-in Customer';
  document.getElementById('checkout-modal-total').textContent = `${pkr(totals.grandTotal)}`;

  const payMethod = method || 'Cash';
  payments = [{
    paymentMethod: payMethod,
    amount: cashReceivedStartAmount(payMethod, totals.grandTotal),
    reference: '',
  }];
  focusedPaymentIndex = 0;
  renderPaymentSplitRows();
  updateCheckoutChange();
  checkoutModalOverlay.style.display = 'flex';
  if (shouldAskCashReceived()) {
    setTimeout(() => {
      const inp = document.querySelector('.pay-amount-inp');
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 30);
  }
}

btnCheckoutTrigger.addEventListener('click', () => openCheckout('Cash'));
document.getElementById('btn-credit-sale-trigger')?.addEventListener('click', () => openCheckout('Credit'));
document.querySelectorAll('.pay-quick').forEach((btn) => {
  btn.addEventListener('click', () => setCheckoutMethod(btn.getAttribute('data-method')));
});

function renderPaymentSplitRows() {
  const container = document.getElementById('payments-split-list');
  container.innerHTML = '';

  payments.forEach((pmt, idx) => {
    const row = document.createElement('div');
    row.className = 'payment-row';
    const askCash = shouldAskCashReceived() && idx === 0;
    const amountVal = askCash && Number(pmt.amount) === 0 ? '' : Number(pmt.amount || 0).toFixed(2);
    row.innerHTML = `
      <select class="pay-method-sel" data-idx="${idx}" style="flex:1;">
        <option value="Cash" ${pmt.paymentMethod === 'Cash' ? 'selected' : ''}>Cash</option>
        <option value="Card" ${pmt.paymentMethod === 'Card' ? 'selected' : ''}>Card</option>
        <option value="Bank Transfer" ${pmt.paymentMethod === 'Bank Transfer' ? 'selected' : ''}>Bank Transfer</option>
        <option value="Mobile Wallet" ${pmt.paymentMethod === 'Mobile Wallet' ? 'selected' : ''}>Mobile Wallet</option>
        <option value="Cheque" ${pmt.paymentMethod === 'Cheque' ? 'selected' : ''}>Cheque</option>
        <option value="Credit" ${pmt.paymentMethod === 'Credit' ? 'selected' : ''}>Credit</option>
      </select>
      <input type="number" class="pay-amount-inp" data-idx="${idx}" value="${amountVal}" step="0.01" min="0" style="width:120px;" placeholder="${askCash ? 'Customer paid' : ''}" />
      ${payments.length > 1 ? `<button style="background:transparent;border:none;color:#ef4444;cursor:pointer;" class="btn-remove-pay" data-idx="${idx}">✕</button>` : ''}
    `;

    // Focus selector
    const amountInp = row.querySelector('.pay-amount-inp');
    amountInp.addEventListener('focus', () => {
      focusedPaymentIndex = idx;
    });

    amountInp.addEventListener('input', (e) => {
      pmt.amount = parseFloat(e.target.value) || 0;
      updateCheckoutChange();
    });

    row.querySelector('.pay-method-sel').addEventListener('change', (e) => {
      const method = e.target.value;
      if (isCreditMethod(method) && !canSellOnCredit(calculateTotals().grandTotal)) {
        e.target.value = pmt.paymentMethod;
        return;
      }
      pmt.paymentMethod = method;
      updateCheckoutChange();
    });

    if (payments.length > 1) {
      row.querySelector('.btn-remove-pay').addEventListener('click', () => {
        payments.splice(idx, 1);
        focusedPaymentIndex = 0;
        renderPaymentSplitRows();
        updateCheckoutChange();
      });
    }

    container.appendChild(row);
  });
}

function updateCheckoutChange() {
  const totals = calculateTotals();
  const paidTotal = payments.reduce((acc, p) => acc + p.amount, 0);
  const diff = paidTotal - totals.grandTotal;
  const credit = saleHasCredit();
  const askCash = shouldAskCashReceived();

  const label = document.getElementById('checkout-change-label');
  const value = document.getElementById('checkout-modal-change');
  const note = document.getElementById('checkout-credit-note');
  const tenderPanel = document.getElementById('checkout-cash-received-panel');
  const primary = payments[0]?.paymentMethod || 'Cash';
  highlightPayQuick(isCreditMethod(primary) ? 'Credit' : primary === 'Card' ? 'Card' : 'Cash');
  if (note) note.style.display = credit ? 'block' : 'none';
  if (tenderPanel) tenderPanel.classList.toggle('open', askCash && !credit);

  if (credit && diff >= -0.009) {
    label.textContent = 'On account:';
    value.textContent = `${pkr(totals.grandTotal)}`;
    value.style.color = '#0f766e';
  } else if (diff >= 0) {
    label.textContent = askCash ? 'Change / remaining:' : 'Change Due:';
    value.textContent = `${pkr(diff)}`;
    value.style.color = '#10b981';
  } else {
    label.textContent = askCash ? 'Still needed:' : 'Still Owed:';
    value.textContent = `${pkr(Math.abs(diff))}`;
    value.style.color = '#ef4444';
  }

  const billEl = document.getElementById('checkout-tender-bill');
  const recEl = document.getElementById('checkout-tender-received');
  const remainEl = document.getElementById('checkout-tender-remain');
  const remainLabel = document.getElementById('checkout-tender-remain-label');
  const remainBox = document.getElementById('checkout-tender-remain-box');
  if (billEl) billEl.textContent = pkr(totals.grandTotal);
  if (recEl) recEl.textContent = pkr(paidTotal);
  if (remainEl) remainEl.textContent = pkr(Math.abs(diff));
  if (remainLabel) remainLabel.textContent = diff >= 0 ? 'Change' : 'Still needed';
  if (remainBox) remainBox.classList.toggle('owed', diff < 0);
}

// Add split payment line
document.getElementById('btn-add-split-payment').addEventListener('click', () => {
  const totals = calculateTotals();
  const paid = payments.reduce((acc, p) => acc + p.amount, 0);
  const remaining = Math.max(0, totals.grandTotal - paid);

  payments.push({ paymentMethod: 'Card', amount: remaining, reference: '' });
  focusedPaymentIndex = payments.length - 1;
  renderPaymentSplitRows();
  updateCheckoutChange();
});

// Set exact amount
document.getElementById('btn-checkout-set-exact').addEventListener('click', () => {
  const totals = calculateTotals();
  payments = [{ paymentMethod: payments[0]?.paymentMethod || 'Cash', amount: totals.grandTotal, reference: '' }];
  focusedPaymentIndex = 0;
  renderPaymentSplitRows();
  updateCheckoutChange();
});

// Keyboard helper click
const keyButtons = document.querySelectorAll('.keypad-btn');
keyButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const char = btn.textContent.trim();
    const activeInp = document.querySelectorAll('.pay-amount-inp')[focusedPaymentIndex];
    if (!activeInp) return;

    let currentVal = activeInp.value;
    if (char === '⌫') {
      currentVal = currentVal.slice(0, -1);
    } else {
      if (currentVal === '0.00' || currentVal === '0') currentVal = '';
      currentVal += char;
    }

    activeInp.value = currentVal;
    payments[focusedPaymentIndex].amount = parseFloat(currentVal) || 0;
    updateCheckoutChange();
  });
});

document.getElementById('btn-checkout-close').addEventListener('click', () => {
  checkoutModalOverlay.style.display = 'none';
});

// Submit Complete Sale
document.getElementById('btn-checkout-submit').addEventListener('click', submitCompleteSale);

async function submitCompleteSale() {
  const totals = calculateTotals();
  const paidTotal = payments.reduce((acc, p) => acc + p.amount, 0);

  if (saleHasCredit() && !canSellOnCredit(totals.grandTotal)) return;

  if (shouldAskCashReceived() && paidTotal <= 0) {
    alert('Enter how much the customer paid.');
    return;
  }

  if (paidTotal < totals.grandTotal) {
    alert(`Insufficient payment. Need ${pkr(totals.grandTotal)}, got ${pkr(paidTotal)}`);
    return;
  }

  if (submittingSale) return;
  submittingSale = true;

  const pricingModel = taxContext?.pricingModel || 'exclusive';

  const payload = {
    terminalId: activeShift.terminalId,
    locationId: currentLocationId() || undefined,
    invoiceNumber: `POS-L-${Date.now()}`,
    customerName: selectedCustomer ? selectedCustomer.name : 'Walk-in Customer',
    customerPhone: selectedCustomer ? selectedCustomer.phone : null,
    customerEmail: selectedCustomer ? selectedCustomer.email : null,
    customerId: selectedCustomer ? selectedCustomer.id : null,
    items: cart.map(i => ({
      productId: i.isCustom ? null : i.productId,
      productName: i.productName,
      sku: i.sku,
      quantity: i.quantity,
      unitName: i.unitName || 'Pcs',
      conversionFactor: i.salesConversionFactor ?? 1,
      salesConversionFactor: i.salesConversionFactor ?? 1,
      allowFractionalQty: Boolean(i.allowFractionalQty),
      stockUnitName: i.stockUnitName || i.unitName || 'Pcs',
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxRate: resolveTaxRate(i.taxRate),
      pricingModel,
      taxType: pricingModel === 'inclusive' ? 'Inclusive' : 'Exclusive',
      isCustom: i.isCustom
    })),
    payments: payments.map(p => ({
      paymentMethod: p.paymentMethod,
      amount: p.amount,
      reference: p.reference || ''
    })),
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    notes: saleHasCredit() ? 'Credit sale' : ''
  };

  const res = await api.pos.completeSale(payload);
  submittingSale = false;

  if (res?.success && res.data) {
    const saleData = res.data.sale || res.data;
    const snapItems = (Array.isArray(saleData?.items) && saleData.items.length ? saleData.items : cart).map((i) => ({
      ...i,
      productName: i.productName || i.name,
      quantity: Number(i.quantity) || 0,
      unitPrice: Number(i.unitPrice) || 0,
      discount: resolveTaxRate(i.discount),
      taxRate: resolveTaxRate(i.taxRate),
      lineTotal: Number(i.lineTotal) || ((Number(i.quantity) || 0) * (Number(i.unitPrice) || 0)),
    }));

    checkoutModalOverlay.style.display = 'none';

    // Clear cart immediately
    cart = [];
    selectedCustomer = null;
    overallDiscount = 0;
    cartDiscountAmount = 0;
    document.getElementById('cart-discount-input').value = 0;
    customerSearchInp.value = '';
    custCreditInfoCard.style.display = 'none';
    renderCartList();

    // Update local stock quantities
    snapItems.forEach(async (cartItem) => {
      const product = products.find((p) => p.id === cartItem.productId);
      if (product) {
        const factor = Number(cartItem.conversionFactor ?? cartItem.salesConversionFactor ?? 1) || 1;
        const baseQty = cartItem.baseQuantity != null
          ? Number(cartItem.baseQuantity)
          : (Number(cartItem.quantity) || 0) * factor;
        product.currentStock = Math.max(0, (product.currentStock || 0) - baseQty);
        try {
          await window.bisonDesktop.catalog.saveProduct(product);
        } catch (err) {
          console.error('[POS] Failed to update local stock:', err);
        }
      }
    });
    renderProducts();

    openSaleReceipt(saleData, {
      items: snapItems,
      payments: saleData?.payments || payload.payments,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      paidAmount: paidTotal,
      changeAmount: paidTotal - totals.grandTotal,
    });
  } else {
    alert(res?.message || 'Completed sale API error');
  }
}

// ─── RECEIPT LAYOUT RENDERING ─────────────────────────────────────────────────
function buildLastSaleFromRecord(saleData, extras = {}) {
  const sourceItems = extras.items || saleData?.items || [];
  const items = sourceItems.map((i) => ({
    ...i,
    productName: i.productName || i.name,
    quantity: Number(i.quantity) || 0,
    unitPrice: Number(i.unitPrice) || 0,
    discount: Number(i.discount) || 0,
    taxRate: Number(i.taxRate) || 0,
    lineTotal:
      Number(i.lineTotal) || (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0),
  }));
  const subtotal =
    extras.subtotal ??
    items.reduce((sum, i) => sum + (Number(i.lineTotal) || 0), 0);
  const grandTotal =
    extras.grandTotal ?? Number(saleData.grandTotal ?? saleData.totalAmount ?? subtotal);
  const payments = extras.payments || saleData?.payments || [];
  const paidAmount =
    extras.paidAmount ??
    payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);

  return {
    ...saleData,
    items,
    payments,
    subtotal,
    discountTotal: extras.discountTotal ?? (Number(saleData.discountTotal) || 0),
    taxTotal: extras.taxTotal ?? (Number(saleData.taxTotal) || 0),
    grandTotal,
    totalAmount: grandTotal,
    paidAmount,
    changeAmount: extras.changeAmount ?? Math.max(0, paidAmount - grandTotal),
    cashierName:
      extras.cashierName ||
      (cashierMetaEl?.textContent || '').replace('Cashier: ', '') ||
      'Staff',
    terminalName: extras.terminalName || terminalBadgeEl?.textContent || '',
    createdAt: saleData.createdAt || new Date().toISOString(),
    notes: extras.notes ?? saleData.notes,
    receiptTitle: extras.receiptTitle,
    customerName: extras.customerName ?? saleData.customerName,
  };
}

function openSaleReceipt(saleData, extras = {}) {
  lastSale = buildLastSaleFromRecord(saleData, extras);
  renderReceipt();
  modalReceipt.style.display = 'flex';
  if (posSettings.autoPrintOnSale) {
    setTimeout(() => {
      document.getElementById('btn-receipt-print')?.click();
    }, 350);
  }
}

function renderReceipt() {
  const box = document.getElementById('receipt-paper-box');
  if (!lastSale) return;
  try {
    const tpl = window.PosReceipt
      ? window.PosReceipt.loadReceiptTemplate()
      : null;
    let t = tpl;
    const company = window.PosReceipt
      ? window.PosReceipt.resolveReceiptCompany(companyProfile, tpl)
      : (companyProfile || { name: 'BisonTechs POS', email: '', phone: '', address: {} });
    // Extra fields the builder expects for the totals/paid/change
    const s = Object.assign({}, lastSale, {
      subtotal: lastSale.subtotal ?? calculateTotalsFor(lastSale),
      grandTotal: lastSale.totalAmount || lastSale.grandTotal || calculateTotalsFor(lastSale),
      paidAmount: lastSale.paidAmount || 0,
      changeAmount: lastSale.changeAmount || 0,
    });
    if (window.PosReceipt) {
      const html = window.PosReceipt.buildReceiptHtml(s, company, t);
      // Wrap with proper class for printReceiptNode
      box.innerHTML = '<div class="pos-receipt-paper">' + html + '</div>';
      return;
    }
  } catch (err) {
    console.error('[POS] renderReceipt error', err);
  }
  // Fallback (legacy) if PosReceipt is unavailable
  legacyRenderReceipt();
}

function legacyRenderReceipt() {
  const box = document.getElementById('receipt-paper-box');
  if (!lastSale) return;
  const company = companyProfile || {};
  const companyName =
    company.companyName ||
    company.company?.name ||
    company.organizationName ||
    company.name ||
    'POS';
  const addr = company.address || company.company?.address || company.businessDetails?.address || {};
  const dateStr = new Date(lastSale.createdAt || lastSale.orderDate || Date.now()).toLocaleString();
  let itemsHtml = '';
  lastSale.items.forEach(i => {
    const lineTotal = i.lineTotal || (i.unitPrice * i.quantity);
    itemsHtml += `<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${i.productName || i.name} x ${formatSellQty(i.quantity, i.unitName || 'Pcs')}</span><span>${pkr(lineTotal)}</span></div>`;
  });
  let paymentsHtml = '';
  lastSale.payments.forEach(p => {
    paymentsHtml += `<div style="display:flex;justify-content:space-between;font-size:11px;"><span>Payment (${p.paymentMethod})</span><span>${pkr(p.amount)}</span></div>`;
  });
  const finalTax = Number(lastSale.taxTotal || 0);
  const grandTotal = Number(lastSale.totalAmount || lastSale.grandTotal || 0);
  const change = Number(lastSale.changeAmount || 0);
  box.innerHTML = `
    <div style="text-align:center;border-bottom:1px dashed #ccc;padding-bottom:12px;margin-bottom:12px;"><h3 style="margin:0;font-size:16px;">${companyName}</h3>
      <div style="font-size:11px;color:#555;margin-top:4px;">${addr.street || ''} ${addr.city || ''} ${addr.state || ''}<br/>Phone: ${company.phone || company.company?.phone || 'N/A'} | Email: ${company.email || company.company?.email || 'N/A'}</div></div>
    <div style="font-size:11px;border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;"><b>Invoice:</b> ${lastSale.invoiceNumber || lastSale.orderNumber || 'Draft'}<br/><b>Date:</b> ${dateStr}<br/><b>Cashier:</b> ${lastSale.cashierName || 'Staff'}<br/><b>Customer:</b> ${lastSale.customerName || 'Walk-in Customer'}</div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">${itemsHtml}</div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;font-size:11px;">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${pkr(lastSale.subtotal || grandTotal)}</span></div>
      ${lastSale.discountTotal > 0 ? `<div style="display:flex;justify-content:space-between;color:#d97706;"><span>Discount</span><span>-${pkr(lastSale.discountTotal)}</span></div>` : ''}
      ${finalTax > 0 ? `<div style="display:flex;justify-content:space-between;"><span>GST</span><span>${pkr(finalTax)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:bold;margin-top:4px;"><span>Total</span><span>${pkr(grandTotal)}</span></div></div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">${paymentsHtml}<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;margin-top:2px;"><span>Change Return</span><span>${pkr(change)}</span></div></div>
    <div style="text-align:center;font-size:10px;color:#777;margin-top:8px;">Thank you for shopping with us!</div>`;
}

function calculateTotalsFor(sale) {
  if (!sale || !Array.isArray(sale.items)) return 0;
  return sale.items.reduce((sum, i) => sum + (Number(i.lineTotal) || (Number(i.quantity || 0) * Number(i.unitPrice || 0))), 0);
}

document.getElementById('btn-receipt-close').addEventListener('click', () => modalReceipt.style.display = 'none');
document.getElementById('btn-receipt-new-sale').addEventListener('click', () => modalReceipt.style.display = 'none');
document.getElementById('btn-receipt-print').addEventListener('click', () => {
  try {
    const receiptBox = document.getElementById('receipt-paper-box');
    const tpl = window.PosReceipt ? window.PosReceipt.loadReceiptTemplate() : { thermalPaperWidthMm: 80 };
    const widthMm = tpl.thermalPaperWidthMm || 80;
    
    if (window.PosReceipt && typeof window.PosReceipt.printReceiptNode === 'function') {
      window.PosReceipt.printReceiptNode(receiptBox, widthMm);
    } else {
      // Fallback to window.print()
      window.print();
    }
    // Close modal after print
    setTimeout(() => {
      modalReceipt.style.display = 'none';
    }, 1000);
  } catch (err) {
    console.error('[POS] Print error', err);
    window.print();
    setTimeout(() => {
      modalReceipt.style.display = 'none';
    }, 1000);
  }
});

document.getElementById('btn-receipt-email').addEventListener('click', () => {
  // Email feature not implemented in Electron - prompt() not supported
  showToast('Email feature not available in desktop app', 'info');
});

// ─── HOLD SALE ──────────────────────────────────────────────────────────────
btnHoldSaleTrigger.addEventListener('click', async () => {
  if (cart.length === 0) return;
  const totals = calculateTotals();

  const payload = {
    terminalId: activeShift.terminalId,
    customerId: selectedCustomer?.id || null,
    customerName: selectedCustomer ? selectedCustomer.name : 'Walk-in Customer',
    customerPhone: selectedCustomer ? selectedCustomer.phone : null,
    customerEmail: selectedCustomer ? selectedCustomer.email : null,
    items: cart.map(i => ({
      productId: i.isCustom ? null : i.productId,
      productName: i.productName,
      sku: i.sku,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxRate: i.taxRate
    })),
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal
  };

  const res = await api.pos.holdSale(payload);
  if (res?.success) {
    alert('Sale parked successfully');

    // Clear cart
    cart = [];
    selectedCustomer = null;
    overallDiscount = 0;
    cartDiscountAmount = 0;
    customerSearchInp.value = '';
    custCreditInfoCard.style.display = 'none';
    renderCartList();
  } else {
    alert(res?.message || 'Could not park sale');
  }
});

// ─── CLOSE SHIFT / CASH FLOW MODALS ───────────────────────────────────────────
document.getElementById('btn-trigger-close-shift').addEventListener('click', () => {
  document.getElementById('close-shift-actual-cash').value = '';
  document.getElementById('close-shift-notes').value = '';
  modalCloseShift.style.display = 'flex';
});

document.getElementById('btn-close-shift-cancel').addEventListener('click', () => modalCloseShift.style.display = 'none');
document.getElementById('btn-close-shift-no').addEventListener('click', () => modalCloseShift.style.display = 'none');
document.getElementById('btn-close-shift-yes').addEventListener('click', async () => {
  const actualStr = document.getElementById('close-shift-actual-cash').value;
  const notes = document.getElementById('close-shift-notes').value;

  if (!actualStr) {
    alert('Please enter counted cash in drawer!');
    return;
  }

  const actualCash = parseFloat(actualStr);
  const res = await api.pos.closeShift({ actualCash, notes });
  if (res?.success) {
    modalCloseShift.style.display = 'none';
    window.location.href = './shift.html';
  } else {
    alert(res?.message || 'Shift close failed');
  }
});

// Cash Flow
document.getElementById('btn-cash-flow').addEventListener('click', () => {
  document.getElementById('cash-flow-amount').value = '';
  document.getElementById('cash-flow-reason').value = '';
  modalCashFlow.style.display = 'flex';
});

document.getElementById('btn-cash-flow-cancel').addEventListener('click', () => modalCashFlow.style.display = 'none');
document.getElementById('btn-cash-flow-no').addEventListener('click', () => modalCashFlow.style.display = 'none');
document.getElementById('btn-cash-flow-yes').addEventListener('click', async () => {
  const type = document.getElementById('cash-flow-type').value;
  const amountStr = document.getElementById('cash-flow-amount').value;
  const reason = document.getElementById('cash-flow-reason').value.trim();

  if (!amountStr || parseFloat(amountStr) <= 0) {
    alert('Please enter valid amount!');
    return;
  }
  if (!reason) {
    alert('Please enter reason for transaction!');
    return;
  }

  const payload = {
    shiftId: activeShift.id,
    type,
    amount: parseFloat(amountStr),
    reason
  };

  const res = await api.pos.recordCashFlow(payload);
  if (res?.success) {
    alert('Cash entry recorded successfully!');
    modalCashFlow.style.display = 'none';
  } else {
    alert(res?.message || 'Failed to record entry');
  }
});

// Suspend shift
document.getElementById('btn-suspend-shift').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to suspend this shift? You can resume later.')) return;
  const res = await api.pos.suspendShift(activeShift.id);
  if (res?.success) {
    window.location.href = './shift.html';
  } else {
    alert(res?.message || 'Failed to suspend shift');
  }
});

// Kick drawer
if (btnKickDrawer) {
  btnKickDrawer.addEventListener('click', () => {
    alert('Cash drawer kick command sent!');
  });
}

// ─── T2: RETURNS TAB (offline-first) ──────────────────────────────────────────
function renderReturnForm(sale, sourceLabel) {
  const wrap = document.getElementById('returns-list-wrap');
  const invNo = sale.invoiceNumber || sale.orderNumber || sale.id || '—';
  wrap.innerHTML = `
      <div style="background:#fff;padding:16px;border-radius:12px;border:1px solid var(--line);margin-top:10px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <b>Invoice: ${invNo}</b>
          <span style="font-weight:700;color:var(--brand);">${pkr(sale.totalAmount || sale.grandTotal)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
          Customer: ${sale.customerName || (sale.customer && sale.customer.name) || 'Walk-in Customer'} | Date: ${new Date(sale.orderDate || sale.createdAt || Date.now()).toLocaleDateString()} | Source: ${sourceLabel}
        </div>
        <table class="returns-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty Sold</th>
              <th>Unit Price</th>
              <th>Return Qty</th>
            </tr>
          </thead>
          <tbody>
            ${(sale.items || []).map((i, idx) => `
              <tr>
                <td>${i.productName || i.name}</td>
                <td>${i.quantity}</td>
                <td>${pkr(i.unitPrice)}</td>
                <td><input type="number" class="return-qty-inp" data-idx="${idx}" value="0" min="0" max="${i.quantity}" step="0.001" style="width:72px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;" /> <span style="font-size:11px;color:#64748b;">${i.unitName || 'Pcs'}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div style="margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="font-size:13px;font-weight:600;color:var(--muted);">Refund Method:</label>
          <select id="refund-method-select" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff;">
            <option value="Cash">Cash</option>
            <option value="Card">Card</option>
            <option value="Bank Transfer">Bank Transfer</option>
            <option value="Store Credit">Store Credit</option>
          </select>
          <label style="font-size:13px;font-weight:600;color:var(--muted);">Reason:</label>
          <select id="return-reason-select" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff;">
            <option value="Customer return">Customer return</option>
            <option value="Defective item">Defective item</option>
            <option value="Wrong item">Wrong item</option>
            <option value="Overcharged">Overcharged</option>
            <option value="Other">Other</option>
          </select>
        </div>

        <button class="btn-add-custom" id="btn-submit-refund" style="margin-top:14px;background-color:#ef4444;">Process Refund</button>
      </div>
    `;

  document.getElementById('btn-submit-refund').addEventListener('click', async () => {
    const qInps = document.querySelectorAll('.return-qty-inp');
    const refundItems = [];
    qInps.forEach(inp => {
      const qty = parseFloat(inp.value) || 0;
      if (qty > 0) {
        const idx = parseInt(inp.getAttribute('data-idx'));
        const item = sale.items[idx];
        refundItems.push({
          productId: item.productId,
          productName: item.productName || item.name,
          sku: item.sku || '',
          quantity: qty,
          unitPrice: item.unitPrice
        });
      }
    });

    if (refundItems.length === 0) {
      alert('Please specify items to refund!');
      return;
    }

    const refundMethod = document.getElementById('refund-method-select')?.value || 'Cash';
    const reason = document.getElementById('return-reason-select')?.value || 'Customer return';

    const payload = {
      saleId: sale.id || sale._id,
      originalSaleId: sale.id || sale._id,
      items: refundItems,
      refundMethod,
      reason,
      type: 'RETURN',
    };

    const retRes = await api.pos.processReturn(payload);
    if (retRes?.success) {
      // Refresh local cache and list of products
      try {
        await loadLocalProducts();
      } catch (e) {
        console.warn('[returns] failed to refresh products:', e);
      }

      // Build the offline RETURN RECEIPT and show it in the receipt modal
      const refundTotal = refundItems.reduce((sum, r) => sum + Number(r.unitPrice) * r.quantity, 0);
      lastSale = {
        receiptTitle: 'RETURN RECEIPT',
        invoiceNumber: 'RET-' + String(invNo) + '-' + String(Date.now()).slice(-4),
        originalInvoice: invNo,
        createdAt: new Date().toISOString(),
        customerName: sale.customerName || (sale.customer && sale.customer.name) || 'Walk-in Customer',
        items: refundItems,
        subtotal: refundTotal,
        taxTotal: 0,
        discountTotal: 0,
        grandTotal: refundTotal,
        payments: [{ paymentMethod: refundMethod + ' Refund', amount: refundTotal }],
        paidAmount: refundTotal,
        changeAmount: 0,
        status: 'RETURNED (offline — will sync)',
      };
      renderReceipt();
      modalReceipt.style.display = 'flex';
      wrap.innerHTML = '<div style="color:#10b981;font-weight:bold;">Return queued locally — refund receipt opened. It will sync to the cloud on next sync.</div>';
      // Reload the history register to show the latest return
      loadReturnHistory();
    } else {
      alert(retRes?.message || 'Refund failed');
    }
  });
}

async function loadReturnHistory() {
  const wrap = document.getElementById('returns-history-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:var(--muted)">Loading returns history...</div>';

  try {
    const res = await api.pos.listLocalReturns();
    const list = res?.data?.returns || [];
    if (list.length === 0) {
      wrap.innerHTML = '<div style="color:var(--muted);font-size:14px;">No returns recorded yet.</div>';
      return;
    }

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:600;color:var(--muted);">${list.length} return(s) in local queue</span>
        <button id="btn-delete-all-returns" style="padding:5px 12px;background:#ef4444;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">Delete All</button>
      </div>
      <table class="returns-table">
        <thead>
          <tr>
            <th>Return ID</th>
            <th>Orig Invoice</th>
            <th>Date</th>
            <th>Refunded Items</th>
            <th>Total Amount</th>
          </tr>
        </thead>
        <tbody>
    `;

    list.forEach(r => {
      const dateStr = new Date(r.createdAt || Date.now()).toLocaleString();
      const itemsStr = (r.items || []).map(i => `${i.productName || i.name} (${i.quantity})`).join(', ');
      const total = (r.items || []).reduce((sum, item) => sum + (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0), 0);
      html += `
        <tr>
          <td><span style="font-family:monospace;font-weight:700;">${r.id}</span></td>
          <td><b>${r.saleId || '—'}</b></td>
          <td>${dateStr}</td>
          <td><span style="font-size:12px;color:var(--muted);" title="${itemsStr}">${itemsStr}</span></td>
          <td style="font-weight:700;color:#ef4444;">-${pkr(total)}</td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;
    wrap.innerHTML = html;

    document.getElementById('btn-delete-all-returns')?.addEventListener('click', async () => {
      if (!confirm(`Delete all ${list.length} queued return(s) from local storage? This cannot be undone.`)) return;
      const delRes = await api.pos.clearReturnsQueue();
      if (delRes?.success) {
        showToast('All local returns deleted.', 'success');
        loadReturnHistory();
      } else {
        showToast(delRes?.message || 'Delete failed', 'error');
      }
    });

  } catch (err) {
    wrap.innerHTML = `<div style="color:#ef4444;">Failed to load returns history: ${err.message || err}</div>`;
  }
}

function saleMatchesReturnScan(sale, scanned) {
  if (window.PosReceipt && typeof window.PosReceipt.saleMatchesReceiptScan === 'function') {
    return window.PosReceipt.saleMatchesReceiptScan(sale, scanned);
  }
  const n = (v) => String(v || '').trim().toLowerCase();
  const inv = String(scanned || '').trim();
  if (!inv || !sale) return false;
  return (
    n(sale.invoiceNumber) === n(inv) ||
    n(sale.orderNumber) === n(inv) ||
    n(sale.id) === n(inv) ||
    n(sale._id) === n(inv)
  );
}

async function searchReturnByCode(rawCode) {
  const inv = String(rawCode || '').trim();
  const searchInp = document.getElementById('return-search-invoice');
  if (searchInp) searchInp.value = inv;
  if (!inv) return;

  const wrap = document.getElementById('returns-list-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:var(--muted)">Searching transaction...</div>';

  // OFFLINE-FIRST: match full invoice OR receipt barcode digits (what Code128 prints).
  try {
    const local = await api.pos.listLocalSales();
    const localSales = local?.data?.sales || [];
    const localHit = localSales.find((s) => saleMatchesReturnScan(s, inv));
    if (localHit) {
      renderReturnForm(localHit, 'local');
      return;
    }
  } catch { /* local read failed — fall through */ }

  // Recent POS sales (synced) — same flexible barcode match
  try {
    const posRes = await api.pos.listSales('page=1&limit=100');
    const posSales = posRes?.data?.sales || posRes?.data || [];
    if (Array.isArray(posSales)) {
      const posHit = posSales.find((s) => saleMatchesReturnScan(s, inv));
      if (posHit) {
        renderReturnForm(posHit, 'cloud');
        return;
      }
    }
  } catch { /* ignore */ }

  // Cloud order search (full invoice / partial). Also try POS-L-<digits> if scan was numeric.
  const dig = inv.replace(/\D/g, '').replace(/^0+/, '');
  const queries = [inv];
  if (dig && dig !== inv) queries.push(dig);
  if (dig && !/^pos-l-/i.test(inv)) queries.push(`POS-L-${dig}`);

  for (const q of queries) {
    try {
      const res = await api.sales.getOrders({ search: q, limit: 25 });
      const rows = Array.isArray(res?.data)
        ? res.data
        : (res?.data?.orders || res?.data?.sales || []);
      if (!(res?.success && Array.isArray(rows) && rows.length)) continue;
      const hit = rows.find((s) => saleMatchesReturnScan(s, inv));
      if (hit) {
        renderReturnForm(hit, 'cloud');
        return;
      }
    } catch { /* try next query */ }
  }

  wrap.innerHTML = '<div style="color:#ef4444;">Transaction not found! Scan the receipt barcode or type the full invoice (e.g. POS-L-…).</div>';
}

document.getElementById('btn-scan-return').addEventListener('click', () => {
  if (typeof window.openCodeScanner === 'function') {
    window.openCodeScanner({
      title: 'Scan Receipt Barcode',
      onScan: (code) => {
        searchReturnByCode(code);
      },
    });
  } else {
    showToast('Scanner not available', 'error');
  }
});

// USB Scanner support - Enter submits the scanned code (do NOT clear before search)
const returnSearchInp = document.getElementById('return-search-invoice');
if (returnSearchInp) {
  returnSearchInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = returnSearchInp.value.trim();
      if (code.length > 0) searchReturnByCode(code);
    }
  });
}

// Auto-focus the input when Returns tab is opened
document.querySelector('.tab-btn[data-tab="returns"]')?.addEventListener('click', () => {
  setTimeout(() => {
    const searchInp = document.getElementById('return-search-invoice');
    if (searchInp) {
      searchInp.focus();
      searchInp.value = '';
    }
  }, 100);
});

document.getElementById('btn-search-return').addEventListener('click', async () => {
  const inv = document.getElementById('return-search-invoice').value.trim();
  await searchReturnByCode(inv);
});

// ─── T3: REPORTS TAB ──────────────────────────────────────────────────────────
async function loadShiftReports() {
  const wrap = document.getElementById('reports-cards-grid');
  const kpiRow = document.getElementById('reports-kpi-row');
  const metaEl = document.getElementById('reports-cashier-meta');
  const recentPanel = document.getElementById('reports-recent-panel');
  const productsPanel = document.getElementById('reports-products-panel');
  const recentWrap = document.getElementById('reports-recent-sales');
  const topWrap = document.getElementById('reports-top-products');

  if (wrap) wrap.innerHTML = '<div class="report-card">Loading reports…</div>';
  if (kpiRow) kpiRow.innerHTML = '';

  if (!activeShift?.id) {
    if (wrap) wrap.innerHTML = '<div class="report-card">Open a shift to see cashier reports.</div>';
    return;
  }

  const res = await api.pos.getShiftReport(activeShift.id);
  if (!(res?.success && res.data)) {
    if (wrap) wrap.innerHTML = `<div class="report-card">${res?.message || 'Could not load current shift reports'}</div>`;
    return;
  }

  const report = res.data;
  const openedLabel = report.openedAt ? new Date(report.openedAt).toLocaleString() : '—';
  if (metaEl) {
    metaEl.textContent = [
      report.cashierName || 'Cashier',
      report.terminalName ? `· ${report.terminalName}` : '',
      report.locationName ? `· ${report.locationName}` : '',
      `· ${report.status || 'Open'}`,
      `· since ${openedLabel}`,
    ].filter(Boolean).join(' ');
  }

  if (kpiRow) {
    const kpis = [
      ['Receipts', report.salesCount || 0],
      ['Gross sales', pkr(report.totalSales)],
      ['Items sold', report.itemsSold || 0],
      ['Avg ticket', pkr(report.avgTicket)],
      ['Cash sales', pkr(report.cashSales)],
      ['Card sales', pkr(report.cardSales)],
      ['Credit sales', pkr(report.creditSales)],
      ['Returns', `${report.returnsCount || 0} · ${pkr(report.returnsTotal)}`],
    ];
    kpiRow.innerHTML = kpis.map(([label, val]) => `
      <div class="kpi"><span>${label}</span><b>${val}</b></div>
    `).join('');
  }

  const payRows = Object.entries(report.paymentsBreakdown || {});
  wrap.innerHTML = `
      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Cashier</h4>
        <div class="totals-row"><span>Name</span><b>${report.cashierName || '—'}</b></div>
        <div class="totals-row"><span>Terminal</span><b>${report.terminalName || '—'}</b></div>
        <div class="totals-row"><span>Location</span><b>${report.locationName || '—'}</b></div>
        <div class="totals-row"><span>Shift status</span><b>${report.status || 'Open'}</b></div>
        <div class="totals-row"><span>Opened</span><b>${openedLabel}</b></div>
      </div>

      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Shift Cash Summary</h4>
        <div class="totals-row"><span>Opening Cash</span><b>${pkr(report.openingCash)}</b></div>
        <div class="totals-row"><span>Cash Sales</span><b>${pkr(report.cashSales)}</b></div>
        <div class="totals-row"><span>Cash Inflow</span><b>${pkr(report.cashIn)}</b></div>
        <div class="totals-row"><span>Cash Outflow</span><b>-${pkr(report.cashOut)}</b></div>
        <div class="totals-row" style="border-top:1px solid var(--line);padding-top:6px;margin-top:6px;">
          <span>Expected Cash</span><b>${pkr(report.expectedCash)}</b>
        </div>
      </div>

      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Sales Summary</h4>
        <div class="totals-row"><span>Total Sales</span><b>${pkr(report.totalSales)}</b></div>
        <div class="totals-row"><span>GST Tax</span><b>${pkr(report.taxTotal)}</b></div>
        <div class="totals-row"><span>Discounts</span><b>-${pkr(report.discountTotal)}</b></div>
        <div class="totals-row"><span>Net Sales</span><b>${pkr(report.netSales)}</b></div>
        <div class="totals-row"><span>Receipts Issued</span><b>${report.salesCount || 0}</b></div>
        <div class="totals-row"><span>Items Sold</span><b>${report.itemsSold || 0}</b></div>
        <div class="totals-row"><span>Average Ticket</span><b>${pkr(report.avgTicket)}</b></div>
        <div class="totals-row"><span>Returns</span><b>${report.returnsCount || 0} (${pkr(report.returnsTotal)})</b></div>
      </div>

      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Payment Methods</h4>
        ${payRows.length
          ? payRows.map(([method, amount]) => `
          <div class="totals-row"><span>${method}</span><b>${pkr(amount)}</b></div>
        `).join('')
          : '<div class="totals-row"><span>No payments yet</span><b>—</b></div>'}
        <div class="totals-row" style="border-top:1px solid var(--line);padding-top:6px;margin-top:6px;">
          <span>Card</span><b>${pkr(report.cardSales)}</b>
        </div>
        <div class="totals-row"><span>Credit</span><b>${pkr(report.creditSales)}</b></div>
        <div class="totals-row"><span>Other</span><b>${pkr(report.otherSales)}</b></div>
      </div>
    `;

  const recent = report.recentSales || [];
  if (recentPanel && recentWrap) {
    if (!recent.length) {
      recentPanel.style.display = 'none';
    } else {
      recentPanel.style.display = 'block';
      recentWrap.innerHTML = `<table>
        <thead><tr><th>Invoice</th><th>Time</th><th>Customer</th><th>Pay</th><th>Items</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${recent.map((s) => `<tr>
          <td>${s.invoiceNumber || '—'}</td>
          <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
          <td>${s.customerName || 'Walk-in'}</td>
          <td>${s.paymentMethod || '—'}</td>
          <td>${s.itemsCount || 0}</td>
          <td style="text-align:right;font-weight:700">${pkr(s.total)}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    }
  }

  const tops = report.topProducts || [];
  if (productsPanel && topWrap) {
    if (!tops.length) {
      productsPanel.style.display = 'none';
    } else {
      productsPanel.style.display = 'block';
      topWrap.innerHTML = `<table>
        <thead><tr><th>Product</th><th>Qty</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${tops.map((p) => `<tr>
          <td>${p.name}</td>
          <td>${p.qty}</td>
          <td style="text-align:right;font-weight:700">${pkr(p.amount)}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    }
  }
}

document.getElementById('btn-refresh-reports')?.addEventListener('click', () => {
  loadShiftReports().catch((err) => console.warn('refresh reports', err));
});

function saleMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function saleFmt(n) {
  return pkr(n);
}

function saleCashier(sale) {
  const c = sale.shift?.cashier || sale.cashier || {};
  if (c.firstName || c.lastName) {
    return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Staff';
  }
  if (sale.cashierName) return sale.cashierName;
  if (sale.cashierId) return sale.cashierId;
  if (sale.userId) return sale.userId;
  return 'Staff';
}

function saleLineTotal(item) {
  const line = saleMoney(item.lineTotal) || (saleMoney(item.quantity || 1) * saleMoney(item.unitPrice));
  const disc = saleMoney(item.discount || 0);
  const taxRate = saleMoney(item.taxRate || 0);
  const net = line - (disc / 100) * line;
  const tax = net * (taxRate / 100);
  return net + tax;
}

function saleTotalOf(sale) {
  // Prefer an explicit grand total if the payload carries one
  const explicit = sale.grandTotal ?? sale.total ?? sale.totalAmount;
  if (saleMoney(explicit) > 0) return saleMoney(explicit);
  // Otherwise compute from line items (qty * unitPrice, minus discount, plus tax)
  const items = sale.items || [];
  if (items.length) return items.reduce((sum, i) => sum + saleLineTotal(i), 0);
  return saleMoney(sale.amount || sale.subtotal || 0);
}

function saleDateFormat(sale) {
  const ts = sale.createdAt || sale.created_at || sale.date || sale.orderDate;
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return '—'; }
}

function saleIsCredit(sale) {
  return (sale.payments || []).some((p) => String(p.paymentMethod || '').toLowerCase().includes('credit'))
    || String(sale.notes || '').toLowerCase().includes('credit sale');
}

// ─── Sales register filter state & helpers ────────────────────────────────────
let sales = [];
let salesFilter = { search: '', from: '', to: '' };
let salesRegisterOpenId = null;

function saleMatchesFilter(sale) {
  const term = salesFilter.search.trim().toLowerCase();
  if (term) {
    const inv = String(sale.invoiceNumber || sale.orderNumber || sale.id || '').toLowerCase();
    const cust = String(sale.customerName || sale.customer?.name || '').toLowerCase();
    const items = (sale.items || []).map((i) => `${i.productName || i.name || ''} ${i.sku || ''}`.toLowerCase()).join(' ');
    if (!inv.includes(term) && !cust.includes(term) && !items.includes(term)) return false;
  }
  const d = sale.createdAt || sale.created_at || sale.date || sale.orderDate;
  if (d) {
    const dateStr = String(new Date(d).toISOString()).slice(0, 10);
    if (salesFilter.from && dateStr < salesFilter.from) return false;
    if (salesFilter.to && dateStr > salesFilter.to) return false;
  }
  return true;
}

function renderSalesTable(sales) {
  const listWrap = document.getElementById('sales-list-table');
  if (!listWrap) return;
  listWrap.innerHTML = sales.length
    ? `<table><thead><tr><th>Invoice</th><th>Date</th><th>Cashier</th><th>Customer</th><th>Pay</th><th style="text-align:right">Total</th></tr></thead><tbody>${sales
      .map((s) => `<tr data-sale-id="${s.id}" style="cursor:pointer;">
        <td>${s.invoiceNumber || s.orderNumber || s.id || '—'}</td>
        <td>${saleDateFormat(s)}</td>
        <td>${saleCashier(s)}</td>
        <td>${s.customerName || s.customer?.name || 'Walk-in'}</td>
        <td>${saleIsCredit(s) ? 'Credit' : ((s.payments || []).map((p) => p.paymentMethod).filter(Boolean).join(', ') || '—')}</td>
        <td style="text-align:right;">${saleFmt(saleTotalOf(s))}</td>
      </tr>`)
      .join('')}
    </tbody></table>`
    : '<div style="padding:20px;color:var(--muted);text-align:center;">No POS sales found.</div>';
  listWrap.querySelectorAll('tr[data-sale-id]').forEach((row) => {
    row.addEventListener('click', () => openSaleDetail(row.dataset.saleId));
  });
}

function openSaleDetail(id) {
  salesRegisterOpenId = id;
  const modal = document.getElementById('sale-detail-modal');
  const box = document.getElementById('sale-detail-body');
  if (!modal || !box) return;
  const sale = sales.find((s) => String(s.id) === String(id));
  if (!sale) return;
  const itemsHtml = (sale.items || []).map((i) => `
    <tr><td>${i.productName || i.name || '—'}</td><td>${i.sku || '—'}</td>
      <td style="text-align:right">${i.quantity || 1}</td>
      <td style="text-align:right">${saleFmt(i.unitPrice)}</td>
      <td style="text-align:right">${saleFmt(saleLineTotal(i))}</td></tr>`).join('');
  const paymentsHtml = (sale.payments || []).map((p) => `
    <tr><td>${p.paymentMethod || '—'}</td><td style="text-align:right">${saleFmt(p.amount || 0)}</td></tr>`).join('');
  document.getElementById('detail-invoice').textContent = sale.invoiceNumber || sale.orderNumber || sale.id || '—';
  document.getElementById('detail-date').textContent = saleDateFormat(sale);
  document.getElementById('detail-cashier').textContent = saleCashier(sale);
  document.getElementById('detail-customer').textContent = sale.customerName || sale.customer?.name || 'Walk-in';
  document.getElementById('detail-total').textContent = saleFmt(saleTotalOf(sale));
  box.innerHTML = `
    <div class="data-panel"><h3>Items</h3>
      <table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">Product</th><th style="text-align:left">SKU</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${itemsHtml || '<tr><td colspan="5">No items</td></tr>'}</tbody></table>
    </div>
    <div class="data-panel"><h3>Payments</h3>
      <table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">Method</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${paymentsHtml || '<tr><td colspan="2">—</td></tr>'}</tbody></table>
    </div>`;
  modal.style.display = 'flex';
}

function closeSaleDetail() {
  const modal = document.getElementById('sale-detail-modal');
  if (modal) modal.style.display = 'none';
  salesRegisterOpenId = null;
}

async function deleteSale() {
  if (!salesRegisterOpenId) {
    alert('No sale selected for deletion.');
    return;
  }
  
  if (!confirm('Are you sure you want to delete this sale? This action cannot be undone.')) return;
  
  try {
    const res = await api.pos.voidSale(salesRegisterOpenId, { reason: 'Deleted by user' });
    if (res?.success) {
      alert('Sale deleted successfully.');
      closeSaleDetail();
      loadSalesRegister();
    } else {
      alert(res?.message || 'Failed to delete sale');
    }
  } catch (err) {
    alert('Error deleting sale: ' + err.message);
  }
}

async function printSaleSlip() {
  const sale = sales.find((s) => String(s.id) === String(salesRegisterOpenId));
  if (!sale) return;
  const itemsRows = (sale.items || []).map((i) => `
    <tr><td style="text-align:left">${i.productName || i.name || '—'} (${i.sku || ''})</td>
      <td style="text-align:right">${formatSellQty(i.quantity || 1, i.unitName || 'Pcs')} x ${saleFmt(i.unitPrice)}</td>
      <td style="text-align:right">${saleFmt(saleLineTotal(i))}</td></tr>`).join('');
  const paymentsRows = (sale.payments || []).map((p) => `<tr><td>${p.paymentMethod || '—'}</td><td style="text-align:right">${saleFmt(p.amount || 0)}</td></tr>`).join('');
  const html = `
    <!DOCTYPE html><html><head><title>Invoice ${sale.invoiceNumber || sale.orderNumber || sale.id}</title>
    <style>body{font-family:monospace;font-size:12px;margin:0;padding:20px;width:80mm;}h2{font-size:16px;margin:0 0 4px;}
    .hdr{border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:12px;}table{width:100%;border-collapse:collapse;margin-bottom:12px;}
    th,td{border-bottom:1px dashed #eee;padding:2px 4px;}td{text-align:left;}tfoot{font-weight:bold}
    .bc{text-align:center;padding:8px 0;}
    @page{size:80mm auto;margin:0;}</style></head>
    <body>
      <div class="hdr"><h2>Invoice: ${sale.invoiceNumber || sale.orderNumber || sale.id || '—'}</h2>
        Date: ${saleDateFormat(sale)} | Cashier: ${saleCashier(sale)} |
        Customer: ${sale.customerName || sale.customer?.name || 'Walk-in'}</div>
      <div class="bc">${(() => {
      try {
        const pr = window.PosReceipt;
        if (!pr) return '';
        return pr.code128BarcodeSvg(pr.receiptBarcodeValue(sale), 320);
      } catch { return ''; }
    })()}</div>
      <table><thead><tr><th>Item</th><th style="text-align:right">Qty x Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${itemsRows}</tbody>
        <tfoot><tr><td colspan="2" style="text-align:right">TOTAL</td><td style="text-align:right">${saleFmt(saleTotalOf(sale))}</td></tr></tfoot></table>
      <table><thead><tr><th>Payment method</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${paymentsRows || '<tr><td colspan="2">—</td></tr>'}</tbody></table>
    </body></html>`;
  const w = window.open('', '_blank', 'width=380,height=600');
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

async function exportSalePdf() {
  await printSaleSlip();
}

// ─── Sales report within a date range (for toolbar Print/PDF) ────────────────
function salesReportRows(range = { from: salesFilter.from, to: salesFilter.to }) {
  const rows = sales.filter((s) => {
    const d = s.createdAt || s.created_at || s.date || s.orderDate;
    if (!d) return false;
    const dateStr = String(new Date(d).toISOString()).slice(0, 10);
    if (range.from && dateStr < range.from) return false;
    if (range.to && dateStr > range.to) return false;
    return true;
  }).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return rows;
}

function buildSalesReportHtml(rows, range) {
  const fromLabel = range.from || 'earliest';
  const toLabel = range.to || 'now';
  const rowsHtml = rows.map((s) => `
    <tr>
      <td>${s.invoiceNumber || s.orderNumber || s.id || '—'}</td>
      <td>${saleDateFormat(s)}</td>
      <td>${saleCashier(s)}</td>
      <td>${s.customerName || s.customer?.name || 'Walk-in'}</td>
      <td style="text-align:right">${saleFmt(saleTotalOf(s))}</td>
    </tr>`).join('');
  const grand = rows.reduce((sum, s) => sum + saleTotalOf(s), 0);
  const credit = rows.filter(saleIsCredit).reduce((sum, s) => sum + saleTotalOf(s), 0);
  return `
    <!DOCTYPE html><html><head><title>Sales Report</title>
    <style>body{font-family:Arial,sans-serif;font-size:12px;margin:0;padding:24px;}
    h2{margin:0 0 4px;font-size:18px;} .meta{color:#555;margin-bottom:16px;font-size:12px;}
    table{width:100%;border-collapse:collapse;} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;}
    th{background:#f2f2f2;} .tright{text-align:right;} .tfoot{font-weight:bold;background:#fafafa;}
    @page{size:A4;margin:20mm;}</style></head>
    <body>
      <h2>POS Sales Report</h2>
      <div class="meta">Date range: ${fromLabel} to ${toLabel}<br/>
        Sales: ${rows.length} &nbsp;|&nbsp; Cashiers: ${new Set(rows.map(saleCashier)).size} &nbsp;|&nbsp; Generated: ${new Date().toLocaleString()}</div>
      <table><thead><tr><th>Invoice</th><th>Date</th><th>Cashier</th><th>Customer</th><th class="tright">Total</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="5" style="text-align:center;color:#999;">No sales in this date range</td></tr>'}</tbody>
        <tfoot>
          <tr class="tfoot"><td colspan="4" class="tright">GRAND TOTAL</td><td class="tright">${saleFmt(grand)}</td></tr>
          <tr class="tfoot"><td colspan="4" class="tright">Credit sales</td><td class="tright">${saleFmt(credit)}</td></tr>
        </tfoot></table>
    </body></html>`;
}

function openReportWindow(html, title) {
  const w = window.open('', '_blank', 'width=820,height=720');
  if (!w) {
    showToast('Popup blocked. Please allow popups for this app.', 'error');
    return null;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.document.title = title || 'Report';
  w.focus();
  return w;
}

async function printSalesReport() {
  if (!salesFilter.from || !salesFilter.to) {
    showToast('Please select both From and To dates to print', 'error');
    return;
  }
  const range = { from: salesFilter.from, to: salesFilter.to };
  const rows = salesReportRows(range);
  showToast(`Preparing report for ${rows.length} sale(s)...`, 'info');
  try {
    openReportWindow(buildSalesReportHtml(rows, range), 'Sales Report');
  } catch (err) {
    console.error('[POS] print error', err);
    showToast('Could not open print window: ' + err.message, 'error');
  }
}

async function exportSalesReportPdf() {
  if (!salesFilter.from || !salesFilter.to) {
    showToast('Please select both From and To dates to export PDF', 'error');
    return;
  }
  const range = { from: salesFilter.from, to: salesFilter.to };
  const rows = salesReportRows(range);
  showToast(`Preparing PDF for ${rows.length} sale(s)...`, 'info');
  try {
    // Electron routes the print dialog and lets the user "Save as PDF".
    const w = openReportWindow(buildSalesReportHtml(rows, range), 'Sales Report');
    if (w) setTimeout(() => { try { w.print(); } catch (e) { console.error(e); } }, 250);
  } catch (err) {
    console.error('[POS] pdf error', err);
    showToast('Could not open PDF window: ' + err.message, 'error');
  }
}

async function loadSalesRegister() {
  const userWrap = document.getElementById('sales-user-table');
  const listWrap = document.getElementById('sales-list-table');
  if (!listWrap) return;
  try {
    // OFFLINE-FIRST: load local sales first so the register is always
    // populated from the local SQLite cache, even with no internet.
    sales = [];
    try {
      const local = await api.pos.listLocalSales();
      if (local?.data?.sales) sales = local.data.sales;
    } catch { /* ignore local read error, try live */ }

    // Background refresh: if online and local cache is empty, try live API.
    if (!sales.length) {
      try {
        const res = await api.pos.listSales('page=1&limit=200');
        sales = Array.isArray(res?.data) ? res.data : (res?.data?.sales || []);
      } catch (err) {
        if (sales.length === 0) {
          listWrap.innerHTML = `<div style="padding:20px;color:#b91c1c;text-align:center;">${err.message || 'Could not load sales'}</div>`;
          return;
        }
      }
    }

    // Apply search + date-range filters to the loaded sales.
    const visible = sales.filter(saleMatchesFilter);

    const total = visible.reduce((sum, s) => sum + saleTotalOf(s), 0);
    const credit = visible.filter(saleIsCredit).reduce((sum, s) => sum + saleTotalOf(s), 0);
    const byUser = new Map();
    visible.forEach((s) => {
      const name = saleCashier(s);
      const cur = byUser.get(name) || { name, count: 0, total: 0, credit: 0 };
      cur.count += 1;
      cur.total += saleTotalOf(s);
      if (saleIsCredit(s)) cur.credit += saleTotalOf(s);
      byUser.set(name, cur);
    });
    const users = [...byUser.values()].sort((a, b) => b.total - a.total);

    document.getElementById('sales-kpi-count').textContent = String(visible.length);
    document.getElementById('sales-kpi-total').textContent = saleFmt(total);
    document.getElementById('sales-kpi-credit').textContent = saleFmt(credit);
    document.getElementById('sales-kpi-users').textContent = String(users.length);

    userWrap.innerHTML = users.length
      ? `<table><thead><tr><th>Cashier</th><th>Sales</th><th>Total</th><th>Credit</th></tr></thead><tbody>${users
        .map((u) => `<tr><td>${u.name}</td><td>${u.count}</td><td>${saleFmt(u.total)}</td><td>${saleFmt(u.credit)}</td></tr>`)
        .join('')
      }</tbody></table>`
      : '<div style="padding:20px;color:var(--muted);text-align:center;">No cashier sales yet.</div>';

    renderSalesTable(visible);
  } catch (err) {
    listWrap.innerHTML = `<div style="padding:20px;color:#b91c1c;text-align:center;">${err.message || 'Could not load sales'}</div>`;
  }
}

var localCatalog = [];
var localSuppliers = [];
let catTab = 'cats';
let catEditing = null;

function renderLocalCatalog() {
  const wrap = document.getElementById('cat-table');
  if (!wrap) return;
  const q = String(document.getElementById('cat-search')?.value || '').toLowerCase();
  if (catTab === 'cats') {
    const rows = localCatalog.filter((c) => `${c.name} ${c.code} ${c.description}`.toLowerCase().includes(q));
    wrap.innerHTML = rows.length ? `<table class="returns-table"><thead><tr><th>Name</th><th>Code</th><th>Description</th><th>Subs</th><th style="width:100px;text-align:right;padding-right:24px;">Actions</th></tr></thead><tbody>${rows.map((c) => `<tr data-cat-row-id="${c.id}" style="cursor:pointer;">
        <td><b>${c.name}</b></td><td>${c.code || '—'}</td><td>${c.description || '—'}</td>
        <td>${(c.subCategories || []).length}</td>
        <td style="text-align:right;padding-right:20px;"><button type="button" class="icon-btn" data-edit-cat="${c.id}" title="Edit">✎</button> <button type="button" class="icon-btn del" data-del-cat="${c.id}" title="Delete">🗑</button></td>
      </tr>`).join('')
      }</tbody></table>` : '<div style="padding:24px;text-align:center;color:var(--muted);">No categories found</div>';
  } else {
    const rows = [];
    localCatalog.forEach((c) => (c.subCategories || []).forEach((s) => rows.push({ ...s, parentName: c.name, parentId: c.id })));
    const filtered = rows.filter((r) => `${r.name} ${r.code} ${r.parentName}`.toLowerCase().includes(q));
    wrap.innerHTML = filtered.length ? `<table class="returns-table"><thead><tr><th>Name</th><th>Code</th><th>Parent</th><th>Description</th><th style="width:100px;text-align:right;padding-right:24px;">Actions</th></tr></thead><tbody>${filtered.map((s) => `<tr data-sub-row-id="${s.id}" data-parent-id="${s.parentId}" style="cursor:pointer;">
        <td><b>${s.name}</b></td><td>${s.code || '—'}</td><td>${s.parentName}</td><td>${s.description || '—'}</td>
        <td style="text-align:right;padding-right:20px;"><button type="button" class="icon-btn" data-edit-sub="${s.id}" data-parent="${s.parentId}" title="Edit">✎</button> <button type="button" class="icon-btn del" data-del-sub="${s.id}" title="Delete">🗑</button></td>
      </tr>`).join('')
      }</tbody></table>` : '<div style="padding:24px;text-align:center;color:var(--muted);">No subcategories found</div>';
  }
}

async function loadLocalCatalog() {
  const res = await api.catalog.list();
  localCatalog = Array.isArray(res?.data) ? res.data : [];
  const suppRes = await api.catalog.listSuppliers();
  localSuppliers = Array.isArray(suppRes?.data) ? suppRes.data : [];
  renderLocalCatalog();
}

function openCatForm(kind, row) {
  catEditing = { kind, row };
  document.getElementById('cat-form-error').textContent = '';
  document.getElementById('cat-form-title').textContent = kind === 'cats' ? (row ? 'Edit Category' : 'Add Category') : (row ? 'Edit Subcategory' : 'Add Subcategory');
  document.getElementById('cat-parent-field').style.display = kind === 'subs' ? 'block' : 'none';
  document.getElementById('cat-f-parent').innerHTML = localCatalog.map((c) =>
    `<option value="${c.id}" ${c.id === (row?.categoryId || row?.parentId) ? 'selected' : ''}>${c.name}</option>`
  ).join('');
  document.getElementById('cat-f-name').value = row?.name || '';
  document.getElementById('cat-f-code').value = row?.code || '';
  document.getElementById('cat-f-desc').value = row?.description || '';
  document.getElementById('cat-overlay').style.display = 'flex';
}

function closeCatForm() {
  document.getElementById('cat-overlay').style.display = 'none';
  catEditing = null;
}

function initCatalogPanel() {
  document.querySelectorAll('.cat-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      catTab = btn.getAttribute('data-cat-tab');
      document.querySelectorAll('.cat-subtab').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('cat-add').textContent = catTab === 'cats' ? '+ Add Category' : '+ Add Subcategory';
      renderLocalCatalog();
    });
  });
  document.getElementById('cat-search')?.addEventListener('input', renderLocalCatalog);
  document.getElementById('cat-add')?.addEventListener('click', () => openCatForm(catTab, null));
  document.getElementById('cat-form-cancel')?.addEventListener('click', closeCatForm);
  document.getElementById('cat-form-no')?.addEventListener('click', closeCatForm);
  document.getElementById('cat-table')?.addEventListener('click', async (e) => {
    const editCat = e.target.closest('[data-edit-cat]');
    const delCat = e.target.closest('[data-del-cat]');
    const editSub = e.target.closest('[data-edit-sub]');
    const delSub = e.target.closest('[data-del-sub]');

    if (editCat) {
      openCatForm('cats', localCatalog.find((c) => c.id === editCat.getAttribute('data-edit-cat')));
      return;
    }
    if (delCat && confirm('Delete this category and its subcategories?')) {
      await api.catalog.deleteCategory(delCat.getAttribute('data-del-cat'));
      await loadLocalCatalog();
      loadCategories();
      return;
    }
    if (editSub) {
      const parent = localCatalog.find((c) => c.id === editSub.getAttribute('data-parent'));
      const row = (parent?.subCategories || []).find((s) => s.id === editSub.getAttribute('data-edit-sub'));
      openCatForm('subs', row);
      return;
    }
    if (delSub && confirm('Delete this subcategory?')) {
      await api.catalog.deleteSubcategory(delSub.getAttribute('data-del-sub'));
      await loadLocalCatalog();
      loadCategories();
      return;
    }

    // Row click fallback (open edit modal)
    const catRow = e.target.closest('[data-cat-row-id]');
    const subRow = e.target.closest('[data-sub-row-id]');
    if (catRow) {
      openCatForm('cats', localCatalog.find((c) => c.id === catRow.getAttribute('data-cat-row-id')));
    } else if (subRow) {
      const parent = localCatalog.find((c) => c.id === subRow.getAttribute('data-parent-id'));
      const row = (parent?.subCategories || []).find((s) => s.id === subRow.getAttribute('data-sub-row-id'));
      openCatForm('subs', row);
    }
  });
  document.getElementById('cat-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('cat-f-name').value.trim();
    const code = document.getElementById('cat-f-code').value.trim();
    const description = document.getElementById('cat-f-desc').value.trim();
    const parentId = document.getElementById('cat-f-parent').value;
    if (!name) {
      document.getElementById('cat-form-error').textContent = 'Name is required';
      return;
    }
    const payload = { id: catEditing?.row?.id, name, code, description };
    const res = catEditing?.kind === 'subs'
      ? await api.catalog.saveSubcategory({ ...payload, categoryId: parentId })
      : await api.catalog.saveCategory(payload);
    if (!res?.success) {
      document.getElementById('cat-form-error').textContent = res?.message || 'Save failed';
      return;
    }
    closeCatForm();
    await loadLocalCatalog();
    loadCategories();
  });
}

initCatalogPanel();

let localProducts = [];
let prodEditing = null;
let prodImages = [];

function pf(id) {
  return document.getElementById('pf-' + id);
}
function pfVal(id) {
  return String(pf(id)?.value || '').trim();
}
function pfNum(id) {
  const n = Number(pf(id)?.value);
  return Number.isFinite(n) ? n : 0;
}
function pfBool(id) {
  return !!pf(id)?.checked;
}
function setPf(id, value) {
  const el = pf(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value == null ? '' : String(value);
  if (id === 'barcode' || id === 'qrCode') {
    void refreshProductCodePreviews();
  }
}

let _prodCodePreviewTimer = null;
async function refreshProductCodePreviews() {
  const codes = window.PosProductCodes;
  const bcEl = document.getElementById('pf-barcode-preview');
  const qrEl = document.getElementById('pf-qr-preview');
  if (!codes) {
    if (bcEl) bcEl.innerHTML = pfVal('barcode') ? `<b>${pfVal('barcode')}</b>` : '';
    if (qrEl) qrEl.innerHTML = pfVal('qrCode') ? `<b>${pfVal('qrCode')}</b>` : '';
    return;
  }
  if (bcEl) bcEl.innerHTML = codes.productBarcodeSvg(pfVal('barcode'), 340);
  if (!qrEl) return;
  refreshProductCodePreviews._tok = (refreshProductCodePreviews._tok || 0) + 1;
  const token = refreshProductCodePreviews._tok;
  // Debounce QR IPC while typing
  clearTimeout(_prodCodePreviewTimer);
  await new Promise((r) => {
    _prodCodePreviewTimer = setTimeout(r, 180);
  });
  if (token !== refreshProductCodePreviews._tok) return;
  qrEl.innerHTML = await codes.productQrSvg(pfVal('qrCode'), 148);
}
function firstVal(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}
function dateVal(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}
function showProdTab(tabId) {
  document.querySelectorAll('.prod-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-prod-tab') === tabId);
  });
  document.querySelectorAll('.prod-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.getAttribute('data-pane') === tabId);
  });
}
function fillProductCats(selectedCat, selectedSub) {
  const catSel = pf('category');
  const subSel = pf('subCategory');
  if (!catSel || !subSel) return;
  catSel.innerHTML = `<option value="">Select category</option>` + localCatalog.map((c) =>
    `<option value="${c.id}" ${c.id === selectedCat ? 'selected' : ''}>${c.name}</option>`
  ).join('');
  const parent = localCatalog.find((c) => c.id === (selectedCat || catSel.value));
  const subs = parent?.subCategories || [];
  subSel.innerHTML = `<option value="">${catSel.value ? 'Select subcategory' : 'Select category first'}</option>` + subs.map((s) =>
    `<option value="${s.id}" ${s.id === selectedSub ? 'selected' : ''}>${s.name}</option>`
  ).join('');
  const addSub = document.getElementById('pf-add-subcategory');
  if (addSub) addSub.disabled = !catSel.value;
}

function fillProductSuppliers(selectedId) {
  const sel = pf('supplier');
  if (!sel) return;
  const current = String(selectedId || sel.value || '');
  sel.innerHTML = `<option value="">Select supplier...</option>` + localSuppliers.map((s) => {
    const id = String(s.id || s._id || '');
    return `<option value="${id}" ${id === current ? 'selected' : ''}>${s.name || '—'}</option>`;
  }).join('');
}

function renderLocalProducts() {
  const wrap = document.getElementById('prod-table');
  if (!wrap) return;
  const q = String(document.getElementById('prod-search')?.value || '').toLowerCase();
  const rows = localProducts.filter((p) =>
    `${p.name} ${p.sku} ${p.barcode} ${p.categoryName}`.toLowerCase().includes(q)
  );
  wrap.innerHTML = rows.length ? `<table class="returns-table"><thead><tr><th>Name</th><th>SKU</th><th>Barcode</th><th>Category</th><th>Price</th><th>Stock</th><th style="width:100px;text-align:right;padding-right:24px;">Actions</th></tr></thead><tbody>${rows.map((p) => `<tr data-prod-row-id="${p.id}" style="cursor:pointer;">
      <td><b>${p.name}</b></td>
      <td>${p.sku || '—'}</td>
      <td>${p.barcode || '—'}</td>
      <td>${p.subcategoryName || p.categoryName || '—'}</td>
      <td>${pkr(p.sellingPrice)}</td>
      <td>${Number(p.currentStock || 0)}</td>
      <td style="text-align:right;padding-right:20px;"><button type="button" class="icon-btn" data-edit-prod="${p.id}" title="Edit">✎</button> <button type="button" class="icon-btn del" data-del-prod="${p.id}" title="Delete">🗑</button></td>
    </tr>`).join('')
    }</tbody></table>` : '<div style="padding:24px;text-align:center;color:var(--muted);">No products found</div>';
}

async function loadLocalProducts() {
  if (!localCatalog.length) {
    try { await loadLocalCatalog(); } catch (_) { /* ignore */ }
  }
  const res = await api.catalog.listProducts();
  localProducts = Array.isArray(res?.data) ? res.data : [];
  renderLocalProducts();
}

async function afterProductChange() {
  await loadLocalProducts();
  if (selectedCategoryId && selectedCategoryId !== 'All') {
    try { await loadCategoryProducts(selectedCategoryId); } catch (_) { /* ignore */ }
  }
}

// ─── Products page barcode scan ───────────────────────────────────────────────
(function wireProductBarcodeScan() {
  const scanInp = document.getElementById('prod-barcode-scan');
  const searchInp = document.getElementById('prod-search');
  if (!scanInp) return;

  function applyProductBarcode(code) {
    const trimmed = normalizeScanInput(code);
    if (!trimmed) return;
    // Push scanned value into the search field so renderLocalProducts() picks it up
    if (searchInp) {
      searchInp.value = trimmed;
      searchInp.dispatchEvent(new Event('input'));
    }
    // Flash the scan input green for feedback
    scanInp.value = '';
    scanInp.style.borderColor = '#22c55e';
    scanInp.style.background = '#f0fdf4';
    setTimeout(() => {
      scanInp.style.borderColor = '';
      scanInp.style.background = '#fff';
    }, 800);
  }

  // Enter key on the scan input
  scanInp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    applyProductBarcode(scanInp.value);
  });

  // Clear search when scan field is cleared
  scanInp.addEventListener('input', () => {
    if (!scanInp.value.trim() && searchInp && searchInp.value) {
      searchInp.value = '';
      renderLocalProducts();
    }
  });
})();

const PF_TEXT = [
  'name', 'sku', 'barcode', 'qrCode', 'productType', 'description', 'tags',
  'costPrice', 'sellingPrice', 'landingCost', 'currency', 'taxRate', 'taxType',
  'stockUnit', 'currentStock', 'minimumStock', 'maximumStock',
  'brand', 'modelNumber', 'supplier', 'supplierSku', 'leadTime', 'reorderPoint',
  'rackLocation', 'zone', 'palletNumber', 'shelfNumber', 'storageCondition', 'tempMin', 'tempMax',
  'weight', 'weightUnit', 'length', 'width', 'height', 'dimensionUnit', 'color', 'size', 'material', 'finish',
  'expiryDate', 'manufacturingDate', 'batchNumber', 'shelfLife', 'bulkUnit', 'defaultBatchQuantity',
  'hsCode', 'countryOfOrigin', 'shippingClass', 'freightClass', 'stackingLimit', 'unNumber', 'handlingInstructions',
  'videoUrl', 'warrantyPeriod', 'warrantyUnit', 'returnDays', 'notes',
];
const PF_BOOL = [
  'isActive', 'hasExpiry', 'isBatchManaged', 'isSerialManaged', 'isExpiryManaged',
  'isBulkManaged', 'hasIndividualTracking', 'dangerousGoods', 'isReturnable',
];

function renderProdImages() {
  const wrap = document.getElementById('pf-image-preview');
  if (!wrap) return;
  wrap.innerHTML = '';
  prodImages.forEach((url, idx) => {
    const box = document.createElement('div');
    box.className = 'pf-img';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Product';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
      prodImages.splice(idx, 1);
      renderProdImages();
    });
    box.appendChild(img);
    box.appendChild(btn);
    wrap.appendChild(box);
  });
}

function addProdImage(url) {
  const value = String(url || '').trim();
  if (!value || prodImages.includes(value) || prodImages.length >= 5) return;
  prodImages.push(value);
  renderProdImages();
}

function addCustomRow(name = '', value = '') {
  const wrap = document.getElementById('pf-custom-rows');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'pf-custom-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'pf-input pf-custom-name';
  nameInput.placeholder = 'Attribute name';
  nameInput.value = name;
  const valueInput = document.createElement('input');
  valueInput.className = 'pf-input pf-custom-value';
  valueInput.placeholder = 'Value';
  valueInput.value = value;
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '✕';
  del.addEventListener('click', () => row.remove());
  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(del);
  wrap.appendChild(row);
}

function collectCustomFields() {
  return Array.from(document.querySelectorAll('#pf-custom-rows .pf-custom-row')).map((row) => ({
    name: row.querySelector('.pf-custom-name')?.value.trim() || '',
    value: row.querySelector('.pf-custom-value')?.value.trim() || '',
  })).filter((item) => item.name || item.value);
}

function resetProdForm() {
  PF_TEXT.forEach((id) => setPf(id, ''));
  PF_BOOL.forEach((id) => setPf(id, false));
  setPf('isActive', true);
  setPf('isReturnable', true);
  setPf('productType', 'Physical');
  setPf('currency', 'PKR');
  setPf('taxType', taxContext?.pricingModel === 'inclusive' ? 'Inclusive' : 'Exclusive');
  setPf('taxRate', taxContext?.enabled ? resolveTaxRate(taxContext.defaultRate) : 0);
  setPf('stockUnit', 'Pcs');
  setPf('weightUnit', 'KG');
  setPf('dimensionUnit', 'cm');
  setPf('countryOfOrigin', 'Pakistan');
  setPf('bulkUnit', 'Bale');
  setPf('warrantyUnit', 'Months');
  prodImages = [];
  renderProdImages();
  const customWrap = document.getElementById('pf-custom-rows');
  if (customWrap) customWrap.innerHTML = '';
  applyCompanyTaxUi();
  showProdTab('basic');
  void refreshProductCodePreviews();
}

function openProdForm(row) {
  prodEditing = row || null;
  resetProdForm();
  const err = document.getElementById('prod-form-error');
  const title = document.getElementById('prod-form-title');
  if (err) err.textContent = '';
  if (title) title.textContent = row ? 'Edit Product' : 'Add Product';
  const parentId = firstVal(row, ['category', 'categoryId']);
  const subId = firstVal(row, ['subCategory', 'subcategoryId', 'subCategoryId']);
  fillProductCats(parentId, subId);
  fillProductSuppliers(firstVal(row, ['supplierId', 'supplier']));
  if (!row) {
    document.getElementById('prod-overlay').style.display = 'flex';
    void refreshProductCodePreviews();
    return;
  }
  setPf('name', row.name || '');
  setPf('sku', row.sku || '');
  setPf('barcode', firstVal(row, ['barcode', 'barcodeNumber']));
  setPf('qrCode', firstVal(row, ['qrCode']));
  setPf('productType', firstVal(row, ['productType'], 'Physical'));
  setPf('description', row.description || '');
  setPf('tags', Array.isArray(row.tags) ? row.tags.join(', ') : (row.tags || ''));
  setPf('isActive', row.isActive !== false);
  setPf('costPrice', firstVal(row, ['costPrice']));
  setPf('sellingPrice', firstVal(row, ['sellingPrice', 'price']));
  setPf('landingCost', firstVal(row, ['landingCost']));
  setPf('currency', firstVal(row, ['currency', 'currencyCode'], 'PKR'));
  setPf('taxRate', firstVal(row, ['taxRate']));
  setPf('taxType', firstVal(row, ['taxType', 'taxTypeName'], 'Exclusive'));
  setPf('stockUnit', firstVal(row, ['stockUnit', 'stockUnitName'], 'Pcs'));
  setPf('currentStock', firstVal(row, ['currentStock']));
  setPf('minimumStock', firstVal(row, ['minimumStock']));
  setPf('maximumStock', firstVal(row, ['maximumStock']));
  setPf('brand', firstVal(row, ['brand', 'brandName']));
  setPf('modelNumber', firstVal(row, ['modelNumber']));
  setPf('supplier', firstVal(row, ['supplierId', 'supplier']));
  setPf('supplierSku', firstVal(row, ['supplierSku']));
  setPf('leadTime', firstVal(row, ['leadTime', 'leadTimeDays']));
  setPf('reorderPoint', firstVal(row, ['reorderPoint']));
  setPf('rackLocation', firstVal(row, ['rackLocation', 'rackLocationName']));
  setPf('zone', firstVal(row, ['zone', 'zoneName']));
  setPf('palletNumber', firstVal(row, ['palletNumber']));
  setPf('shelfNumber', firstVal(row, ['shelfNumber']));
  setPf('storageCondition', firstVal(row, ['storageCondition', 'storageConditionName']));
  setPf('tempMin', firstVal(row, ['tempMin', 'temperatureMin']));
  setPf('tempMax', firstVal(row, ['tempMax', 'temperatureMax']));
  setPf('weight', firstVal(row, ['weight']));
  setPf('weightUnit', firstVal(row, ['weightUnit', 'weightUnitName'], 'KG'));
  setPf('length', firstVal(row, ['length']));
  setPf('width', firstVal(row, ['width']));
  setPf('height', firstVal(row, ['height']));
  setPf('dimensionUnit', firstVal(row, ['dimensionUnit'], 'cm'));
  setPf('color', firstVal(row, ['color']));
  setPf('size', firstVal(row, ['size']));
  setPf('material', firstVal(row, ['material']));
  setPf('finish', firstVal(row, ['finish']));
  setPf('hasExpiry', !!row.hasExpiry);
  setPf('isBatchManaged', !!row.isBatchManaged);
  setPf('isSerialManaged', !!row.isSerialManaged);
  setPf('isExpiryManaged', !!row.isExpiryManaged);
  setPf('expiryDate', dateVal(row.expiryDate));
  setPf('manufacturingDate', dateVal(row.manufacturingDate));
  setPf('batchNumber', firstVal(row, ['batchNumber']));
  setPf('shelfLife', firstVal(row, ['shelfLife', 'shelfLifeDays']));
  setPf('isBulkManaged', !!row.isBulkManaged);
  setPf('hasIndividualTracking', !!row.hasIndividualTracking);
  setPf('bulkUnit', firstVal(row, ['bulkUnit'], 'Bale'));
  setPf('defaultBatchQuantity', firstVal(row, ['defaultBatchQuantity', 'defaultQuantityPerBatch']));
  setPf('hsCode', firstVal(row, ['hsCode']));
  setPf('countryOfOrigin', firstVal(row, ['countryOfOrigin', 'countryOfOriginName'], 'Pakistan'));
  setPf('shippingClass', firstVal(row, ['shippingClass']));
  setPf('freightClass', firstVal(row, ['freightClass']));
  setPf('stackingLimit', firstVal(row, ['stackingLimit']));
  setPf('dangerousGoods', !!row.dangerousGoods);
  setPf('unNumber', firstVal(row, ['unNumber']));
  setPf('handlingInstructions', firstVal(row, ['handlingInstructions']));
  setPf('videoUrl', firstVal(row, ['videoUrl']));
  setPf('warrantyPeriod', firstVal(row, ['warrantyPeriod']));
  setPf('warrantyUnit', firstVal(row, ['warrantyUnit'], 'Months'));
  setPf('isReturnable', row.isReturnable !== false);
  setPf('returnDays', firstVal(row, ['returnDays'], '7'));
  setPf('notes', firstVal(row, ['notes']));
  const images = Array.isArray(row.images) ? row.images : [row.mainImage || row.image];
  prodImages = images.filter(Boolean).slice(0, 5);
  renderProdImages();
  const custom = Array.isArray(row.customFields) ? row.customFields : [];
  custom.forEach((item) => addCustomRow(item.name || item.key || '', item.value || ''));
  document.getElementById('prod-overlay').style.display = 'flex';
  void refreshProductCodePreviews();
}

function closeProdForm() {
  document.getElementById('prod-quick-overlay').style.display = 'none';
  document.getElementById('prod-overlay').style.display = 'none';
  prodEditing = null;
}

function collectProductForm() {
  const tags = pfVal('tags');
  const payload = {
    id: prodEditing?.id,
    name: pfVal('name'),
    sku: pfVal('sku'),
    barcode: pfVal('barcode'),
    barcodeNumber: pfVal('barcode'),
    qrCode: pfVal('qrCode'),
    productType: pfVal('productType') || 'Physical',
    description: pfVal('description'),
    tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    isActive: pfBool('isActive'),
    costPrice: pfNum('costPrice'),
    sellingPrice: pfNum('sellingPrice'),
    price: pfNum('sellingPrice'),
    landingCost: pfNum('landingCost'),
    currency: pfVal('currency') || 'PKR',
    currencyCode: pfVal('currency') || 'PKR',
    taxRate: taxContext?.enabled ? pfNum('taxRate') : 0,
    taxType: taxContext?.enabled ? (pfVal('taxType') || (taxContext.pricingModel === 'inclusive' ? 'Inclusive' : 'Exclusive')) : '',
    taxTypeName: taxContext?.enabled ? (pfVal('taxType') || (taxContext.pricingModel === 'inclusive' ? 'Inclusive' : 'Exclusive')) : '',
    stockUnit: pfVal('stockUnit'),
    stockUnitName: pfVal('stockUnit'),
    currentStock: pfNum('currentStock'),
    minimumStock: pfNum('minimumStock'),
    maximumStock: pfNum('maximumStock'),
    category: pfVal('category') || null,
    categoryId: pfVal('category') || null,
    subCategory: pfVal('subCategory') || null,
    subcategoryId: pfVal('subCategory') || null,
    brand: pfVal('brand'),
    brandName: pfVal('brand'),
    modelNumber: pfVal('modelNumber'),
    supplierId: pfVal('supplier') || null,
    supplier: localSuppliers.find((s) => String(s.id || s._id) === pfVal('supplier'))?.name || pfVal('supplier'),
    supplierName: localSuppliers.find((s) => String(s.id || s._id) === pfVal('supplier'))?.name || pfVal('supplier'),
    supplierSku: pfVal('supplierSku'),
    leadTime: pfVal('leadTime'),
    leadTimeDays: pfNum('leadTime'),
    reorderPoint: pfNum('reorderPoint'),
    rackLocation: pfVal('rackLocation'),
    rackLocationName: pfVal('rackLocation'),
    zone: pfVal('zone'),
    zoneName: pfVal('zone'),
    palletNumber: pfVal('palletNumber'),
    shelfNumber: pfVal('shelfNumber'),
    storageCondition: pfVal('storageCondition'),
    storageConditionName: pfVal('storageCondition'),
    tempMin: pfVal('tempMin'),
    temperatureMin: pfVal('tempMin'),
    tempMax: pfVal('tempMax'),
    temperatureMax: pfVal('tempMax'),
    weight: pfVal('weight'),
    weightUnit: pfVal('weightUnit'),
    weightUnitName: pfVal('weightUnit'),
    length: pfVal('length'),
    width: pfVal('width'),
    height: pfVal('height'),
    dimensionUnit: pfVal('dimensionUnit'),
    color: pfVal('color'),
    size: pfVal('size'),
    material: pfVal('material'),
    finish: pfVal('finish'),
    hasExpiry: pfBool('hasExpiry'),
    isBatchManaged: pfBool('isBatchManaged'),
    isSerialManaged: pfBool('isSerialManaged'),
    isExpiryManaged: pfBool('isExpiryManaged'),
    expiryDate: pfVal('expiryDate'),
    manufacturingDate: pfVal('manufacturingDate'),
    batchNumber: pfVal('batchNumber'),
    shelfLife: pfVal('shelfLife'),
    shelfLifeDays: pfNum('shelfLife'),
    isBulkManaged: pfBool('isBulkManaged'),
    hasIndividualTracking: pfBool('hasIndividualTracking'),
    bulkUnit: pfVal('bulkUnit'),
    defaultBatchQuantity: pfVal('defaultBatchQuantity'),
    defaultQuantityPerBatch: pfNum('defaultBatchQuantity'),
    hsCode: pfVal('hsCode'),
    countryOfOrigin: pfVal('countryOfOrigin'),
    countryOfOriginName: pfVal('countryOfOrigin'),
    shippingClass: pfVal('shippingClass'),
    freightClass: pfVal('freightClass'),
    stackingLimit: pfVal('stackingLimit'),
    dangerousGoods: pfBool('dangerousGoods'),
    unNumber: pfVal('unNumber'),
    handlingInstructions: pfVal('handlingInstructions'),
    images: prodImages.slice(),
    mainImage: prodImages[0] || '',
    image: prodImages[0] || '',
    videoUrl: pfVal('videoUrl'),
    customFields: collectCustomFields(),
    warrantyPeriod: pfVal('warrantyPeriod'),
    warrantyUnit: pfVal('warrantyUnit') || 'Months',
    isReturnable: pfBool('isReturnable'),
    returnDays: pfNum('returnDays'),
    notes: pfVal('notes'),
  };
  if (!payload.qrCode && payload.sku) payload.qrCode = payload.sku;
  if (!payload.barcode && payload.sku) {
    payload.barcode = payload.sku;
    payload.barcodeNumber = payload.sku;
  }
  return payload;
}

function initProductPanel() {
  document.getElementById('prod-search')?.addEventListener('input', renderLocalProducts);
  document.getElementById('prod-add')?.addEventListener('click', () => openProdForm(null));
  document.getElementById('prod-form-cancel')?.addEventListener('click', closeProdForm);
  document.getElementById('prod-form-no')?.addEventListener('click', closeProdForm);
  document.getElementById('prod-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-prod-tab]');
    if (tab) showProdTab(tab.getAttribute('data-prod-tab'));
  });
  pf('category')?.addEventListener('change', () => {
    fillProductCats(pfVal('category'), '');
  });
  let prodQuickKind = 'category';
  function openProdQuick(kind) {
    if (kind === 'subcategory' && !pfVal('category')) {
      alert('Select a category first');
      return;
    }
    prodQuickKind = kind;
    document.getElementById('prod-quick-title').textContent =
      kind === 'subcategory' ? 'Add sub-category' : 'Add category';
    document.getElementById('prod-quick-name').value = '';
    document.getElementById('prod-quick-error').textContent = '';
    document.getElementById('prod-quick-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('prod-quick-name').focus(), 30);
  }
  function closeProdQuick() {
    document.getElementById('prod-quick-overlay').style.display = 'none';
  }
  async function saveProdQuick() {
    const name = document.getElementById('prod-quick-name').value.trim();
    const err = document.getElementById('prod-quick-error');
    if (!name) {
      err.textContent = 'Name is required';
      return;
    }
    const parentId = pfVal('category');
    if (prodQuickKind === 'subcategory' && !parentId) {
      err.textContent = 'Select a category first';
      return;
    }
    err.textContent = '';
    const res = prodQuickKind === 'subcategory'
      ? await api.catalog.saveSubcategory({ name, categoryId: parentId })
      : await api.catalog.saveCategory({ name });
    if (!res?.success) {
      err.textContent = res?.message || 'Save failed';
      return;
    }
    const createdId = String(res?.data?.id || res?.data?._id || '');
    await loadLocalCatalog();
    if (typeof loadCategories === 'function') loadCategories();
    if (prodQuickKind === 'category') fillProductCats(createdId, '');
    else fillProductCats(parentId, createdId);
    closeProdQuick();
  }
  document.getElementById('pf-add-category')?.addEventListener('click', () => openProdQuick('category'));
  document.getElementById('pf-add-subcategory')?.addEventListener('click', () => openProdQuick('subcategory'));
  document.getElementById('prod-quick-cancel')?.addEventListener('click', closeProdQuick);
  document.getElementById('prod-quick-save')?.addEventListener('click', () => { void saveProdQuick(); });
  document.getElementById('prod-quick-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveProdQuick();
    }
  });
  function ensurePfSku() {
    let sku = pfVal('sku');
    if (sku) return sku;
    const name = pfVal('name') || 'PRD';
    const prefix = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'PRD';
    sku = `${prefix}-${Date.now().toString().slice(-6)}`;
    setPf('sku', sku);
    return sku;
  }

  document.getElementById('pf-barcode-scan')?.addEventListener('click', () => {
    const apply = (raw) => {
      const code = window.PosProductCodes
        ? window.PosProductCodes.normalizeProductCode(raw)
        : normalizeScanInput(raw);
      setPf('barcode', code);
    };
    if (typeof window.openCodeScanner === 'function') {
      window.openCodeScanner({
        title: 'Scan barcode',
        onScan: apply,
      });
      return;
    }
    const code = prompt('Scan or enter barcode:');
    if (code) apply(code);
  });
  document.getElementById('pf-barcode-auto')?.addEventListener('click', () => {
    setPf('barcode', ensurePfSku());
  });
  document.getElementById('pf-qr-scan')?.addEventListener('click', () => {
    const apply = (raw) => {
      const code = window.PosProductCodes
        ? window.PosProductCodes.normalizeProductCode(raw)
        : normalizeScanInput(raw);
      setPf('qrCode', code);
    };
    if (typeof window.openCodeScanner === 'function') {
      window.openCodeScanner({
        title: 'Scan QR / barcode',
        onScan: apply,
      });
      return;
    }
    showToast('Use barcode scanner or enter QR code manually in the field', 'info');
  });
  document.getElementById('pf-qr-from-sku')?.addEventListener('click', () => {
    setPf('qrCode', ensurePfSku());
  });
  document.getElementById('pf-barcode')?.addEventListener('input', () => {
    void refreshProductCodePreviews();
  });
  document.getElementById('pf-barcode')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = normalizeScanInput(e.target.value);
      setPf('barcode', code);
    }
  });
  document.getElementById('pf-qrCode')?.addEventListener('input', () => {
    void refreshProductCodePreviews();
  });
  document.getElementById('pf-qrCode')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = normalizeScanInput(e.target.value);
      setPf('qrCode', code);
    }
  });
  document.getElementById('pf-image-add-url')?.addEventListener('click', () => {
    addProdImage(pfVal('imageUrl'));
    setPf('imageUrl', '');
  });
  document.getElementById('pf-image-pick')?.addEventListener('click', () => {
    document.getElementById('pf-image-files')?.click();
  });
  document.getElementById('pf-image-files')?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    files.slice(0, Math.max(0, 5 - prodImages.length)).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => addProdImage(reader.result);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  });
  document.getElementById('pf-custom-add')?.addEventListener('click', () => addCustomRow());
  document.getElementById('prod-table')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-prod]');
    const delBtn = e.target.closest('[data-del-prod]');
    if (editBtn) {
      openProdForm(localProducts.find((p) => p.id === editBtn.getAttribute('data-edit-prod')));
      return;
    }
    if (delBtn && confirm('Delete this product?')) {
      await api.catalog.deleteProduct(delBtn.getAttribute('data-del-prod'));
      await afterProductChange();
      return;
    }

    // Row click fallback (open edit modal)
    const prodRow = e.target.closest('[data-prod-row-id]');
    if (prodRow) {
      openProdForm(localProducts.find((p) => p.id === prodRow.getAttribute('data-prod-row-id')));
    }
  });
  document.getElementById('prod-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = collectProductForm();
    const err = document.getElementById('prod-form-error');
    if (!payload.name) {
      if (err) err.textContent = 'Product name is required';
      showProdTab('basic');
      return;
    }
    if (!Number.isFinite(payload.costPrice) || payload.costPrice < 0) {
      if (err) err.textContent = 'Enter a valid cost price';
      showProdTab('pricing');
      return;
    }
    if (!Number.isFinite(payload.sellingPrice) || payload.sellingPrice < 0) {
      if (err) err.textContent = 'Enter a valid selling price';
      showProdTab('pricing');
      return;
    }
    const res = await api.catalog.saveProduct(payload);
    if (!res?.success) {
      if (err) err.textContent = res?.message || 'Save failed';
      return;
    }
    closeProdForm();
    await afterProductChange();
  });
}

initProductPanel();

document.getElementById('logout')?.addEventListener('click', () => api?.auth?.logout());
// ─── Sales register: search + date range + print/pdf ───────────────────────
const srSearch = document.getElementById('sales-search');
const srFrom = document.getElementById('sales-date-from');
const srTo = document.getElementById('sales-date-to');
srSearch?.addEventListener('input', () => {
  salesFilter.search = srSearch.value || '';
  loadSalesRegister();
});
srFrom?.addEventListener('change', () => {
  salesFilter.from = srFrom.value || '';
  loadSalesRegister();
});
srTo?.addEventListener('change', () => {
  salesFilter.to = srTo.value || '';
  loadSalesRegister();
});
document.getElementById('btn-sales-print')?.addEventListener('click', () => printSalesReport());
document.getElementById('btn-sales-pdf')?.addEventListener('click', () => exportSalesReportPdf());
document.getElementById('btn-sales-delete-all')?.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to delete ALL sales? This action cannot be undone.')) return;
  if (!confirm('This will permanently delete all POS sales from the system. Continue?')) return;
  
  try {
    const res = await api.pos.deleteAllSales();
    if (res?.success) {
      alert('All sales have been deleted successfully.');
      loadSalesRegister();
    } else {
      alert(res?.message || 'Failed to delete sales');
    }
  } catch (err) {
    alert('Error deleting sales: ' + err.message);
  }
});
document.getElementById('btn-detail-print')?.addEventListener('click', () => printSaleSlip());
document.getElementById('btn-detail-pdf')?.addEventListener('click', () => exportSalePdf());
document.getElementById('btn-detail-delete')?.addEventListener('click', async () => deleteSale());
document.getElementById('sale-detail-close')?.addEventListener('click', closeSaleDetail);
document.getElementById('sale-detail-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'sale-detail-modal') closeSaleDetail();
});
window.addEventListener('DOMContentLoaded', () => {
  boot()
    .then(() => {
      initStockPanel();
    })
    .catch((err) => {
      console.error('[POS Boot Error]', err);
      alert('Could not initialize POS system: ' + err.message);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN (Offline Inventory Receiving & Costing Flow) LOGIC
// ═══════════════════════════════════════════════════════════════════════════

let stockSelectedProduct = null;
let stockMovementsList = [];

// Initialize Stock In listeners & setup
function initStockPanel() {
  const form = document.getElementById('stock-movement-form');
  if (!form) return;

  const barcodeInp = document.getElementById('stock-barcode-scan');
  const searchInp = document.getElementById('stock-product-search');
  const productList = document.getElementById('stock-product-list');
  const productSelect = document.getElementById('stock-product-select');
  const typeSelect = document.getElementById('stock-type-select');
  const bulkQtyInp = document.getElementById('stock-qty-input');
  const boxCountInp = document.getElementById('stock-box-count-input');
  const pcsPerBoxInp = document.getElementById('stock-pieces-per-box-input');
  const costInp = document.getElementById('stock-cost-input');
  const reasonSelect = document.getElementById('stock-reason-select');
  const supplierSelect = document.getElementById('stock-supplier-select');
  const refInp = document.getElementById('stock-reference-input');
  const notesInp = document.getElementById('stock-notes-input');
  const submitBtn = document.getElementById('btn-submit-stock');

  // 1. Search filter for product list
  searchInp?.addEventListener('input', () => {
    renderStockProductList(searchInp.value);
  });

  // 2. Clickable product list (replaces flaky <select size> listbox)
  productList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-product-id]');
    if (!btn) return;
    const id = String(btn.getAttribute('data-product-id') || '');
    const prod = localProducts.find((p) => String(p.id) === id || String(p._id || '') === id);
    if (!prod) {
      showStockFormAlert('Product not found in local catalog', 'error');
      return;
    }
    applyStockProductSelection(prod);
  });

  // 3. Stock Type format switch (Bulk vs Box)
  typeSelect.addEventListener('change', () => {
    const format = typeSelect.value;
    const bulkGroup = document.getElementById('stock-bulk-qty-group');
    const boxGroup = document.getElementById('stock-box-qty-group');
    const calcQtyDisp = document.getElementById('stock-calc-qty-display');

    if (format === 'box') {
      bulkGroup.style.display = 'none';
      boxGroup.style.display = 'flex';
      calcQtyDisp.style.display = 'block';
    } else {
      bulkGroup.style.display = 'flex';
      boxGroup.style.display = 'none';
      calcQtyDisp.style.display = 'none';
    }
    recalculateStockFormTotal();
  });

  // 4. Barcode scanning handler
  barcodeInp.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = normalizeScanInput(barcodeInp.value);
      if (!code) return;
      barcodeInp.value = '';

      // Match barcode / QR / SKU in localProducts
      const matched = localProducts.find((p) =>
        [p.barcode, p.barcodeNumber, p.sku, p.qrCode, p.qr_code]
          .some((v) => String(v || '').trim() === code)
      );
      if (matched) {
        applyStockProductSelection(matched);
        showStockFormAlert('Product matched successfully!', 'success');
      } else {
        showStockFormAlert(`No local product found for barcode/SKU: ${code}`, 'error');
      }
    }
  });

  // 5. Quantity and cost change listeners
  bulkQtyInp.addEventListener('input', recalculateStockFormTotal);
  boxCountInp.addEventListener('input', recalculateStockFormTotal);
  pcsPerBoxInp.addEventListener('input', recalculateStockFormTotal);
  costInp.addEventListener('input', recalculateStockFormTotal);

  // 6. Form submit handler
  submitBtn.addEventListener('click', async () => {
    try {
      if (!stockSelectedProduct) {
        showStockFormAlert('Please select a product first', 'error');
        return;
      }

      const format = typeSelect.value;
      let quantity = 0;
      let boxCountVal = null;
      let piecesPerBoxVal = null;

      if (format === 'box') {
        const boxes = parseFloat(boxCountInp.value);
        const pieces = parseFloat(pcsPerBoxInp.value);
        if (isNaN(boxes) || boxes <= 0 || isNaN(pieces) || pieces <= 0) {
          showStockFormAlert('Please enter valid Box Count and Pieces per Box', 'error');
          return;
        }
        quantity = boxes * pieces;
        boxCountVal = boxes;
        piecesPerBoxVal = pieces;
      } else {
        const qty = parseFloat(bulkQtyInp.value);
        if (isNaN(qty) || qty <= 0) {
          showStockFormAlert('Please enter a valid quantity', 'error');
          return;
        }
        quantity = qty;
      }

      const cost = parseFloat(costInp.value);
      if (isNaN(cost) || cost < 0) {
        showStockFormAlert('Please enter a valid unit cost', 'error');
        return;
      }

      const reason = reasonSelect.value;
      const supplierId = supplierSelect.value || null;
      const supplierName = supplierId
        ? (localSuppliers.find(s => String(s.id || s._id) === supplierId)?.name || '')
        : null;

      const reference = refInp.value.trim();
      const notes = notesInp.value.trim();

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';

      const payload = {
        productId: stockSelectedProduct.id,
        quantity,
        unitCost: cost,
        stockType: format,
        reason: getReasonLabel(reason),
        supplierId,
        supplierName,
        reference,
        notes,
        boxCount: boxCountVal,
        piecesPerBox: piecesPerBoxVal,
      };

      const res = await api.pos.addStockIn(payload);
      if (res && res.success) {
        showToast('Inventory stock received successfully', 'success');
        showStockFormAlert('Stock received and updated successfully!', 'success');

        // Reset form
        bulkQtyInp.value = '';
        boxCountInp.value = '';
        pcsPerBoxInp.value = '';
        refInp.value = '';
        notesInp.value = '';

        // Reload products cache to reflect stock change locally
        if (typeof loadLocalProducts === 'function') {
          await loadLocalProducts();
        }

        // Refresh stock panel data
        await loadStockPanel();
      } else {
        showStockFormAlert(res.message || 'Failed to save stock movement', 'error');
      }
    } catch (err) {
      showStockFormAlert(err.message || 'Error executing stock transaction', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Stock In';
    }
  });
}

function applyStockProductSelection(prod) {
  if (!prod) return;
  stockSelectedProduct = prod;

  const id = String(prod.id || prod._id || '');
  const productSelect = document.getElementById('stock-product-select');
  if (productSelect) productSelect.value = id;

  document.querySelectorAll('#stock-product-list .stock-product-item').forEach((el) => {
    el.classList.toggle('active', String(el.getAttribute('data-product-id') || '') === id);
  });

  const banner = document.getElementById('stock-selected-banner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = `Selected: ${prod.name || 'Product'}${prod.sku ? ` · SKU ${prod.sku}` : ''}`;
  }

  onStockProductSelected(prod);
}

function resolveProductUnitCost(prod) {
  const raw = prod?.costPrice ?? prod?.cost_price ?? prod?.landingCost ?? prod?.purchasePrice ?? prod?.purchase_price;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function onStockProductSelected(prod) {
  if (!prod) return;

  // Show unit label
  const unitLabel = document.getElementById('stock-unit-label');
  const unit = prod.stockUnitName || prod.stockUnit || 'Pcs';
  if (unitLabel) {
    unitLabel.textContent = unit;
    unitLabel.style.display = 'inline-block';
  }

  // Always pre-fill unit cost (0 if product has no cost saved)
  const costInp = document.getElementById('stock-cost-input');
  if (costInp) {
    costInp.value = String(resolveProductUnitCost(prod));
  }
  recalculateStockFormTotal();
}

function recalculateStockFormTotal() {
  const format = document.getElementById('stock-type-select').value;
  const bulkQty = parseFloat(document.getElementById('stock-qty-input').value) || 0;
  const boxCount = parseFloat(document.getElementById('stock-box-count-input').value) || 0;
  const pcsPerBox = parseFloat(document.getElementById('stock-pieces-per-box-input').value) || 0;
  const cost = parseFloat(document.getElementById('stock-cost-input').value) || 0;

  let qty = 0;
  if (format === 'box') {
    qty = boxCount * pcsPerBox;
    const calcVal = document.getElementById('stock-calc-qty-val');
    if (calcVal) calcVal.textContent = qty;
  } else {
    qty = bulkQty;
  }

  const total = qty * cost;
  const totalValDisp = document.getElementById('stock-total-value');
  if (totalValDisp) {
    totalValDisp.textContent = `${pkr(total)}`;
  }
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderStockProductList(query = '') {
  const list = document.getElementById('stock-product-list');
  const select = document.getElementById('stock-product-select');
  if (!list) return;

  const prevId = stockSelectedProduct
    ? String(stockSelectedProduct.id || stockSelectedProduct._id || '')
    : '';
  const q = String(query).toLowerCase().trim();
  const filtered = (localProducts || []).filter((p) =>
    !q || `${p.name || ''} ${p.sku || ''} ${p.barcode || ''}`.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    list.innerHTML = `<button type="button" class="stock-product-item" disabled>No matching products</button>`;
    if (select) select.innerHTML = `<option value="">No matching products</option>`;
    return;
  }

  const maxShow = 80;
  const shown = filtered.slice(0, maxShow);
  list.innerHTML = shown.map((p) => {
    const id = String(p.id || p._id || '');
    const unit = p.stockUnitName || p.stockUnit || 'Pcs';
    const stockStr = p.currentStock != null ? `${p.currentStock} ${unit}` : `0 ${unit}`;
    const active = prevId && prevId === id ? ' active' : '';
    return `<button type="button" class="stock-product-item${active}" data-product-id="${escapeHtmlAttr(id)}" role="option">
      ${escapeHtmlAttr(p.name || 'Unnamed')}
      <span class="meta">SKU: ${escapeHtmlAttr(p.sku || 'N/A')} · Stock: ${escapeHtmlAttr(stockStr)} · Cost: ${escapeHtmlAttr(pkr(resolveProductUnitCost(p)))}</span>
    </button>`;
  }).join('') + (filtered.length > maxShow
    ? `<button type="button" class="stock-product-item" disabled>…and ${filtered.length - maxShow} more — refine search</button>`
    : '');

  if (select) {
    select.innerHTML = shown.map((p) => {
      const id = String(p.id || p._id || '');
      return `<option value="${escapeHtmlAttr(id)}">${escapeHtmlAttr(p.name || '')}</option>`;
    }).join('');
  }

  // Auto-pick when only one match
  if (filtered.length === 1) {
    applyStockProductSelection(filtered[0]);
  } else if (prevId && filtered.some((p) => String(p.id || p._id) === prevId)) {
    if (select) select.value = prevId;
  }
}

function getReasonLabel(reason) {
  switch (reason) {
    case 'opening_stock': return 'Opening Stock';
    case 'purchase': return 'Purchase';
    case 'adjustment': return 'Stock Adjustment';
    case 'return': return 'Sales Return';
    default: return 'Stock In';
  }
}

function showStockFormAlert(msg, type = 'error') {
  const alertEl = document.getElementById('stock-form-alert');
  if (!alertEl) return;
  alertEl.className = `stock-alert ${type}`;
  alertEl.textContent = msg;
  alertEl.style.display = 'block';
  if (type === 'success') {
    setTimeout(() => { alertEl.style.display = 'none'; }, 5000);
  }
}

// Loads product lists, suppliers, and movements list
async function loadStockPanel() {
  try {
    // Refresh products (listProducts also backfills cost from API cache when SQLite cost is 0)
    if (typeof loadLocalProducts === 'function') {
      await loadLocalProducts();
    }

    // Fill product list
    renderStockProductList(document.getElementById('stock-product-search')?.value || '');

    // Fill suppliers dropdown
    const supSelect = document.getElementById('stock-supplier-select');
    if (supSelect) {
      const suppliers = Array.isArray(localSuppliers) ? localSuppliers : [];
      supSelect.innerHTML = `<option value="">Select supplier...</option>` + suppliers.map(s =>
        `<option value="${escapeHtmlAttr(s.id || s._id)}">${escapeHtmlAttr(s.name)}</option>`
      ).join('');
    }

    // Fetch stock movements from SQLite
    const res = await api.pos.listStockMovements({ limit: 100 });
    if (res && res.success) {
      stockMovementsList = res.data || [];
      renderStockMovementsHistory();
    }
  } catch (err) {
    console.error('Error loading stock panel data:', err);
  }
}

function renderStockMovementsHistory() {
  const body = document.getElementById('stock-history-table-body');
  if (!body) return;

  if (!stockMovementsList.length) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--muted);">No stock movements recorded yet.</td></tr>`;
    return;
  }

  body.innerHTML = stockMovementsList.map(m => {
    const dateStr = new Date(m.createdAt).toLocaleString();
    const costStr = m.unitCost != null ? pkr(m.unitCost) : pkr(0);
    const totalStr = m.totalCost != null ? pkr(m.totalCost) : pkr(0);
    const typeBadge = m.type === 'stock_in'
      ? `<span class="badge-type in">Stock In</span>`
      : `<span class="badge-type out">Stock Out</span>`;

    const qtyStr = `${m.quantity} ${m.unit || 'Pcs'}`;
    const afterStr = m.newStock != null ? `${m.newStock} ${m.unit || 'Pcs'}` : '—';
    const supplierStr = m.supplierName || '—';
    const formatStr = m.stockType === 'box' ? 'Boxed' : 'Bulk';

    return `
      <tr>
        <td>${dateStr}</td>
        <td><strong>${m.productName}</strong></td>
        <td>${m.reason || 'Stock Adjust'}</td>
        <td>${formatStr}</td>
        <td>${typeBadge} <strong>+${qtyStr}</strong></td>
        <td>${afterStr}</td>
        <td>${costStr}</td>
        <td><strong>${totalStr}</strong></td>
        <td>${supplierStr}</td>
      </tr>
    `;
  }).join('');
}


