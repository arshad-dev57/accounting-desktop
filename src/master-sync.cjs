
const masterSqlite = require('./master-sqlite.cjs');
const posApi = require('./pos-api.cjs');
const localDb = require('./local-db.cjs');
const config = require('./config.cjs');

async function checkOnline(accessToken) {
  const res = await posApi.checkConnectivity(accessToken);
  return { online: res.online === true, ...res };
}

function offlineResult(conn = {}) {
  const apiUrl = conn.apiUrl || config.resolveApiUrl();
  return {
    success: false,
    online: false,
    retryable: true,
    code: 'OFFLINE',
    apiUrl,
    message:
      conn.message ||
      `Cannot reach API at ${apiUrl}. Sync skipped.`,
  };
}

async function pushPendingCatalog(accessToken) {
  const pending = masterSqlite.listPendingSync();
  const total =
    pending.categories.length + pending.subcategories.length + pending.products.length;
  if (!total) {
    return {
      success: true,
      pushed: false,
      summary: { categories: 0, subcategories: 0, products: 0, failed: 0 },
    };
  }

  const res = await posApi.pushMasterData(accessToken, pending);
  if (!res.success) {
    return {
      success: false,
      retryable: res.retryable !== false && res.status !== 401,
      status: res.status,
      code: res.code || 'PUSH_FAILED',
      message: res.message || 'Failed to upload local changes to the cloud',
    };
  }

  const data = res.data || { pushed: [], mapping: {} };
  masterSqlite.markSynced(data);
  if (Array.isArray(data?.pushed?.failed)) masterSqlite.markFailed(data.pushed.failed);
  masterSqlite.reloadFromDisk();
  return {
    success: true,
    pushed: true,
    mapping: data.mapping || {},
    summary: data.summary || data.pushed || {},
  };
}

function flattenCategories(nodes, inheritedParent = null, into = { categories: [], subcategories: [] }) {
  for (const node of nodes || []) {
    const id = node.id || node._id;
    if (!id) continue;
    const parentId = node.parentId || inheritedParent || null;
    // Do not seed category/subcategory images from cloud — they stay POS-local
    if (!parentId) {
      into.categories.push({
        id,
        name: node.name,
        code: node.code || '',
        description: node.description || '',
        isDeleted: node.isDeleted === true || node.isActive === false,
        isActive: node.isActive !== false,
        updatedAt: node.updatedAt,
      });
    } else {
      into.subcategories.push({
        id,
        categoryId: parentId,
        name: node.name,
        code: node.code || '',
        description: node.description || '',
        isDeleted: node.isDeleted === true || node.isActive === false,
        isActive: node.isActive !== false,
        updatedAt: node.updatedAt,
      });
    }
    const kids = node.children || node.subCategories || [];
    flattenCategories(kids, id, into);
  }
  return into;
}

function unwrapRows(res) {
  const raw = res?.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.products)) return raw.products;
  if (Array.isArray(raw?.categories)) return raw.categories;
  if (Array.isArray(raw?.customers)) return raw.customers;
  if (Array.isArray(raw?.suppliers)) return raw.suppliers;
  return [];
}

