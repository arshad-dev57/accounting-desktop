
'use strict';

// DEBUG: track boot progress in a global readable by main process
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
  if (window.bisonLocation) {
    const picked = bisonLocation.effectiveId(bisonLocation.getStoredLocationId());
    if (picked) return picked;
  }
  return selectedLocation?.id || currentTerminal?.locationId || currentTerminal?.location?.id || '';
}

async function initLocationPicker() {
  const select = document.getElementById('location-select');
  if (!select) return;
  // Load from local cache (no live API call)
  try {
    const res = await api.pos.listLocations();
    locationList = Array.isArray(res?.data) ? res.data : [];
  } catch (err) {
    locationList = [];
  }
  const preferred =
    (window.bisonLocation ? bisonLocation.getStoredLocationId() : '') ||
    currentTerminal?.locationId ||
    currentTerminal?.location?.id ||
    '';
  if (window.bisonLocation) {
    const chosen = bisonLocation.fillLocationSelect(select, locationList, preferred, { allowAll: true });
    bisonLocation.setStoredLocationId(chosen);
    applySelectedLocation(chosen);
  } else {
    applySelectedLocation(preferred);
  }
  select.addEventListener('change', () => {
    void onLocationChanged(select.value);
  });
}

function applySelectedLocation(id) {
  const effective = window.bisonLocation ? bisonLocation.effectiveId(id) : String(id || '');
  selectedLocation =
    locationList.find((l) => l.id === effective) ||
    (effective ? { id: effective } : currentTerminal?.location || {});
}

async function onLocationChanged(id) {
  if (window.bisonLocation) bisonLocation.setStoredLocationId(id);
  applySelectedLocation(id);
  // Load catalog from local DB — no live API sync on location change
  await loadCategories();
  await loadCategoryProducts(selectedCategoryId || 'All');
  if (typeof loadLocalCatalog === 'function') loadLocalCatalog();
  if (typeof loadLocalProducts === 'function') loadLocalProducts();
}

// State management
let activeShift = null;
let currentCashier = null;
let currentTerminal = null;
let selectedLocation = null;
let locationList = [];
let companyProfile = null;
let taxContext = null;

// Sell tab state
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
}

function saveLocalSettings() {
  posSettings.enableBarcodeScanner = document.getElementById('settings-enable-scanner').checked;
  posSettings.enablePaymentTerminal = document.getElementById('settings-enable-terminal').checked;
  posSettings.autoPrintOnSale = document.getElementById('settings-enable-thermal').checked;

  localStorage.setItem('pos_settings', JSON.stringify(posSettings));
  alert('Settings saved successfully!');
}

document.getElementById('btn-save-settings').addEventListener('click', saveLocalSettings);

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
}

