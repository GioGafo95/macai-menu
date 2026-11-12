import { store, mutateDoc, bySort } from './data.js';
import { HttpError, round2, nowIso } from './util.js';

/**
 * Inventario de ingredientes (documento 'inventory'):
 *
 *   items:     [{ id, name, unit, stock, min_stock, par, cost, supplier, active }]
 *              min_stock = "avísame cuando baje de aquí" · par = cantidad ideal al rellenar · cost = precio por unidad
 *   recipes:   { 'p12': [{ item_id, qty }], 't34': [...] }  → cuánto usa 1 producto (p) o 1 opción/topping (t)
 *   usage:     { 'YYYY-MM-DD': { item_id: cantidad vendida } }  (últimos 35 días, para calcular para cuántos días alcanza)
 *   movements: últimos movimientos (compra, venta, merma, conteo, devolución) para el historial
 *
 * Cada pedido descuenta sus ingredientes al crearse y los regresa si se cancela.
 */
export const UNITS = ['g', 'kg', 'ml', 'L', 'pz', 'porción'];
export const UNIT_LABELS = {
  g: 'Gramos (g)', kg: 'Kilos (kg)', ml: 'Mililitros (ml) · líquidos', L: 'Litros (L) · líquidos', pz: 'Piezas (pz)', porción: 'Porciones',
};
// Unidades convertibles entre sí: peso (g ↔ kg) y volumen (ml ↔ L)
const FACTOR = { g: 1, kg: 1000, ml: 1, L: 1000 };
const FAMILY = { g: 'peso', kg: 'peso', ml: 'volumen', L: 'volumen', pz: 'pz', porción: 'porción' };
export const compatibleUnits = (unit) => UNITS.filter((u) => FAMILY[u] === FAMILY[unit]);
/** Convierte una cantidad entre unidades de la misma familia (ej. 250 ml → 0.25 L). */
export function convert(qty, from, to) {
  if (from === to || !FACTOR[from] || !FACTOR[to]) return qty;
  if (FAMILY[from] !== FAMILY[to]) throw new HttpError(400, `No se puede convertir ${from} a ${to}`);
  return (qty * FACTOR[from]) / FACTOR[to];
}
export const MOVEMENT_TYPES = { compra: 'Compra', venta: 'Venta', merma: 'Merma', conteo: 'Conteo', devolucion: 'Devolución', ajuste: 'Ajuste' };
const KEEP_MOVEMENTS = 300;
const KEEP_USAGE_DAYS = 35;

const emptyInventory = () => ({ items: [], recipes: {}, usage: {}, movements: [], seq: { item: 0, movement: 0 } });

export async function getInventory() {
  const doc = await store.getDoc('inventory');
  return { ...emptyInventory(), ...(doc?.data || {}) };
}

export function mutateInventory(fn) {
  return mutateDoc('inventory', emptyInventory, (inv) => {
    for (const [k, v] of Object.entries(emptyInventory())) inv[k] ??= v;
    return fn(inv);
  });
}

const n2 = (n) => Math.round(n * 10000) / 10000;
const today = () => nowIso().slice(0, 10);
export const recipeKey = (kind, id) => `${kind === 'product' ? 'p' : 't'}${id}`;

function addMovement(inv, m) {
  inv.seq.movement = (inv.seq.movement || 0) + 1;
  inv.movements.unshift({ id: inv.seq.movement, at: nowIso(), ...m });
  if (inv.movements.length > KEEP_MOVEMENTS) inv.movements.length = KEEP_MOVEMENTS;
}

const isLow = (i) => i.min_stock > 0 && i.stock <= i.min_stock;

/* ----------------------------- Pedidos ----------------------------- */

/** Ingredientes que consume un pedido: Map(item_id → cantidad). */
export function orderNeeds(order, inv) {
  const need = new Map();
  const add = (key, times) => {
    for (const line of inv.recipes[key] || []) need.set(line.item_id, (need.get(line.item_id) || 0) + line.qty * times);
  };
  for (const it of order.items || []) {
    add(`p${it.product_id}`, it.quantity);
    for (const t of it.toppings || []) add(`t${t.id}`, it.quantity);
  }
  return need;
}

/**
 * Descuenta (sign = -1, venta) o regresa (sign = +1, cancelación) los ingredientes de un pedido.
 * Devuelve los ingredientes que acaban de bajar del mínimo (para avisar al celular).
 */
export async function applyOrderStock(order, sign) {
  return mutateInventory((inv) => {
    const need = orderNeeds(order, inv);
    const crossed = [];
    const day = (order.created_at || nowIso()).slice(0, 10);
    for (const [itemId, qty] of need) {
      const item = inv.items.find((i) => i.id === itemId);
      if (!item || !qty) continue;
      const wasLow = isLow(item) || item.stock <= 0;
      item.stock = n2(item.stock + sign * qty);
      inv.usage[day] ||= {};
      inv.usage[day][itemId] = n2(Math.max(0, (inv.usage[day][itemId] || 0) - sign * qty));
      addMovement(inv, {
        item_id: itemId, type: sign < 0 ? 'venta' : 'devolucion', qty: n2(sign * qty),
        stock_after: item.stock, order_id: order.id,
      });
      if (sign < 0 && !wasLow && (isLow(item) || item.stock <= 0)) crossed.push({ ...item });
    }
    // Conserva solo los últimos días de consumo
    const keys = Object.keys(inv.usage).sort();
    while (keys.length > KEEP_USAGE_DAYS) delete inv.usage[keys.shift()];
    return crossed;
  });
}

/* ----------------------- Agotado automático ----------------------- */

