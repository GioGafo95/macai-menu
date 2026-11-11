import crypto from 'node:crypto';
import { store, bySort } from './data.js';
import { ACTIVE_STATUSES } from './store/common.js';
import { HttpError, round2, str, nowIso, money } from './util.js';

export { ACTIVE_STATUSES };
export const STATUSES = ['nuevo', 'preparando', 'listo', 'en_camino', 'entregado', 'cancelado'];
export const STATUS_LABELS = {
  nuevo: 'Recibido',
  preparando: 'Preparando',
  listo: 'Listo',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
export const PAYMENT_LABELS = { cash: 'Efectivo', transfer: 'Transferencia' };
export const FULFILLMENT_LABELS = { delivery: 'Envío a domicilio', pickup: 'Recoger en tienda' };

/* ------------------------------------------------------------------ */
/* Crear pedido: valida todo y calcula precios en el servidor          */
/* ------------------------------------------------------------------ */

export function activeZones(cat) {
  return cat.zones.filter((z) => z.active).sort(bySort).map(({ id, name, fee }) => ({ id, name, fee }));
}

export function deliveryFeeFor(subtotal, zone, s) {
  const freeOver = Number(s.free_delivery_over) || 0;
  if (freeOver > 0 && subtotal >= freeOver) return 0;
  return round2(zone ? zone.fee : Number(s.delivery_flat_fee) || 0);
}

/**
 * "Incluye N opciones de hasta $X": descuenta hasta X a las N opciones con costo más caras.
 * Modifica cada topping: price = lo que se cobra, list_price = precio normal, included = true si entró en el paquete.
 * La misma regla está en public/app.js (solo para mostrar el precio; el servidor manda).
 */
export function applyIncluded(toppings, count, value) {
  for (const t of toppings) { t.list_price = t.price; t.included = false; }
  if (!(count > 0 && value > 0)) return toppings;
  const order = toppings.map((t, i) => i).filter((i) => toppings[i].list_price > 0)
    .sort((a, b) => toppings[b].list_price - toppings[a].list_price || a - b);
  for (const i of order.slice(0, count)) {
    const t = toppings[i];
    t.price = round2(Math.max(0, t.list_price - value));
    t.included = true;
  }
  return toppings;
}

/** Producto disponible: activo y con su categoría visible (o sin categoría). */
export function isAvailable(p, cat) {
  if (!p?.active) return false;
  const c = cat.categories.find((x) => x.id === p.category_id);
  return !c || c.active;
}

export function buildOrder(input, s, cat) {
  if (s.store_open !== '1') throw new HttpError(409, s.closed_message || 'Por ahora no estamos recibiendo pedidos.');
  input = input || {};

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) throw new HttpError(400, 'Tu carrito está vacío');
  if (rawItems.length > 50) throw new HttpError(400, 'Demasiados productos en un solo pedido');

  const items = [];
  let subtotal = 0;
  for (const it of rawItems) {
    const p = cat.products.find((x) => x.id === Number(it?.product_id));
    if (!isAvailable(p, cat)) throw new HttpError(400, 'Uno de los productos ya no está disponible. Revisa tu carrito.');
    const quantity = Math.floor(Number(it.quantity));
    if (!(quantity >= 1 && quantity <= 50)) throw new HttpError(400, `Cantidad inválida para "${p.name}"`);

    const selected = new Set((Array.isArray(it.toppings) ? it.toppings : []).map(Number));
    const toppings = [];
    for (const gid of p.group_ids || []) {
      const g = cat.groups.find((x) => x.id === gid);
      if (!g) continue;
      const picked = g.toppings.filter((o) => o.active).sort(bySort).filter((o) => selected.has(o.id));
      picked.forEach((o) => selected.delete(o.id));
      if (picked.length < g.min_select) {
        throw new HttpError(400, `"${p.name}": elige al menos ${g.min_select} en "${g.name}"`);
      }
      if (g.max_select > 0 && picked.length > g.max_select) {
        throw new HttpError(400, `"${p.name}": máximo ${g.max_select} en "${g.name}"`);
      }
      for (const o of picked) toppings.push({ id: o.id, name: o.name, price: o.price, group: g.name });
    }
    if (selected.size) throw new HttpError(400, `Algunas opciones de "${p.name}" ya no están disponibles. Revisa tu carrito.`);

    applyIncluded(toppings, p.included_count, p.included_value);
    const unit_price = round2(p.price + toppings.reduce((a, t) => a + t.price, 0));
    const line_total = round2(unit_price * quantity);
    subtotal += line_total;
    items.push({
      product_id: p.id,
      name: p.name,
      unit_price,
      quantity,
      toppings,
      note: p.allow_notes ? str(it.note, 200) : '',
      line_total,
    });
  }
  subtotal = round2(subtotal);

  const minOrder = Number(s.min_order) || 0;
  if (minOrder > 0 && subtotal < minOrder) {
    throw new HttpError(400, `El pedido mínimo es de ${money(minOrder, s)}`);
  }

  const customer_name = str(input.customer_name, 80);
  if (customer_name.length < 2) throw new HttpError(400, 'Escribe tu nombre');
  const customer_phone = str(input.customer_phone, 30).replace(/[^\d+]/g, '');
  if (customer_phone.replace(/\D/g, '').length < 8) throw new HttpError(400, 'Escribe un teléfono válido (al menos 8 dígitos)');

  const fulfillment = input.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  let address = null, address_ref = null, zone = null, delivery_fee = 0;
  if (fulfillment === 'pickup') {
    if (s.pickup_enabled !== '1') throw new HttpError(400, 'La opción de recoger no está disponible');
  } else {
    if (s.delivery_enabled !== '1') throw new HttpError(400, 'El envío a domicilio no está disponible');
    address = str(input.address, 300);
    if (address.length < 5) throw new HttpError(400, 'Escribe tu dirección completa');
    address_ref = str(input.address_ref, 200) || null;
    const zones = activeZones(cat);
    if (zones.length) {
      zone = zones.find((z) => z.id === Number(input.zone_id));
      if (!zone) throw new HttpError(400, 'Elige tu zona de entrega');
    }
    delivery_fee = deliveryFeeFor(subtotal, zone, s);
  }

  const total = round2(subtotal + delivery_fee);

  const payment_method = input.payment_method === 'transfer' ? 'transfer' : input.payment_method === 'cash' ? 'cash' : null;
  if (!payment_method) throw new HttpError(400, 'Elige un método de pago');
  if (payment_method === 'cash' && s.cash_enabled !== '1') throw new HttpError(400, 'El pago en efectivo no está disponible');
  if (payment_method === 'transfer' && s.transfer_enabled !== '1') throw new HttpError(400, 'El pago por transferencia no está disponible');

  let cash_amount = null;
  if (payment_method === 'cash' && input.cash_amount !== undefined && input.cash_amount !== null && input.cash_amount !== '') {
    cash_amount = Number(input.cash_amount);
    if (!Number.isFinite(cash_amount) || cash_amount < total) {
      throw new HttpError(400, `El monto con el que pagas debe ser de al menos ${money(total, s)}`);
    }
    cash_amount = round2(cash_amount);
  }

  return {
    customer: { name: customer_name, phone: customer_phone },
    fulfillment, address, address_ref,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    delivery_fee, subtotal, total, payment_method, cash_amount,
    notes: str(input.notes, 500) || null,
    items,
  };
}

