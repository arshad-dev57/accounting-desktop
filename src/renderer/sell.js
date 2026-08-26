
'use strict';

window.addEventListener('error', (event) => {
  console.error('[POS JS Error]', event.message, event.filename, event.lineno);
});

const api = window.bisonDesktop;

function isAdminRole(role) {
  const r = String(role || '').toLowerCase().trim();
  return r === 'admin' || r === 'owner' || r === 'superadmin' || r === 'company_admin';
}

// State management
let activeShift = null;
let currentCashier = null;
let currentTerminal = null;
let selectedLocation = null;
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
let discountMode = 'pct'; // 'pct' or 'amount'

// Checkout state
let payments = [];
let focusedPaymentIndex = 0;
let submittingSale = false;
let lastSale = null;

// Settings state
let posSettings = {
  enableBarcodeScanner: true,
  enablePaymentTerminal: false,
  autoPrintOnSale: false,
  loyaltyEnabled: true,
};

// DOM Refs
const liveClockEl = document.getElementById('live-clock');
const cashierMetaEl = document.getElementById('cashier-meta');
const terminalBadgeEl = document.getElementById('terminal-badge');
const offlineBadgeEl = document.getElementById('offline-badge');

// Tab Navigation
const tabButtons = document.querySelectorAll('.tab-btn');
const viewPanels = document.querySelectorAll('.view-panel');

// Sell Panel DOM Refs
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

// Modal Overlays
const modalCloseShift = document.getElementById('modal-close-shift');
const modalCashFlow = document.getElementById('modal-cash-flow');
const checkoutModalOverlay = document.getElementById('checkout-modal-overlay');
const modalAddCustomer = document.getElementById('modal-add-customer');
const modalReceipt = document.getElementById('modal-receipt');
const modalManagerPin = document.getElementById('modal-manager-pin');

// Autocomplete customer search helper
let customerSearchTimeout = null;

// Initialize Settings
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
  loadLocalSettings();
  
  // 1. Get shift
  const res = await api.pos.getCurrentShift();
  if (!res?.success || !res?.data || res.data.status !== 'Open') {
    // If no active shift, redirect to shift gate
    window.location.href = './shift.html';
    return;
  }
  
  activeShift = res.data;
  currentCashier = activeShift.cashier || {};
  currentTerminal = activeShift.terminal || {};
  selectedLocation = currentTerminal.location || {};
  
  // Get Company profile info
  const profRes = await api.pos.getProfile();
  if (profRes?.success) {
    companyProfile = profRes.data;
  }
  
  // Get Tax context
  const taxRes = await api.tax.getContext();
  if (taxRes?.success) {
    taxContext = taxRes.data;
  }

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
      
      if (targetTab === 'held') loadHeldSales();
      if (targetTab === 'shifts') loadShiftHistory();
      if (targetTab === 'reports') loadShiftReports();
      if (targetTab === 'sales') loadSalesRegister();
      if (targetTab === 'categories') loadLocalCatalog();
      if (targetTab === 'products') loadLocalProducts();
      if (targetTab === 'settings') loadMachineInfo();
    });
  });
}

