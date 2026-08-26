/**
 * Pull POS master data pages and commit each page in SQLite.
 */
const masterSqlite = require('./master-sqlite.cjs');
const posApi = require('./pos-api.cjs');
const localDb = require('./local-db.cjs');

function flattenCategories(nodes, inheritedParent = null, into = { categories: [], subcategories: [] }) {
  for (const node of nodes || []) {
    const id = node.id || node._id;
    if (!id) continue;
    const parentId = node.parentId || inheritedParent || null;
    if (!parentId) {
      into.categories.push({
        id,
        name: node.name,
        isDeleted: node.isDeleted === true || node.isActive === false,
        isActive: node.isActive !== false,
        updatedAt: node.updatedAt,
      });
    } else {
      into.subcategories.push({
        id,
        categoryId: parentId,
        name: node.name,
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
  return [];
}

function mapLiveProduct(p) {
  const id = p.id || p._id;
  if (!id) return null;
  const categoryId = p.categoryId || p.category?.id || null;
  const parentId = p.category?.parentId || null;
  return {
    id,
    categoryId: parentId || categoryId,
    subcategoryId: p.subcategoryId || p.subCategoryId || (parentId ? categoryId : null),
    name: p.name,
    sku: p.sku || p.sku || '',
    barcode: p.barcodeNumber || p.barcodeNumber || p.barcode || '',
    price: Number(p.sellingPrice ?? p.sellingPrice ?? p.price ?? 0),
    taxRate: Number(p.taxRate || p.taxRate || 0),
    taxType: p.taxType || p.taxType || 'Exclusive',
    currentStock: Number(p.currentStock ?? p.availableStock ?? p.currentStock ?? 0),
    mainImage: p.mainImage || (Array.isArray(p.images) && p.images[0]) || '',
    isDeleted: p.isActive === false,
    isActive: p.isActive !== false,
    updatedAt: p.updatedAt,
  };
}

async function seedFromLiveApis(accessToken) {
  const [catsRes, prodRes, custRes] = await Promise.all([
    posApi.fetchAllCategories(accessToken),
    posApi.fetchAllProducts(accessToken),
    posApi.fetchAllCustomers(accessToken),
  ]);
  const catRows = unwrapRows(catsRes);
  const prodRows = unwrapRows(prodRes);
  const custRows = unwrapRows(custRes);
  const flat = flattenCategories(catRows);
  const products = prodRows.map(mapLiveProduct).filter(Boolean);
  if (!flat.categories.length && !products.length && !custRows.length) {
    return { success: false, message: 'Live catalog APIs returned no catalog rows' };
  }
  masterSqlite.applyPage({
    categories: flat.categories,
    subcategories: flat.subcategories,
    products,
    customers: custRows,
    nextCursor: masterSqlite.getCursor() || '',
  });
  if (custRows.length) localDb.saveCustomers(custRows);
  return { success: true, recovered: true, pages: 1, counts: masterSqlite.counts() };
}

async function syncMasterData(accessToken) {
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
      const fallback = await seedFromLiveApis(accessToken);
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
        const fallback = await seedFromLiveApis(accessToken);
        if (fallback.success) return { ...fallback, pages };
      }
      const live = await seedFromLiveApis(accessToken);
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

async function refreshCatalog(accessToken) {
  masterSqlite.clearCatalog();
  const snapshot = await syncMasterData(accessToken);
  const live = await seedFromLiveApis(accessToken);
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

module.exports = { syncMasterData, refreshCatalog };
