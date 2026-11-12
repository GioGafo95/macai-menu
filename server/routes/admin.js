import { Router } from 'express';
import multer from 'multer';
import {
  store, getSettings, updateSettings, getCatalog, mutateCatalog, nextSeq, bySort,
  EDITABLE_KEYS, PRIVATE_KEYS, randomKey,
} from '../data.js';
import { requireAdmin, verifyPassword, setSessionCookie, clearSessionCookie, changePassword, setWaiterPassword } from '../auth.js';
import { listOrders, updateOrder, getOrder, salesSummary, formatDriverText, STATUSES, ACTIVE_STATUSES } from '../orders.js';
import { notifyOrderUpdated, sendTest } from '../notify.js';
import { parseTiers } from '../distance.js';
import inventoryRoutes from './inventory.js';
import { HttpError, reqStr, str, int, num, bool, parseDate, rateLimit, isSafeImageUrl, settle } from '../util.js';

const r = Router();
const idOf = (req) => Number(req.params.id) || 0;
const must = (row, what = 'Elemento') => {
  if (!row) throw new HttpError(404, `${what} no encontrado`);
  return row;
};
const find = (list, id) => list.find((x) => x.id === id);

/* ------------------------------ Sesión ------------------------------ */

r.post('/login', rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Demasiados intentos. Espera 15 minutos.' }), async (req, res) => {
  if (!(await verifyPassword(str(req.body?.password, 200)))) throw new HttpError(401, 'Contraseña incorrecta');
  await setSessionCookie(req, res);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

r.use(requireAdmin);

r.get('/me', (req, res) => res.json({ ok: true }));

r.use('/inventory', inventoryRoutes);

/* ----------------------------- Categorías ----------------------------- */

r.get('/categories', async (req, res) => res.json((await getCatalog()).categories.sort(bySort)));

r.post('/categories', async (req, res) => {
  const b = req.body || {};
  const name = reqStr(b.name, 'El nombre', 60);
  const c = await mutateCatalog((cat) => {
    const row = { id: nextSeq(cat, 'category'), name, sort: int(b.sort), active: bool(b.active, true) };
    cat.categories.push(row);
    return row;
  });
  res.status(201).json(c);
});

r.put('/categories/:id', async (req, res) => {
  const b = req.body || {};
  const c = await mutateCatalog((cat) => {
    const row = must(find(cat.categories, idOf(req)), 'Categoría');
    if (b.name !== undefined) row.name = reqStr(b.name, 'El nombre', 60);
    if (b.sort !== undefined) row.sort = int(b.sort);
    if (b.active !== undefined) row.active = bool(b.active);
    return row;
  });
  res.json(c);
});

r.delete('/categories/:id', async (req, res) => {
  await mutateCatalog((cat) => {
    must(find(cat.categories, idOf(req)), 'Categoría');
    cat.categories = cat.categories.filter((c) => c.id !== idOf(req));
    for (const p of cat.products) if (p.category_id === idOf(req)) p.category_id = null;
  });
  res.json({ ok: true });
});

/* ------------------------------ Productos ------------------------------ */

const productOut = (p) => ({ ...p, topping_group_ids: p.group_ids || [] });

function applyProductFields(cat, p, b) {
  const has = (k) => b[k] !== undefined;
  if (has('image')) {
    const image = str(b.image, 500) || null;
    if (!isSafeImageUrl(image)) throw new HttpError(400, 'La imagen debe ser un archivo subido o una URL https://');
    p.image = image;
  }
  if (has('category_id')) {
    const cid = b.category_id === null || b.category_id === '' ? null : int(b.category_id) || null;
    if (cid && !find(cat.categories, cid)) throw new HttpError(400, 'La categoría no existe');
    p.category_id = cid;
  }
  if (has('name')) p.name = reqStr(b.name, 'El nombre', 80);
  if (has('description')) p.description = str(b.description, 500);
  if (has('price')) p.price = num(b.price, 'El precio');
  if (has('active')) p.active = bool(b.active);
  if (has('featured')) p.featured = bool(b.featured);
  if (has('allow_notes')) p.allow_notes = bool(b.allow_notes);
  if (has('sort')) p.sort = int(b.sort);
  if (has('included_count')) p.included_count = Math.max(0, int(b.included_count));
  if (has('included_value')) p.included_value = num(b.included_value || 0, 'El valor de las opciones incluidas');
  if (Array.isArray(b.topping_group_ids)) {
    p.group_ids = [...new Set(b.topping_group_ids.map(Number))].filter((gid) => find(cat.groups, gid));
  }
}

r.get('/products', async (req, res) => {
  res.json((await getCatalog()).products.sort(bySort).map(productOut));
});

r.post('/products', async (req, res) => {
  const b = req.body || {};
  if (b.price === undefined) throw new HttpError(400, 'El precio es obligatorio');
  reqStr(b.name, 'El nombre', 80);
  const p = await mutateCatalog((cat) => {
    const row = {
      id: nextSeq(cat, 'product'), category_id: null, name: '', description: '', price: 0, image: null,
      active: true, featured: false, allow_notes: true, sort: 0, included_count: 0, included_value: 0, group_ids: [],
    };
    applyProductFields(cat, row, b);
    cat.products.push(row);
    return row;
  });
  res.status(201).json(productOut(p));
});

r.put('/products/:id', async (req, res) => {
  const p = await mutateCatalog((cat) => {
    const row = must(find(cat.products, idOf(req)), 'Producto');
    applyProductFields(cat, row, req.body || {});
    return row;
  });
  res.json(productOut(p));
});

r.delete('/products/:id', async (req, res) => {
  await mutateCatalog((cat) => {
    must(find(cat.products, idOf(req)), 'Producto');
    cat.products = cat.products.filter((p) => p.id !== idOf(req));
  });
  res.json({ ok: true });
});

/* ------------------------------- Imágenes ------------------------------- */

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Solo se permiten imágenes JPG, PNG, WEBP o GIF'));
  },
});