// Boot Check
async function boot() {
  window.__bootSteps.push('boot start');
  try { loadLocalSettings(); } catch (e) { window.__bootSteps.push('loadLocalSettings err: ' + e.message); }

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
  await initLocationPicker();
  window.__bootSteps.push('initLocationPicker done');
  const locId = currentLocationId();

  // Don't auto-sync on boot - let user manually sync or sync in background
  // This prevents app from getting stuck on slow network
  window.__bootSteps.push('about to getProfile');

  // Get Company profile info
  const profRes = await api.pos.getProfile();
  window.__bootSteps.push('getProfile done: ' + profRes?.success);
  if (profRes?.success) {
    companyProfile = profRes.data;
  }

  // Get Tax context
  const taxRes = await api.tax.getContext();
  window.__bootSteps.push('getTaxContext done: ' + taxRes?.success);
  if (taxRes?.success) {
    taxContext = taxRes.data;
  }
  window.__bootSteps.push('about loadCategories');

  // Set top information
  cashierMetaEl.textContent = `Cashier: ${[currentCashier.firstName, currentCashier.lastName].filter(Boolean).join(' ') || currentCashier.email || 'Cashier'}`;

  const session = await api.auth.getSession();
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn && (session?.isAdmin || isAdminRole(session?.user?.role))) {
    adminBtn.style.display = '';
  }
  terminalBadgeEl.textContent = `${currentTerminal.name || 'Terminal'}`;

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
      if (targetTab === 'settings') { try { loadMachineInfo(); } catch (e) { console.warn('loadMachineInfo not defined', e); } }
      if (targetTab === 'stock') { try { loadStockPanel(); } catch (e) { console.warn('loadStockPanel not defined', e); } }
      if (targetTab === 'returns') { try { loadReturnHistory(); } catch (e) { console.warn('loadReturnHistory not defined', e); } }
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
    if (msg) msg.textContent = 'Uploading local changes to the cloud, then pulling the latest catalog…';
    try {
      const catalog = await api.pos.syncMasterData({
        refresh: true,
        locationId: currentLocationId(),
      });
      if (msg) msg.textContent = 'Updating the local catalog…';
      try { await api.pos.syncOfflineSales(); } catch (_) { /* offline queue optional */ }
      if (catalog?.offline || catalog?.code === 'OFFLINE') {
        showToast(catalog?.message || 'No internet connection. Sync skipped.', 'error');
        if (overlay) overlay.classList.remove('show');
        await updateOfflineCount();
        return;
      }
      if (catalog?.success) {
        const n = catalog.counts?.products || 0;
        const c = catalog.counts?.categories || 0;
        const u = catalog.counts?.customers || 0;
        if (window.bisonLocation) bisonLocation.setLastSyncedLocationId(currentLocationId());
        showToast(`Cloud catalog synced · ${c} categories, ${n} products, ${u} customers`, 'success');
        if (overlay) overlay.classList.remove('show');
        await applySyncedCatalog(catalog);
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
      <div class="prod-card-price">$${Number(p.sellingPrice || 0).toFixed(2)}</div>
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
        stockSelectedProduct = matched;
        const productSelect = document.getElementById('stock-product-select');
        if (productSelect) productSelect.value = matched.id;
        onStockProductSelected(matched);
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
    if (tag === 'input' && !isScanField && !['text', 'search', 'number'].includes(String(target.type || '').toLowerCase())) {
      return;
    }

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
    // Slow manual typing in a search box is not a scanner wedge burst
    if (tag === 'input' && lastAt && now - lastAt > 180) {
      buffer = e.key;
    } else {
      buffer += e.key;
    }
    lastAt = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushBuffer, IDLE_MS);
  }, true);
}

attachHidBarcodeScanner();
setTimeout(() => barcodeScanInp?.focus(), 200);

// ─── CART persistence ────────────────────────────────────────────────────────
function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
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
      const rate = money(item.taxRate);
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
  if (cartSubtotalEl) cartSubtotalEl.textContent = `$${money(subtotal).toFixed(2)}`;
  if (cartDiscountValueEl) cartDiscountValueEl.textContent = `-$${money(discountTotal).toFixed(2)}`;

  if (taxContext?.enabled && finalTax > 0) {
    if (taxSummaryRow) taxSummaryRow.style.display = 'flex';
    if (taxRegimeLabel) taxRegimeLabel.textContent = `${regime}${pricingModel === 'inclusive' ? ' (incl.)' : ''}`;
    if (cartTaxValueEl) cartTaxValueEl.textContent = `$${money(finalTax).toFixed(2)}`;
  } else if (taxSummaryRow) {
    taxSummaryRow.style.display = 'none';
  }

  if (cartGrandTotalEl) cartGrandTotalEl.textContent = `$${money(grandTotal).toFixed(2)}`;
  if (checkoutGrandTotalEl) checkoutGrandTotalEl.textContent = `$${money(grandTotal).toFixed(2)}`;

  const disabled = cart.length === 0;
  if (btnCheckoutTrigger) btnCheckoutTrigger.disabled = disabled;
  const btnCreditSale = document.getElementById('btn-credit-sale-trigger');
  if (btnCreditSale) btnCreditSale.disabled = disabled;
  if (btnHoldSaleTrigger) btnHoldSaleTrigger.disabled = disabled;
  if (btnClearCart) btnClearCart.style.display = disabled ? 'none' : 'block';

  return { subtotal, discountTotal, taxTotal: finalTax, grandTotal };
}