// Offline sync helper — reads pending queue counts from main process
async function updateOfflineCount() {
  try {
    const res = await api.pos.getSyncStatus();
    const count = res?.data?.totalPending ?? 0;
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
    if (msg) msg.textContent = 'Pulling latest categories, products and customers from the cloud.';
    try {
      const catalog = await api.pos.syncMasterData({ refresh: true });
      if (msg) msg.textContent = 'Updating the local catalog…';
      try { await api.pos.syncOfflineSales(); } catch (_) { /* offline queue optional */ }
      if (catalog?.success) {
        const n = catalog.counts?.products || 0;
        const c = catalog.counts?.categories || 0;
        const u = catalog.counts?.customers || 0;
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


// Helper methods for category structure matching Next.js SellScreen
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
  let res = await api.pos.getCategories('tree=true');
  let tree = unwrapCategoryTree(res);
  if (!tree.length && api?.pos?.syncMasterData) {
    try {
      await api.pos.syncMasterData({ refresh: true });
      res = await api.pos.getCategories('tree=true');
      tree = unwrapCategoryTree(res);
    } catch (err) {
      console.warn('[POS] catalog refresh failed', err);
    }
  }
  categories = tree;
  renderCategoryLayout();
}

function renderCategoryLayout() {
  if (!categoriesTabsBar || !mainCategoriesGrid || !productsGrid) return;
  categoriesTabsBar.innerHTML = '';
  
  if (activeParent) {
    // Crumb Nav Header
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
  const locationId = selectedLocation?.id || '';
  const payload = {
    categoryId: categoryId,
    locationId: locationId
  };
  
  productsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--muted); padding: 48px;"><span class="spinner-sm" style="border-top-color: var(--brand); width: 24px; height: 24px;"></span> Loading products...</div>';

  const res = await api.pos.searchProducts(payload);
  if (res?.success && Array.isArray(res.data)) {
    products = res.data;
    renderProducts();
  } else {
    productsGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #ef4444; padding: 24px;">${res?.message || 'Error loading products'}</div>`;
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
    const locationId = selectedLocation?.id || '';
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

// Barcode Scan box
barcodeScanInp?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const code = barcodeScanInp.value.trim();
    barcodeScanInp.value = '';
    if (!code) return;
    
    const locationId = selectedLocation?.id || '';
    const res = await api.pos.byBarcode(code, locationId);
    if (res?.success && res.data) {
      addProductToCart(res.data);
      // Play brief success audio beep if configured
    } else {
      alert(`Product with barcode ${code} not found!`);
    }
  }
});

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
  const existing = cart.find(item => item.productId === p.id);
  if (existing) {
    if (existing.quantity >= (p.availableStock ?? p.currentStock ?? 9999)) {
      alert(`Cannot add more. Stock limit reached!`);
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
      currentStock: p.currentStock || 0,
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
  
  // Get credit limit
  const res = await api.pos.getCustomerCreditInfo(c.id);
  if (res?.success && res.data) {
    const cr = res.data;
    document.getElementById('cc-limit').textContent = `$${Number(cr.creditLimit || 0).toFixed(2)}`;
    document.getElementById('cc-owed').textContent = `$${Number(cr.outstandingBalance || 0).toFixed(2)}`;
    document.getElementById('cc-avail').textContent = `$${Number(cr.availableCredit || 0).toFixed(2)}`;
    document.getElementById('cc-points').textContent = cr.loyaltyPoints || 0;
    customerCreditInfo = cr;
    custCreditInfoCard.style.display = 'block';
  } else {
    customerCreditInfo = null;
    custCreditInfoCard.style.display = 'none';
  }
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
    locationId: selectedLocation?.id || undefined,
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
    lastSale = {
      ...res.data.sale,
      items: res.data.sale?.items || cart,
      payments: res.data.sale?.payments || payload.payments,
      paidAmount: paidTotal,
      changeAmount: paidTotal - totals.grandTotal,
      cashierName: cashierMetaEl.textContent.replace('Cashier: ', ''),
      terminalName: terminalBadgeEl.textContent
    };
    
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
  
  const company = companyProfile || { name: 'Bisonstechs POS', email: '', phone: '', address: {} };
  const addr = company.address || {};
  const dateStr = new Date(lastSale.createdAt || lastSale.orderDate || Date.now()).toLocaleString();
  
  let itemsHtml = '';
  lastSale.items.forEach(i => {
    const lineTotal = i.lineTotal || (i.unitPrice * i.quantity);
    itemsHtml += `
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span>${i.productName || i.name} x ${i.quantity}</span>
        <span>$${Number(lineTotal).toFixed(2)}</span>
      </div>
    `;
  });

  let paymentsHtml = '';
  lastSale.payments.forEach(p => {
    paymentsHtml += `
      <div style="display:flex;justify-content:space-between;font-size:11px;">
        <span>Payment (${p.paymentMethod})</span>
        <span>$${Number(p.amount || 0).toFixed(2)}</span>
      </div>
    `;
  });

  const finalTax = Number(lastSale.taxTotal || 0);
  const grandTotal = Number(lastSale.totalAmount || lastSale.grandTotal || 0);
  const change = Number(lastSale.changeAmount || 0);

  box.innerHTML = `
    <div style="text-align:center;border-bottom:1px dashed #ccc;padding-bottom:12px;margin-bottom:12px;">
      <h3 style="margin:0;font-size:16px;">${company.name || 'Bisonstechs POS'}</h3>
      <div style="font-size:11px;color:#555;margin-top:4px;">
        ${addr.street || ''} ${addr.city || ''} ${addr.state || ''}<br/>
        Phone: ${company.phone || 'N/A'} | Email: ${company.email || 'N/A'}
      </div>
    </div>
    
    <div style="font-size:11px;border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">
      <b>Invoice:</b> ${lastSale.invoiceNumber || lastSale.orderNumber || 'Draft'}<br/>
      <b>Date:</b> ${dateStr}<br/>
      <b>Cashier:</b> ${lastSale.cashierName || 'Staff'}<br/>
      <b>Customer:</b> ${lastSale.customerName || 'Walk-in Customer'}
    </div>
    
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">
      ${itemsHtml}
    </div>
    
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;font-size:11px;">
      <div style="display:flex;justify-content:space-between;">
        <span>Subtotal</span>
        <span>$${Number(lastSale.subtotal || grandTotal).toFixed(2)}</span>
      </div>
      ${lastSale.discountTotal > 0 ? `
      <div style="display:flex;justify-content:space-between;color:#d97706;">
        <span>Discount</span>
        <span>-$${Number(lastSale.discountTotal).toFixed(2)}</span>
      </div>` : ''}
      ${finalTax > 0 ? `
      <div style="display:flex;justify-content:space-between;">
        <span>GST</span>
        <span>$${finalTax.toFixed(2)}</span>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:bold;margin-top:4px;">
        <span>Total</span>
        <span>$${grandTotal.toFixed(2)}</span>
      </div>
    </div>
    
    <div style="border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:8px;">
      ${paymentsHtml}
      <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;margin-top:2px;">
        <span>Change Return</span>
        <span>$${change.toFixed(2)}</span>
      </div>
    </div>
    
    <div style="text-align:center;font-size:10px;color:#777;margin-top:8px;">
      Thank you for shopping with us!<br/>
      Power by Bisonstechs POS Desktop
    </div>
  `;
}

document.getElementById('btn-receipt-close').addEventListener('click', () => modalReceipt.style.display = 'none');
document.getElementById('btn-receipt-new-sale').addEventListener('click', () => modalReceipt.style.display = 'none');
document.getElementById('btn-receipt-print').addEventListener('click', () => {
  window.print();
});

document.getElementById('btn-receipt-email').addEventListener('click', () => {
  const email = prompt('Enter customer email to send receipt:', lastSale?.customerEmail || '');
  if (email && email.includes('@')) {
    alert(`Receipt queued to send to ${email}`);
  }
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
btnKickDrawer.addEventListener('click', () => {
  alert('Cash drawer kick command sent!');
});

// ─── T2: RETURNS TAB ──────────────────────────────────────────────────────────
document.getElementById('btn-search-return').addEventListener('click', async () => {
  const inv = document.getElementById('return-search-invoice').value.trim();
  if (!inv) return;
  
  // Quick return logic layout
  const wrap = document.getElementById('returns-list-wrap');
  wrap.innerHTML = '<div style="color:var(--muted)">Loading transaction...</div>';
  
  // We can query sales using orders endpoints or lookup
  const res = await api.sales.getOrders({ search: inv, limit: 1 });
  if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
    const sale = res.data[0];
    wrap.innerHTML = `
      <div style="background:#fff;padding:16px;border-radius:12px;border:1px solid var(--line);margin-top:10px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <b>Invoice: ${sale.orderNumber || sale.invoiceNumber}</b>
          <span style="font-weight:700;color:var(--brand);">$${Number(sale.totalAmount || sale.grandTotal || 0).toFixed(2)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
          Customer: ${sale.customerName || 'Walk-in Customer'} | Date: ${new Date(sale.orderDate || sale.createdAt).toLocaleDateString()}
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
        alert('Refund transaction complete!');
        wrap.innerHTML = '<div style="color:#10b981;font-weight:bold;">Refund successful</div>';
      } else {
        alert(retRes?.message || 'Refund failed');
      }
    });
  } else {
    wrap.innerHTML = '<div style="color:#ef4444;">Transaction not found!</div>';
  }
});

