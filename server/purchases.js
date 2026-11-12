import { store, mutateDoc } from './data.js';
import { HttpError, round2 } from './util.js';
import { convert, compatibleUnits } from './inventory.js';

/**
 * Historial de compras (para ver cómo cambian los precios).
 * Un documento por mes ('purchases-2026-11') para que ninguno crezca demasiado:
 *   { list: [{ id, date, item_id, item_name, qty, unit, qty_item, item_unit, total_cost,
 *              price_base, base_unit, supplier, note, at }], seq }
 * price_base = precio normalizado: por kilo (peso), por litro (líquidos) o por pieza/porción.
 */

const TZ = 'America/Mazatlan'; // Los Mochis
export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

const BASE = { g: 'kg', kg: 'kg', ml: 'L', L: 'L', pz: 'pz', porción: 'porción' };
export const baseUnit = (unit) => BASE[unit] || unit;

const monthKey = (date) => `purchases-${date.slice(0, 7)}`;
const empty = () => ({ list: [], seq: 0 });

/** Lista de meses 'YYYY-MM' desde hace n-1 meses hasta el actual. */
export function lastMonths(n, from = todayLocal()) {
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export function cleanDate(v) {
  const today = todayLocal();
  if (v === undefined || v === null || v === '') return today;
  const d = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, 'Fecha inválida');
  if (d > today) throw new HttpError(400, 'La fecha de compra no puede ser futura');
  if (d < lastMonths(36)[0]) throw new HttpError(400, 'La fecha es demasiado antigua');
  return d;
}

/** Arma el registro de una compra. qty viene en `unit` (compatible con la del ingrediente). */
export function buildPurchase(item, { date, qty, unit, total_cost, supplier, note }) {
  const u = compatibleUnits(item.unit).includes(unit) ? unit : item.unit;
  const qtyItem = convert(qty, u, item.unit);
  const b = baseUnit(item.unit);
  const qtyBase = convert(qtyItem, item.unit, b === 'kg' ? 'kg' : b === 'L' ? 'L' : item.unit);
  return {
    date, item_id: item.id, item_name: item.name, qty, unit: u,
    qty_item: Math.round(qtyItem * 10000) / 10000, item_unit: item.unit,
    total_cost: total_cost === null ? null : round2(total_cost),
    price_base: total_cost === null || !qtyBase ? null : Math.round((total_cost / qtyBase) * 100) / 100,
    base_unit: b,
    supplier: supplier || '', note: note || '',
  };
}

export async function savePurchase(p) {
  return mutateDoc(monthKey(p.date), empty, (doc) => {
    doc.seq = (doc.seq || 0) + 1;
    const rec = { id: `${p.date.slice(0, 7)}-${doc.seq}`, ...p, at: new Date().toISOString() };
    doc.list.push(rec);
    return rec;
  });
}

export async function listPurchases(months) {
  const docs = await Promise.all(lastMonths(months).map((m) => store.getDoc(`purchases-${m}`)));
  return docs.flatMap((d) => d?.data?.list || [])
    .sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
}

export async function deletePurchase(id) {
  const m = String(id).match(/^(\d{4}-\d{2})-\d+$/);
  if (!m) throw new HttpError(404, 'Compra no encontrada');
  return mutateDoc(`purchases-${m[1]}`, empty, (doc) => {
    const i = doc.list.findIndex((p) => p.id === id);
    if (i < 0) throw new HttpError(404, 'Compra no encontrada');
    return doc.list.splice(i, 1)[0];
  });
}
