import { Router } from 'express';
import { getSettings, getCatalog, bySort, PUBLIC_KEYS } from '../data.js';
import { buildOrder, createOrder, getOrderByToken, publicOrder, activeZones, formatOrderText, formatDriverText, isAvailable, byDistance, estimatedTimeFor } from '../orders.js';
import { quoteDelivery, parsePoint } from '../distance.js';
import { notifyNewOrder } from '../notify.js';
import { HttpError, rateLimit, settle, baseUrlOf } from '../util.js';

const r = Router();

export { baseUrlOf };

r.get('/menu', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await menuPayload());
});

/** Menú visible (productos activos, opciones y zonas). Lo usan la página de pedidos y el modo mesero. */
export async function menuPayload() {
  const [s, cat] = await Promise.all([getSettings(), getCatalog()]);
  const settings = Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]]));

  const categories = cat.categories.filter((c) => c.active).sort(bySort).map(({ id, name }) => ({ id, name }));
  const groups = {};
  for (const g of [...cat.groups].sort(bySort)) {
    groups[g.id] = {
      id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select,
      options: g.toppings.filter((t) => t.active).sort(bySort)
        .map(({ id, name, price, description }) => ({ id, name, price, description: description || '' })),
    };
  }

  const products = cat.products.filter((p) => isAvailable(p, cat)).sort(bySort).map((p) => ({
    id: p.id, category_id: p.category_id, name: p.name, description: p.description, price: p.price,
    image: p.image, featured: !!p.featured, allow_notes: !!p.allow_notes,
    included_count: p.included_count || 0, included_value: p.included_value || 0,
    groups: (p.group_ids || []).filter((gid) => groups[gid]?.options.length),
  }));

  // Productos sin categoría van en "Otros"
  if (products.some((p) => !categories.find((c) => c.id === p.category_id))) {
    categories.push({ id: 0, name: 'Otros' });
    for (const p of products) if (!categories.find((c) => c.id === p.category_id)) p.category_id = 0;
  }

  return { settings, categories, products, groups, zones: activeZones(cat) };
}

// Costo de envío según el punto que el cliente marca en el mapa
r.post('/delivery-quote', rateLimit({ windowMs: 10 * 60_000, max: 60, message: 'Demasiadas consultas. Intenta en unos minutos.' }), async (req, res) => {
  const s = await getSettings();
  if (!byDistance(s)) throw new HttpError(400, 'El envío no se calcula por distancia');
  res.set('Cache-Control', 'no-store');
  res.json(await quoteDelivery(req.body, s));
});

r.post('/orders', rateLimit({ windowMs: 10 * 60_000, max: 15, message: 'Has enviado muchos pedidos seguidos. Intenta en unos minutos o escríbenos por WhatsApp.' }), async (req, res) => {
  const [s, cat] = await Promise.all([getSettings(), getCatalog()]);
  const body = req.body || {};
  let quote = null;
  if (body.fulfillment !== 'pickup' && byDistance(s) && s.delivery_enabled === '1') {
    const point = parsePoint(body.location);
    if (point) quote = { ...(await quoteDelivery(point, s)), ...point };
  }
  const order = await createOrder(buildOrder(body, s, cat, { quote }));
  const baseUrl = s.public_url || baseUrlOf(req);

  let whatsapp_url = null;
  const wa = (s.whatsapp_number || '').replace(/\D/g, '');
  if (wa) whatsapp_url = `https://wa.me/${wa}?text=${encodeURIComponent(formatOrderText(order, s, { baseUrl, forCustomer: true }))}`;

  await settle(notifyNewOrder(order, baseUrl), 'notificación');
  res.status(201).json({ id: order.id, token: order.token, total: order.total, whatsapp_url });
});

// Enlace del mensaje de WhatsApp a la tienda: abre WhatsApp con el texto para el grupo de repartidores
r.get('/orders/:token/repartidor', async (req, res) => {
  const order = await getOrderByToken(req.params.token);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  const s = await getSettings();
  res.set('Cache-Control', 'no-store');
  res.redirect(302, `https://wa.me/?text=${encodeURIComponent(formatDriverText(order, s))}`);
});

r.get('/orders/:token', async (req, res) => {
  const order = await getOrderByToken(req.params.token);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  const s = await getSettings();
  const out = publicOrder(order, s);
  const wa = (s.whatsapp_number || '').replace(/\D/g, '');
  out.whatsapp_url = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent(formatOrderText(order, s, { baseUrl: s.public_url || baseUrlOf(req), forCustomer: true }))}`
    : null;
  out.business_name = s.business_name;
  out.currency = s.currency;
  out.locale = s.locale;
  out.estimated_time = estimatedTimeFor(order, s);
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

export default r;