// ─── T3: HELD SALES TAB ───────────────────────────────────────────────────────
async function loadHeldSales() {
  const wrap = document.getElementById('held-sales-list-wrap');
  wrap.innerHTML = '<div>Loading held sales...</div>';
  
  const res = await api.pos.getHeldSales();
  if (res?.success && Array.isArray(res.data)) {
    if (res.data.length === 0) {
      wrap.innerHTML = '<div style="color:var(--muted)">No held sales parked</div>';
      return;
    }
    
    let html = `
      <table class="returns-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Date</th>
            <th>Items</th>
            <th>Amount</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    res.data.forEach(s => {
      const dateStr = new Date(s.createdAt).toLocaleString();
      const itemsStr = (s.items || []).map(i => i.productName).join(', ');
      html += `
        <tr>
          <td><b>${s.customerName || 'Walk-in Customer'}</b></td>
          <td>${dateStr}</td>
          <td><span style="font-size:12px;color:var(--muted);" title="${itemsStr}">${s.items?.length || 0} items</span></td>
          <td style="font-weight:700;color:var(--brand);">$${Number(s.totalAmount || s.grandTotal || 0).toFixed(2)}</td>
          <td>
            <button class="btn-qty btn-recall" data-id="${s.id}" style="width:70px;background-color:var(--brand);color:#fff;border:none;height:28px;">Recall</button>
            <button class="btn-qty btn-del-held" data-id="${s.id}" style="width:70px;background-color:#ef4444;color:#fff;border:none;height:28px;margin-left:4px;">Delete</button>
          </td>
        </tr>
      `;
    });
    
    html += '</tbody></table>';
    wrap.innerHTML = html;
    
    // Wire Recall / Delete
    wrap.querySelectorAll('.btn-recall').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const sale = res.data.find(s => s.id === id);
        if (!sale) return;
        
        // Recall into cart
        cart = sale.items.map(i => ({
          productId: i.productId || `custom-${Date.now()}-${i.productName}`,
          productName: i.productName,
          sku: i.sku || 'CUSTOM',
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discount: i.discount || 0,
          taxRate: i.taxRate || 0,
          taxAmount: 0,
          lineTotal: i.unitPrice * i.quantity,
          currentStock: 9999,
          isCustom: !i.productId || i.sku === 'CUSTOM'
        }));
        
        selectedCustomer = sale.customerId ? { id: sale.customerId, name: sale.customerName } : null;
        customerSearchInp.value = sale.customerName || '';
        
        // Go to Sell tab
        document.querySelector('.tab-btn[data-tab="sell"]').click();
        renderCartList();
      });
    });
    
    wrap.querySelectorAll('.btn-del-held').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Are you sure you want to delete this held sale?')) return;
        const delRes = await api.pos.deleteHeldSale(id);
        if (delRes?.success) {
          loadHeldSales();
        } else {
          alert(delRes?.message || 'Delete failed');
        }
      });
    });
    
  } else {
    wrap.innerHTML = '<div>Could not load held sales</div>';
  }
}

// ─── T4: SHIFTS HISTORY TAB ──────────────────────────────────────────────────
async function loadShiftHistory() {
  const wrap = document.getElementById('shifts-list-wrap');
  wrap.innerHTML = '<div>Loading shifts history...</div>';
  
  const res = await api.pos.getShiftHistory('limit=30');
  if (res?.success && Array.isArray(res.data)) {
    if (res.data.length === 0) {
      wrap.innerHTML = '<div style="color:var(--muted)">No shifts found</div>';
      return;
    }
    
    let html = `
      <table class="shifts-table">
        <thead>
          <tr>
            <th>Cashier</th>
            <th>Terminal</th>
            <th>Opened</th>
            <th>Closed</th>
            <th>Opening Cash</th>
            <th>Actual Cash</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    res.data.forEach(s => {
      const opened = new Date(s.openedAt).toLocaleString();
      const closed = s.closedAt ? new Date(s.closedAt).toLocaleString() : '—';
      const cashierName = s.cashier ? `${s.cashier.firstName} ${s.cashier.lastName}` : 'N/A';
      
      html += `
        <tr>
          <td>${cashierName}</td>
          <td>${s.terminal?.name || 'N/A'}</td>
          <td>${opened}</td>
          <td>${closed}</td>
          <td>$${Number(s.openingCash || 0).toFixed(2)}</td>
          <td>$${s.actualCash ? Number(s.actualCash).toFixed(2) : '—'}</td>
          <td>
            <span style="background-color: ${s.status === 'Open' ? '#10b981' : '#64748b'};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">
              ${s.status}
            </span>
          </td>
        </tr>
      `;
    });
    
    html += '</tbody></table>';
    wrap.innerHTML = html;
  } else {
    wrap.innerHTML = '<div>Could not load shifts history</div>';
  }
}