function addProductToCart(p) {
  const stock = p.currentStock ?? p.availableStock ?? 0;

  // Block adding if stock is 0
  if (stock <= 0) {
    showToast(`⚠️ Cannot add ${p.name} - Out of stock!`, 'error');
    return;
  }

  const existing = cart.find(item => item.productId === p.id);
  if (existing) {
    // Only enforce stock ceiling when stock is tracked (> 0).
    if (stock > 0 && existing.quantity >= stock) {
      showToast(`Cannot add more. Stock limit reached for ${p.name}!`, 'error');
      return;
    }
    existing.quantity += 1;
    existing.lineTotal = existing.quantity * existing.unitPrice;
  } else {
    const rate = p.taxRate || (taxContext?.enabled ? taxContext.defaultRate : 0) || 0;
    cart.push({
      productId: p.id,
      productName: p.name,
      sku: p.sku || '',
      quantity: 1,
      unitPrice: Number(p.sellingPrice || 0),
      discount: 0,
      taxRate: rate,
      taxAmount: 0,
      lineTotal: Number(p.sellingPrice || 0),
      currentStock: stock,
      isCustom: false
    });
  }
  renderCartList();
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
          <span>${item.quantity} × $${Number(item.unitPrice || 0).toFixed(2)}</span>
        </div>
        <div class="cart-item-total">$${(Number(item.unitPrice || 0) * Number(item.quantity || 0)).toFixed(2)}</div>
      </div>
      <div class="cart-item-controls">
        <div class="cart-item-qty">
          <button class="btn-qty btn-minus" data-idx="${index}">-</button>
          <span style="font-weight:700;">${item.quantity}</span>
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
    row.querySelector('.btn-minus').addEventListener('click', () => {
      if (item.quantity > 1) {
        item.quantity -= 1;
      } else {
        cart.splice(index, 1);
      }
      renderCartList();
    });

    row.querySelector('.btn-plus').addEventListener('click', () => {
      item.quantity += 1;
      renderCartList();
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
  const qty = parseInt(String(customLineQtyInp?.value || '1'), 10);
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

function updateCustomLinePreview() {
  const el = document.getElementById('custom-line-total');
  if (!el) return;
  const price = parseCustomPrice();
  const qty = parseCustomQty();
  el.textContent = `$${(price * qty).toFixed(2)}`;
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
    taxRate: money(taxContext?.defaultRate),
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
    alert(`Credit limit exceeded. Available: $${available.toFixed(2)}`);
    return false;
  }
  return true;
}

function highlightPayQuick(method) {
  document.querySelectorAll('.pay-quick').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-method') === method);
  });
}

function setCheckoutMethod(method) {
  const totals = calculateTotals();
  if (isCreditMethod(method) && !canSellOnCredit(totals.grandTotal)) return;
  payments = [{ paymentMethod: method, amount: totals.grandTotal, reference: '' }];
  focusedPaymentIndex = 0;
  renderPaymentSplitRows();
  updateCheckoutChange();
}

