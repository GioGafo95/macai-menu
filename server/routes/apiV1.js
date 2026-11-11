import { Router } from 'express';
import { getCatalog, bySort } from '../data.js';
import { requireApiKey } from '../auth.js';
import { listOrders, getOrder, updateOrder, salesSummary, STATUSES } from '../orders.js';
import { notifyOrderUpdated } from '../notify.js';
import { HttpError, parseDate, bool, settle } from '../util.js';

/**
 * API pública v1 para integraciones (p. ej. tu sistema de registro de ventas).
 * Autenticación: header "X-API-Key: <key>" o "Authorization: Bearer <key>".
 * Documentación: docs/API.md
 */
const r = Router();

r.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.set('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

r.use(requireApiKey);

r.get('/orders', async (req, res) => {
  const q = req.query;
  const statuses = q.status ? String(q.status).split(',') : undefined;
  if (statuses?.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status inválido. Valores: ${STATUSES.join(', ')}`);
  if (q.fulfillment && !['delivery', 'pickup'].includes(q.fulfillment)) throw new HttpError(400, 'fulfillment debe ser delivery o pickup');
  if (q.payment_method && !['cash', 'transfer'].includes(q.payment_method)) throw new HttpError(400, 'payment_method debe ser cash o transfer');
  res.json(await listOrders({
    from: parseDate(q.from),
    to: parseDate(q.to, true),
    updated_since: parseDate(q.updated_since),
    statuses,
    paid: q.paid === undefined ? undefined : bool(q.paid),
    fulfillment: q.fulfillment,
    payment_method: q.payment_method,
    limit: q.limit,
    offset: q.offset,
    sort: q.sort === 'asc' ? 'asc' : 'desc',
  }));
});

r.get('/orders/:id', async (req, res) => {
  const o = await getOrder(req.params.id);
  if (!o) throw new HttpError(404, 'Pedido no encontrado');
  res.json(o);
});

r.patch('/orders/:id', async (req, res) => {
  const b = req.body || {};
  const o = await updateOrder(req.params.id, { status: b.status, paid: b.paid === undefined ? undefined : bool(b.paid) });
  await settle(notifyOrderUpdated(o), 'webhook');
  res.json(o);
});

r.get('/products', async (req, res) => {
  const cat = await getCatalog();
  const catName = (id) => cat.categories.find((c) => c.id === id)?.name ?? null;
  res.json({
    data: [...cat.products].sort(bySort).map((p) => ({
      id: p.id, name: p.name, description: p.description, price: p.price, active: !!p.active,
      category_id: p.category_id, category: catName(p.category_id),
    })),
  });
});

r.get('/sales/summary', async (req, res) => {
  res.json(await salesSummary({ from: parseDate(req.query.from), to: parseDate(req.query.to, true) }));
});

export default r;