export async function createOrder(o) {
  const now = nowIso();
  const order = {
    id: await store.nextId('orders'),
    token: crypto.randomBytes(9).toString('base64url'),
    created_at: now,
    updated_at: now,
    status: 'nuevo',
    paid: false,
    ...o,
  };
  await store.createOrder(order);
  return present(order);
}

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

/** Agrega campos calculados (etiqueta de estado, cambio) para mostrar y para la API. */
export function present(o) {
  if (!o) return null;
  return {
    id: o.id,
    token: o.token,
    created_at: o.created_at,
    updated_at: o.updated_at,
    status: o.status,
    status_label: STATUS_LABELS[o.status] || o.status,
    customer: o.customer,
    fulfillment: o.fulfillment,
    address: o.address ?? null,
    address_ref: o.address_ref ?? null,
    zone: o.zone ?? null,
    payment_method: o.payment_method,
    cash_amount: o.cash_amount ?? null,
    change_due: o.cash_amount ? round2(o.cash_amount - o.total) : null,
    paid: !!o.paid,
    notes: o.notes ?? null,
    subtotal: o.subtotal,
    delivery_fee: o.delivery_fee,
    total: o.total,
    items: o.items,
  };
}

export async function getOrder(id) {
  return present(await store.getOrder(id));
}