function openCheckout(method) {
  const totals = calculateTotals();
  if (isCreditMethod(method) && !canSellOnCredit(totals.grandTotal)) return;

  const custEl = document.getElementById('checkout-customer-label');
  if (custEl) custEl.textContent = selectedCustomer?.name || 'Walk-in Customer';
  document.getElementById('checkout-modal-total').textContent = `$${totals.grandTotal.toFixed(2)}`;

  payments = [{ paymentMethod: method || 'Cash', amount: totals.grandTotal, reference: '' }];
  focusedPaymentIndex = 0;
  renderPaymentSplitRows();
  updateCheckoutChange();
  checkoutModalOverlay.style.display = 'flex';
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
    row.innerHTML = `
      <select class="pay-method-sel" data-idx="${idx}" style="flex:1;">
        <option value="Cash" ${pmt.paymentMethod === 'Cash' ? 'selected' : ''}>Cash</option>
        <option value="Card" ${pmt.paymentMethod === 'Card' ? 'selected' : ''}>Card</option>
        <option value="Bank Transfer" ${pmt.paymentMethod === 'Bank Transfer' ? 'selected' : ''}>Bank Transfer</option>
        <option value="Mobile Wallet" ${pmt.paymentMethod === 'Mobile Wallet' ? 'selected' : ''}>Mobile Wallet</option>
        <option value="Cheque" ${pmt.paymentMethod === 'Cheque' ? 'selected' : ''}>Cheque</option>
        <option value="Credit" ${pmt.paymentMethod === 'Credit' ? 'selected' : ''}>Credit</option>
      </select>
      <input type="number" class="pay-amount-inp" data-idx="${idx}" value="${pmt.amount.toFixed(2)}" step="0.01" style="width:100px;" />
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

  const label = document.getElementById('checkout-change-label');
  const value = document.getElementById('checkout-modal-change');
  const note = document.getElementById('checkout-credit-note');
  const primary = payments[0]?.paymentMethod || 'Cash';
  highlightPayQuick(isCreditMethod(primary) ? 'Credit' : primary === 'Card' ? 'Card' : 'Cash');
  if (note) note.style.display = credit ? 'block' : 'none';

  if (credit && diff >= -0.009) {
    label.textContent = 'On account:';
    value.textContent = `$${totals.grandTotal.toFixed(2)}`;
    value.style.color = '#0f766e';
  } else if (diff >= 0) {
    label.textContent = 'Change Due:';
    value.textContent = `$${diff.toFixed(2)}`;
    value.style.color = '#10b981';
  } else {
    label.textContent = 'Still Owed:';
    value.textContent = `$${Math.abs(diff).toFixed(2)}`;
    value.style.color = '#ef4444';
  }
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

  if (paidTotal < totals.grandTotal) {
    alert(`Insufficient payment. Need $${totals.grandTotal.toFixed(2)}, got $${paidTotal.toFixed(2)}`);
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
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxRate: i.taxRate,
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
    // Cloud returns { sale: {...} } but the offline queue returns the saved
    // sale object directly — accept both shapes so invoiceNumber/id survive.
    const saleData = res.data.sale || res.data;
    lastSale = {
      ...saleData,
      items: saleData?.items || cart,
      payments: saleData?.payments || payload.payments,
      paidAmount: paidTotal,
      changeAmount: paidTotal - totals.grandTotal,
      cashierName: cashierMetaEl.textContent.replace('Cashier: ', ''),
      terminalName: terminalBadgeEl.textContent
    };

    // Update local stock quantities
    cart.forEach(async (cartItem) => {
      const product = products.find(p => p.id === cartItem.productId);
      if (product) {
        product.currentStock = Math.max(0, (product.currentStock || 0) - cartItem.quantity);
        // Save to local database
        try {
          await window.bisonDesktop.catalog.saveProduct(product);
        } catch (err) {
          console.error('[POS] Failed to update local stock:', err);
        }
      }
    });
    renderProducts();

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

    // Render Receipt Modal
    renderReceipt();
    modalReceipt.style.display = 'flex';
  } else {
    alert(res?.message || 'Completed sale API error');
  }
}

// ─── RECEIPT LAYOUT RENDERING ─────────────────────────────────────────────────
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
  const company = companyProfile || { name: 'Bisonstechs POS', email: '', phone: '', address: {} };
  const addr = company.address || {};
  const dateStr = new Date(lastSale.createdAt || lastSale.orderDate || Date.now()).toLocaleString();
  let itemsHtml = '';
  lastSale.items.forEach(i => {
    const lineTotal = i.lineTotal || (i.unitPrice * i.quantity);
    itemsHtml += `<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${i.productName || i.name} x ${i.quantity}</span><span>$${Number(lineTotal).toFixed(2)}</span></div>`;
  });
  let paymentsHtml = '';
  lastSale.payments.forEach(p => {
    paymentsHtml += `<div style="display:flex;justify-content:space-between;font-size:11px;"><span>Payment (${p.paymentMethod})</span><span>$${Number(p.amount || 0).toFixed(2)}</span></div>`;
  });
  const finalTax = Number(lastSale.taxTotal || 0);
  const grandTotal = Number(lastSale.totalAmount || lastSale.grandTotal || 0);
  const change = Number(lastSale.changeAmount || 0);
  box.innerHTML = `
    <div style="text-align:center;border-bottom:1px dashed #ccc;padding-bottom:12px;margin-bottom:12px;"><h3 style="margin:0;font-size:16px;">${company.name || 'Bisonstechs POS'}</h3>
      <div style="font-size:11px;color:#555;margin-top:4px;">${addr.street || ''} ${addr.city || ''} ${addr.state || ''}<br/>Phone: ${company.phone || 'N/A'} | Email: ${company.email || 'N/A'}</div></div>
    <div style="font-size:11px;border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;"><b>Invoice:</b> ${lastSale.invoiceNumber || lastSale.orderNumber || 'Draft'}<br/><b>Date:</b> ${dateStr}<br/><b>Cashier:</b> ${lastSale.cashierName || 'Staff'}<br/><b>Customer:</b> ${lastSale.customerName || 'Walk-in Customer'}</div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">${itemsHtml}</div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;font-size:11px;">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>$${Number(lastSale.subtotal || grandTotal).toFixed(2)}</span></div>
      ${lastSale.discountTotal > 0 ? `<div style="display:flex;justify-content:space-between;color:#d97706;"><span>Discount</span><span>-$${Number(lastSale.discountTotal).toFixed(2)}</span></div>` : ''}
      ${finalTax > 0 ? `<div style="display:flex;justify-content:space-between;"><span>GST</span><span>$${finalTax.toFixed(2)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:bold;margin-top:4px;"><span>Total</span><span>$${grandTotal.toFixed(2)}</span></div></div>
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">${paymentsHtml}<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;margin-top:2px;"><span>Change Return</span><span>$${change.toFixed(2)}</span></div></div>
    <div style="text-align:center;font-size:10px;color:#777;margin-top:8px;">Thank you for shopping with us!<br/>Power by Bisonstechs POS Desktop</div>`;
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
          <span style="font-weight:700;color:var(--brand);">$${Number(sale.totalAmount || sale.grandTotal || 0).toFixed(2)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
          Customer: ${sale.customerName || (sale.customer && sale.customer.name) || 'Walk-in Customer'} | Date: ${new Date(sale.orderDate || sale.createdAt || Date.now()).toLocaleDateString()} | Source: ${sourceLabel}
        </div>
        <table class="returns-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Refund Qty</th>
            </tr>
          </thead>
          <tbody>
            ${(sale.items || []).map((i, idx) => `
              <tr>
                <td>${i.productName || i.name}</td>
                <td>${i.quantity}</td>
                <td>$${Number(i.unitPrice).toFixed(2)}</td>
                <td><input type="number" class="return-qty-inp" data-idx="${idx}" value="0" min="0" max="${i.quantity}" style="width:50px;" /></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <button class="btn-add-custom" id="btn-submit-refund" style="margin-top:14px;background-color:#ef4444;">Process Refund</button>
      </div>
    `;

  document.getElementById('btn-submit-refund').addEventListener('click', async () => {
    const qInps = document.querySelectorAll('.return-qty-inp');
    const refundItems = [];
    qInps.forEach(inp => {
      const qty = parseInt(inp.value) || 0;
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

    const payload = {
      saleId: sale.id || sale._id,
      items: refundItems
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
        payments: [{ paymentMethod: 'Cash Refund', amount: refundTotal }],
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
          <td style="font-weight:700;color:#ef4444;">-$${total.toFixed(2)}</td>
        </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    `;
    wrap.innerHTML = html;
  } catch (err) {
    wrap.innerHTML = `<div style="color:#ef4444;">Failed to load returns history: ${err.message || err}</div>`;
  }
}

document.getElementById('btn-scan-return').addEventListener('click', () => {
  if (typeof window.openCodeScanner === 'function') {
    window.openCodeScanner({
      title: 'Scan Receipt Barcode',
      onScan: (code) => {
        document.getElementById('return-search-invoice').value = code;
        document.getElementById('btn-search-return').click();
      },
    });
  } else {
    showToast('Scanner not available', 'error');
  }
});

// USB Scanner support - simple and reliable for returns
const returnSearchInp = document.getElementById('return-search-invoice');
if (returnSearchInp) {
  returnSearchInp.addEventListener('keydown', (e) => {
    console.log('[Returns Input] Keydown event:', e.key, 'value:', e.target.value);
    
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = returnSearchInp.value.trim();
      console.log('[Returns Input] Enter key pressed, code:', code);
      
      if (code.length > 0) {
        returnSearchInp.value = '';
        console.log('[Returns Input] Triggering search with code:', code);
        document.getElementById('btn-search-return').click();
      }
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
      console.log('[Returns Tab] Focused search input');
    }
  }, 100);
});

document.getElementById('btn-search-return').addEventListener('click', async () => {
  const inv = document.getElementById('return-search-invoice').value.trim();
  if (!inv) return;

  // Quick return logic layout
  const wrap = document.getElementById('returns-list-wrap');
  wrap.innerHTML = '<div style="color:var(--muted)">Searching transaction...</div>';
  const norm = (v) => String(v || '').trim().toLowerCase();

  // OFFLINE-FIRST: search the local sales cache before hitting the API, so
  // receipt-number lookup works even without internet.
  try {
    const local = await api.pos.listLocalSales();
    const localSales = local?.data?.sales || [];
    const localHit = localSales.find((s) =>
      norm(s.invoiceNumber) === norm(inv) ||
      norm(s.orderNumber) === norm(inv) ||
      norm(s.id) === norm(inv)
    );
    if (localHit) {
      renderReturnForm(localHit, 'local');
      return;
    }
  } catch { /* local read failed — fall through to API */ }

  // Not found locally (or local cache unavailable) — try the cloud.
  const res = await api.sales.getOrders({ search: inv, limit: 1 });
  if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
    renderReturnForm(res.data[0], 'cloud');
  } else {
    wrap.innerHTML = '<div style="color:#ef4444;">Transaction not found!</div>';
  }
});

// ─── T3: REPORTS TAB ──────────────────────────────────────────────────────────
async function loadShiftReports() {
  const wrap = document.getElementById('reports-cards-grid');
  wrap.innerHTML = '<div>Loading reports...</div>';

  const res = await api.pos.getShiftReport(activeShift.id);
  if (res?.success && res.data) {
    const report = res.data;
    wrap.innerHTML = `
      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Shift Cash Summary</h4>
        <div class="totals-row"><span>Opening Cash</span><b>$${Number(report.openingCash || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Cash Sales</span><b>$${Number(report.cashSales || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Cash Inflow</span><b>$${Number(report.cashIn || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Cash Outflow</span><b>-$${Number(report.cashOut || 0).toFixed(2)}</b></div>
        <div class="totals-row" style="border-top:1px solid var(--line);padding-top:6px;margin-top:6px;">
          <span>Expected Cash</span><b>$${Number(report.expectedCash || 0).toFixed(2)}</b>
        </div>
      </div>
      
      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Sales Summary</h4>
        <div class="totals-row"><span>Total Sales</span><b>$${Number(report.totalSales || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>GST Tax</span><b>$${Number(report.taxTotal || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Discounts</span><b>-$${Number(report.discountTotal || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Net Sales</span><b>$${Number(report.netSales || 0).toFixed(2)}</b></div>
        <div class="totals-row"><span>Receipts Issued</span><b>${report.salesCount || 0}</b></div>
      </div>

      <div class="report-card">
        <h4 style="margin:0 0 12px 0;">Payment Methods</h4>
        ${Object.entries(report.paymentsBreakdown || {}).map(([method, amount]) => `
          <div class="totals-row"><span>${method}</span><b>$${Number(amount).toFixed(2)}</b></div>
        `).join('')}
      </div>
    `;
  } else {
    wrap.innerHTML = '<div>Could not load current shift reports</div>';
  }
}

function saleMoney(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function saleFmt(n) {
  return `$${saleMoney(n).toFixed(2)}`;
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
      <td style="text-align:right">${i.quantity || 1} x ${saleFmt(i.unitPrice)}</td>
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
      <td>$${Number(p.sellingPrice || 0).toFixed(2)}</td>
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
  setPf('taxType', 'Exclusive');
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
  showProdTab('basic');
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
    taxRate: pfNum('taxRate'),
    taxType: pfVal('taxType') || 'Exclusive',
    taxTypeName: pfVal('taxType') || 'Exclusive',
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
    if (typeof window.openCodeScanner === 'function') {
      window.openCodeScanner({
        title: 'Scan barcode',
        onScan: (code) => setPf('barcode', code),
      });
      return;
    }
    const code = prompt('Scan or enter barcode:');
    if (code) setPf('barcode', code);
  });
  document.getElementById('pf-barcode-auto')?.addEventListener('click', () => {
    setPf('barcode', ensurePfSku());
  });
  document.getElementById('pf-qr-scan')?.addEventListener('click', () => {
    if (typeof window.openCodeScanner === 'function') {
      window.openCodeScanner({
        title: 'Scan QR / barcode',
        onScan: (code) => setPf('qrCode', code),
      });
      return;
    }
    // QR code input via prompt not supported in Electron
    showToast('Use barcode scanner or enter QR code manually in the field', 'info');
  });
  document.getElementById('pf-qr-from-sku')?.addEventListener('click', () => {
    setPf('qrCode', ensurePfSku());
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

document.getElementById('btn-admin')?.addEventListener('click', () => api?.pos?.enterManagement());
document.getElementById('logout')?.addEventListener('click', () => api?.auth?.logout());
if (api?.auth?.onExpired) api.auth.onExpired(() => api.auth.logout());
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
  searchInp.addEventListener('input', () => {
    renderStockProductList(searchInp.value);
  });

  // 2. Select product from list
  productSelect.addEventListener('change', () => {
    const val = productSelect.value;
    const prod = localProducts.find(p => p.id === val);
    stockSelectedProduct = prod || null;
    onStockProductSelected(prod);
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
        stockSelectedProduct = matched;
        productSelect.value = matched.id;
        onStockProductSelected(matched);
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

function onStockProductSelected(prod) {
  if (!prod) return;

  // Show unit label
  const unitLabel = document.getElementById('stock-unit-label');
  const unit = prod.stockUnitName || prod.stockUnit || 'Pcs';
  if (unitLabel) {
    unitLabel.textContent = unit;
    unitLabel.style.display = 'inline-block';
  }

  // Pre-fill cost price
  const costInp = document.getElementById('stock-cost-input');
  if (costInp && prod.costPrice != null) {
    costInp.value = prod.costPrice;
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
    totalValDisp.textContent = `Rs. ${Number(total).toFixed(2)}`;
  }
}

function renderStockProductList(query = '') {
  const select = document.getElementById('stock-product-select');
  if (!select) return;

  const q = String(query).toLowerCase().trim();
  const filtered = localProducts.filter(p =>
    !q || `${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    select.innerHTML = `<option value="">No matching products</option>`;
    return;
  }

  select.innerHTML = filtered.map(p => {
    const unit = p.stockUnitName || p.stockUnit || 'Pcs';
    const stockStr = p.currentStock != null ? `${p.currentStock} ${unit}` : '0 Pcs';
    return `<option value="${p.id}">${p.name} (SKU: ${p.sku || 'N/A'}, Stock: ${stockStr})</option>`;
  }).join('');
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
    // 1. Load latest products & suppliers if not loaded
    if (!localProducts || !localProducts.length) {
      if (typeof loadLocalProducts === 'function') {
        await loadLocalProducts();
      }
    }

    // Fill product list select box
    renderStockProductList(document.getElementById('stock-product-search')?.value || '');

    // Fill suppliers dropdown
    const supSelect = document.getElementById('stock-supplier-select');
    if (supSelect) {
      supSelect.innerHTML = `<option value="">Select supplier...</option>` + localSuppliers.map(s =>
        `<option value="${s.id || s._id}">${s.name}</option>`
      ).join('');
    }

    // 2. Fetch stock movements from SQLite
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
    const costStr = m.unitCost ? `Rs. ${Number(m.unitCost).toFixed(2)}` : 'Rs. 0.00';
    const totalStr = m.totalCost ? `Rs. ${Number(m.totalCost).toFixed(2)}` : 'Rs. 0.00';
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


