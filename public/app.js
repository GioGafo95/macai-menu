import { $, $$, esc, money, setCurrency, api, toast, store, emojiFor } from './common.js';
import { createMap, searchAddress, reverseAddress, currentPosition } from './map.js';

// Modo mesero (/mesero/): la misma página, pero el personal captura el pedido del cliente.
const STAFF = document.body.dataset.mode === 'mesero';
const API = STAFF ? '/api/mesero' : '/api/public';
const CART_KEY = STAFF ? 'macai_mesero_cart' : 'macai_cart';
const CUSTOMER_KEY = STAFF ? 'macai_mesero_prefs' : 'macai_customer';
const LAST_ORDER_KEY = 'macai_last_order';
const WAITER_KEY = 'macai_mesero_nombre';

let menu = null;          // respuesta de /api/public/menu (o /api/mesero/menu)
let S = {};               // ajustes públicos
let cart = store.get(CART_KEY, []);
const BLANK = { customer_name: '', customer_phone: '', address: '', address_ref: '', zone_id: '', location: null, fulfillment: '', payment_method: '', cash_amount: '', notes: '', table: '', paid: false };
const checkout = Object.assign(
  { ...BLANK },
  store.get(CUSTOMER_KEY, {}),
  { cash_amount: '', notes: '' },
);

/* ============================ Carga inicial ============================ */

async function init() {
  try {
    menu = await api(`${API}/menu`);
  } catch (e) {
    if (STAFF && e.status === 401) return staffLogin();
    $('#menu').innerHTML = `<div class="empty"><div class="big">😕</div><p>No pudimos cargar el menú.<br>${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">Reintentar</button></div>`;
    return;
  }
  S = menu.settings;
  setCurrency(S.locale, S.currency);
  if (STAFF) {
    staffReady();
    sanitizeCart();
    renderMenu();
    renderCartBar();
    return;
  }
  document.title = `${S.business_name} · Haz tu pedido`;
  $('#biz-name').textContent = S.business_name;
  $('#biz-tagline').textContent = S.tagline || '';

  const meta = [];
  if (S.delivery_enabled === '1') meta.push(`<span class="pill">🛵 A domicilio${S.estimated_time ? ` · ${esc(S.estimated_time)}` : ''}</span>`);
  if (S.pickup_enabled === '1') meta.push(`<span class="pill">🏪 Recoger${pickupTime() ? ` · ${esc(pickupTime())}` : ''}</span>`);
  const last = store.get(LAST_ORDER_KEY);
  if (last?.token) meta.push(`<a class="pill accent" href="/pedido.html?t=${encodeURIComponent(last.token)}">📦 Mi último pedido</a>`);
  $('#hero-meta').innerHTML = meta.join('');

  if (S.store_open !== '1') {
    $('#closed').textContent = S.closed_message || 'Por ahora estamos cerrados.';
    $('#closed').classList.remove('hidden');
  }

  sanitizeCart();
  renderMenu();
  renderCartBar();
}

/* ================================ Menú ================================ */

const productById = (id) => menu.products.find((p) => p.id === id);
const pickupTime = () => S.pickup_estimated_time || S.estimated_time || '';

function productThumb(p, cls = 'thumb') {
  return p.image
    ? `<img class="${cls}" src="${esc(p.image)}" alt="" loading="lazy">`
    : `<div class="${cls} thumb-ph" aria-hidden="true">${emojiFor(p.id)}</div>`;
}