// ─── T5: REPORTS TAB ──────────────────────────────────────────────────────────
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
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || sale.cashierName || 'Unknown';
}

function saleTotalOf(sale) {
  return saleMoney(sale.grandTotal ?? sale.total ?? sale.totalAmount);
}

function saleIsCredit(sale) {
  return (sale.payments || []).some((p) => String(p.paymentMethod || '').toLowerCase().includes('credit'))
    || String(sale.notes || '').toLowerCase().includes('credit sale');
}

async function loadSalesRegister() {
  const userWrap = document.getElementById('sales-user-table');
  const listWrap = document.getElementById('sales-list-table');
  if (!listWrap) return;
  try {
    const res = await api.pos.listSales('page=1&limit=200');
    const sales = Array.isArray(res?.data) ? res.data : (res?.data?.sales || []);
    const total = sales.reduce((sum, s) => sum + saleTotalOf(s), 0);
    const credit = sales.filter(saleIsCredit).reduce((sum, s) => sum + saleTotalOf(s), 0);
    document.getElementById('sales-kpi-count').textContent = String(sales.length);
    document.getElementById('sales-kpi-total').textContent = saleFmt(total);
    document.getElementById('sales-kpi-credit').textContent = saleFmt(credit);

    const byUser = new Map();
    sales.forEach((s) => {
      const name = saleCashier(s);
      const cur = byUser.get(name) || { name, count: 0, total: 0, credit: 0 };
      cur.count += 1;
      cur.total += saleTotalOf(s);
      if (saleIsCredit(s)) cur.credit += saleTotalOf(s);
      byUser.set(name, cur);
    });
    const users = [...byUser.values()].sort((a, b) => b.total - a.total);
    document.getElementById('sales-kpi-users').textContent = String(users.length);
    userWrap.innerHTML = users.length ? `<table><thead><tr><th>Cashier</th><th>Sales</th><th>Total</th><th>Credit</th></tr></thead><tbody>${
      users.map((u) => `<tr><td>${u.name}</td><td>${u.count}</td><td>${saleFmt(u.total)}</td><td>${saleFmt(u.credit)}</td></tr>`).join('')
    }</tbody></table>` : '<div style="padding:20px;color:var(--muted);text-align:center;">No cashier sales yet.</div>';

    listWrap.innerHTML = sales.length ? `<table><thead><tr><th>Invoice</th><th>Date</th><th>Cashier</th><th>Customer</th><th>Pay</th><th>Total</th></tr></thead><tbody>${
      sales.map((s) => `<tr>
        <td>${s.invoiceNumber || s.id || '—'}</td>
        <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
        <td>${saleCashier(s)}</td>
        <td>${s.customerName || s.customer?.name || 'Walk-in'}</td>
        <td>${saleIsCredit(s) ? 'Credit' : ((s.payments || []).map((p) => p.paymentMethod).filter(Boolean).join(', ') || '—')}</td>
        <td>${saleFmt(saleTotalOf(s))}</td>
      </tr>`).join('')
    }</tbody></table>` : '<div style="padding:20px;color:var(--muted);text-align:center;">No POS sales found.</div>';
  } catch (err) {
    listWrap.innerHTML = `<div style="padding:20px;color:#b91c1c;text-align:center;">${err.message}</div>`;
  }
}

