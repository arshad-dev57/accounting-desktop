/**
 * Local SQLite catalog for POS (sql.js — no native Electron rebuild).
 * Cloud PostgreSQL remains the source of truth; this is a replica.
 */
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
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS subcategories (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
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
      updated_at TEXT
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
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
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
  addColumnIfMissing('products', 'description', 'TEXT');
  addColumnIfMissing('products', 'cost_price', 'REAL');
  addColumnIfMissing('products', 'payload', 'TEXT');
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

function upsertCategory(row) {
  const parentId = row.parentId || row.categoryId || null;
  if (parentId) {
    upsertSubcategory({ ...row, categoryId: parentId });
    return;
  }
  run(
    `INSERT INTO categories (id, name, parent_id, code, description, is_active, is_deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       parent_id = excluded.parent_id,
       code = COALESCE(excluded.code, categories.code),
       description = COALESCE(excluded.description, categories.description),
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.name || '',
      null,
      row.code || null,
      row.description || null,
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
    ]
  );
}

function upsertSubcategory(row) {
  run(
    `INSERT INTO subcategories (id, category_id, name, code, description, is_active, is_deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category_id = excluded.category_id,
       name = excluded.name,
       code = COALESCE(excluded.code, subcategories.code),
       description = COALESCE(excluded.description, subcategories.description),
       is_active = excluded.is_active,
       is_deleted = excluded.is_deleted,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.categoryId || '',
      row.name || '',
      row.code || null,
      row.description || null,
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
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
  const id = row.id || row._id;
  if (!id) return;
  run(
    `INSERT INTO products (
        id, category_id, subcategory_id, name, sku, barcode, price,
        tax_rate, tax_type, current_stock, image, description, cost_price, payload,
        is_active, is_deleted, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       updated_at = excluded.updated_at`,
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
      Number(row.costPrice ?? row.cost_price ?? 0),
      toPayloadJson(row),
      row.isActive === false || row.isDeleted ? 0 : 1,
      row.isDeleted ? 1 : 0,
      row.updatedAt || new Date().toISOString(),
    ]
  );
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

function applyPage(page) {
  if (!db) throw new Error('Local catalog is not open');
  db.run('BEGIN');
  try {
    for (const row of page.categories || []) upsertCategory(row);
    for (const row of page.subcategories || []) upsertSubcategory(row);
    for (const row of page.products || []) upsertProduct(row);
    for (const row of page.customers || []) upsertCustomer(row);
    if (page.nextCursor) setCursor(page.nextCursor);
    db.run('COMMIT');
    persist();
    return true;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function resetCursor() {
  setCursor('');
  persist();
}

function clearCatalog() {
  if (!db) throw new Error('Local catalog is not open');
  db.run('BEGIN');
  try {
    db.run('DELETE FROM products');
    db.run('DELETE FROM subcategories');
    db.run('DELETE FROM categories');
    db.run('DELETE FROM customers');
    db.run(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ['master_cursor', '']
    );
    db.run('COMMIT');
    persist();
  } catch (err) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
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
    cursor: getCursor() || '',
  };
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
  upsertCategory({
    id,
    name,
    code: payload.code || '',
    description: payload.description || '',
    isActive: payload.isActive !== false,
    isDeleted: false,
  });
  persist();
  return { success: true, data: { id, name, code: payload.code || '', description: payload.description || '' } };
}

function deleteCategory(id) {
  if (!id) return { success: false, message: 'Category id is required' };
  const now = new Date().toISOString();
  run(`UPDATE categories SET is_deleted = 1, updated_at = ? WHERE id = ?`, [now, id]);
  run(`UPDATE subcategories SET is_deleted = 1, updated_at = ? WHERE category_id = ?`, [now, id]);
  persist();
  return { success: true };
}

function saveSubcategory(payload = {}) {
  const name = String(payload.name || '').trim();
  const categoryId = payload.categoryId || payload.parentId;
  if (!name) return { success: false, message: 'Name is required' };
  if (!categoryId) return { success: false, message: 'Parent category is required' };
  const id = payload.id || crypto.randomUUID();
  upsertSubcategory({
    id,
    categoryId,
    name,
    code: payload.code || '',
    description: payload.description || '',
    isActive: payload.isActive !== false,
    isDeleted: false,
  });
  persist();
  return { success: true, data: { id, name, categoryId, code: payload.code || '', description: payload.description || '' } };
}

function deleteSubcategory(id) {
  if (!id) return { success: false, message: 'Subcategory id is required' };
  run(`UPDATE subcategories SET is_deleted = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
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
  const merged = {
    ...prev,
    ...payload,
    id,
    name,
    sku,
    barcode,
    barcodeNumber: barcode,
    qrCode,
    categoryId: payload.categoryId || payload.category || null,
    subcategoryId: payload.subcategoryId || payload.subCategory || null,
    category: payload.category || payload.categoryId || '',
    subCategory: payload.subCategory || payload.subcategoryId || '',
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
  run(`UPDATE products SET is_deleted = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  persist();
  return { success: true };
}

module.exports = {
  open,
  getCursor,
  resetCursor,
  clearCatalog,
  reloadFromDisk,
  applyPage,
  searchProducts,
  searchCustomers,
  upsertCustomer,
  getCategoryTree,
  counts,
  addLocalSale,
  listPendingSales,
  listCatalog,
  saveCategory,
  deleteCategory,
  saveSubcategory,
  deleteSubcategory,
  listProducts,
  saveProduct,
  deleteProduct,
};