function mapLiveProduct(p) {
  const id = p.id || p._id;
  if (!id) return null;
  const categoryId = p.categoryId || p.category?.id || null;
  const parentId = p.category?.parentId || null;
  const image = p.mainImage || (Array.isArray(p.images) && p.images[0]) || '';
  const mapped = {
    id,
    categoryId: parentId || categoryId,
    subcategoryId: p.subcategoryId || p.subCategoryId || (parentId ? categoryId : null),
    name: p.name,
    sku: p.sku || '',
    barcode: p.barcodeNumber || p.barcode || '',
    price: Number(p.sellingPrice ?? p.price ?? 0),
    sellingPrice: Number(p.sellingPrice ?? p.price ?? 0),
    costPrice: Number(p.costPrice ?? p.cost_price ?? p.landingCost ?? 0),
    taxRate: Number(p.taxRate || 0),
    taxType: p.taxType || 'Exclusive',
    currentStock: Number(p.currentStock ?? p.availableStock ?? 0),
    stockUnitName: p.stockUnitName || p.stockUnit || 'Pcs',
    stockUnit: p.stockUnit || p.stockUnitName || 'Pcs',
    purchaseUnitName: p.purchaseUnitName || p.stockUnitName || p.stockUnit || 'Pcs',
    salesUnitName: p.salesUnitName || p.salesUnit || p.stockUnitName || p.stockUnit || 'Pcs',
    purchaseConversionFactor: Number(p.purchaseConversionFactor ?? 1) || 1,
    salesConversionFactor: Number(p.salesConversionFactor ?? 1) || 1,
    allowFractionalQty: Boolean(p.allowFractionalQty),
    hasExpiry: Boolean(p.hasExpiry),
    isBatchManaged: Boolean(p.isBatchManaged),
    isSerialManaged: Boolean(p.isSerialManaged),
    isExpiryManaged: Boolean(p.isExpiryManaged || p.hasExpiry),
    expiryDate: p.expiryDate || null,
    manufacturingDate: p.manufacturingDate || null,
    batchNumber: p.batchNumber || null,
    shelfLifeDays: Number(p.shelfLifeDays ?? p.shelfLife ?? 0) || 0,
    units: Array.isArray(p.units)
      ? p.units
      : Array.isArray(p.productUnits)
        ? p.productUnits
        : undefined,
    productUnits: Array.isArray(p.productUnits)
      ? p.productUnits
      : Array.isArray(p.units)
        ? p.units
        : undefined,
    isDeleted: p.isActive === false,
    isActive: p.isActive !== false,
    updatedAt: p.updatedAt,
  };
  // Only set when cloud actually has values — avoid default READY_ITEM wiping local MENU_ITEM
  if (p.itemType) mapped.itemType = String(p.itemType).toUpperCase();
  if (p.trackInventory !== undefined && p.trackInventory !== null) {
    mapped.trackInventory = p.trackInventory !== false;
  }
  if (p.showInPos !== undefined && p.showInPos !== null) {
    mapped.showInPos = p.showInPos !== false;
  }
  if (image) {
    mapped.mainImage = image;
    mapped.image = image;
  }
  return mapped;
}

async function seedFromLiveApis(accessToken, locationId) {
  const [catsRes, prodRes, custRes, suppRes] = await Promise.all([
    posApi.fetchAllCategories(accessToken),
    posApi.fetchAllProducts(accessToken, locationId),
    posApi.fetchAllCustomers(accessToken),
    posApi.fetchAllSuppliers(accessToken),
  ]);
  const catRows = unwrapRows(catsRes);
  const prodRows = unwrapRows(prodRes);
  const custRows = unwrapRows(custRes);
  const suppRows = unwrapRows(suppRes);
  console.log('[sync] live suppliers', suppRows.length, suppRes?.success, suppRes?.message || '');
  const flat = flattenCategories(catRows);
  const products = prodRows.map(mapLiveProduct).filter(Boolean);
  if (!flat.categories.length && !products.length && !custRows.length && !suppRows.length) {
    return { success: false, message: 'Live catalog APIs returned no catalog rows' };
  }
  masterSqlite.applyPage({
    categories: flat.categories,
    subcategories: flat.subcategories,
    products,
    customers: custRows,
    suppliers: suppRows,
    nextCursor: masterSqlite.getCursor() || '',
  });
  if (locationId) {
    masterSqlite.keepOnlyProductIds(products.map((p) => p.id));
  }
  if (custRows.length) localDb.saveCustomers(custRows);
  if (prodRows.length) {
    try { localDb.saveProducts(prodRows); } catch (_) { /* ignore */ }
  }
  return { success: true, recovered: true, pages: 1, counts: masterSqlite.counts() };
}

