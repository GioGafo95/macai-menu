import { Router } from 'express';
import { getCatalog } from '../data.js';
import {
  getInventory, mutateInventory, inventoryView, cleanItem, seedFromCatalog, MOVEMENT_TYPES, convert, compatibleUnits, RECIPE_KEY,
} from '../inventory.js';
import { productCosts, salesProfit } from '../costing.js';
import { listOrders } from '../orders.js';
import { buildPurchase, savePurchase, listPurchases, deletePurchase, cleanDate, todayLocal, lastMonths, baseUnit } from '../purchases.js';
import { notifyLowStock } from '../notify.js';
import { HttpError, str, settle } from '../util.js';

/** /api/admin/inventory (requiere sesión de admin; se monta dentro de routes/admin.js) */
const r = Router();
const idOf = (req) => Number(req.params.id) || 0;
const n3 = (n) => Math.round(n * 1000) / 1000;
const n6 = (n) => Math.round(n * 1e6) / 1e6; // recetas: 5 ml de un ingrediente en L = 0.005

const view = async () => inventoryView(await getInventory(), await getCatalog());

r.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await view());
});

/* ----------------------------- Ingredientes ----------------------------- */

r.post('/items', async (req, res) => {
  const b = req.body || {};
  await mutateInventory((inv) => {
    const data = cleanItem(b);
    if (inv.items.some((i) => i.name.toLowerCase() === data.name.toLowerCase())) throw new HttpError(400, `Ya existe "${data.name}"`);
    inv.seq.item = (inv.seq.item || 0) + 1;
    const stock = Number(b.stock) || 0;
    if (stock < 0) throw new HttpError(400, 'La existencia no puede ser negativa');
    inv.items.push({ id: inv.seq.item, ...data, sort: data.sort || inv.items.length + 1, stock: n3(stock) });
  });
  res.status(201).json(await view());
});

r.put('/items/:id', async (req, res) => {
  await mutateInventory((inv) => {
    const item = inv.items.find((i) => i.id === idOf(req));
    if (!item) throw new HttpError(404, 'Ingrediente no encontrado');
    const data = cleanItem(req.body || {}, item);
    if (inv.items.some((i) => i.id !== item.id && i.name.toLowerCase() === data.name.toLowerCase())) throw new HttpError(400, `Ya existe "${data.name}"`);
    // Cambio de unidad dentro de la misma familia (g ↔ kg, ml ↔ L): se convierten existencia y recetas
    if (data.unit !== item.unit && compatibleUnits(item.unit).includes(data.unit)) {
      const c = (q) => n3(convert(q, item.unit, data.unit));
      item.stock = c(item.stock);
      // Si el formulario manda los mismos números que ya había, se interpretan en la unidad anterior
      const same = (k) => req.body[k] === undefined || req.body[k] === '' || Number(req.body[k]) === item[k];
      if (same('min_stock')) data.min_stock = c(item.min_stock);
      if (same('par')) data.par = c(item.par);
      if (same('cost')) data.cost = Math.round(item.cost * convert(1, data.unit, item.unit) * 10000) / 10000;
      for (const lines of Object.values(inv.recipes)) for (const l of lines) if (l.item_id === item.id) l.qty = n6(convert(l.qty, item.unit, data.unit));
    }
    Object.assign(item, data);
  });
  res.json(await view());
});

r.delete('/items/:id', async (req, res) => {
  await mutateInventory((inv) => {
    if (!inv.items.some((i) => i.id === idOf(req))) throw new HttpError(404, 'Ingrediente no encontrado');
    inv.items = inv.items.filter((i) => i.id !== idOf(req));
    for (const [k, lines] of Object.entries(inv.recipes)) {
      inv.recipes[k] = lines.filter((l) => l.item_id !== idOf(req));
      if (!inv.recipes[k].length) delete inv.recipes[k];
    }
  });
  res.json(await view());
});

/**
 * Movimiento manual:
 *  - compra:  suma lo que llegó (opcional: costo total o por unidad → actualiza el costo)
 *  - merma:   resta lo que se tiró / echó a perder
 *  - conteo:  "hay X" → deja la existencia en X (registra la diferencia)
 */