r.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No se recibió ninguna imagen');
  const url = await store.saveUpload(req.file.buffer, MIME_EXT[req.file.mimetype], req.file.mimetype);
  res.status(201).json({ url });
});

/* --------------------------- Grupos de toppings --------------------------- */

const groupOut = (g) => ({ ...g, toppings: [...g.toppings].sort(bySort) });

function applyGroupFields(g, b) {
  if (b.name !== undefined) g.name = reqStr(b.name, 'El nombre', 60);
  if (b.min_select !== undefined) g.min_select = Math.max(0, int(b.min_select));
  if (b.max_select !== undefined) g.max_select = Math.max(0, int(b.max_select));
  if (b.sort !== undefined) g.sort = int(b.sort);
  if (g.max_select > 0 && g.min_select > g.max_select) throw new HttpError(400, 'El mínimo no puede ser mayor que el máximo');
}

const findTopping = (cat, id) => {
  for (const g of cat.groups) {
    const t = find(g.toppings, id);
    if (t) return { g, t };
  }
  return null;
};

r.get('/topping-groups', async (req, res) => {
  res.json((await getCatalog()).groups.sort(bySort).map(groupOut));
});

r.post('/topping-groups', async (req, res) => {
  const b = req.body || {};
  reqStr(b.name, 'El nombre', 60);
  const g = await mutateCatalog((cat) => {
    const row = { id: nextSeq(cat, 'group'), name: '', min_select: 0, max_select: 0, sort: 0, toppings: [] };
    applyGroupFields(row, b);
    cat.groups.push(row);
    return row;
  });
  res.status(201).json(groupOut(g));
});

r.put('/topping-groups/:id', async (req, res) => {
  const g = await mutateCatalog((cat) => {
    const row = must(find(cat.groups, idOf(req)), 'Grupo');
    applyGroupFields(row, req.body || {});
    return row;
  });
  res.json(groupOut(g));
});

r.delete('/topping-groups/:id', async (req, res) => {
  await mutateCatalog((cat) => {
    must(find(cat.groups, idOf(req)), 'Grupo');
    cat.groups = cat.groups.filter((g) => g.id !== idOf(req));
    for (const p of cat.products) p.group_ids = (p.group_ids || []).filter((gid) => gid !== idOf(req));
  });
  res.json({ ok: true });
});

r.post('/topping-groups/:id/toppings', async (req, res) => {
  const b = req.body || {};
  const name = reqStr(b.name, 'El nombre', 60);
  const price = num(b.price ?? 0, 'El precio');
  const g = await mutateCatalog((cat) => {
    const grp = must(find(cat.groups, idOf(req)), 'Grupo');
    grp.toppings.push({
      id: nextSeq(cat, 'topping'), name, price, description: str(b.description, 200),
      active: bool(b.active, true), sort: int(b.sort),
    });
    return grp;
  });
  res.status(201).json(groupOut(g));
});

r.put('/toppings/:id', async (req, res) => {
  const b = req.body || {};
  const g = await mutateCatalog((cat) => {
    const { g: grp, t } = must(findTopping(cat, idOf(req)), 'Topping');
    if (b.name !== undefined) t.name = reqStr(b.name, 'El nombre', 60);
    if (b.price !== undefined) t.price = num(b.price, 'El precio');
    if (b.description !== undefined) t.description = str(b.description, 200);
    if (b.active !== undefined) t.active = bool(b.active);
    if (b.sort !== undefined) t.sort = int(b.sort);
    return grp;
  });
  res.json(groupOut(g));
});

r.delete('/toppings/:id', async (req, res) => {
  const g = await mutateCatalog((cat) => {
    const { g: grp } = must(findTopping(cat, idOf(req)), 'Topping');
    grp.toppings = grp.toppings.filter((t) => t.id !== idOf(req));
    return grp;
  });
  res.json(groupOut(g));
});

/* ---------------------------- Zonas de envío ---------------------------- */

r.get('/zones', async (req, res) => res.json((await getCatalog()).zones.sort(bySort)));

