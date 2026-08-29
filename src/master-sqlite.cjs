
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.cjs');

let SQL = null;
let db = null;
let dbFile = '';

function persist() {
  if (!db || !dbFile) return;
  const data = Buffer.from(db.export());
  fs.writeFileSync(dbFile, data);
}

function reloadFromDisk() {
  persist();
  if (!SQL || !dbFile || !fs.existsSync(dbFile)) return;
  try { db.close(); } catch { /* ignore */ }
  db = new SQL.Database(fs.readFileSync(dbFile));
}

function reloadFromDiskSafe() {
  if (!SQL || !dbFile || !fs.existsSync(dbFile)) return false;
  try { db.close(); } catch { /* ignore */ }
  try {
    db = new SQL.Database(fs.readFileSync(dbFile));
    return true;
  } catch {
    return false;
  }
}

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function migrate() {
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      sync_id TEXT,
      sync_status TEXT DEFAULT 'PENDING',
      last_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS subcategories (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      sync_id TEXT,
      sync_status TEXT DEFAULT 'PENDING',
      last_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT,
      subcategory_id TEXT,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      price REAL NOT NULL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_type TEXT,
      current_stock REAL DEFAULT 0,
      image TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      sync_id TEXT,
      sync_status TEXT DEFAULT 'PENDING',
      last_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_sales (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_returns (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      previous_stock REAL NOT NULL DEFAULT 0,
      new_stock REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'Pcs',
      unit_cost REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      stock_type TEXT NOT NULL DEFAULT 'bulk',
      reason TEXT NOT NULL,
      supplier_id TEXT,
      supplier_name TEXT,
      reference TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Completed',
      sync_status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(type);
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      company_name TEXT,
      customer_type TEXT,
      payload TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      company_name TEXT,
      payload TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
  `);
}

async function open(userDataPath) {
  if (db) return;
  const initSqlJs = require('sql.js');
  const wasmDir = path.join(path.dirname(require.resolve('sql.js/package.json')), 'dist');
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });
  dbFile = path.join(userDataPath, 'pos-master.sqlite');
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile));
  } else {
    db = new SQL.Database();
  }
  migrate();
  addColumnIfMissing('products', 'image', 'TEXT');
  addColumnIfMissing('categories', 'code', 'TEXT');
  addColumnIfMissing('categories', 'description', 'TEXT');
  addColumnIfMissing('subcategories', 'code', 'TEXT');
  addColumnIfMissing('subcategories', 'description', 'TEXT');
  addColumnIfMissing('products', 'cost_price', 'REAL');
  addColumnIfMissing('products', 'payload', 'TEXT');
  addColumnIfMissing('products', 'description', 'TEXT');
  addColumnIfMissing('categories', 'sync_id', 'TEXT');
  addColumnIfMissing('categories', 'sync_status', 'TEXT');
  addColumnIfMissing('categories', 'last_synced_at', 'TEXT');
  addColumnIfMissing('subcategories', 'sync_id', 'TEXT');
  addColumnIfMissing('subcategories', 'sync_status', 'TEXT');
  addColumnIfMissing('subcategories', 'last_synced_at', 'TEXT');
  addColumnIfMissing('products', 'sync_id', 'TEXT');
  addColumnIfMissing('products', 'sync_status', 'TEXT');
  addColumnIfMissing('products', 'last_synced_at', 'TEXT');
  addColumnIfMissing('products', 'stock_unit_name', 'TEXT');
  // Ensure existing rows are treated as synced (they originate from the cloud).
  run(`UPDATE categories SET sync_status = 'SYNCED' WHERE sync_status IS NULL`);
  run(`UPDATE subcategories SET sync_status = 'SYNCED' WHERE sync_status IS NULL`);
  run(`UPDATE products SET sync_status = 'SYNCED' WHERE sync_status IS NULL`);
  persist();
}

function addColumnIfMissing(table, column, type) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => String(c.name).toLowerCase() === String(column).toLowerCase())) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function resolveMediaUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
  if (value.startsWith('//')) return `https:${value}`;
  const base = config.resolveApiUrl();
  if (value.startsWith('/')) return `${base}${value}`;
  return `${base}/${value}`;
}

function pickImage(row) {
  if (!row || typeof row !== 'object') return '';
  const first = Array.isArray(row.images) ? row.images[0] : '';
  return resolveMediaUrl(row.image || row.mainImage || row.imageUrl || first || '');
}

function getCursor() {
  const row = get('SELECT value FROM sync_state WHERE key = ?', ['master_cursor']);
  return row?.value || null;
}

function setCursor(cursor) {
  run(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ['master_cursor', cursor || '']
  );
}

function resolveSyncId(table, syncId, fallbackId) {
  if (!syncId) return fallbackId;
  const bySync = get(`SELECT id FROM ${table} WHERE sync_id = ? AND is_deleted = 0`, [syncId]);
  return bySync ? bySync.id : fallbackId;
}

function upsertCategory(row) {
  const parentId = row.parentId || row.categoryId || null;
  if (parentId) {
    upsertSubcategory({ ...row, categoryId: parentId });
    return;
  }
  const id = resolveSyncId('categories', row.syncId, row.id);
  const syncStatus = row.syncStatus && row.syncStatus !== 'SYNCED' ? row.syncStatus : 'SYNCED';
  run(
    `INSERT INTO categories (id, name, parent_id, code, description, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       parent_id = excluded.parent_id,
       code = COALESCE(excluded.code, categories.code),
       description = COALESCE(excluded.description, categories.description),
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at,
       sync_id = COALESCE(categories.sync_id, excluded.sync_id),
       sync_status = excluded.sync_status,
       last_synced_at = COALESCE(excluded.last_synced_at, categories.last_synced_at)`,
    [
      id,
      row.name || '',
      null,
      row.code || null,
      row.description || null,
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
      row.syncId || null,
      syncStatus,
      row.lastSyncedAt || (syncStatus === 'SYNCED' ? new Date().toISOString() : null),
    ]
  );
}

function upsertSubcategory(row) {
  const id = resolveSyncId('subcategories', row.syncId, row.id);
  const syncStatus = row.syncStatus && row.syncStatus !== 'SYNCED' ? row.syncStatus : 'SYNCED';
  run(
    `INSERT INTO subcategories (id, category_id, name, code, description, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category_id = excluded.category_id,
       name = excluded.name,
       code = COALESCE(excluded.code, subcategories.code),
       description = COALESCE(excluded.description, subcategories.description),
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at,
       sync_id = COALESCE(subcategories.sync_id, excluded.sync_id),
       sync_status = excluded.sync_status,
       last_synced_at = COALESCE(excluded.last_synced_at, subcategories.last_synced_at)`,
    [
      id,
      row.categoryId || '',
      row.name || '',
      row.code || null,
      row.description || null,
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
      row.syncId || null,
      syncStatus,
      row.lastSyncedAt || (syncStatus === 'SYNCED' ? new Date().toISOString() : null),
    ]
  );
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toPayloadJson(row) {
  if (typeof row.payload === 'string' && row.payload.trim()) return row.payload;
  const copy = { ...row };
  delete copy.payload;
  try {
    return JSON.stringify(copy);
  } catch {
    return '{}';
  }
}

function upsertProduct(row) {
  const idValue = row.id || row._id;
  if (!idValue) return;
  const id = resolveSyncId('products', row.syncId, idValue);
  const syncStatus = row.syncStatus && row.syncStatus !== 'SYNCED' ? row.syncStatus : 'SYNCED';
  const hasCostKey = Object.prototype.hasOwnProperty.call(row, 'costPrice')
    || Object.prototype.hasOwnProperty.call(row, 'cost_price')
    || Object.prototype.hasOwnProperty.call(row, 'landingCost');
  const existing = get('SELECT cost_price, payload FROM products WHERE id = ?', [id]);
  const incomingCost = Number(row.costPrice ?? row.cost_price ?? row.landingCost ?? 0);
  // Don't wipe a known cost when a lean sync payload omits pricing
  const costPrice = hasCostKey
    ? incomingCost
    : Number(existing?.cost_price ?? incomingCost ?? 0);
  const prevPayload = parseJson(existing?.payload, {});
  const payloadObj = {
    ...prevPayload,
    ...row,
    costPrice,
    sellingPrice: Number(row.price ?? row.sellingPrice ?? prevPayload.sellingPrice ?? 0),
  };
  delete payloadObj.payload;
  run(
    `INSERT INTO products (
        id, category_id, subcategory_id, name, sku, barcode, price,
        tax_rate, tax_type, current_stock, image, description, cost_price, payload,
        is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at, stock_unit_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category_id = excluded.category_id,
       subcategory_id = excluded.subcategory_id,
       name = excluded.name,
       sku = excluded.sku,
       barcode = excluded.barcode,
       price = excluded.price,
       tax_rate = excluded.tax_rate,
       tax_type = excluded.tax_type,
       current_stock = excluded.current_stock,
       image = excluded.image,
       description = excluded.description,
       cost_price = excluded.cost_price,
       payload = excluded.payload,
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at,
       sync_id = COALESCE(products.sync_id, excluded.sync_id),
       sync_status = CASE
         WHEN products.sync_status IN ('PENDING', 'FAILED')
              AND (excluded.sync_id IS NULL OR products.sync_id IS NULL OR products.sync_id <> excluded.sync_id)
         THEN products.sync_status
         ELSE excluded.sync_status
       END,
       last_synced_at = COALESCE(excluded.last_synced_at, products.last_synced_at),
       stock_unit_name = excluded.stock_unit_name`,
    [
      id,
      row.categoryId || row.category?.id || null,
      row.subcategoryId || row.subCategoryId || null,
      row.name || '',
      row.sku || '',
      row.barcode || row.barcodeNumber || '',
      Number(row.price ?? row.sellingPrice ?? 0),
      Number(row.taxRate ?? 0),
      row.taxType || row.taxTypeName || 'Exclusive',
      Number(row.currentStock ?? row.availableStock ?? 0),
      pickImage(row),
      row.description || '',
      costPrice,
      JSON.stringify(payloadObj),
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
      row.syncId || null,
      syncStatus,
      row.lastSyncedAt || (syncStatus === 'SYNCED' ? new Date().toISOString() : null),
      row.stockUnitName || row.stockUnit || 'Pcs',
    ]
  );
}

function upsertSupplier(row) {
  const id = row.id || row._id;
  if (!id) return;
  const name = row.name || row.companyName || '';
  if (!name) return;
  const inactive = row.isActive === false || row.isDeleted || String(row.status || '').toLowerCase() === 'inactive';
  run(
    `INSERT INTO suppliers (
        id, name, phone, email, company_name, payload,
        is_active, is_deleted, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       email = excluded.email,
       company_name = excluded.company_name,
       payload = excluded.payload,
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at`,
    [
      id,
      name,
      row.phone || row.mobile || '',
      row.email || '',
      row.companyName || row.company || '',
      JSON.stringify(row),
      inactive ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
    ]
  );
}

function listSuppliers() {
  return all(
    `SELECT * FROM suppliers WHERE is_deleted = 0 AND is_active = 1 ORDER BY name`
  ).map((row) => {
    let extra = {};
    try { extra = JSON.parse(row.payload || '{}'); } catch { extra = {}; }
    return {
      ...extra,
      id: row.id,
      _id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      companyName: row.company_name,
      isActive: row.is_active === 1,
    };
  });
}

function upsertCustomer(row) {
  const id = row.id || row._id;
  if (!id) return;
  const name = row.name || row.companyName || '';
  if (!name) return;
  run(
    `INSERT INTO customers (
        id, name, phone, email, company_name, customer_type, payload,
        is_active, is_deleted, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       phone = excluded.phone,
       email = excluded.email,
       company_name = excluded.company_name,
       customer_type = excluded.customer_type,
       payload = excluded.payload,
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at`,
    [
      id,
      name,
      row.phone || row.mobile || '',
      row.email || '',
      row.companyName || row.company || '',
      row.customerType || row.type || '',
      JSON.stringify(row),
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
    ]
  );
  persist();
}

function searchCustomers({ query = '', limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let sql = `SELECT * FROM customers WHERE is_deleted = 0 AND is_active = 1`;
  const params = [];
  if (q) {
    sql += ` AND (lower(name) LIKE ? OR lower(IFNULL(phone,'')) LIKE ? OR lower(IFNULL(email,'')) LIKE ? OR lower(IFNULL(company_name,'')) LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ` ORDER BY name LIMIT ?`;
  params.push(Math.max(1, Number(limit) || 20));
  return all(sql, params).map((row) => {
    let extra = {};
    try { extra = JSON.parse(row.payload || '{}'); } catch { extra = {}; }
    return {
      ...extra,
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      companyName: row.company_name,
      customerType: row.customer_type,
      isActive: row.is_active === 1,
    };
  });
}

function getCustomerById(id) {
  const row = get(`SELECT * FROM customers WHERE id = ? AND is_deleted = 0`, [id]);
  if (!row) return null;
  return row;
}


function keepOnlyProductIds(ids) {
  const list = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  const now = new Date().toISOString();
  // NEVER soft-delete rows that have not been uploaded to the cloud yet
  // (sync_status PENDING/FAILED) — they only exist locally and would be lost.
  if (!list.length) {
    run(`UPDATE products SET is_deleted = 1, updated_at = ? WHERE sync_status = 'SYNCED'`, [now]);
    persist();
    return;
  }
  const placeholders = list.map(() => '?').join(', ');
  run(
    `UPDATE products SET is_deleted = 1, updated_at = ? WHERE id NOT IN (${placeholders}) AND sync_status = 'SYNCED'`,
    [now, ...list]
  );
  persist();
}

function applyPage(page) {
  if (!db) throw new Error('Local catalog is not open');
  for (const row of page.categories || []) upsertCategory(row);
  for (const row of page.subcategories || []) upsertSubcategory(row);
  for (const row of page.products || []) upsertProduct(row);
  for (const row of page.customers || []) upsertCustomer(row);
  for (const row of page.suppliers || []) upsertSupplier(row);
  if (page.nextCursor) setCursor(page.nextCursor);
  persist();
  return true;
}

function resetCursor() {
  setCursor('');
  persist();
}

function clearCatalog() {
  if (!db) throw new Error('Local catalog is not open');
  db.run(`DELETE FROM products WHERE sync_status IS NULL OR sync_status = 'SYNCED'`);
  db.run(`DELETE FROM subcategories WHERE sync_status IS NULL OR sync_status = 'SYNCED'`);
  db.run(`DELETE FROM categories WHERE sync_status IS NULL OR sync_status = 'SYNCED'`);
  db.run('DELETE FROM customers');
  db.run('DELETE FROM suppliers');
  db.run(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ['master_cursor', '']
  );
  persist();
}

function categoryMatchIds(categoryId) {
  const ids = [String(categoryId)];
  const root = get('SELECT id FROM categories WHERE id = ? AND is_deleted = 0', [categoryId]);
  if (root) {
    const kids = all(
      `SELECT id FROM subcategories WHERE is_deleted = 0 AND category_id = ?
       UNION
       SELECT id FROM categories WHERE is_deleted = 0 AND parent_id = ?`,
      [categoryId, categoryId]
    );
    for (const row of kids) ids.push(String(row.id));
  }
  return ids;
}

function searchProducts({ query = '', categoryId = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let sql = `SELECT * FROM products WHERE is_deleted = 0 AND is_active = 1`;
  const params = [];
  if (q) {
    sql += ` AND (lower(name) LIKE ? OR lower(IFNULL(sku,'')) LIKE ? OR lower(IFNULL(barcode,'')) LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (categoryId && categoryId !== 'All') {
    const ids = categoryMatchIds(categoryId);
    const placeholders = ids.map(() => '?').join(',');
    sql += ` AND (category_id IN (${placeholders}) OR subcategory_id IN (${placeholders}))`;
    params.push(...ids, ...ids);
  }
  sql += ` ORDER BY name LIMIT 300`;
  return all(sql, params).map(mapProduct);
}

function scanKeysOf(product) {
  return [
    product.barcode,
    product.barcodeNumber,
    product.sku,
    product.qrCode,
    product.qr_code,
  ]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function findByScanCode(code) {
  const needle = String(code || '').trim().toLowerCase();
  if (!needle) return null;
  const rows = all(`SELECT * FROM products WHERE is_deleted = 0 AND is_active = 1`);
  return rows.map(mapProduct).find((p) => scanKeysOf(p).includes(needle)) || null;
}

function mapProduct(row) {
  const extra = parseJson(row.payload, {});
  const image = resolveMediaUrl(row.image || extra.mainImage || extra.image || '');
  return {
    ...extra,
    id: row.id,
    name: row.name,
    sku: row.sku || extra.sku || '',
    barcode: row.barcode || extra.barcode || extra.barcodeNumber || '',
    barcodeNumber: row.barcode || extra.barcodeNumber || extra.barcode || '',
    description: row.description || extra.description || '',
    sellingPrice: Number(row.price ?? extra.sellingPrice ?? 0),
    price: Number(row.price ?? extra.sellingPrice ?? 0),
    costPrice: Number(row.cost_price ?? extra.costPrice ?? 0),
    taxRate: Number(row.tax_rate ?? extra.taxRate ?? 0),
    taxType: row.tax_type || extra.taxType || extra.taxTypeName || 'Exclusive',
    currentStock: Number(row.current_stock ?? extra.currentStock ?? 0),
    categoryId: row.category_id || extra.categoryId || extra.category || '',
    subcategoryId: row.subcategory_id || extra.subcategoryId || extra.subCategory || extra.subCategoryId || '',
    category: extra.category || extra.categoryId || row.category_id || '',
    subCategory: extra.subCategory || extra.subcategoryId || row.subcategory_id || '',
    isActive: row.is_active === 1,
    mainImage: image,
    image,
    stockUnitName: row.stock_unit_name || extra.stockUnitName || extra.stockUnit || 'Pcs',
    stockUnit: row.stock_unit_name || extra.stockUnit || extra.stockUnitName || 'Pcs',
  };
}

function getCategoryTree() {
  const cats = all('SELECT * FROM categories WHERE is_deleted = 0 AND (parent_id IS NULL OR parent_id = \'\') ORDER BY name');
  const nestedCats = all('SELECT * FROM categories WHERE is_deleted = 0 AND parent_id IS NOT NULL AND parent_id != \'\' ORDER BY name');
  const subs = all('SELECT * FROM subcategories WHERE is_deleted = 0 ORDER BY name');
  return cats.map((c) => {
    const fromSubs = subs
      .filter((s) => s.category_id === c.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        parentId: s.category_id,
        categoryId: s.category_id,
        isActive: s.is_active === 1,
      }));
    const fromNested = nestedCats
      .filter((s) => s.parent_id === c.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        parentId: s.parent_id,
        categoryId: s.parent_id,
        isActive: s.is_active === 1,
      }));
    const seen = new Set();
    const children = [...fromSubs, ...fromNested].filter((child) => {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      return true;
    });
    return {
      id: c.id,
      name: c.name,
      parentId: null,
      isActive: c.is_active === 1,
      children,
      subCategories: children,
    };
  });
}

function counts() {
  return {
    categories: get('SELECT COUNT(*) AS n FROM categories WHERE is_deleted = 0')?.n || 0,
    subcategories: get('SELECT COUNT(*) AS n FROM subcategories WHERE is_deleted = 0')?.n || 0,
    products: get('SELECT COUNT(*) AS n FROM products WHERE is_deleted = 0')?.n || 0,
    customers: get('SELECT COUNT(*) AS n FROM customers WHERE is_deleted = 0')?.n || 0,
    suppliers: get('SELECT COUNT(*) AS n FROM suppliers WHERE is_deleted = 0')?.n || 0,
    cursor: getCursor() || '',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL STOCK MOVEMENTS (Offline-first inventory receiving/costing)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adjust a product's current_stock in the local SQLite DB.
 * Returns { previousStock, newStock }.
 */
function adjustProductStockLocally(productId, delta) {
  const row = get('SELECT current_stock, name, stock_unit_name FROM products WHERE id = ? AND is_deleted = 0', [productId]);
  if (!row) throw new Error('Product not found locally');
  const previousStock = Number(row.current_stock) || 0;
  const newStock = Math.max(0, previousStock + Number(delta));
  run('UPDATE products SET current_stock = ?, sync_status = \'PENDING\', updated_at = ? WHERE id = ?',
    [newStock, new Date().toISOString(), productId]);
  persist();
  return { previousStock, newStock, productName: row.name, unit: row.stock_unit_name || 'Pcs' };
}

/**
 * Record a stock movement (stock_in or stock_out) in the local stock_movements table.
 */
function addStockMovement({
  productId, productName, type, quantity, previousStock, newStock,
  unit = 'Pcs', unitCost = 0, stockType = 'bulk', reason,
  supplierId = null, supplierName = null, reference = '', notes = '',
}) {
  const id = crypto.randomUUID();
  const totalCost = Number(quantity) * Number(unitCost);
  run(
    `INSERT INTO stock_movements (
       id, product_id, product_name, type, quantity, previous_stock, new_stock,
       unit, unit_cost, total_cost, stock_type, reason, supplier_id, supplier_name,
       reference, notes, status, sync_status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Completed', 'PENDING', ?)`,
    [id, productId, productName, type, Number(quantity), Number(previousStock), Number(newStock),
     unit, Number(unitCost), totalCost, stockType, reason,
     supplierId, supplierName, reference || '', notes || '', new Date().toISOString()]
  );
  persist();
  return { id, productId, productName, type, quantity, previousStock, newStock, unit, unitCost, totalCost, stockType, reason };
}

/**
 * List all local stock movements, newest first.
 * Optionally filter by productId or type ('stock_in'/'stock_out').
 */
function listStockMovements({ productId, type, limit = 100 } = {}) {
  let query = 'SELECT * FROM stock_movements WHERE 1=1';
  const params = [];
  if (productId) { query += ' AND product_id = ?'; params.push(productId); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  query += ' ORDER BY created_at DESC';
  if (limit) { query += ` LIMIT ${parseInt(limit, 10)}`; }
  return all(query, params).map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    type: row.type,
    quantity: row.quantity,
    previousStock: row.previous_stock,
    newStock: row.new_stock,
    unit: row.unit || 'Pcs',
    unitCost: row.unit_cost || 0,
    totalCost: row.total_cost || 0,
    stockType: row.stock_type || 'bulk',
    reason: row.reason,
    supplierId: row.supplier_id || null,
    supplierName: row.supplier_name || '',
    reference: row.reference || '',
    notes: row.notes || '',
    status: row.status,
    createdAt: row.created_at,
  }));
}

function addLocalSale(sale) {
  const id = sale.id || `local-sale-${Date.now()}`;
  run(
    `INSERT INTO local_sales (id, payload, status, created_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    [id, JSON.stringify(sale), new Date().toISOString()]
  );
  persist();
  return id;
}

function listPendingSales() {
  return all(`SELECT * FROM local_sales WHERE status = 'pending'`).map((row) => ({
    id: row.id,
    ...JSON.parse(row.payload || '{}'),
  }));
}

/**
 * Return every local sale (pending + synced), newest first, for offline-first
 * display on the Sell screen's sales register without hitting the API.
 */
function listAllLocalSales() {
  return all(`SELECT * FROM local_sales ORDER BY created_at DESC`).map((row) => ({
    id: row.id,
    ...JSON.parse(row.payload || '{}'),
  }));
}

function deleteLocalSale(id) {
  run(`DELETE FROM local_sales WHERE id = ?`, [id]);
  persist();
}

function addLocalReturn(ret) {
  const id = ret.id || `local-return-${Date.now()}`;
  run(
    `INSERT INTO local_returns (id, sale_id, payload, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    [id, ret.saleId || '', JSON.stringify(ret), ret.createdAt || new Date().toISOString()]
  );
  persist();
  return id;
}

function listAllLocalReturns() {
  return all(`SELECT * FROM local_returns ORDER BY created_at DESC`).map((row) => ({
    id: row.id,
    ...JSON.parse(row.payload || '{}'),
  }));
}

function listCatalog() {
  const parents = all(
    `SELECT * FROM categories WHERE is_deleted = 0 AND (parent_id IS NULL OR parent_id = '') ORDER BY name`
  );
  const subs = all(`SELECT * FROM subcategories WHERE is_deleted = 0 ORDER BY name`);
  return parents.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code || '',
    description: p.description || '',
    isActive: p.is_active === 1,
    subCategories: subs
      .filter((s) => s.category_id === p.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code || '',
        description: s.description || '',
        categoryId: s.category_id,
        isActive: s.is_active === 1,
      })),
  }));
}

function saveCategory(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) return { success: false, message: 'Name is required' };
  const id = payload.id || crypto.randomUUID();
  const prev = get('SELECT sync_id, sync_status, last_synced_at FROM categories WHERE id = ?', [id]);
  const syncId = String(payload.syncId || prev?.sync_id || crypto.randomUUID()).trim();
  upsertCategory({
    id,
    syncId,
    syncStatus: 'PENDING',
    name,
    code: payload.code || '',
    description: payload.description || '',
    isActive: payload.isActive !== false,
    isDeleted: false,
  });
  persist();
  return { success: true, data: { id, name, syncId, code: payload.code || '', description: payload.description || '' } };
}

function deleteCategory(id) {
  if (!id) return { success: false, message: 'Category id is required' };
  const now = new Date().toISOString();
  run(`UPDATE categories SET is_deleted = 1, sync_status = 'PENDING', updated_at = ? WHERE id = ?`, [now, id]);
  run(`UPDATE subcategories SET is_deleted = 1, sync_status = 'PENDING', updated_at = ? WHERE category_id = ?`, [now, id]);
  persist();
  return { success: true };
}

function saveSubcategory(payload = {}) {
  const name = String(payload.name || '').trim();
  const categoryId = payload.categoryId || payload.parentId;
  if (!name) return { success: false, message: 'Name is required' };
  if (!categoryId) return { success: false, message: 'Parent category is required' };
  const id = payload.id || crypto.randomUUID();
  const prev = get('SELECT sync_id, sync_status FROM subcategories WHERE id = ?', [id]);
  const syncId = String(payload.syncId || prev?.sync_id || crypto.randomUUID()).trim();
  upsertSubcategory({
    id,
    syncId,
    syncStatus: 'PENDING',
    categoryId,
    name,
    code: payload.code || '',
    description: payload.description || '',
    isActive: payload.isActive !== false,
    isDeleted: false,
  });
  persist();
  return { success: true, data: { id, name, syncId, categoryId, code: payload.code || '', description: payload.description || '' } };
}

function deleteSubcategory(id) {
  if (!id) return { success: false, message: 'Subcategory id is required' };
  run(`UPDATE subcategories SET is_deleted = 1, sync_status = 'PENDING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  persist();
  return { success: true };
}

function listProducts() {
  return all(
    `SELECT p.*, c.name AS category_name, s.name AS subcategory_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN subcategories s ON s.id = p.subcategory_id
     WHERE p.is_deleted = 0
     ORDER BY p.name`
  ).map((row) => ({
    ...mapProduct(row),
    categoryName: row.category_name || '',
    subcategoryName: row.subcategory_name || '',
  }));
}

/** Restore cost_price when lean sync wiped it (cost column / payload = 0). */
function patchProductCost(id, cost) {
  const productId = String(id || '').trim();
  const n = Number(cost);
  if (!productId || !Number.isFinite(n) || n < 0) return false;
  const row = get('SELECT cost_price, payload FROM products WHERE id = ?', [productId]);
  if (!row) return false;
  if (Number(row.cost_price) > 0) return false;
  const extra = parseJson(row.payload, {});
  extra.costPrice = n;
  run(
    `UPDATE products SET cost_price = ?, payload = ? WHERE id = ?`,
    [n, JSON.stringify(extra), productId]
  );
  persist();
  return true;
}

function generateSku(name) {
  const prefix = String(name || 'PRD').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'PRD';
  let n = Number(get('SELECT COUNT(*) AS n FROM products')?.n || 0) + 1;
  let sku = `${prefix}-${String(n).padStart(5, '0')}`;
  while (get('SELECT id FROM products WHERE sku = ? AND is_deleted = 0', [sku])) {
    n += 1;
    sku = `${prefix}-${String(n).padStart(5, '0')}`;
  }
  return sku;
}

function saveProduct(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) return { success: false, message: 'Name is required' };
  const id = payload.id || crypto.randomUUID();
  const existing = get('SELECT payload FROM products WHERE id = ?', [id]);
  const prev = parseJson(existing?.payload, {});
  let sku = String(payload.sku || prev.sku || '').trim();
  if (!sku) sku = generateSku(name);
  const barcode = String(payload.barcode || payload.barcodeNumber || sku).trim();
  const qrCode = String(payload.qrCode || sku).trim();
  const images = Array.isArray(payload.images)
    ? payload.images.filter(Boolean)
    : [payload.mainImage || payload.image].filter(Boolean);
  let categoryId = payload.categoryId || payload.category || null;
  let subcategoryId = payload.subcategoryId || payload.subCategory || null;
  // The UI's "category" picker often holds a leaf SUBCATEGORY id. Auto-fill
  // subcategory_id so the row carries both links; the push resolves syncIds
  // from either column (see listPendingSync).
  const subRef = categoryId
    ? get('SELECT id, category_id FROM subcategories WHERE id = ? AND is_deleted = 0', [categoryId])
    : null;
  if (subRef && !subcategoryId) subcategoryId = subRef.id;
  const merged = {
    ...prev,
    ...payload,
    id,
    syncId: String(payload.syncId || prev.syncId || crypto.randomUUID()).trim(),
    syncStatus: 'PENDING',
    name,
    sku,
    barcode,
    barcodeNumber: barcode,
    qrCode,
    categoryId,
    subcategoryId,
    category: payload.category || categoryId || '',
    subCategory: subcategoryId || payload.subCategory || '',
    sellingPrice: Number(payload.sellingPrice ?? payload.price ?? 0),
    price: Number(payload.sellingPrice ?? payload.price ?? 0),
    costPrice: Number(payload.costPrice || 0),
    landingCost: Number(payload.landingCost || 0),
    taxRate: Number(payload.taxRate || 0),
    taxType: payload.taxType || payload.taxTypeName || 'Exclusive',
    currentStock: Number(payload.currentStock ?? 0),
    images,
    mainImage: payload.mainImage || payload.image || images[0] || '',
    image: payload.image || payload.mainImage || images[0] || '',
    isActive: payload.isActive !== false,
    isDeleted: false,
    updatedAt: new Date().toISOString(),
  };
  upsertProduct({ ...merged, payload: JSON.stringify(merged) });
  persist();
  return { success: true, data: { id, name, sku } };
}

function deleteProduct(id) {
  if (!id) return { success: false, message: 'Product id is required' };
  run(`UPDATE products SET is_deleted = 1, sync_status = 'PENDING', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  persist();
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// BIDIRECTIONAL SYNC (Local -> Cloud -> Local) - client-side support
// ═══════════════════════════════════════════════════════════════════════════

const SYNC_PENDING = 'PENDING';
const SYNC_SYNCED = 'SYNCED';
const SYNC_FAILED = 'FAILED';

function newSyncId() {
  return crypto.randomUUID();
}

/** Rewrites JSON reference keys inside product payloads after an id change. */
function fixProductPayloadRefs(oldId, newId) {
  const rows = all('SELECT id, payload FROM products');
  const keys = ['categoryId', 'category', 'subcategoryId', 'subCategory', 'parentId'];
  for (const r of rows) {
    const parsed = parseJson(r.payload, {});
    let changed = false;
    for (const k of keys) {
      if (parsed[k] && String(parsed[k]) === String(oldId)) {
        parsed[k] = newId;
        changed = true;
      }
    }
    if (changed) {
      run('UPDATE products SET payload = ? WHERE id = ?', [JSON.stringify(parsed), r.id]);
    }
  }
}

/** Renames a parent category's primary key to its cloud id and fixes references. */
function renameCategoryId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const tmp = `__tmp_${oldId}_${newId}`;
  run('DELETE FROM categories WHERE id = ?', [tmp]); // stale tmp from an interrupted rename
  try {
    run('INSERT INTO categories (id, name, parent_id, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at) SELECT ?, name, parent_id, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at FROM categories WHERE id = ?', [tmp, oldId]);
    run('DELETE FROM categories WHERE id = ?', [oldId]);
  } catch { /* tmp collision guard */ }
  run(`UPDATE subcategories SET category_id = ? WHERE category_id = ?`, [newId, oldId]);
  run(`UPDATE categories SET parent_id = ? WHERE parent_id = ?`, [newId, oldId]);
  run(`UPDATE products SET category_id = ? WHERE category_id = ?`, [newId, oldId]);
  fixProductPayloadRefs(oldId, newId);
  const moved = get('SELECT id FROM categories WHERE id = ?', [tmp]);
  if (moved) {
    const target = get('SELECT id FROM categories WHERE id = ?', [newId]);
    if (target) {
      // Cloud row already exists locally (pulled earlier) — keep it and drop
      // the tmp copy instead of failing with UNIQUE constraint.
      run('DELETE FROM categories WHERE id = ?', [tmp]);
    } else {
      run('UPDATE categories SET id = ? WHERE id = ?', [newId, tmp]);
    }
  }
}

/** Renames a subcategory's primary key to its cloud id and fixes references. */
function renameSubcategoryId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const tmp = `__tmp_${oldId}_${newId}`;
  run('DELETE FROM subcategories WHERE id = ?', [tmp]); // stale tmp from an interrupted rename
  try {
    run('INSERT INTO subcategories (id, category_id, name, code, description, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at) SELECT ?, category_id, name, code, description, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at FROM subcategories WHERE id = ?', [tmp, oldId]);
    run('DELETE FROM subcategories WHERE id = ?', [oldId]);
  } catch { /* tmp collision guard */ }
  run(`UPDATE products SET subcategory_id = ? WHERE subcategory_id = ?`, [newId, oldId]);
  fixProductPayloadRefs(oldId, newId);
  const moved = get('SELECT id FROM subcategories WHERE id = ?', [tmp]);
  if (moved) {
    const target = get('SELECT id FROM subcategories WHERE id = ?', [newId]);
    if (target) {
      // Cloud row already exists locally — keep it, drop the tmp copy.
      run('DELETE FROM subcategories WHERE id = ?', [tmp]);
    } else {
      run('UPDATE subcategories SET id = ? WHERE id = ?', [newId, tmp]);
    }
  }
}

/** Renames a product's primary key to its cloud id. */
function renameProductId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const tmp = `__tmp_${oldId}_${newId}`;
  run('DELETE FROM products WHERE id = ?', [tmp]); // stale tmp from an interrupted rename
  try {
    run('INSERT INTO products (id, category_id, subcategory_id, name, sku, barcode, price, tax_rate, tax_type, current_stock, image, description, cost_price, payload, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at) SELECT ?, category_id, subcategory_id, name, sku, barcode, price, tax_rate, tax_type, current_stock, image, description, cost_price, payload, is_active, is_deleted, updated_at, sync_id, sync_status, last_synced_at FROM products WHERE id = ?', [tmp, oldId]);
    run('DELETE FROM products WHERE id = ?', [oldId]);
  } catch { /* tmp collision guard */ }
  const moved = get('SELECT id FROM products WHERE id = ?', [tmp]);
  if (moved) {
    const target = get('SELECT id FROM products WHERE id = ?', [newId]);
    if (target) {
      // Cloud row already exists locally — keep it, drop the tmp copy.
      run('DELETE FROM products WHERE id = ?', [tmp]);
    } else {
      run('UPDATE products SET id = ? WHERE id = ?', [newId, tmp]);
    }
  }
}

/**
 * Reads the client's pending local catalog records (created/edited while
 * offline). Every record is handed a stable `syncId` (generated if missing) so
 * the cloud can upsert by it without creating duplicates.
 *
 * @returns {{categories: object[], subcategories: object[], products: object[]}}
 */
function listPendingSync() {
  const now = new Date().toISOString();
  const ensure = (table) => {
    run(
      `UPDATE ${table} SET sync_id = ?, sync_status = IFNULL(sync_status, '${SYNC_PENDING}') WHERE sync_id IS NULL`,
      [crypto.randomUUID()]
    );
  };
  ensure('categories');
  ensure('subcategories');
  ensure('products');

  const categories = all(
    `SELECT c.* FROM categories c
     WHERE (c.sync_status IS NULL OR c.sync_status != 'SYNCED')
       AND (c.is_deleted = 0 OR c.is_deleted IS NULL)`
  ).map((row) => ({
    syncId: row.sync_id || newSyncId(),
    name: row.name || '',
    code: row.code || '',
    description: row.description || '',
    isActive: row.is_active !== 0,
    isDeleted: row.is_deleted === 1,
    updatedAt: row.updated_at || now,
  }));

  const subcategories = all(
    `SELECT s.*, p.sync_id AS parent_sync_id FROM subcategories s
     LEFT JOIN categories p ON p.id = s.category_id
     WHERE (s.sync_status IS NULL OR s.sync_status != 'SYNCED')
       AND (s.is_deleted = 0 OR s.is_deleted IS NULL)`
  ).map((row) => ({
    syncId: row.sync_id || newSyncId(),
    name: row.name || '',
    parentSyncId: row.parent_sync_id || '',
    code: row.code || '',
    description: row.description || '',
    isActive: row.is_active !== 0,
    isDeleted: row.is_deleted === 1,
    updatedAt: row.updated_at || now,
  }));

  const products = all(
    `SELECT pr.*,
            c.sync_id  AS category_sync_id,
            s.sync_id  AS subcategory_sync_id,
            s2.sync_id AS sub_via_cat_sync_id,
            p2.sync_id AS parent_via_sub_sync_id,
            c.name     AS category_name,
            s.name     AS subcategory_name,
            s2.name    AS sub_via_cat_name,
            p2.name    AS parent_via_sub_name
     FROM products pr
     LEFT JOIN categories c ON c.id = pr.category_id
     LEFT JOIN subcategories s ON s.id = pr.subcategory_id
     LEFT JOIN subcategories s2 ON s2.id = pr.category_id
     LEFT JOIN categories p2 ON p2.id = s2.category_id
     WHERE (pr.sync_status IS NULL OR pr.sync_status != 'SYNCED')
       AND (pr.is_deleted = 0 OR pr.is_deleted IS NULL)`
  ).map((row) => {
    const extra = parseJson(row.payload, {});
    // The product form stores the selected leaf (often a SUBCATEGORY id) in
    // category_id with subcategory_id left empty. Resolve the real links:
    //  - if category_id references a subcategory row, use it as the sub and
    //    take its parent category as the category;
    //  - otherwise use the classic category_id / subcategory_id joins.
    const subcategorySyncId = row.subcategory_sync_id || row.sub_via_cat_sync_id || '';
    const categorySyncId = row.category_sync_id || row.parent_via_sub_sync_id || '';
    const subcategoryName = row.subcategory_name || row.sub_via_cat_name || '';
    const categoryName = row.category_name || row.parent_via_sub_name || '';
    return {
      syncId: row.sync_id || newSyncId(),
      name: row.name || '',
      sku: row.sku || extra.sku || '',
      barcode: row.barcode || extra.barcodeNumber || extra.barcode || '',
      sellingPrice: Number(row.price ?? extra.sellingPrice ?? 0),
      costPrice: Number(row.cost_price ?? extra.costPrice ?? 0),
      taxRate: Number(row.tax_rate ?? extra.taxRate ?? 0),
      taxType: row.tax_type || extra.taxType || 'Exclusive',
      currentStock: Number(row.current_stock ?? extra.currentStock ?? 0),
      mainImage: row.image || extra.mainImage || '',
      categorySyncId,
      subcategorySyncId,
      categoryName,
      subcategoryName,
      isActive: row.is_active !== 0,
      isDeleted: row.is_deleted === 1,
      updatedAt: row.updated_at || now,
    };
  });

  return sanitizeRecordsForPush({ categories, subcategories, products });
}

/**
 * Base64 data-URL images (added from the product form) can be megabytes each
 * and blow past the backend's JSON body limit (HTTP 413). The local replica
 * keeps them for offline display, but the push only carries http(s) URLs —
 * inline data: URLs are stripped before upload.
 */
function stripInlineImages(value) {
  if (typeof value === 'string') {
    return value.startsWith('data:') ? '' : value;
  }
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === 'string' && v.startsWith('data:')));
  }
  return value;
}