r.post('/items/:id/movements', async (req, res) => {
  const b = req.body || {};
  const type = String(b.type);
  if (!['compra', 'merma', 'conteo'].includes(type)) throw new HttpError(400, 'Tipo de movimiento inválido');
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty < 0 || (type !== 'conteo' && qty === 0)) throw new HttpError(400, 'Escribe una cantidad válida');
  const totalCost = b.total_cost === undefined || b.total_cost === '' ? null : Number(b.total_cost);
  if (totalCost !== null && (!Number.isFinite(totalCost) || totalCost < 0)) throw new HttpError(400, 'Costo inválido');

  // Compra: fecha (puede ser anterior), unidad en que se compró, proveedor y si se suma a la existencia
  const date = type === 'compra' ? cleanDate(b.date) : null;
  const addStock = type !== 'compra' || b.add_stock === undefined || b.add_stock === true || b.add_stock === '1' || b.add_stock === 'true';
  let purchase = null;

  const crossed = await mutateInventory((inv) => {
    const item = inv.items.find((i) => i.id === idOf(req));
    if (!item) throw new HttpError(404, 'Ingrediente no encontrado');
    const before = item.stock;
    const wasLow = item.stock <= 0 || (item.min_stock > 0 && item.stock <= item.min_stock);
    let delta;
    if (type === 'compra') {
      purchase = buildPurchase(item, { date, qty, unit: b.unit, total_cost: totalCost, supplier: str(b.supplier, 80) || item.supplier, note: str(b.note, 140) });
      delta = addStock ? purchase.qty_item : 0;
      // El costo del ingrediente es el de la compra más reciente (una compra con fecha anterior no lo cambia)
      if (totalCost !== null && purchase.qty_item > 0 && date >= (item.last_purchase_date || '')) {
        item.cost = Math.round((totalCost / purchase.qty_item) * 10000) / 10000;
        item.last_purchase_date = date;
      }
      if (!addStock) return [];
    } else if (type === 'merma') delta = -qty;
    else delta = qty - before;
    item.stock = n3(before + delta);
    inv.seq.movement = (inv.seq.movement || 0) + 1;
    inv.movements.unshift({
      id: inv.seq.movement, at: new Date().toISOString(), item_id: item.id, type, qty: n3(delta),
      stock_after: item.stock, note: str(b.note, 140) || null, ...(totalCost !== null ? { total_cost: totalCost } : {}),
    });
    if (inv.movements.length > 300) inv.movements.length = 300;
    const nowLow = item.stock <= 0 || (item.min_stock > 0 && item.stock <= item.min_stock);
    return !wasLow && nowLow ? [{ ...item }] : [];
  });
  if (purchase) await savePurchase(purchase);
  if (crossed.length) await settle(notifyLowStock(crossed), 'inventario');
  res.json(await view());
});

/* -------------------------------- Compras -------------------------------- */

/** Historial de compras de los últimos meses (13 por defecto: un año + el mes anterior para comparar). */
r.get('/purchases', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const months = Math.min(Math.max(Number(req.query.months) || 13, 1), 36);
  const inv = await getInventory();
  res.json({
    today: todayLocal(),
    months: lastMonths(months),
    purchases: await listPurchases(months),
    items: inv.items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, base_unit: baseUnit(i.unit), units: compatibleUnits(i.unit), supplier: i.supplier })),
  });
});

/** Borra una compra del historial (no cambia la existencia). */
r.delete('/purchases/:id', async (req, res) => {
  await deletePurchase(String(req.params.id));
  res.json({ ok: true });
});

/* -------------------------------- Recetas -------------------------------- */

// key: p<id de producto>, t<id de opción/topping> o p<producto>t<opción> (la opción solo en ese producto)
r.put('/recipes/:key', async (req, res) => {
  const key = String(req.params.key);
  if (!RECIPE_KEY.test(key)) throw new HttpError(400, 'Receta inválida');
  const cat = await getCatalog();
  const [, pid, tid] = key.match(/^(?:p(\d+))?(?:t(\d+))?$/).map(Number);
  const product = pid ? cat.products.find((p) => p.id === pid) : null;
  if (pid && !product) throw new HttpError(404, 'Producto no encontrado');
  if (tid) {
    const groups = cat.groups.filter((g) => !product || (product.group_ids || []).includes(g.id));
    if (!groups.some((g) => g.toppings.some((t) => t.id === tid))) throw new HttpError(404, 'Opción no encontrada');
  }
  const raw = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (raw.length > 30) throw new HttpError(400, 'Demasiados ingredientes');

  await mutateInventory((inv) => {
    const lines = [];
    for (const l of raw) {
      const item_id = Number(l.item_id);
      const raw = Number(l.qty);
      if (!item_id && !raw) continue;
      const item = inv.items.find((i) => i.id === item_id);
      if (!item) throw new HttpError(400, 'Elige un ingrediente de la lista');
      if (!Number.isFinite(raw) || raw <= 0) throw new HttpError(400, 'Cada ingrediente necesita una cantidad mayor a 0');
      // La receta se puede capturar en otra unidad compatible (ej. 250 ml de un ingrediente que se compra en L)
      const unit = compatibleUnits(item.unit).includes(l.unit) ? l.unit : item.unit;
      const qty = convert(raw, unit, item.unit); // siempre se guarda en la unidad del ingrediente
      const same = lines.find((x) => x.item_id === item_id);
      if (same) same.qty = n6(same.qty + qty);
      else lines.push({ item_id, qty: n6(qty), unit });
    }
    if (lines.length) inv.recipes[key] = lines;
    else delete inv.recipes[key];
  });
  res.json(await view());
});

/** Costo de producción y ganancia por producto, y ganancia real de los últimos días. */
r.get('/costs', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const [inv, cat, orders] = await Promise.all([getInventory(), getCatalog(), listOrders({ from, limit: 500 })]);
  // listOrders pagina a 500; para la ganancia se necesitan todos los del rango
  let all = orders.data;
  for (let offset = 500; offset < orders.pagination.total; offset += 500) {
    all = all.concat((await listOrders({ from, limit: 500, offset })).data);
  }
  res.json({ ...productCosts(inv, cat), sales: { days, ...salesProfit(all, inv) } });
});

/** Crea ingredientes y recetas desde los toppings, spreads y frutas del menú. */
r.post('/seed', async (req, res) => {
  const cat = await getCatalog();
  const created = await mutateInventory((inv) => seedFromCatalog(inv, cat));
  res.json({ created, ...(await view()) });
});

r.get('/movement-types', (req, res) => res.json(MOVEMENT_TYPES));

export default r;
