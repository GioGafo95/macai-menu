
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConflictError, ACTIVE_STATUSES } from './common.js';

export async function createSqliteStore({ dataDir }) {
  // Import dinámico: así el paquete para Lambda (que usa DynamoDB) nunca carga node:sqlite
  const { DatabaseSync } = await import('node:sqlite');
  const DATA_DIR = path.resolve(dataDir);
  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const db = new DatabaseSync(path.join(DATA_DIR, 'macai.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS order_docs (
      id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_od_created ON order_docs(created_at);
    CREATE INDEX IF NOT EXISTS idx_od_updated ON order_docs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_od_active ON order_docs(active, created_at);
  `);

  const writeOrder = db.prepare(`INSERT OR REPLACE INTO order_docs (id, token, created_at, updated_at, active, data)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const orderRow = (o) => [o.id, o.token, o.created_at, o.updated_at, ACTIVE_STATUSES.includes(o.status) ? 1 : 0, JSON.stringify(o)];

  const store = {
    kind: 'sqlite',
    uploadDir: UPLOAD_DIR,

    async getDoc(key) {
      const row = db.prepare('SELECT data, version FROM kv WHERE key = ?').get(key);
      return row ? { data: JSON.parse(row.data), version: row.version } : null;
    },

    async putDoc(key, data, expectedVersion) {
      const json = JSON.stringify(data);
      if (expectedVersion == null) {
        try {
          db.prepare('INSERT INTO kv (key, data, version) VALUES (?, ?, 1)').run(key, json);
        } catch (e) {
          if (/UNIQUE|constraint/i.test(e.message)) throw new ConflictError(key);
          throw e;
        }
        return 1;
      }
      const r = db.prepare('UPDATE kv SET data = ?, version = version + 1 WHERE key = ? AND version = ?').run(json, key, expectedVersion);
      if (r.changes === 0) throw new ConflictError(key);
      return expectedVersion + 1;
    },

    async nextId(name) {
      return db.prepare(`INSERT INTO counters (name, value) VALUES (?, 1)
        ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).get(name).value;
    },

    async createOrder(order) {
      db.prepare(`INSERT INTO order_docs (id, token, created_at, updated_at, active, data) VALUES (?, ?, ?, ?, ?, ?)`).run(...orderRow(order));
    },

    async putOrder(order) {
      writeOrder.run(...orderRow(order));
    },

    async getOrder(id) {
      const row = db.prepare('SELECT data FROM order_docs WHERE id = ?').get(Number(id) || 0);
      return row ? JSON.parse(row.data) : null;
    },

    async getOrderByToken(token) {
      const row = db.prepare('SELECT data FROM order_docs WHERE token = ?').get(String(token || ''));
      return row ? JSON.parse(row.data) : null;
    },

    async queryOrders({ index = 'created', from, to, desc = true, limit = 5000 } = {}) {
      const col = index === 'updated' ? 'updated_at' : 'created_at';
      const where = [];
      const params = [];
      if (index === 'active') where.push('active = 1');
      if (from) { where.push(index === 'updated' ? `${col} > ?` : `${col} >= ?`); params.push(from); }
      if (to) { where.push(`${col} <= ?`); params.push(to); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT data FROM order_docs ${w} ORDER BY ${col} ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'} LIMIT ?`)
        .all(...params, limit).map((r) => JSON.parse(r.data));
    },

    async saveUpload(buffer, ext) {
      const name = crypto.randomBytes(12).toString('hex') + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
      return `/uploads/${name}`;
    },
  };

  migrateLegacy(db);
  return store;
}

/**
 * Convierte la base de la versión anterior (tablas relacionales) al nuevo formato de documentos.
 * Se ejecuta una sola vez: sólo si existen las tablas viejas y aún no hay documento 'catalog'.
 */
function migrateLegacy(db) {
  const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('products') || db.prepare("SELECT 1 FROM kv WHERE key = 'catalog'").get()) return;

  const all = (sql) => db.prepare(sql).all();
  const col = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  const maxId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0);

  const categories = all('SELECT * FROM categories').map((c) => ({ id: c.id, name: c.name, sort: c.sort, active: !!c.active }));
  const links = all('SELECT * FROM product_topping_groups ORDER BY sort');
  const hasIncluded = col('products', 'included_count');
  const products = all('SELECT * FROM products').map((p) => ({
    id: p.id, category_id: p.category_id, name: p.name, description: p.description, price: p.price,
    image: p.image, active: !!p.active, featured: !!p.featured, allow_notes: !!p.allow_notes, sort: p.sort,
    included_count: hasIncluded ? p.included_count : 0, included_value: hasIncluded ? p.included_value : 0,
    group_ids: links.filter((l) => l.product_id === p.id).map((l) => l.group_id),
  }));
  const hasDesc = col('toppings', 'description');
  const toppings = all('SELECT * FROM toppings');
  const groups = all('SELECT * FROM topping_groups').map((g) => ({
    id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select, sort: g.sort,
    toppings: toppings.filter((t) => t.group_id === g.id).map((t) => ({
      id: t.id, name: t.name, price: t.price, description: hasDesc ? t.description : '', active: !!t.active, sort: t.sort,
    })),
  }));
  const zones = has('delivery_zones') ? all('SELECT * FROM delivery_zones').map((z) => ({ id: z.id, name: z.name, fee: z.fee, active: !!z.active, sort: z.sort })) : [];
  const catalog = {
    categories, products, groups, zones,
    seq: { category: maxId(categories), product: maxId(products), group: maxId(groups), topping: maxId(toppings), zone: maxId(zones) },
  };

  const settings = has('settings') ? Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value ?? ''])) : {};

  const orders = has('orders') ? all('SELECT * FROM orders') : [];
  const items = has('order_items') ? all('SELECT * FROM order_items ORDER BY id') : [];

  db.exec('BEGIN');
  try {
    db.prepare("INSERT OR REPLACE INTO kv (key, data, version) VALUES ('catalog', ?, 1)").run(JSON.stringify(catalog));
    if (Object.keys(settings).length) db.prepare("INSERT OR REPLACE INTO kv (key, data, version) VALUES ('settings', ?, 1)").run(JSON.stringify(settings));
    const ins = db.prepare('INSERT OR REPLACE INTO order_docs (id, token, created_at, updated_at, active, data) VALUES (?, ?, ?, ?, ?, ?)');
    for (const o of orders) {
      const doc = {
        id: o.id, token: o.token, created_at: o.created_at, updated_at: o.updated_at, status: o.status,
        customer: { name: o.customer_name, phone: o.customer_phone }, fulfillment: o.fulfillment,
        address: o.address, address_ref: o.address_ref,
        zone: o.zone_id ? { id: o.zone_id, name: o.zone_name } : null,
        payment_method: o.payment_method, cash_amount: o.cash_amount, paid: !!o.paid, notes: o.notes,
        subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total,
        items: items.filter((i) => i.order_id === o.id).map((i) => ({
          product_id: i.product_id, name: i.name, quantity: i.quantity, unit_price: i.unit_price,
          toppings: JSON.parse(i.toppings || '[]'), note: i.note, line_total: i.line_total,
        })),
      };
      ins.run(doc.id, doc.token, doc.created_at, doc.updated_at, ACTIVE_STATUSES.includes(doc.status) ? 1 : 0, JSON.stringify(doc));
    }
    if (orders.length) {
      db.prepare("INSERT OR REPLACE INTO counters (name, value) VALUES ('orders', ?)").run(maxId(orders));
    }
    db.exec('COMMIT');
    console.log(`Base de datos migrada al nuevo formato (${products.length} productos, ${orders.length} pedidos).`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