const PUSH_IMAGE_FIELDS = ['mainImage', 'image', 'imageUrl', 'images', 'logo', 'icon'];

function sanitizeRecordsForPush(records) {
  const clean = (rec) => {
    if (!rec || typeof rec !== 'object') return rec;
    const out = { ...rec };
    for (const field of PUSH_IMAGE_FIELDS) {
      if (out[field] !== undefined) out[field] = stripInlineImages(out[field]);
    }
    return out;
  };
  return {
    categories: (records.categories || []).map(clean),
    subcategories: (records.subcategories || []).map(clean),
    products: (records.products || []).map(clean),
  };
}

/**
 * Applies the result of a successful Local -> Cloud upload:
 *  - aligns local primary keys to the returned cloud ids (so parent/child and
 *    product references stay consistent when the catalog is pulled back),
 *  - marks each pushed record SYNCED and records lastSyncedAt.
 * Failed records are kept PENDING/FAILED so they are retried next sync.
 *
 * @param {object} result ingest result: { pushed, mapping, summary }
 */
function markSynced(result) {
  if (!result || !result.pushed) return false;
  const mapping = result.mapping || {};
  const now = new Date().toISOString();
  const groups = [
    { list: result.pushed.categories || [], table: 'categories', rename: renameCategoryId },
    { list: result.pushed.subcategories || [], table: 'subcategories', rename: renameSubcategoryId },
    { list: result.pushed.products || [], table: 'products', rename: renameProductId },
  ];

  for (const group of groups) {
    for (const item of group.list) {
      if (!item || item.action === 'failed' || !item.syncId) continue;
      const cloudId = mapping[item.syncId] || item.cloudId;
      if (cloudId) {
        try {
          const local = get(`SELECT id FROM ${group.table} WHERE sync_id = ?`, [item.syncId]);
          if (local) group.rename(local.id, cloudId);
        } catch (err) {
          console.warn('[sqlite] id realign skipped:', err.message);
        }
      }
      run(
        `UPDATE ${group.table} SET sync_status = '${SYNC_SYNCED}', last_synced_at = ? WHERE sync_id = ?`,
        [now, item.syncId]
      );
    }
  }
  persist();
  return true;
}