async function syncMasterData(accessToken, locationId, opts = {}) {
  if (opts.push !== false) {
    const conn = await checkOnline(accessToken);
    if (!conn.online) return offlineResult(conn);
    const pushed = await pushPendingCatalog(accessToken);
    if (!pushed.success) return pushed;
  }

  let cursor = masterSqlite.getCursor() || '';
  let pages = 0;
  let recovered = false;

  const pull = (next) => posApi.pullMasterData(accessToken, next, 200);

  let res = await pull(cursor);
  if (!res.success && res.code === 'CURSOR_INVALID') {
    masterSqlite.resetCursor();
    cursor = '';
    recovered = true;
    res = await pull('');
  }
  if (!res.success) {
    if (!masterSqlite.counts().products) {
      const fallback = await seedFromLiveApis(accessToken, locationId);
      if (fallback.success) return fallback;
    }
    return {
      success: false,
      retryable: res.retryable !== false && res.status !== 401,
      status: res.status,
      code: res.code,
      message: res.message || 'Master data sync failed',
    };
  }

  while (true) {
    const page = res.data || res;
    masterSqlite.applyPage({
      categories: page.categories || [],
      subcategories: page.subcategories || [],
      products: page.products || [],
      nextCursor: page.nextCursor,
    });
    pages += 1;
    if (!page.hasMore) {
      const counts = masterSqlite.counts();
      if (!counts.products) {
        const fallback = await seedFromLiveApis(accessToken, locationId);
        if (fallback.success) return { ...fallback, pages };
      }
      const live = await seedFromLiveApis(accessToken, locationId);
      return {
        success: true,
        recovered,
        pages,
        cursor: page.nextCursor,
        counts: live.success ? live.counts : masterSqlite.counts(),
        liveMerged: live.success,
      };
    }
    res = await pull(page.nextCursor);
    if (!res.success) {
      return {
        success: false,
        retryable: res.retryable !== false && res.status !== 401,
        status: res.status,
        code: res.code,
        message: res.message || 'Master data sync failed mid-page',
        pages,
      };
    }
  }
}

async function refreshCatalog(accessToken, locationId) {
  const conn = await checkOnline(accessToken);
  if (!conn.online) {
    return offlineResult(conn);
  }

  // Preserve POS-local images + restaurant item types across refresh
  let localOverlay = null;
  try {
    localOverlay = masterSqlite.snapshotLocalPosOverlays();
  } catch (err) {
    console.warn('[sync] overlay snapshot failed:', err.message);
  }

  let push = { success: true };
  try {
    push = await pushPendingCatalog(accessToken);
  } catch (err) {
    push = { success: false, retryable: true, code: 'PUSH_FAILED', message: err.message };
  }
  if (!push.success) {

    console.warn('[sync] refresh aborted — push failed, local unsynced data preserved:', push.message);
    return {
      success: false,
      retryable: push.retryable !== false && push.status !== 401,
      status: push.status,
      code: push.code || 'PUSH_FAILED',
      message: `Sync failed before refresh (${push.message || 'upload error'}). Local unsynced records are preserved and will retry on the next sync.`,
    };
  }

  // Do NOT clearCatalog() — that wiped category/product images and MENU_ITEM types.
  // Merge pull + live APIs, then restore any local-only overlays.
  const snapshot = await syncMasterData(accessToken, locationId, { push: false });
  const live = await seedFromLiveApis(accessToken, locationId);
  if (localOverlay) {
    try {
      masterSqlite.restoreLocalPosOverlays(localOverlay);
    } catch (err) {
      console.warn('[sync] overlay restore failed:', err.message);
    }
  }
  masterSqlite.reloadFromDisk();
  const counts = masterSqlite.counts();
  const tree = masterSqlite.getCategoryTree();
  if (live.success || snapshot.success) {
    return {
      success: true,
      refreshed: true,
      counts,
      data: tree,
      tree,
      snapshotSuccess: snapshot.success,
      liveSuccess: live.success,
      pages: snapshot.pages || live.pages || 0,
    };
  }
  return snapshot.success === false ? snapshot : live;
}

async function syncBidirectional(accessToken, opts = {}) {
  const conn = await checkOnline(accessToken);
  if (!conn.online) return offlineResult(conn);

  const pending = masterSqlite.listPendingSync();
  const total = pending.categories.length + pending.subcategories.length + pending.products.length;

  let pushSummary = { categories: 0, subcategories: 0, products: 0, failed: 0 };
  if (total) {
    const res = await posApi.publishMasterData(accessToken, pending);
    if (!res.success) {
      return {
        success: false,
        retryable: res.retryable !== false && res.status !== 401,
        status: res.status,
        code: res.code || 'SYNC_FAILED',
        message: res.message || 'Bidirectional sync failed',
      };
    }
    const data = res.data || {};
    masterSqlite.markSynced(data);
    if (Array.isArray(data?.pushed?.failed)) masterSqlite.markFailed(data.pushed.failed);
    pushSummary = data?.phase?.push || data?.summary || {};
  }
  masterSqlite.reloadFromDisk();
  const counts = masterSqlite.counts();
  return {
    success: true,
    online: true,
    pushed: total > 0,
    summary: pushSummary,
    pendingAfter: masterSqlite.pendingCounts(),
    counts,
  };
}

module.exports = { syncMasterData, refreshCatalog, syncBidirectional, checkOnline, pushPendingCatalog };
