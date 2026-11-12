import { Router } from 'express';
import { getSettings, getCatalog } from '../data.js';
import { requireStaff, verifyPassword, verifyWaiterPassword, setWaiterCookie, clearWaiterCookie, setSessionCookie } from '../auth.js';
import { buildOrder, createOrder, listOrders, updateOrder, getOrder, byDistance, ACTIVE_STATUSES } from '../orders.js';
import { quoteDelivery, parsePoint } from '../distance.js';
import { notifyNewOrder, notifyOrderUpdated } from '../notify.js';
import { HttpError, rateLimit, settle, str, baseUrlOf } from '../util.js';
import { menuPayload } from './public.js';
import { catalogWithStock } from '../inventory.js';

/**
 * Modo mesero (/mesero/): el personal toma pedidos desde su celular.
 * Entra con la contraseña de meseros (Ajustes → Seguridad) o con la del admin.
 */
const r = Router();

r.post('/login', rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Demasiados intentos. Espera 15 minutos.' }), async (req, res) => {
  const pw = str(req.body?.password, 200);
  if (await verifyWaiterPassword(pw)) {
    await setWaiterCookie(req, res);
    return res.json({ ok: true, role: 'mesero' });
  }
  // Con la contraseña del admin se abre la sesión de admin (sirve también para el panel)
  if (await verifyPassword(pw)) {
    await setSessionCookie(req, res);
    return res.json({ ok: true, role: 'admin' });
  }
  throw new HttpError(401, 'Contraseña incorrecta');
});

r.post('/logout', (req, res) => {
  clearWaiterCookie(res);
  res.json({ ok: true });
});

r.use(requireStaff);
r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

r.get('/me', (req, res) => res.json({ ok: true, role: req.staffRole }));

r.get('/menu', async (req, res) => res.json(await menuPayload()));

r.post('/delivery-quote', async (req, res) => {
  const s = await getSettings();
  if (!byDistance(s)) throw new HttpError(400, 'El envío no se calcula por distancia');
  res.json(await quoteDelivery(req.body, s));
});

r.post('/orders', async (req, res) => {
  const [s, rawCat] = await Promise.all([getSettings(), getCatalog()]);
  const cat = await catalogWithStock(rawCat, s);
  const body = req.body || {};
  let quote = null;
  if (body.fulfillment === 'delivery' && byDistance(s)) {
    const point = parsePoint(body.location);
    if (point) quote = { ...(await quoteDelivery(point, s)), ...point };
  }
  const order = await createOrder(buildOrder(body, s, cat, { quote, staff: { name: body.taken_by } }));
  await settle(notifyNewOrder(order, s.public_url || baseUrlOf(req)), 'notificación');
  res.status(201).json(slim(order));
});

/** Pedidos activos (para que el mesero vea si ya están listos). */
r.get('/orders', async (req, res) => {
  const { data } = await listOrders({ statuses: ACTIVE_STATUSES, sort: 'asc', limit: 200 });
  res.json(data.map(slim));
});

// El mesero solo puede marcar como entregado (cuando lleva el pedido a la mesa o se lo dan al cliente).
r.post('/orders/:id/entregado', async (req, res) => {
  const cur = await getOrder(Number(req.params.id) || 0);
  if (!cur) throw new HttpError(404, 'Pedido no encontrado');
  if (cur.fulfillment === 'delivery') throw new HttpError(400, 'Los pedidos a domicilio se cierran desde el panel');
  const order = await updateOrder(cur.id, { status: 'entregado' });
  await settle(notifyOrderUpdated(order), 'webhook');
  res.json(slim(order));
});

const slim = (o) => ({
  id: o.id, created_at: o.created_at, status: o.status, status_label: o.status_label,
  fulfillment: o.fulfillment, fulfillment_label: o.fulfillment_label, table: o.table,
  customer_name: o.customer.name, taken_by: o.taken_by, source: o.source,
  total: o.total, paid: o.paid, payment_method: o.payment_method,
  items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, toppings: i.toppings.map((t) => t.name), note: i.note })),
  notes: o.notes,
});

export default r;