r.post('/zones', async (req, res) => {
  const b = req.body || {};
  const name = reqStr(b.name, 'El nombre', 80);
  const fee = num(b.fee ?? 0, 'El costo');
  const z = await mutateCatalog((cat) => {
    const row = { id: nextSeq(cat, 'zone'), name, fee, active: bool(b.active, true), sort: int(b.sort) };
    cat.zones.push(row);
    return row;
  });
  res.status(201).json(z);
});

r.put('/zones/:id', async (req, res) => {
  const b = req.body || {};
  const z = await mutateCatalog((cat) => {
    const row = must(find(cat.zones, idOf(req)), 'Zona');
    if (b.name !== undefined) row.name = reqStr(b.name, 'El nombre', 80);
    if (b.fee !== undefined) row.fee = num(b.fee, 'El costo');
    if (b.active !== undefined) row.active = bool(b.active);
    if (b.sort !== undefined) row.sort = int(b.sort);
    return row;
  });
  res.json(z);
});

r.delete('/zones/:id', async (req, res) => {
  await mutateCatalog((cat) => {
    must(find(cat.zones, idOf(req)), 'Zona');
    cat.zones = cat.zones.filter((z) => z.id !== idOf(req));
  });
  res.json({ ok: true });
});

/* ------------------------------- Pedidos ------------------------------- */

r.get('/orders', async (req, res) => {
  const q = req.query;
  let statuses;
  if (q.view === 'active') statuses = ACTIVE_STATUSES;
  else if (q.status) statuses = String(q.status).split(',').filter((x) => STATUSES.includes(x));
  res.set('Cache-Control', 'no-store');
  const s = await getSettings();
  const out = await listOrders({
    from: parseDate(q.from),
    to: parseDate(q.to, true),
    statuses,
    limit: q.limit || 200,
    offset: q.offset,
    sort: q.view === 'active' ? 'asc' : 'desc',
  });
  out.data = out.data.map((o) => withDriver(o, s));
  res.json(out);
});

/** Agrega el texto para el grupo de repartidores (botón "Copiar para repartidor" del panel). */
const withDriver = (o, s) => ({ ...o, driver_text: formatDriverText(o, s) });

r.get('/orders/:id', async (req, res) => res.json(withDriver(must(await getOrder(idOf(req)), 'Pedido'), await getSettings())));

r.patch('/orders/:id', async (req, res) => {
  const b = req.body || {};
  const order = await updateOrder(idOf(req), { status: b.status, paid: b.paid === undefined ? undefined : bool(b.paid) });
  await settle(notifyOrderUpdated(order), 'webhook');
  res.json(withDriver(order, await getSettings()));
});

r.get('/summary', async (req, res) => {
  res.json(await salesSummary({ from: parseDate(req.query.from), to: parseDate(req.query.to, true) }));
});

/* ------------------------------- Ajustes ------------------------------- */

const publicView = (s) => {
  s.waiter_enabled = s.waiter_password_hash ? '1' : '0';
  for (const k of PRIVATE_KEYS) delete s[k];
  return s;
};

r.get('/settings', async (req, res) => res.json(publicView(await getSettings())));

r.put('/settings', async (req, res) => {
  const b = req.body || {};
  const url = (k) => {
    const v = str(b[k], 500);
    if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw new HttpError(400, `"${k}" debe ser una URL que empiece con http:// o https://`);
    return v.replace(/\/+$/, '');
  };
  const patch = {};
  for (const k of EDITABLE_KEYS) {
    if (b[k] === undefined) continue;
    patch[k] = k === 'webhook_url' || k === 'public_url' ? url(k) : str(b[k], 2000);
  }
  if (patch.delivery_tiers !== undefined) {
    patch.delivery_tiers = parseTiers(patch.delivery_tiers, { strict: true }).map((t) => `${t.km} = ${t.fee}`).join('\n');
  }
  if (patch.delivery_mode !== undefined && !['distance', 'zones'].includes(patch.delivery_mode)) patch.delivery_mode = 'distance';
  for (const k of ['store_lat', 'store_lng']) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || Math.abs(n) > (k === 'store_lat' ? 90 : 180)) throw new HttpError(400, 'Ubicación del negocio inválida');
    patch[k] = String(Math.round(n * 1e6) / 1e6);
  }
  res.json(publicView(await updateSettings(patch)));
});

r.post('/settings/regenerate-api-key', async (req, res) => {
  res.json(publicView(await updateSettings({ api_key: randomKey('mk_') })));
});

r.post('/settings/regenerate-webhook-secret', async (req, res) => {
  res.json(publicView(await updateSettings({ webhook_secret: randomKey('whsec_') })));
});

r.post('/password', async (req, res) => {
  await changePassword(str(req.body?.current, 200), str(req.body?.next, 200));
  await setSessionCookie(req, res); // la sesión anterior queda invalidada; emitimos una nueva
  res.json({ ok: true });
});

// Contraseña del modo mesero (/mesero/). Vacía = desactivar el acceso de meseros.
r.post('/waiter-password', async (req, res) => {
  await setWaiterPassword(str(req.body?.password, 200));
  res.json(publicView(await getSettings()));
});

r.post('/notify/test', async (req, res) => {
  res.json({ results: await sendTest() });
});

export default r;
