import { $, $$, esc, money, setCurrency, api, toast, store, emojiFor } from './common.js';

const CART_KEY = 'macai_cart';
const CUSTOMER_KEY = 'macai_customer';
const LAST_ORDER_KEY = 'macai_last_order';

let menu = null;          // respuesta de /api/public/menu
let S = {};               // ajustes públicos
let cart = store.get(CART_KEY, []);
const checkout = Object.assign(
  { customer_name: '', customer_phone: '', address: '', address_ref: '', zone_id: '', fulfillment: '', payment_method: '', cash_amount: '', notes: '' },
  store.get(CUSTOMER_KEY, {}),
  { cash_amount: '', notes: '' },
);

/* ============================ Carga inicial ============================ */

async function init() {
  try {
    menu = await api('/api/public/menu');
  } catch (e) {
    $('#menu').innerHTML = `<div class="empty"><div class="big">😕</div><p>No pudimos cargar el menú.<br>${esc(e.message)}</p>
      <button class="btn" onclick="location.reload()">Reintentar</button></div>`;
    return;
  }
  S = menu.settings;
  setCurrency(S.locale, S.currency);
  document.title = `${S.business_name} · Haz tu pedido`;
  $('#biz-name').textContent = S.business_name;
  $('#biz-tagline').textContent = S.tagline || '';

  const meta = [];
  if (S.estimated_time) meta.push(`<span class="pill">⏱ ${esc(S.estimated_time)}</span>`);
  if (S.delivery_enabled === '1') meta.push('<span class="pill">🛵 Envío a domicilio</span>');
  if (S.pickup_enabled === '1') meta.push('<span class="pill">🏪 Recoger en tienda</span>');
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
  const closed = S.store_open !== '1';

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
          <textarea class="input" id="p-note" maxlength="200" placeholder="Ej. sin cebolla, aderezo aparte…">${esc(editing?.note || '')}</textarea>
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
        ? `🎁 Tu bowl incluye <strong>${n} ${n === 1 ? 'opción' : 'opciones'}</strong> sin costo. Te ${pricing.left === 1 ? 'queda' : 'quedan'} <strong>${pricing.left}</strong>.`
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

function deliveryFee(sub) {
  if (checkout.fulfillment !== 'delivery') return 0;
  const freeOver = Number(S.free_delivery_over) || 0;
  if (freeOver > 0 && sub >= freeOver) return 0;
  if (menu.zones.length) {
    const z = menu.zones.find((x) => x.id === Number(checkout.zone_id));
    return z ? z.fee : null; // null = falta elegir zona
  }
  return Number(S.delivery_flat_fee) || 0;
}

function openCart() {
  if (!cart.length) { closeSheet(); return; }
  const sheet = openSheet(`
    <div class="sheet-title"><h2>Tu pedido</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
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
      ${Number(S.min_order) > 0 && subtotal() < Number(S.min_order)
        ? `<div class="box warn">El pedido mínimo es de ${money(S.min_order)}. Te faltan ${money(Number(S.min_order) - subtotal())}.</div>` : ''}
    </div>
    <div class="sheet-foot">
      <button class="btn btn-lg btn-block" data-next ${S.store_open !== '1' || (Number(S.min_order) > 0 && subtotal() < Number(S.min_order)) ? 'disabled' : ''}>
        ${S.store_open !== '1' ? 'Estamos cerrados' : 'Continuar'}
      </button>
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
  const canPickup = S.pickup_enabled === '1';
  if (!checkout.fulfillment || (checkout.fulfillment === 'delivery' && !canDeliver) || (checkout.fulfillment === 'pickup' && !canPickup)) {
    checkout.fulfillment = canDeliver ? 'delivery' : 'pickup';
  }
  const canCash = S.cash_enabled === '1';
  const canTransfer = S.transfer_enabled === '1';
  if ((checkout.payment_method === 'cash' && !canCash) || (checkout.payment_method === 'transfer' && !canTransfer)) checkout.payment_method = '';
  if (!checkout.payment_method && canCash !== canTransfer) checkout.payment_method = canCash ? 'cash' : 'transfer';

  const sheet = openSheet(`
    <div class="sheet-title">
      <div class="steps-title"><button class="icon-btn" data-back aria-label="Regresar">‹</button><h2>Datos de entrega</h2></div>
      <button class="icon-btn" data-close aria-label="Cerrar">×</button>
    </div>
    <form class="sheet-body" id="checkout-form" novalidate>
      <div class="field">
        <label for="c-name">Tu nombre</label>
        <input class="input" id="c-name" name="customer_name" autocomplete="name" maxlength="80" required value="${esc(checkout.customer_name)}">
      </div>
      <div class="field">
        <label for="c-phone">Teléfono / WhatsApp</label>
        <input class="input" id="c-phone" name="customer_phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required value="${esc(checkout.customer_phone)}" placeholder="10 dígitos">
      </div>

      <div class="field">
        <span class="label">¿Cómo lo quieres?</span>
        <div class="choice-row">
          ${canDeliver ? `<button type="button" class="choice" data-ful="delivery"><span class="ico">🛵</span><strong>A domicilio</strong><small data-fee-label></small></button>` : ''}
          ${canPickup ? `<button type="button" class="choice" data-ful="pickup"><span class="ico">🏪</span><strong>Recoger</strong><small>Sin costo de envío</small></button>` : ''}
        </div>
      </div>

      <div data-delivery>
        ${menu.zones.length ? `
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
        ${S.pickup_address ? `<div class="box">📍 Recoges en: ${esc(S.pickup_address)}</div>` : ''}
      </div>

      <div class="field">
        <span class="label">Método de pago</span>
        <div class="choice-row">
          ${canCash ? '<button type="button" class="choice" data-pay="cash"><span class="ico">💵</span><strong>Efectivo</strong><small>Pagas al recibir</small></button>' : ''}
          ${canTransfer ? '<button type="button" class="choice" data-pay="transfer"><span class="ico">🏦</span><strong>Transferencia</strong><small>Te damos los datos</small></button>' : ''}
        </div>
      </div>
      <div data-cash class="field">
        <label for="c-cash">¿Con cuánto pagas? <span class="muted small">(opcional, para llevar cambio)</span></label>
        <input class="input" id="c-cash" name="cash_amount" type="number" inputmode="decimal" min="0" step="1" placeholder="Ej. 500" value="${esc(checkout.cash_amount)}">
      </div>
      <div data-transfer>
        ${S.bank_info ? `<div class="box"><strong>Datos para transferir</strong>\n${esc(S.bank_info)}</div>
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
      <button class="btn btn-lg btn-block" data-submit>Confirmar pedido</button>
    </div>`);

  const form = $('#checkout-form', sheet);

  function sync() {
    for (const el of form.elements) if (el.name) checkout[el.name] = el.value;
    store.set(CUSTOMER_KEY, {
      customer_name: checkout.customer_name, customer_phone: checkout.customer_phone,
      address: checkout.address, address_ref: checkout.address_ref, zone_id: checkout.zone_id,
      fulfillment: checkout.fulfillment, payment_method: checkout.payment_method,
    });
  }

  function update() {
    $$('[data-ful]', sheet).forEach((b) => b.classList.toggle('active', b.dataset.ful === checkout.fulfillment));
    $$('[data-pay]', sheet).forEach((b) => b.classList.toggle('active', b.dataset.pay === checkout.payment_method));
    $('[data-delivery]', sheet).classList.toggle('hidden', checkout.fulfillment !== 'delivery');
    $('[data-pickup]', sheet).classList.toggle('hidden', checkout.fulfillment !== 'pickup');
    $('[data-cash]', sheet).classList.toggle('hidden', checkout.payment_method !== 'cash');
    $('[data-transfer]', sheet).classList.toggle('hidden', checkout.payment_method !== 'transfer');

    const feeLabel = $('[data-fee-label]', sheet);
    if (feeLabel) {
      const freeOver = Number(S.free_delivery_over) || 0;
      feeLabel.textContent = freeOver > 0 && subtotal() >= freeOver ? '¡Envío gratis!'
        : menu.zones.length ? 'Costo según zona' : `Envío ${money(S.delivery_flat_fee)}`;
    }

    const sub = subtotal();
    const fee = deliveryFee(sub);
    const total = sub + (fee || 0);
    $('[data-totals]', sheet).innerHTML = `
      <div class="row"><span>Subtotal</span><span>${money(sub)}</span></div>
      ${checkout.fulfillment === 'delivery' ? `<div class="row"><span>Envío</span><span>${fee === null ? '<span class="muted">Elige tu zona</span>' : fee > 0 ? money(fee) : 'Gratis'}</span></div>` : ''}
      <div class="row total"><span>Total</span><span>${money(total)}</span></div>
      ${Number(S.free_delivery_over) > 0 && checkout.fulfillment === 'delivery' && sub < Number(S.free_delivery_over)
        ? `<p class="muted small">Agrega ${money(Number(S.free_delivery_over) - sub)} más y tu envío es gratis.</p>` : ''}`;
    $('[data-submit]', sheet).textContent = `Confirmar pedido · ${money(total)}`;
  }

  form.addEventListener('input', () => { sync(); update(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.ful) { checkout.fulfillment = t.dataset.ful; sync(); update(); }
    if (t.dataset.pay) { checkout.payment_method = t.dataset.pay; sync(); update(); }
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
    if (checkout.customer_name.trim().length < 2) return fail('Escribe tu nombre', 'customer_name');
    if (checkout.customer_phone.replace(/\D/g, '').length < 8) return fail('Escribe un teléfono válido', 'customer_phone');
    if (checkout.fulfillment === 'delivery') {
      if (menu.zones.length && !checkout.zone_id) return fail('Elige tu zona de entrega', 'zone_id');
      if (checkout.address.trim().length < 5) return fail('Escribe tu dirección completa', 'address');
    }
    if (!checkout.payment_method) return fail('Elige un método de pago');

    const btn = $('[data-submit]', sheet);
    sending = true;
    btn.disabled = true;
    btn.textContent = 'Enviando pedido…';
    try {
      const res = await api('/api/public/orders', {
        method: 'POST',
        body: {
          items: cart.map((i) => ({ product_id: i.product_id, quantity: i.quantity, toppings: i.toppings, note: i.note })),
          customer_name: checkout.customer_name,
          customer_phone: checkout.customer_phone,
          fulfillment: checkout.fulfillment,
          zone_id: checkout.zone_id ? Number(checkout.zone_id) : null,
          address: checkout.address,
          address_ref: checkout.address_ref,
          payment_method: checkout.payment_method,
          cash_amount: checkout.payment_method === 'cash' && checkout.cash_amount ? Number(checkout.cash_amount) : null,
          notes: checkout.notes,
        },
      });
      cart = [];
      store.del(CART_KEY);
      store.set(LAST_ORDER_KEY, { token: res.token, id: res.id });
      location.href = `/pedido.html?t=${encodeURIComponent(res.token)}&nuevo=1`;
    } catch (e) {
      sending = false;
      btn.disabled = false;
      update();
      fail(e.message);
      if (/disponible|carrito/i.test(e.message)) {
        // El menú cambió: recargar datos
        menu = await api('/api/public/menu').catch(() => menu);
        S = menu.settings;
        sanitizeCart();
      }
    }
  }

  update();
}

init();