export async function getOrderByToken(token) {
  return present(await store.getOrderByToken(token));
}

/**
 * Filtros: from, to, updated_since (ISO), statuses[], paid (bool), fulfillment,
 * payment_method, limit, offset, sort ('asc'|'desc').
 */
export async function listOrders(f = {}) {
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const desc = f.sort !== 'asc';

  let rows;
  const onlyActive = f.statuses?.length && f.statuses.every((x) => ACTIVE_STATUSES.includes(x));
  if (f.updated_since) {
    rows = await store.queryOrders({ index: 'updated', from: f.updated_since, desc });
    if (f.from) rows = rows.filter((o) => o.created_at >= f.from);
    if (f.to) rows = rows.filter((o) => o.created_at <= f.to);
  } else if (onlyActive && !f.from && !f.to) {
    rows = await store.queryOrders({ index: 'active', desc });
  } else {
    // Volumen bajo: se leen todos los del rango (máx. 20 000) y se filtra en memoria
    rows = await store.queryOrders({ index: 'created', from: f.from, to: f.to, desc, limit: 20000 });
  }
  if (f.statuses?.length) rows = rows.filter((o) => f.statuses.includes(o.status));
  if (f.paid !== undefined) rows = rows.filter((o) => !!o.paid === !!f.paid);
  if (f.fulfillment) rows = rows.filter((o) => o.fulfillment === f.fulfillment);
  if (f.payment_method) rows = rows.filter((o) => o.payment_method === f.payment_method);

  return {
    data: rows.slice(offset, offset + limit).map(present),
    pagination: { total: rows.length, limit, offset },
  };
}

export async function updateOrder(id, { status, paid }) {
  const order = await store.getOrder(id);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  if (status === undefined && paid === undefined) throw new HttpError(400, 'Nada que actualizar (usa "status" y/o "paid")');
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new HttpError(400, `Estado inválido. Usa: ${STATUSES.join(', ')}`);
    order.status = status;
  }
  if (paid !== undefined) order.paid = !!paid;
  order.updated_at = nowIso();
  await store.putOrder(order);
  return present(order);
}

/** Vista pública (cliente final): sin datos internos. */
export function publicOrder(o, s) {
  return {
    id: o.id,
    created_at: o.created_at,
    status: o.status,
    status_label: o.status_label,
    fulfillment: o.fulfillment,
    customer_name: o.customer.name,
    address: o.address,
    zone: o.zone?.name || null,
    payment_method: o.payment_method,
    cash_amount: o.cash_amount,
    change_due: o.change_due,
    paid: o.paid,
    notes: o.notes,
    items: o.items.map(({ product_id, ...rest }) => rest),
    subtotal: o.subtotal,
    delivery_fee: o.delivery_fee,
    total: o.total,
    bank_info: o.payment_method === 'transfer' ? s.bank_info : null,
    pickup_address: o.fulfillment === 'pickup' ? s.pickup_address : null,
  };
}