/**
 * Productos y opciones que no se pueden preparar porque les falta un ingrediente.
 * Solo aplica si está activado "Ocultar del menú lo que se agote".
 */
export function outOfStock(inv) {
  const out = { products: new Set(), toppings: new Set() };
  const stock = new Map(inv.items.filter((i) => i.active !== false).map((i) => [i.id, i.stock]));
  for (const [key, lines] of Object.entries(inv.recipes)) {
    if (lines.some((l) => stock.has(l.item_id) && stock.get(l.item_id) < l.qty)) {
      (key[0] === 'p' ? out.products : out.toppings).add(Number(key.slice(1)));
    }
  }
  return out;
}

/** Copia del catálogo con lo agotado marcado como no disponible. */
export async function catalogWithStock(cat, s) {
  if (s.inventory_auto_disable !== '1') return cat;
  const out = outOfStock(await getInventory());
  if (!out.products.size && !out.toppings.size) return cat;
  const copy = structuredClone(cat);
  for (const p of copy.products) if (out.products.has(p.id)) p.active = false;
  for (const g of copy.groups) for (const t of g.toppings) if (out.toppings.has(t.id)) t.active = false;
  return copy;
}

/* ----------------------------- Panel ----------------------------- */

/** Vista para el dashboard: estado, consumo diario, para cuántos días alcanza y cuánto comprar. */
export function inventoryView(inv, cat) {
  const days = Object.keys(inv.usage).sort().slice(-7);
  const span = Math.max(1, days.length);
  const usedIn = new Map();
  const names = new Map();
  for (const p of cat.products) names.set(`p${p.id}`, p.name);
  for (const g of cat.groups) for (const t of g.toppings) names.set(`t${t.id}`, `${t.name} (${g.name})`);
  for (const [key, lines] of Object.entries(inv.recipes)) {
    for (const l of lines) {
      if (!names.has(key)) continue;
      if (!usedIn.has(l.item_id)) usedIn.set(l.item_id, []);
      usedIn.get(l.item_id).push(names.get(key));
    }
  }

  const items = [...inv.items].sort(bySort).map((i) => {
    const used7 = days.reduce((a, d) => a + (inv.usage[d]?.[i.id] || 0), 0);
    const avg_daily = n2(used7 / span);
    const status = i.stock <= 0 ? 'agotado' : isLow(i) ? 'bajo' : 'ok';
    return {
      ...i,
      status,
      avg_daily,
      days_left: avg_daily > 0 ? Math.max(0, Math.floor(i.stock / avg_daily)) : null,
      to_buy: i.par > i.stock ? n2(i.par - Math.max(0, i.stock)) : 0,
      value: round2(Math.max(0, i.stock) * (i.cost || 0)),
      used_in: usedIn.get(i.id) || [],
    };
  });
  return {
    items,
    recipes: inv.recipes,
    movements: inv.movements.slice(0, 80),
    summary: {
      total: items.length,
      low: items.filter((i) => i.status === 'bajo').length,
      out: items.filter((i) => i.status === 'agotado').length,
      value: round2(items.reduce((a, i) => a + i.value, 0)),
      days_of_data: days.length,
    },
    units: UNITS,
    unit_labels: UNIT_LABELS,
    unit_families: Object.fromEntries(UNITS.map((u) => [u, compatibleUnits(u)])),
  };
}

export function cleanItem(b, current = {}) {
  const num = (v, def = 0) => {
    if (v === undefined || v === '' || v === null) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Las cantidades deben ser números positivos');
    return n2(n);
  };
  const name = String(b.name ?? current.name ?? '').trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Escribe el nombre del ingrediente');
  const unit = UNITS.includes(b.unit) ? b.unit : current.unit || 'g';
  return {
    name, unit,
    min_stock: num(b.min_stock, current.min_stock ?? 0),
    par: num(b.par, current.par ?? 0),
    cost: b.cost === undefined || b.cost === '' ? current.cost ?? 0 : Math.round(Math.max(0, Number(b.cost) || 0) * 10000) / 10000,
    supplier: String(b.supplier ?? current.supplier ?? '').trim().slice(0, 80),
    active: b.active === undefined ? current.active ?? true : !!b.active,
    sort: b.sort === undefined ? current.sort ?? 0 : Math.floor(Number(b.sort) || 0),
  };
}

/**
 * Crea ingredientes a partir de los toppings, spreads y frutas del menú (uno por opción, en gramos)
 * y les pone receta de 1 porción. Las cantidades son un punto de partida para ajustar.
 */
export function seedFromCatalog(inv, cat) {
  const portion = (groupName) => (/fruta/i.test(groupName) ? 40 : /spread|crema/i.test(groupName) ? 25 : 20);
  let created = 0;
  for (const g of [...cat.groups].sort(bySort)) {
    if (g.min_select > 0) continue; // las bases / sabores obligatorios se capturan a mano (cambian por tamaño)
    for (const t of [...g.toppings].sort(bySort)) {
      let item = inv.items.find((i) => i.name.toLowerCase() === t.name.toLowerCase());
      if (!item) {
        inv.seq.item = (inv.seq.item || 0) + 1;
        item = { id: inv.seq.item, name: t.name, unit: 'g', stock: 0, min_stock: 500, par: 2000, cost: 0, supplier: '', active: true, sort: inv.items.length + 1 };
        inv.items.push(item);
        created++;
      }
      const key = `t${t.id}`;
      if (!inv.recipes[key]?.length) inv.recipes[key] = [{ item_id: item.id, qty: portion(g.name) }];
    }
  }
  return created;
}