let localCatalog = [];
let catTab = 'cats';
let catEditing = null;

function renderLocalCatalog() {
  const wrap = document.getElementById('cat-table');
  if (!wrap) return;
  const q = String(document.getElementById('cat-search')?.value || '').toLowerCase();
  if (catTab === 'cats') {
    const rows = localCatalog.filter((c) => `${c.name} ${c.code} ${c.description}`.toLowerCase().includes(q));
    wrap.innerHTML = rows.length ? `<table><thead><tr><th>Name</th><th>Code</th><th>Description</th><th>Subs</th><th></th></tr></thead><tbody>${
      rows.map((c) => `<tr>
        <td><b>${c.name}</b></td><td>${c.code || '—'}</td><td>${c.description || '—'}</td>
        <td>${(c.subCategories || []).length}</td>
        <td><button type="button" data-edit-cat="${c.id}">Edit</button> <button type="button" data-del-cat="${c.id}">Delete</button></td>
      </tr>`).join('')
    }</tbody></table>` : '<div style="padding:24px;text-align:center;color:var(--muted);">No categories found</div>';
  } else {
    const rows = [];
    localCatalog.forEach((c) => (c.subCategories || []).forEach((s) => rows.push({ ...s, parentName: c.name, parentId: c.id })));
    const filtered = rows.filter((r) => `${r.name} ${r.code} ${r.parentName}`.toLowerCase().includes(q));
    wrap.innerHTML = filtered.length ? `<table><thead><tr><th>Name</th><th>Code</th><th>Parent</th><th>Description</th><th></th></tr></thead><tbody>${
      filtered.map((s) => `<tr>
        <td><b>${s.name}</b></td><td>${s.code || '—'}</td><td>${s.parentName}</td><td>${s.description || '—'}</td>
        <td><button type="button" data-edit-sub="${s.id}" data-parent="${s.parentId}">Edit</button> <button type="button" data-del-sub="${s.id}">Delete</button></td>
      </tr>`).join('')
    }</tbody></table>` : '<div style="padding:24px;text-align:center;color:var(--muted);">No subcategories found</div>';
  }
}