function renderMenu() {
  const cats = menu.categories.filter((c) => menu.products.some((p) => p.category_id === c.id));
  if (!cats.length) {
    $('#menu').innerHTML = '<div class="empty"><div class="big">🥗</div><p>Pronto tendremos productos disponibles.</p></div>';
    return;
  }

  $('#cats').innerHTML = cats.map((c, i) =>
    `<button class="chip${i === 0 ? ' active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('');

  $('#menu').innerHTML = cats.map((c) => `
    <section>
      <h2 class="section-title" id="cat-${c.id}">${esc(c.name)}</h2>
      <div class="grid">
        ${menu.products.filter((p) => p.category_id === c.id).map((p) => `
          <button class="product" data-product="${p.id}" aria-label="${esc(p.name)}, ${money(p.price)}">
            <div class="product-body">
              ${p.featured ? '<span class="tag">⭐ Favorito</span>' : ''}
              <h3>${esc(p.name)}</h3>
              <p>${esc(p.description)}</p>
              <div class="product-foot">
                <span class="price">${money(p.price)}</span>
                <span class="add-badge" aria-hidden="true">+</span>
              </div>
            </div>
            ${productThumb(p)}
          </button>`).join('')}
      </div>
    </section>`).join('');

  $$('[data-product]').forEach((el) => el.addEventListener('click', () => openProduct(productById(Number(el.dataset.product)))));

  $$('.chip').forEach((chip) => chip.addEventListener('click', () => {
    $(`#cat-${chip.dataset.cat}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // Resalta la categoría visible
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.id.replace('cat-', '');
      $$('.chip').forEach((c) => c.classList.toggle('active', c.dataset.cat === id));
      $(`.chip[data-cat="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  $$('.section-title').forEach((h) => obs.observe(h));
}

/* ============================ Hoja / modal ============================ */

let sheetOnClose = null;
function openSheet(html, onClose) {
  closeSheet();
  sheetOnClose = onClose || null;
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop" role="dialog" aria-modal="true"><div class="sheet">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const bd = root.firstElementChild;
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeSheet));
  return bd.firstElementChild;
}
function closeSheet() {
  const root = $('#sheet-root');
  if (!root.firstElementChild) return;
  root.innerHTML = '';
  document.body.style.overflow = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb?.();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

/* ======================= Producto: opciones y toppings ======================= */

function groupRule(g) {
  if (g.min_select > 0 && g.max_select === g.min_select) return g.min_select === 1 ? 'Elige 1' : `Elige ${g.min_select}`;
  if (g.min_select > 0 && g.max_select > 0) return `Elige de ${g.min_select} a ${g.max_select}`;
  if (g.min_select > 0) return `Elige al menos ${g.min_select}`;
  if (g.max_select > 0) return `Opcional · hasta ${g.max_select}`;
  return 'Opcional';
}

function openProduct(p, editKey) {
  if (!p) return;
  const editing = editKey ? cart.find((i) => i.key === editKey) : null;
  let qty = editing?.quantity || 1;
  const groups = p.groups.map((id) => menu.groups[id]).filter(Boolean);
  const selected = new Set(editing?.toppings || []);
  const closed = !STAFF && S.store_open !== '1';

  const sheet = openSheet(`
    <div class="sheet-head">
      ${productThumb(p, 'sheet-img')}
      <button class="icon-btn sheet-close" data-close aria-label="Cerrar">×</button>
    </div>
    <div class="sheet-body">
      <div class="sheet-title" style="padding:18px 0 4px"><h2>${esc(p.name)}</h2><span class="price">${money(p.price)}</span></div>
      <p class="muted" style="margin:0">${esc(p.description)}</p>
      ${p.included_count > 0 ? `<div class="included-box" data-included></div>` : ''}
      ${groups.map((g) => {
        const single = g.max_select === 1;
        const type = single && g.min_select === 1 ? 'radio' : 'checkbox';
        const compact = g.options.length > 5 && !g.options.some((o) => o.description);
        return `
        <div class="group" data-group="${g.id}">
          <div class="group-head"><h4>${esc(g.name)}</h4><span class="req" data-req>${groupRule(g)}</span></div>
          <div class="${compact ? 'opts-grid' : ''}">
          ${g.options.map((o) => `
            <label class="option">
              <input type="${type}" name="g${g.id}" value="${o.id}" ${selected.has(o.id) ? 'checked' : ''}>
              <span class="opt-name">${esc(o.name)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span>
              <span class="opt-price" data-price="${o.id}">${o.price > 0 ? '+' + money(o.price) : ''}</span>
            </label>`).join('')}
          </div>
        </div>`;
      }).join('')}
      ${p.allow_notes ? `
        <div class="field">
          <label for="p-note">Notas para la cocina <span class="muted small">(opcional)</span></label>
          <textarea class="input" id="p-note" maxlength="200" placeholder="Ej. sin plátano, granola aparte…">${esc(editing?.note || '')}</textarea>
        </div>` : ''}
    </div>
    <div class="sheet-foot">
      <div class="stepper"><button type="button" data-dec aria-label="Menos">−</button><span data-qty>${qty}</span><button type="button" data-inc aria-label="Más">+</button></div>
      <button class="btn btn-lg" style="flex:1" data-add ${closed ? 'disabled' : ''}></button>
    </div>`);

  const addBtn = $('[data-add]', sheet);

  function update() {
    let ok = true;
    const pricing = priceFor(p, $$('input:checked', sheet).map((i) => i.value));
    for (const g of groups) {
      const box = $(`[data-group="${g.id}"]`, sheet);
      const inputs = $$('input', box);
      const count = inputs.filter((i) => i.checked).length;
      inputs.forEach((i) => {
        const full = g.max_select > 0 && count >= g.max_select && i.type === 'checkbox' && g.max_select !== 1;
        i.disabled = !i.checked && full;
        i.closest('.option').classList.toggle('disabled', i.disabled);
        // Etiqueta de precio: "Incluido" si entra en el paquete
        const o = g.options.find((x) => x.id === Number(i.value));
        const label = $(`[data-price="${o.id}"]`, box);
        if (!(o.price > 0)) return;
        const sel = pricing.opts.find((x) => x.id === o.id);
        let text = `+${money(o.price)}`;
        let inc = false;
        if (sel?.included) { inc = true; text = sel.charged > 0 ? `Incluido +${money(sel.charged)}` : 'Incluido'; }
        else if (!sel && pricing.left > 0) { inc = true; text = o.price > p.included_value ? `Incluido +${money(o.price - p.included_value)}` : 'Incluido'; }
        label.textContent = text;
        label.classList.toggle('inc', inc);
      });
      const req = $('[data-req]', box);
      const met = count >= g.min_select;
      if (!met) ok = false;
      req.classList.toggle('need', !met);
      req.classList.toggle('ok', g.min_select > 0 && met);
    }
    const incBox = $('[data-included]', sheet);
    if (incBox) {
      const n = p.included_count;
      incBox.innerHTML = pricing.left > 0
        ? `🎁 Incluye <strong>${n} ${n === 1 ? 'opción' : 'opciones'}</strong> sin costo. Te ${pricing.left === 1 ? 'queda' : 'quedan'} <strong>${pricing.left}</strong>.`
        : `✅ Ya elegiste tus ${n} incluidas. Las siguientes tienen costo extra.`;
      incBox.classList.toggle('done', pricing.left === 0);
    }
    $('[data-qty]', sheet).textContent = qty;
    const label = closed ? 'Cerrado por ahora' : editing ? 'Actualizar' : 'Agregar';
    addBtn.innerHTML = `${label} · ${money(pricing.unit * qty)}`;
    addBtn.dataset.ok = ok ? '1' : '';
  }

  sheet.addEventListener('change', (e) => {
    const i = e.target;
    if (i.type === 'checkbox' && i.checked) {
      // Grupos de máximo 1 con checkbox: se comportan como selección única pero se pueden desmarcar
      const g = groups.find((x) => `g${x.id}` === i.name);
      if (g?.max_select === 1) $$(`input[name="${i.name}"]`, sheet).forEach((o) => { if (o !== i) o.checked = false; });
    }
    update();
  });
  $('[data-dec]', sheet).addEventListener('click', () => { qty = Math.max(1, qty - 1); update(); });
  $('[data-inc]', sheet).addEventListener('click', () => { qty = Math.min(50, qty + 1); update(); });

  addBtn.addEventListener('click', () => {
    if (!addBtn.dataset.ok) {
      const missing = groups.find((g) => $$(`[data-group="${g.id}"] input:checked`, sheet).length < g.min_select);
      if (missing) {
        toast(`Elige una opción en "${missing.name}"`);
        $(`[data-group="${missing.id}"]`, sheet).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    const toppings = $$('input:checked', sheet).map((i) => Number(i.value));
    const note = $('#p-note', sheet)?.value.trim() || '';
    const sig = `${p.id}|${[...toppings].sort((a, b) => a - b).join(',')}|${note}`;
    if (editing) {
      Object.assign(editing, { quantity: qty, toppings, note, key: sig });
      mergeDuplicates();
    } else {
      const same = cart.find((i) => i.key === sig);
      if (same) same.quantity = Math.min(50, same.quantity + qty);
      else cart.push({ key: sig, product_id: p.id, quantity: qty, toppings, note });
    }
    saveCart();
    closeSheet();
    if (editing) openCart();
    else toast(`✓ ${p.name} agregado`);
  });

  update();
}

/* ================================ Carrito ================================ */

function mergeDuplicates() {
  const out = [];
  for (const i of cart) {
    const same = out.find((o) => o.key === i.key);
    if (same) same.quantity = Math.min(50, same.quantity + i.quantity);
    else out.push(i);
  }
  cart = out;
}

/**
 * Precio de un producto con sus opciones. Misma regla que el servidor (server/orders.js → applyIncluded):
 * "incluye N opciones de hasta $X": se descuenta hasta X a las N opciones con costo más caras.
 */
function priceFor(p, selectedIds) {
  const ids = new Set(selectedIds.map(Number));
  const opts = [];
  for (const gid of p.groups) for (const o of menu.groups[gid]?.options || []) if (ids.has(o.id)) opts.push({ ...o, charged: o.price, included: false });
  const count = p.included_count || 0;
  const value = p.included_value || 0;
  let used = 0;
  if (count > 0 && value > 0) {
    const order = opts.map((o, i) => i).filter((i) => opts[i].price > 0).sort((a, b) => opts[b].price - opts[a].price || a - b);
    for (const i of order.slice(0, count)) {
      opts[i].charged = Math.max(0, opts[i].price - value);
      opts[i].included = true;
      used++;
    }
  }
  return { opts, used, left: Math.max(0, count - used), unit: p.price + opts.reduce((a, o) => a + o.charged, 0) };
}

function itemInfo(item) {
  const p = productById(item.product_id);
  if (!p) return null;
  const { opts, unit } = priceFor(p, item.toppings);
  return { p, opts, unit, total: unit * item.quantity };
}

/** Quita del carrito productos u opciones que ya no existen. */
function sanitizeCart() {
  const before = cart.length;
  cart = cart.filter((i) => {
    const info = itemInfo(i);
    return info && info.opts.length === i.toppings.length;
  });
  if (cart.length !== before) {
    saveCart();
    toast('Actualizamos tu carrito: algunos productos ya no están disponibles');
  }
}

function saveCart() {
  store.set(CART_KEY, cart);
  renderCartBar();
}

const subtotal = () => cart.reduce((a, i) => a + (itemInfo(i)?.total || 0), 0);
const cartCount = () => cart.reduce((a, i) => a + i.quantity, 0);

function renderCartBar() {
  const n = cartCount();
  $('#cart-bar').classList.toggle('hidden', n === 0);
  $('#cart-count').textContent = n;
  $('#cart-total').textContent = money(subtotal());
}
$('#open-cart').addEventListener('click', () => openCart());

const byDistance = () => S.delivery_mode === 'distance';
const storePoint = () => ({ lat: Number(S.store_lat), lng: Number(S.store_lng) });
let quote = null; // cotización del envío por distancia (la última que dio el servidor)

function deliveryFee(sub) {
  if (checkout.fulfillment !== 'delivery') return 0;
  const freeOver = Number(S.free_delivery_over) || 0;
  if (freeOver > 0 && sub >= freeOver) return 0;
  if (byDistance()) return quote?.available ? quote.fee : null; // null = falta marcar ubicación
  if (menu.zones.length) {
    const z = menu.zones.find((x) => x.id === Number(checkout.zone_id));
    return z ? z.fee : null; // null = falta elegir zona
  }
  return Number(S.delivery_flat_fee) || 0;
}

function openCart() {
  if (!cart.length) { closeSheet(); return; }
  const sheet = openSheet(`
    <div class="sheet-title"><h2>${STAFF ? 'Pedido' : 'Tu pedido'}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
    <div class="sheet-body">
      ${cart.map((i) => {
        const { p, opts, total } = itemInfo(i);
        return `
        <div class="cart-item">
          <div class="cart-item-body">
            <h4>${esc(p.name)}</h4>
            ${opts.length ? `<div class="extra">${opts.map((o) => esc(o.name)).join(', ')}</div>` : ''}
            ${i.note ? `<div class="extra">📝 ${esc(i.note)}</div>` : ''}
            <div style="display:flex;gap:14px;margin-top:6px">
              ${p.groups.length || p.allow_notes ? `<button class="link-btn" style="color:var(--cyan-ink)" data-edit="${esc(i.key)}">Editar</button>` : ''}
              <button class="link-btn" data-remove="${esc(i.key)}">Quitar</button>
            </div>
          </div>
          <div class="cart-item-side">
            <strong>${money(total)}</strong>
            <div class="stepper sm"><button data-q="-1" data-key="${esc(i.key)}" aria-label="Menos">−</button><span>${i.quantity}</span><button data-q="1" data-key="${esc(i.key)}" aria-label="Más">+</button></div>
          </div>
        </div>`;
      }).join('')}
      <button class="btn btn-ghost btn-block" style="margin-top:14px" data-close>+ Agregar más productos</button>
      <div class="totals"><div class="row total"><span>Subtotal</span><span>${money(subtotal())}</span></div></div>
      ${!STAFF && Number(S.min_order) > 0 && subtotal() < Number(S.min_order)
        ? `<div class="box warn">El pedido mínimo es de ${money(S.min_order)}. Te faltan ${money(Number(S.min_order) - subtotal())}.</div>` : ''}
    </div>
    <div class="sheet-foot">
      ${STAFF ? '<button class="btn btn-lg btn-block" data-next>Continuar</button>' : `
      <button class="btn btn-lg btn-block" data-next ${S.store_open !== '1' || (Number(S.min_order) > 0 && subtotal() < Number(S.min_order)) ? 'disabled' : ''}>
        ${S.store_open !== '1' ? 'Estamos cerrados' : 'Continuar'}
      </button>`}
    </div>`);

  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.q) {
      const item = cart.find((i) => i.key === t.dataset.key);
      item.quantity += Number(t.dataset.q);
      if (item.quantity < 1) cart = cart.filter((i) => i !== item);
      item.quantity = Math.min(50, item.quantity);
      saveCart();
      openCart();
    } else if (t.dataset.remove) {
      cart = cart.filter((i) => i.key !== t.dataset.remove);
      saveCart();
      openCart();
    } else if (t.dataset.edit) {
      const item = cart.find((i) => i.key === t.dataset.edit);
      openProduct(productById(item.product_id), item.key);
    } else if ('next' in t.dataset) {
      openCheckout();
    }
  });
}

/* ================================ Checkout ================================ */

function openCheckout() {
  const canDeliver = S.delivery_enabled === '1';
  const canPickup = STAFF || S.pickup_enabled === '1';
  if (!checkout.fulfillment || (checkout.fulfillment === 'delivery' && !canDeliver) || (checkout.fulfillment === 'pickup' && !canPickup)
    || (checkout.fulfillment === 'dine_in' && !STAFF)) {
    checkout.fulfillment = STAFF ? 'dine_in' : canDeliver ? 'delivery' : 'pickup';
  }
  const canCash = STAFF || S.cash_enabled === '1';
  const canTransfer = STAFF || S.transfer_enabled === '1';
  const canCard = STAFF || S.card_enabled === '1'; // tarjeta en sucursal: solo si no es a domicilio

  const whoHtml = `
      <div class="field">
        <label for="c-name">${STAFF ? 'Nombre del cliente' : 'Tu nombre'} <span class="muted small" data-opt-name>(opcional)</span></label>
        <input class="input" id="c-name" name="customer_name" autocomplete="${STAFF ? 'off' : 'name'}" maxlength="80" required value="${esc(checkout.customer_name)}">
      </div>
      <div class="field" data-phone>
        <label for="c-phone">${STAFF ? 'Teléfono del cliente' : 'Teléfono / WhatsApp'} <span class="muted small" data-opt-phone>(opcional)</span></label>
        <input class="input" id="c-phone" name="customer_phone" type="tel" inputmode="tel" autocomplete="${STAFF ? 'off' : 'tel'}" maxlength="20" required value="${esc(checkout.customer_phone)}" placeholder="10 dígitos">
      </div>`;
  const fulHtml = `
      <div class="field">
        <span class="label">${STAFF ? 'Tipo de pedido' : '¿Cómo lo quieres?'}</span>
        <div class="choice-row">
          ${STAFF ? '<button type="button" class="choice" data-ful="dine_in"><span class="ico">🍽️</span><strong>Comer aquí</strong><small>En el local</small></button>' : ''}
          ${canPickup ? `<button type="button" class="choice" data-ful="pickup"><span class="ico">${STAFF ? '🥡' : '🏪'}</span><strong>${STAFF ? 'Para llevar' : 'Recoger'}</strong><small>${STAFF ? 'Se lo lleva' : pickupTime() ? `Listo en ${esc(pickupTime())}` : 'Sin costo de envío'}</small></button>` : ''}
          ${canDeliver ? `<button type="button" class="choice" data-ful="delivery"><span class="ico">🛵</span><strong>A domicilio</strong><small data-fee-label></small></button>` : ''}
        </div>
      </div>
      ${STAFF ? `<div class="field" data-dinein>
        <label for="c-table">Número de mesa</label>
        <input class="input" id="c-table" name="table" inputmode="numeric" maxlength="20" autocomplete="off" placeholder="Ej. 4" value="${esc(checkout.table)}">
      </div>` : ''}`;
  if ((checkout.payment_method === 'cash' && !canCash) || (checkout.payment_method === 'transfer' && !canTransfer)
    || (checkout.payment_method === 'card' && !canCard)) checkout.payment_method = '';
  if (!checkout.payment_method && canCash !== canTransfer) checkout.payment_method = canCash ? 'cash' : 'transfer';

  const sheet = openSheet(`
    <div class="sheet-title">
      <div class="steps-title"><button class="icon-btn" data-back aria-label="Regresar">‹</button><h2>${STAFF ? 'Datos del pedido' : 'Datos de entrega'}</h2></div>
      <button class="icon-btn" data-close aria-label="Cerrar">×</button>
    </div>
    <form class="sheet-body" id="checkout-form" novalidate>
      ${STAFF ? fulHtml + whoHtml : whoHtml + fulHtml}

      <div data-delivery>
        ${byDistance() ? `
          <div class="field">
            <span class="label">📍 ¿A dónde te lo llevamos?</span>
            <div class="search-row">
              <input class="input" id="c-search" type="search" enterkeyhint="search" autocomplete="off" placeholder="Busca tu calle y colonia">
              <button type="button" class="btn btn-light" data-search>Buscar</button>
            </div>
            <div class="search-results hidden" data-results></div>
            <div class="map-box" data-map><div class="map-loading">Cargando mapa…</div></div>
            <div class="map-actions">
              ${STAFF ? '' : '<button type="button" class="link-btn" data-locate>🎯 Usar mi ubicación actual</button>'}
              <span class="muted small">${STAFF ? 'Toca el mapa o arrastra el pin 🏠 hasta la casa del cliente' : 'o toca el mapa / arrastra el pin 🏠'}</span>
            </div>
            <div class="quote-box hidden" data-quote role="status"></div>
          </div>` : ''}
        ${!byDistance() && menu.zones.length ? `
          <div class="field">
            <label for="c-zone">Zona / colonia</label>
            <select class="input" id="c-zone" name="zone_id">
              <option value="">Elige tu zona…</option>
              ${menu.zones.map((z) => `<option value="${z.id}" ${Number(checkout.zone_id) === z.id ? 'selected' : ''}>${esc(z.name)} — ${z.fee > 0 ? money(z.fee) : 'Gratis'}</option>`).join('')}
            </select>
          </div>` : ''}
        <div class="field">
          <label for="c-address">Dirección</label>
          <textarea class="input" id="c-address" name="address" rows="2" maxlength="300" autocomplete="street-address" placeholder="Calle, número, colonia">${esc(checkout.address)}</textarea>
        </div>
        <div class="field">
          <label for="c-ref">Referencias <span class="muted small">(opcional)</span></label>
          <input class="input" id="c-ref" name="address_ref" maxlength="200" placeholder="Ej. casa azul, portón negro" value="${esc(checkout.address_ref)}">
        </div>
      </div>
      <div data-pickup>
        ${!STAFF && (S.pickup_address || pickupTime()) ? `<div class="box">${[
          S.pickup_address ? `📍 Recoges en: ${esc(S.pickup_address)}` : '',
          pickupTime() ? `⏱ Tu pedido estará listo en aprox. ${esc(pickupTime())}` : '',
        ].filter(Boolean).join('\n')}</div>` : ''}
      </div>

      <div class="field">
        <span class="label">Método de pago</span>
        <div class="choice-row">
          ${canCash ? `<button type="button" class="choice" data-pay="cash"><span class="ico">💵</span><strong>Efectivo</strong><small>${STAFF ? 'En caja o al entregar' : 'Pagas al recibir'}</small></button>` : ''}
          ${canTransfer ? `<button type="button" class="choice" data-pay="transfer"><span class="ico">🏦</span><strong>Transferencia</strong><small>${STAFF ? 'A la cuenta del negocio' : 'Te damos los datos'}</small></button>` : ''}
          ${canCard ? `<button type="button" class="choice" data-pay="card"><span class="ico">💳</span><strong>Tarjeta</strong><small>${STAFF ? 'Terminal en caja' : 'Pagas en sucursal'}</small></button>` : ''}
        </div>
      </div>
      ${STAFF ? `<label class="option paid-option"><input type="checkbox" name="paid" ${checkout.paid ? 'checked' : ''}>
        <span class="opt-name">✅ Ya pagó<small>Márcalo si el cliente ya pagó en caja</small></span></label>` : ''}
      <div data-cash class="field">
        <label for="c-cash">¿Con cuánto pagas? <span class="muted small">(opcional, para llevar cambio)</span></label>
        <input class="input" id="c-cash" name="cash_amount" type="number" inputmode="decimal" min="0" step="1" placeholder="Ej. 500" value="${esc(checkout.cash_amount)}">
      </div>
      <div data-transfer>
        ${!STAFF && S.bank_info ? `<div class="box"><strong>Datos para transferir</strong>\n${esc(S.bank_info)}</div>
        <p class="muted small" style="margin:6px 2px 0">Envíanos tu comprobante por WhatsApp después de confirmar.</p>` : ''}
      </div>

      <div class="field">
        <label for="c-notes">Comentarios del pedido <span class="muted small">(opcional)</span></label>
        <textarea class="input" id="c-notes" name="notes" rows="2" maxlength="500" placeholder="Ej. traer cubiertos, tocar el timbre…">${esc(checkout.notes)}</textarea>
      </div>

      <div class="totals" data-totals></div>
      <div class="error-msg hidden" data-error role="alert"></div>
    </form>
    <div class="sheet-foot">
      <button class="btn btn-lg btn-block" data-submit>${STAFF ? 'Enviar a cocina' : 'Confirmar pedido'}</button>
    </div>`);

  const form = $('#checkout-form', sheet);

  function sync() {
    for (const el of form.elements) if (el.name) checkout[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    if (STAFF) { store.set(CUSTOMER_KEY, { fulfillment: checkout.fulfillment }); return; } // cada pedido es otro cliente
    store.set(CUSTOMER_KEY, {
      customer_name: checkout.customer_name, customer_phone: checkout.customer_phone,
      address: checkout.address, address_ref: checkout.address_ref, zone_id: checkout.zone_id,
      location: checkout.location, fulfillment: checkout.fulfillment, payment_method: checkout.payment_method,
    });
  }

  function update() {
    $$('[data-ful]', sheet).forEach((b) => b.classList.toggle('active', b.dataset.ful === checkout.fulfillment));
    if (checkout.payment_method === 'card' && checkout.fulfillment === 'delivery') checkout.payment_method = '';
    $$('[data-pay]', sheet).forEach((b) => b.classList.toggle('active', b.dataset.pay === checkout.payment_method));
    $('[data-pay="card"]', sheet)?.classList.toggle('hidden', checkout.fulfillment === 'delivery');
    $('[data-delivery]', sheet).classList.toggle('hidden', checkout.fulfillment !== 'delivery');
    $('[data-pickup]', sheet).classList.toggle('hidden', checkout.fulfillment !== 'pickup');
    $('[data-dinein]', sheet)?.classList.toggle('hidden', checkout.fulfillment !== 'dine_in');
    $('[data-opt-name]', sheet).classList.toggle('hidden', !(STAFF && checkout.fulfillment === 'dine_in'));
    $('[data-opt-phone]', sheet).classList.toggle('hidden', !(STAFF && checkout.fulfillment !== 'delivery'));
    $('[data-cash]', sheet).classList.toggle('hidden', checkout.payment_method !== 'cash');
    $('[data-transfer]', sheet).classList.toggle('hidden', checkout.payment_method !== 'transfer');

    const feeLabel = $('[data-fee-label]', sheet);
    if (feeLabel) {
      const freeOver = Number(S.free_delivery_over) || 0;
      feeLabel.textContent = freeOver > 0 && subtotal() >= freeOver ? '¡Envío gratis!'
        : byDistance() ? 'Según distancia' : menu.zones.length ? 'Costo según zona' : `Envío ${money(S.delivery_flat_fee)}`;
    }

    const sub = subtotal();
    const fee = deliveryFee(sub);
    const total = sub + (fee || 0);
    $('[data-totals]', sheet).innerHTML = `
      <div class="row"><span>Subtotal</span><span>${money(sub)}</span></div>
      ${checkout.fulfillment === 'delivery' ? `<div class="row"><span>Envío</span><span>${fee === null ? `<span class="muted">${byDistance() ? 'Marca tu ubicación' : 'Elige tu zona'}</span>` : fee > 0 ? money(fee) : 'Gratis'}</span></div>` : ''}
      <div class="row total"><span>Total</span><span>${money(total)}</span></div>
      ${Number(S.free_delivery_over) > 0 && checkout.fulfillment === 'delivery' && sub < Number(S.free_delivery_over)
        ? `<p class="muted small">Agrega ${money(Number(S.free_delivery_over) - sub)} más y tu envío es gratis.</p>` : ''}`;
    $('[data-submit]', sheet).textContent = `${STAFF ? 'Enviar a cocina' : 'Confirmar pedido'} · ${money(total)}`;
    if (byDistance() && checkout.fulfillment === 'delivery') ensureMap();
  }

  /* ---------- Mapa (envío por distancia) ---------- */
  let picker = null, mapStarting = false, quoteSeq = 0, autoAddress = '';

  async function ensureMap() {
    if (picker) { picker.refresh(); return; }
    if (mapStarting) return;
    mapStarting = true;
    try {
      picker = await createMap($('[data-map]', sheet), {
        store: storePoint(), pin: checkout.location, onPick: pick, storeLabel: S.business_name,
      });
      $('.map-loading', sheet)?.remove();
      if (checkout.location) requestQuote(checkout.location);
    } catch (e) {
      $('[data-map]', sheet).innerHTML = `<div class="map-loading">${esc(e.message)}</div>`;
    } finally { mapStarting = false; }
  }

  function pick(point) {
    checkout.location = point;
    sync();
    requestQuote(point);
    fillAddress(point);
  }

  async function fillAddress(point) {
    const ta = $('#c-address', sheet);
    if (ta.value.trim() && ta.value !== autoAddress) return; // ya la escribió el cliente
    const text = await reverseAddress(point);
    if (!text || (ta.value.trim() && ta.value !== autoAddress)) return;
    autoAddress = ta.value = text;
    sync();
  }

  async function requestQuote(point) {
    const seq = ++quoteSeq;
    const box = $('[data-quote]', sheet);
    box.className = 'quote-box';
    box.textContent = 'Calculando envío…';
    quote = null;
    update();
    try {
      const q = await api(`${API}/delivery-quote`, { method: 'POST', body: point });
      if (seq !== quoteSeq) return;
      quote = q;
      box.className = `quote-box ${q.available ? 'ok' : 'warn'}`;
      box.innerHTML = q.available
        ? `🛵 ${STAFF ? 'Está' : 'Estás'} a <strong>${q.distance_km} km</strong> · Envío <strong>${money(q.fee)}</strong>`
        : esc(q.message);
    } catch (e) {
      if (seq !== quoteSeq) return;
      box.className = 'quote-box warn';
      box.textContent = e.message;
    }
    update();
  }

  async function doSearch() {
    const input = $('#c-search', sheet);
    const q = input.value.trim();
    const list = $('[data-results]', sheet);
    if (q.length < 3) { input.focus(); return; }
    list.classList.remove('hidden');
    list.innerHTML = '<div class="muted small">Buscando…</div>';
    try {
      const results = await searchAddress(q, storePoint());
      list.innerHTML = results.length
        ? results.map((r, i) => `<button type="button" data-result="${i}">📍 ${esc(r.label)}</button>`).join('')
        : '<div class="muted small">No encontramos esa dirección. Prueba con calle y colonia, o toca el mapa.</div>';
      list._results = results;
    } catch (e) {
      list.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
    }
  }

  form.addEventListener('input', () => { sync(); update(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('#c-search', sheet)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ful) { checkout.fulfillment = t.dataset.ful; sync(); update(); }
    if (t.dataset.pay) { checkout.payment_method = t.dataset.pay; sync(); update(); }
    if ('search' in t.dataset) doSearch();
    if (t.dataset.result) {
      const list = $('[data-results]', sheet);
      const r = list._results?.[Number(t.dataset.result)];
      list.classList.add('hidden');
      if (r) picker?.set(r);
    }
    if ('locate' in t.dataset) {
      t.disabled = true;
      t.textContent = '🎯 Buscando tu ubicación…';
      currentPosition().then((p) => picker?.set(p)).catch((err) => toast(err.message, 4000))
        .finally(() => { t.disabled = false; t.textContent = '🎯 Usar mi ubicación actual'; });
    }
    if ('back' in t.dataset) openCart();
    if ('submit' in t.dataset) submit();
  });

  function fail(msg, field) {
    const box = $('[data-error]', sheet);
    box.textContent = msg;
    box.classList.remove('hidden');
    const el = field ? $(`[name="${field}"]`, form) : box;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (field) el?.focus({ preventScroll: true });
  }

  let sending = false;
  async function submit() {
    if (sending) return;
    sync();
    $('[data-error]', sheet).classList.add('hidden');
    const dineIn = STAFF && checkout.fulfillment === 'dine_in';
    if (dineIn && !String(checkout.table).trim()) return fail('Escribe el número de mesa', 'table');
    if (!dineIn && checkout.customer_name.trim().length < 2) return fail(STAFF ? 'Escribe el nombre del cliente' : 'Escribe tu nombre', 'customer_name');
    if (dineIn && checkout.customer_name.trim().length === 1) return fail('Escribe el nombre completo o déjalo vacío', 'customer_name');
    const phoneDigits = checkout.customer_phone.replace(/\D/g, '').length;
    const phoneNeeded = !STAFF || checkout.fulfillment === 'delivery' || phoneDigits > 0;
    if (phoneNeeded && phoneDigits < 8) return fail('Escribe un teléfono válido', 'customer_phone');
    if (checkout.fulfillment === 'delivery') {
      if (byDistance()) {
        if (!checkout.location) return fail('Marca en el mapa a dónde te lo llevamos');
        if (!quote) return fail('Espera a que calculemos el costo del envío');
        if (!quote.available) return fail(quote.message);
      } else if (menu.zones.length && !checkout.zone_id) return fail('Elige tu zona de entrega', 'zone_id');
      if (checkout.address.trim().length < 5) return fail('Escribe tu dirección completa', 'address');
    }
    if (!checkout.payment_method) return fail('Elige un método de pago');

    const btn = $('[data-submit]', sheet);
    sending = true;
    btn.disabled = true;
    btn.textContent = 'Enviando pedido…';
    try {
      const res = await api(`${API}/orders`, {
        method: 'POST',
        body: {
          items: cart.map((i) => ({ product_id: i.product_id, quantity: i.quantity, toppings: i.toppings, note: i.note })),
          customer_name: checkout.customer_name,
          customer_phone: checkout.customer_phone,
          fulfillment: checkout.fulfillment,
          zone_id: checkout.zone_id ? Number(checkout.zone_id) : null,
          location: byDistance() ? checkout.location : null,
          address: checkout.address,
          address_ref: checkout.address_ref,
          payment_method: checkout.payment_method,
          cash_amount: checkout.payment_method === 'cash' && checkout.cash_amount ? Number(checkout.cash_amount) : null,
          notes: checkout.notes,
          ...(STAFF ? { table: checkout.table, paid: !!checkout.paid, taken_by: store.get(WAITER_KEY, '') } : {}),
        },
      });
      if (STAFF) return staffSent(res);
      cart = [];
      store.del(CART_KEY);
      store.set(LAST_ORDER_KEY, { token: res.token, id: res.id });
      location.href = `/pedido.html?t=${encodeURIComponent(res.token)}&nuevo=1`;
    } catch (e) {
      sending = false;
      btn.disabled = false;
      update();
      if (STAFF && e.status === 401) { closeSheet(); return staffLogin(); }
      fail(e.message);
      if (/disponible|carrito/i.test(e.message)) {
        // El menú cambió: recargar datos
        menu = await api(`${API}/menu`).catch(() => menu);
        S = menu.settings;
        sanitizeCart();
      }
    }
  }

  update();
}

/* ============================== Modo mesero ============================== */

function staffLogin() {
  $('#staff-bar')?.classList.add('hidden');
  $('#cats').innerHTML = '';
  $('#cart-bar').classList.add('hidden');
  $('#menu').innerHTML = `
    <form class="staff-login" id="staff-login" novalidate>
      <img src="/logo.png" alt="Macaí Bowls" class="staff-login-logo">
      <h2>Modo mesero</h2>
      <p class="muted">Entra con la contraseña de meseros que te dio el encargado.</p>
      <input class="input" type="password" name="password" autocomplete="current-password" placeholder="Contraseña" required>
      <div class="error-msg hidden" data-error role="alert"></div>
      <button class="btn btn-lg btn-block">Entrar</button>
    </form>`;
  const form = $('#staff-login');
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    btn.disabled = true;
    try {
      await api(`${API}/login`, { method: 'POST', body: { password: form.elements.password.value } });
      init();
    } catch (ex) {
      btn.disabled = false;
      const box = $('[data-error]', form);
      box.textContent = ex.message;
      box.classList.remove('hidden');
    }
  });
}

function staffReady() {
  document.title = `Mesero · ${S.business_name}`;
  $('#staff-bar').classList.remove('hidden');
  renderWaiterName();
  if (!store.get(WAITER_KEY, '')) askWaiterName();
}

function renderWaiterName() {
  $('#waiter-name').textContent = store.get(WAITER_KEY, '') || 'Tu nombre';
}

function askWaiterName() {
  const sheet = openSheet(`
    <div class="sheet-title"><h2>¿Quién toma los pedidos?</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
    <form class="sheet-body" id="waiter-form" novalidate>
      <p class="muted" style="margin-top:0">Tu nombre aparece en cada pedido que envíes a cocina.</p>
      <input class="input" name="name" maxlength="40" autocomplete="given-name" placeholder="Ej. Ana" value="${esc(store.get(WAITER_KEY, ''))}">
    </form>
    <div class="sheet-foot"><button class="btn btn-lg btn-block" data-save>Guardar</button></div>`);
  const form = $('#waiter-form', sheet);
  const save = () => {
    const name = form.elements.name.value.trim();
    if (name.length < 2) { form.elements.name.focus(); return; }
    store.set(WAITER_KEY, name);
    renderWaiterName();
    closeSheet();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('[data-save]', sheet).addEventListener('click', save);
  setTimeout(() => form.elements.name.focus(), 50);
}

function staffSent(res) {
  cart = [];
  store.del(CART_KEY);
  Object.assign(checkout, { ...BLANK, fulfillment: checkout.fulfillment });
  saveCart();
  const sheet = openSheet(`
    <div class="sheet-body staff-sent">
      <div class="big">✅</div>
      <h2>Pedido #${res.id} enviado a cocina</h2>
      <p class="muted">${esc(res.fulfillment === 'dine_in' ? `Mesa ${res.table}` : res.customer_name)} · ${money(res.total)}${res.paid ? ' · pagado' : ''}</p>
    </div>
    <div class="sheet-foot">
      <button class="btn btn-light btn-lg" data-orders>Ver pedidos</button>
      <button class="btn btn-lg" style="flex:1" data-close>Nuevo pedido</button>
    </div>`);
  $('[data-orders]', sheet).addEventListener('click', openStaffOrders);
}

let ordersTimer = null;
async function openStaffOrders() {
  clearTimeout(ordersTimer);
  let list;
  try {
    list = await api(`${API}/orders`);
  } catch (e) {
    if (e.status === 401) { closeSheet(); return staffLogin(); }
    return toast(e.message, 4000);
  }
  const sheet = openSheet(`
    <div class="sheet-title"><h2>Pedidos en curso</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
    <div class="sheet-body">
      ${list.length ? list.map((o) => `
        <div class="staff-order s-${o.status}">
          <div class="staff-order-head">
            <strong>#${o.id}</strong>
            <span>${o.fulfillment === 'dine_in' ? `🍽️ Mesa ${esc(o.table)}` : o.fulfillment === 'pickup' ? '🥡 Para llevar' : '🛵 Domicilio'}</span>
            <span class="status-pill s-${o.status}">${esc(o.status_label)}</span>
          </div>
          <div class="muted small">${esc(o.customer_name)}${o.taken_by ? ` · tomó ${esc(o.taken_by)}` : ''} · ${money(o.total)} ${o.paid ? '· ✅ pagado' : '· sin pagar'}</div>
          <div class="small">${o.items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ')}</div>
          ${o.status === 'listo' && o.fulfillment !== 'delivery' ? `<button class="btn btn-sm" data-delivered="${o.id}">📦 Ya lo entregué</button>` : ''}
        </div>`).join('') : '<div class="empty"><div class="big">😌</div><p>No hay pedidos en curso.</p></div>'}
    </div>
    <div class="sheet-foot"><button class="btn btn-light btn-lg btn-block" data-refresh>↻ Actualizar</button></div>`, () => clearTimeout(ordersTimer));
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if ('refresh' in t.dataset) openStaffOrders();
    if (t.dataset.delivered) {
      t.disabled = true;
      try {
        await api(`${API}/orders/${t.dataset.delivered}/entregado`, { method: 'POST' });
        openStaffOrders();
      } catch (ex) { t.disabled = false; toast(ex.message, 4000); }
    }
  });
  ordersTimer = setTimeout(() => { if (document.body.contains(sheet)) openStaffOrders(); }, 20_000);
}

if (STAFF) {
  $('#staff-orders').addEventListener('click', openStaffOrders);
  $('#waiter-btn').addEventListener('click', askWaiterName);
  $('#staff-logout').addEventListener('click', async () => {
    if (!confirm('¿Cerrar sesión en este celular?')) return;
    await api(`${API}/logout`, { method: 'POST' }).catch(() => {});
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    staffLogin();
  });
}

init();