/** Marks local records that the backend reported as failed as retryable FAILED. */
function markFailed(failedItems = []) {
  const groups = ['categories', 'subcategories', 'products'];
  for (const item of failedItems) {
    if (!item || !item.syncId) continue;
    for (const table of groups) {
      run(`UPDATE ${table} SET sync_status = '${SYNC_FAILED}' WHERE sync_id = ?`, [item.syncId]);
    }
  }
  persist();
}

/** Counts pending (unsynced) records per entity for status/summary UIs. */
function pendingCounts() {
  return {
    categories: get(`SELECT COUNT(*) AS n FROM categories WHERE sync_status != '${SYNC_SYNCED}' OR sync_status IS NULL`)?.n || 0,
    subcategories: get(`SELECT COUNT(*) AS n FROM subcategories WHERE sync_status != '${SYNC_SYNCED}' OR sync_status IS NULL`)?.n || 0,
    products: get(`SELECT COUNT(*) AS n FROM products WHERE sync_status != '${SYNC_SYNCED}' OR sync_status IS NULL`)?.n || 0,
  };
}

module.exports = {
  open,
  getCursor,
  resetCursor,
  clearCatalog,
  reloadFromDisk,
  reloadFromDiskSafe,
  applyPage,
  keepOnlyProductIds,
  searchProducts,
  findByScanCode,
  searchCustomers,
  getCustomerById,
  upsertCustomer,

  getCategoryTree,
  counts,
  addLocalSale,
  listPendingSales,
  listAllLocalSales,
  deleteLocalSale,
  addLocalReturn,
  listAllLocalReturns,
  listCatalog,
  listSuppliers,
  saveCategory,
  deleteCategory,
  saveSubcategory,
  deleteSubcategory,
  listProducts,
  patchProductCost,
  saveProduct,
  deleteProduct,
  newSyncId,
  listPendingSync,
  markSynced,
  markFailed,
  pendingCounts,
  adjustProductStockLocally,
  addStockMovement,
  listStockMovements,
};
