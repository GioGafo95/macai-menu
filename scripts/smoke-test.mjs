#!/usr/bin/env node
/**
 * Prueba de humo de punta a punta contra un servidor corriendo.
 *
 *   node scripts/smoke-test.mjs <url-base> <contraseña-admin>
 *   node scripts/smoke-test.mjs http://localhost:3000 mi-clave
 *   node scripts/smoke-test.mjs https://dxxxx.cloudfront.net "$ADMIN_PASSWORD"
 *   node scripts/smoke-test.mjs https://pedidos.ejemplo.com --solo-lectura     (producción)
 *
 * Modo completo: crea un pedido de prueba (cliente "Prueba automática") y lo deja CANCELADO.
 * --solo-lectura: no crea pedidos, no sube imágenes, no inicia sesión (no molesta en producción).
 */
const args = process.argv.slice(2);
const readOnly = args.includes('--solo-lectura');
const [base = 'http://localhost:3000', password = process.env.ADMIN_PASSWORD] = args.filter((a) => !a.startsWith('--'));
if (!password && !readOnly) {
  console.error('Uso: node scripts/smoke-test.mjs <url-base> <contraseña-admin> [--solo-lectura]');
  process.exit(2);
}

let cookie = '';
let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log(`Probando ${base}`);

// 1. Página y salud
const home = await call('/', { raw: true });
check(home.status === 200 && (await home.text()).includes('logo.png'), 'Página del menú responde');
const admin = await call('/admin/', { raw: true });
check(admin.status === 200, 'Página del panel responde');
const health = await call('/api/health');
check(health.status === 200 && health.data.ok, `API saludable (almacenamiento: ${health.data.store})`);

// 2. Menú
const menu = await call('/api/public/menu');
check(menu.status === 200 && menu.data.products?.length > 0, `Menú con ${menu.data.products?.length} productos`);
const bowl = menu.data.products.find((p) => p.included_count > 0 && p.groups.length) || menu.data.products[0];
const groups = bowl.groups.map((g) => menu.data.groups[g]);
const required = groups.filter((g) => g.min_select > 0).flatMap((g) => g.options.slice(0, g.min_select).map((o) => o.id));
const extras = groups.filter((g) => g.min_select === 0).flatMap((g) => g.options.filter((o) => o.price > 0)).slice(0, bowl.included_count + 1);
const toppings = [...required, ...extras.map((o) => o.id)];
const expected = bowl.price + (extras.length > bowl.included_count ? extras.at(-1).price : 0);

// Envío por distancia: cotiza un punto cercano al negocio y uno muy lejano
const S = menu.data.settings;
if (S.delivery_mode === 'distance') {
  const near = { lat: Number(S.store_lat) + 0.004, lng: Number(S.store_lng) + 0.004 };
  const q = await call('/api/public/delivery-quote', { method: 'POST', body: near });
  check(q.status === 200 && q.data.available && q.data.fee > 0, `Envío por distancia: ${q.data.distance_km} km → $${q.data.fee} (${q.data.method})`);
  const far = await call('/api/public/delivery-quote', { method: 'POST', body: { lat: Number(S.store_lat) + 1, lng: Number(S.store_lng) } });
  check(far.status === 200 && far.data.available === false, 'Envío por distancia: rechaza direcciones fuera de rango');
}

if (readOnly) {
  const noKey = await call('/api/v1/orders');
  check(noKey.status === 401, 'API v1 protegida con key');
  const noAdmin = await call('/api/admin/settings');
  check(noAdmin.status === 401, 'Panel protegido con contraseña');
  console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodo bien ✅ (solo lectura)');
  process.exit(failures ? 1 : 0);
}

// 3. Pedido del cliente
const order = await call('/api/public/orders', {
  method: 'POST',
  body: {
    items: [{ product_id: bowl.id, quantity: 1, toppings }],
    customer_name: 'Prueba automática', customer_phone: '5500000000',
    fulfillment: 'pickup', payment_method: 'cash',
  },
});
if (menu.data.settings.store_open !== '1') {
  check(order.status === 409, 'Tienda cerrada: rechaza pedidos (ábrela para probar el flujo completo)');
} else {
  check(order.status === 201 && order.data.token, `Pedido creado #${order.data.id}`);
  check(order.data.total === expected, `Precio calculado en servidor: $${order.data.total} (esperado $${expected})`);
  const track = await call(`/api/public/orders/${order.data.token}`);
  check(track.status === 200 && track.data.status === 'nuevo', 'Seguimiento del pedido');
}

// 4. Admin
const badLogin = await call('/api/admin/login', { method: 'POST', body: { password: 'incorrecta-xyz' } });
check(badLogin.status === 401, 'Rechaza contraseña incorrecta');
const login = await call('/api/admin/login', { method: 'POST', body: { password } });
check(login.status === 200 && cookie, 'Inicio de sesión de admin');
const settings = await call('/api/admin/settings');
check(settings.status === 200 && settings.data.api_key, 'Ajustes del panel');
check(!('admin_password_hash' in settings.data), 'No expone datos privados');
const active = await call('/api/admin/orders?view=active');
check(active.status === 200 && Array.isArray(active.data.data), `Pedidos activos: ${active.data.data?.length}`);

if (order.status === 201) {
  const upd = await call(`/api/admin/orders/${order.data.id}`, { method: 'PATCH', body: { status: 'cancelado' } });
  check(upd.status === 200 && upd.data.status === 'cancelado', 'Cambio de estado (pedido de prueba cancelado)');
}

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const fd = new FormData();
fd.append('image', new Blob([png], { type: 'image/png' }), 'prueba.png');
const up = await call('/api/admin/upload', { method: 'POST', body: fd });
check(up.status === 201 && up.data.url?.startsWith('/uploads/'), 'Subida de imagen');
if (up.data.url) {
  const img = await call(up.data.url, { raw: true });
  check(img.status === 200, 'La imagen subida se puede ver');
}

const summary = await call(`/api/admin/summary?from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}`);
check(summary.status === 200 && typeof summary.data.total === 'number', 'Resumen de ventas');

// 5. API v1
const noKey = await call('/api/v1/orders');
check(noKey.status === 401, 'API v1 sin key: rechazada');
cookie = '';
const v1 = await call('/api/v1/orders?limit=5', { headers: { 'x-api-key': settings.data.api_key } });
check(v1.status === 200 && Array.isArray(v1.data.data), 'API v1 con key');
if (order.status === 201) {
  const since = await call(`/api/v1/orders?updated_since=${encodeURIComponent(new Date(Date.now() - 6e5).toISOString())}`, { headers: { 'x-api-key': settings.data.api_key } });
  check(since.data.data?.some((o) => o.id === order.data.id), 'API v1 updated_since encuentra el pedido');
}

console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodo bien ✅');
process.exit(failures ? 1 : 0);