/* ------------------------------------------------------------------ */
/* Resumen de ventas                                                   */
/* ------------------------------------------------------------------ */

export async function salesSummary({ from, to } = {}) {
  const all = await store.queryOrders({ index: 'created', from, to, limit: 20000 });
  const valid = all.filter((o) => o.status !== 'cancelado');
  const r = (n) => round2(n || 0);
  const sum = (arr, k) => arr.reduce((a, o) => a + (Number(o[k]) || 0), 0);
  const groupBy = (key) => {
    const out = {};
    for (const o of valid) {
      out[o[key]] ||= { orders: 0, total: 0 };
      out[o[key]].orders++;
      out[o[key]].total = r(out[o[key]].total + o.total);
    }
    return out;
  };
  const products = new Map();
  for (const o of valid) {
    for (const i of o.items) {
      const k = `${i.product_id}|${i.name}`;
      const cur = products.get(k) || { product_id: i.product_id, name: i.name, quantity: 0, total: 0 };
      cur.quantity += i.quantity;
      cur.total = r(cur.total + i.line_total);
      products.set(k, cur);
    }
  }
  const total = sum(valid, 'total');
  const paidTotal = sum(valid.filter((o) => o.paid), 'total');
  return {
    from: from || null,
    to: to || null,
    orders: valid.length,
    cancelled_orders: all.length - valid.length,
    total: r(total),
    subtotal: r(sum(valid, 'subtotal')),
    delivery_fees: r(sum(valid, 'delivery_fee')),
    paid_total: r(paidTotal),
    unpaid_total: r(total - paidTotal),
    average_ticket: valid.length ? r(total / valid.length) : 0,
    by_payment_method: groupBy('payment_method'),
    by_fulfillment: groupBy('fulfillment'),
    top_products: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/* Texto para notificaciones / WhatsApp                                */
/* ------------------------------------------------------------------ */

export function formatOrderText(o, s, { baseUrl = '', forCustomer = false } = {}) {
  const m = (n) => money(n, s);
  const L = [];
  if (forCustomer) {
    L.push(`Hola ${s.business_name || ''}, acabo de hacer el pedido #${o.id}`);
  } else {
    L.push(`🥣 NUEVO PEDIDO #${o.id}`);
  }
  L.push(`Cliente: ${o.customer.name} · ${o.customer.phone}`);
  if (o.fulfillment === 'delivery') {
    L.push(`Envío a domicilio${o.zone ? ` (${o.zone.name})` : ''}`);
    L.push(`Dirección: ${o.address}`);
    if (o.address_ref) L.push(`Referencias: ${o.address_ref}`);
  } else {
    L.push('Recoge en tienda');
  }
  L.push('');
  for (const it of o.items) {
    L.push(`${it.quantity}x ${it.name} — ${m(it.line_total)}`);
    if (it.toppings.length) L.push(`   + ${it.toppings.map((t) => t.name + (t.price > 0 ? ` (+${m(t.price)})` : '')).join(', ')}`);
    if (it.note) L.push(`   Nota: ${it.note}`);
  }
  L.push('');
  L.push(`Subtotal: ${m(o.subtotal)}`);
  if (o.fulfillment === 'delivery') L.push(`Envío: ${o.delivery_fee ? m(o.delivery_fee) : 'Gratis'}`);
  L.push(`TOTAL: ${m(o.total)}`);
  let pay = `Pago: ${PAYMENT_LABELS[o.payment_method]}`;
  if (o.payment_method === 'cash' && o.cash_amount) pay += ` (paga con ${m(o.cash_amount)}, cambio ${m(o.change_due)})`;
  L.push(pay);
  if (o.notes) L.push(`Notas: ${o.notes}`);
  if (baseUrl) {
    L.push('');
    L.push(forCustomer ? `Seguimiento: ${baseUrl}/pedido.html?t=${o.token}` : `Panel: ${baseUrl}/admin/`);
  }
  return L.join('\n');
}