async function loadLocalCatalog() {
  const res = await api.catalog.list();
  localCatalog = Array.isArray(res?.data) ? res.data : [];
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
    if (editCat) openCatForm('cats', localCatalog.find((c) => c.id === editCat.getAttribute('data-edit-cat')));
    if (delCat && confirm('Delete this category and its subcategories?')) {
      await api.catalog.deleteCategory(delCat.getAttribute('data-del-cat'));
      await loadLocalCatalog();
      loadCategories();
    }
    if (editSub) {
      const parent = localCatalog.find((c) => c.id === editSub.getAttribute('data-parent'));
      const row = (parent?.subCategories || []).find((s) => s.id === editSub.getAttribute('data-edit-sub'));
      openCatForm('subs', row);
    }
    if (delSub && confirm('Delete this subcategory?')) {
      await api.catalog.deleteSubcategory(delSub.getAttribute('data-del-sub'));
      await loadLocalCatalog();
      loadCategories();
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
  subSel.innerHTML = `<option value="">Select subcategory</option>` + subs.map((s) =>
    `<option value="${s.id}" ${s.id === selectedSub ? 'selected' : ''}>${s.name}</option>`
  ).join('');
}

function renderLocalProducts() {
  const wrap = document.getElementById('prod-table');
  if (!wrap) return;
  const q = String(document.getElementById('prod-search')?.value || '').toLowerCase();
  const rows = localProducts.filter((p) =>
    `${p.name} ${p.sku} ${p.barcode} ${p.categoryName}`.toLowerCase().includes(q)
  );
  wrap.innerHTML = rows.length ? `<table><thead><tr><th>Name</th><th>SKU</th><th>Barcode</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr></thead><tbody>${
    rows.map((p) => `<tr>
      <td><b>${p.name}</b></td>
      <td>${p.sku || '—'}</td>
      <td>${p.barcode || '—'}</td>
      <td>${p.subcategoryName || p.categoryName || '—'}</td>
      <td>$${Number(p.sellingPrice || 0).toFixed(2)}</td>
      <td>${Number(p.currentStock || 0)}</td>
      <td><button type="button" data-edit-prod="${p.id}">Edit</button> <button type="button" data-del-prod="${p.id}">Delete</button></td>
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
  setPf('supplier', firstVal(row, ['supplier', 'supplierName']));
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
    supplier: pfVal('supplier'),
    supplierName: pfVal('supplier'),
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
  document.getElementById('pf-qr-from-sku')?.addEventListener('click', () => {
    const sku = pfVal('sku');
    if (sku) setPf('qrCode', sku);
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
    }
    if (delBtn && confirm('Delete this product?')) {
      await api.catalog.deleteProduct(delBtn.getAttribute('data-del-prod'));
      await loadLocalProducts();
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
    await loadLocalProducts();
  });
}

initProductPanel();

document.getElementById('btn-sales-orders')?.addEventListener('click', () => {
  window.location.href = './sales.html';
});
document.getElementById('btn-admin')?.addEventListener('click', () => api?.pos?.enterManagement());
document.getElementById('logout')?.addEventListener('click', () => api?.auth?.logout());
if (api?.auth?.onExpired) api.auth.onExpired(() => api.auth.logout());
window.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('[POS Boot Error]', err);
    alert('Could not initialize POS system: ' + err.message);
  });
});
