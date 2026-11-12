import { $, $$, esc, money, setCurrency, api, toast, store, emojiFor } from '/common.js';
import { createMap, searchAddress } from '/map.js';

/* ================================ Constantes ================================ */

const STATUS = {
  nuevo: 'Nuevo', preparando: 'Preparando', listo: 'Listo',
  en_camino: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado',
};
const NEXT = {
  delivery: { nuevo: 'preparando', preparando: 'listo', listo: 'en_camino', en_camino: 'entregado' },
  pickup: { nuevo: 'preparando', preparando: 'listo', listo: 'entregado' },
  dine_in: { nuevo: 'preparando', preparando: 'listo', listo: 'entregado' },
};
const PAY_ICON = { cash: '💵', transfer: '🏦', card: '💳' };
const PAY_LABEL = { cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta en sucursal' };
const NEXT_LABEL = { preparando: '👩‍🍳 Preparar', listo: '✅ Listo', en_camino: '🛵 Enviar', entregado: '📦 Entregado' };
const POLL_MS = 10_000;

let settings = {};
let tab = 'orders';
let orderView = store.get('adm_order_view', 'active');
let knownIds = null;
let soundOn = store.get('adm_sound', false);
let audioCtx = null;
let pollTimer = null;
let pendingNew = 0;
const baseTitle = document.title;

const view = $('#view');

/* ================================== API ================================== */

async function A(path, opts) {
  try {
    return await api('/api/admin' + path, opts);
  } catch (e) {
    if (e.status === 401) showLogin();
    throw e;
  }
}

/* ============================ Login / arranque ============================ */

function showLogin() {
  clearInterval(pollTimer);
  pollTimer = null;
  knownIds = null;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#pw').focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

async function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadSettings();
  updateSoundBtn();
  setTab(location.hash.replace('#', '') || 'orders');
  startPolling();
  refreshInvBadge();
}

async function loadSettings() {
  settings = await A('/settings');
  setCurrency(settings.locale, settings.currency);
  $('#top-name').textContent = 'Panel';
  $('#store-open').checked = settings.store_open === '1';
  $('#store-open-label').textContent = settings.store_open === '1' ? 'Abierto' : 'Cerrado';
}

$('#store-open').addEventListener('change', async (e) => {
  const open = e.target.checked;
  try {
    settings = await A('/settings', { method: 'PUT', body: { store_open: open ? '1' : '0' } });
    $('#store-open-label').textContent = open ? 'Abierto' : 'Cerrado';
    toast(open ? '🟢 Tienda abierta: ya puedes recibir pedidos' : '🔴 Tienda cerrada: no se aceptan pedidos');
  } catch (ex) {
    e.target.checked = !open;
    toast(ex.message);
  }
});

/* ================================ Pestañas ================================ */

const TABS = { orders: renderOrders, menu: renderMenu, toppings: renderToppings, inventory: renderInventory, delivery: renderDelivery, settings: renderSettings };

function setTab(name) {
  if (!TABS[name]) name = 'orders';
  tab = name;
  history.replaceState(null, '', `#${name}`);
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'orders') clearNewAlert();
  view.innerHTML = '<div class="spinner"></div>';
  window.scrollTo(0, 0);
  TABS[name]().catch((e) => {
    if (e.status !== 401) view.innerHTML = `<div class="panel">⚠️ ${esc(e.message)} <button class="btn btn-sm" data-retry>Reintentar</button></div>`;
  });
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
view.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) setTab(tab); });
window.addEventListener('hashchange', () => {
  const name = location.hash.replace('#', '');
  if (name !== tab && !$('#app').classList.contains('hidden')) setTab(name);
});

/* ============================ Alertas de pedidos ============================ */

function updateSoundBtn() {
  $('#sound-btn').textContent = soundOn ? '🔔' : '🔕';
  $('#sound-btn').title = soundOn ? 'Sonido activado' : 'Activar sonido de nuevos pedidos';
}

$('#sound-btn').addEventListener('click', async () => {
  soundOn = !soundOn;
  store.set('adm_sound', soundOn);
  updateSoundBtn();
  if (soundOn) {
    ensureAudio();
    beep();
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission().catch(() => {});
    }
    toast('🔔 Te avisaremos con sonido cuando llegue un pedido (deja esta pestaña abierta)');
  }
});

function ensureAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sin audio */ }
}
// Los navegadores solo permiten audio después de una interacción
document.addEventListener('pointerdown', () => { if (soundOn) ensureAudio(); }, { once: true });

function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((d, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = i === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.22);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.25);
  });
}

function newOrderAlert(orders) {
  pendingNew += orders.length;
  document.title = `(${pendingNew}) 🔔 Nuevo pedido · ${baseTitle}`;
  if (soundOn) { ensureAudio(); beep(); }
  navigator.vibrate?.([200, 100, 200]);
  const o = orders[0];
  toast(`🔔 Nuevo pedido #${o.id} · ${o.customer.name} · ${money(o.total)}`, 5000);
  if (soundOn && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(`Nuevo pedido #${o.id}`, { body: `${o.customer.name} · ${money(o.total)}`, tag: `order-${o.id}` }); } catch { /* móvil */ }
  }
}

function clearNewAlert() {
  pendingNew = 0;
  document.title = baseTitle;
}

function updateBadge(active) {
  const n = active.filter((o) => o.status === 'nuevo').length;
  const b = $('#new-badge');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

async function poll() {
  try {
    const { data } = await A('/orders?view=active');
    updateBadge(data);
    const fresh = knownIds ? data.filter((o) => !knownIds.has(o.id) && o.status === 'nuevo') : [];
    knownIds = new Set([...(knownIds || []), ...data.map((o) => o.id)]);
    if (fresh.length) newOrderAlert(fresh);
    if (tab === 'orders' && (fresh.length || orderView === 'active') && !document.querySelector('.sheet-backdrop')) {
      if (orderView === 'active') renderOrderList(data, fresh.map((o) => o.id));
      else if (fresh.length) refreshOrders();
      refreshStats();
    }
  } catch { /* reintenta en el siguiente ciclo */ }
}

function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollTimer) { poll(); if (tab === 'orders') clearNewAlert(); }
});

/* ================================= Pedidos ================================= */

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function renderOrders() {
  view.innerHTML = `
    <div class="view-head">
      <h2>Pedidos</h2>
      <div class="filters">
        ${[['active', 'Activos'], ['today', 'Hoy'], ['history', 'Historial']].map(([k, l]) =>
          `<button class="chip${orderView === k ? ' active' : ''}" data-view="${k}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="stats" id="stats"></div>
    <div id="order-list"><div class="spinner"></div></div>`;
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => {
    orderView = b.dataset.view;
    store.set('adm_order_view', orderView);
    $$('[data-view]', view).forEach((x) => x.classList.toggle('active', x === b));
    refreshOrders();
  }));
  await Promise.all([refreshOrders(), refreshStats()]);
}

async function refreshStats() {
  const el = $('#stats');
  if (!el) return;
  const s = await A(`/summary?from=${encodeURIComponent(startOfToday())}`);
  el.innerHTML = `
    <div class="stat"><small>Pedidos hoy</small><strong>${s.orders}</strong></div>
    <div class="stat"><small>Ventas hoy</small><strong>${money(s.total)}</strong></div>
    <div class="stat"><small>Por cobrar</small><strong>${money(s.unpaid_total)}</strong></div>
    <div class="stat"><small>Ticket promedio</small><strong>${money(s.average_ticket)}</strong></div>`;
}

async function refreshOrders() {
  const q = orderView === 'active' ? 'view=active'
    : orderView === 'today' ? `from=${encodeURIComponent(startOfToday())}` : 'limit=200';
  const { data } = await A(`/orders?${q}`);
  renderOrderList(data);
}

function renderOrderList(orders, flashIds = []) {
  const el = $('#order-list');
  if (!el) return;
  if (!orders.length) {
    el.innerHTML = `<div class="panel empty"><div class="big">${orderView === 'active' ? '😌' : '📭'}</div>
      <p>${orderView === 'active' ? 'No hay pedidos activos. Los nuevos aparecerán aquí automáticamente.' : 'No hay pedidos en este periodo.'}</p></div>`;
    return;
  }
  el.innerHTML = `<div class="orders">${orders.map((o) => orderCard(o, flashIds.includes(o.id))).join('')}</div>`;
}

function orderCard(o, flash) {
  const next = NEXT[o.fulfillment]?.[o.status];
  const phone = o.customer.phone.replace(/[^\d+]/g, '');
  const waPhone = phone.replace(/\D/g, '');
  return `
  <article class="order s-${o.status}${flash ? ' flash' : ''}" data-id="${o.id}">
    <div class="order-head">
      <h3>#${o.id}</h3>
      <span class="muted small">${timeAgo(o.created_at)}</span>
      <span class="status-badge s-${o.status}">${STATUS[o.status]}</span>
    </div>
    <div class="order-body">
      ${o.source === 'mesero' ? `<div class="row"><span>🧑‍🍳</span><div class="muted small">Lo tomó <strong>${esc(o.taken_by || 'mesero')}</strong></div></div>` : ''}
      <div class="row"><span>👤</span><div><strong>${esc(o.customer.name)}</strong>
        ${phone ? `<span class="contact-links"><a href="tel:${esc(phone)}">📞 ${esc(o.customer.phone)}</a>
        <a href="https://wa.me/${esc(waPhone.length === 10 ? '52' + waPhone : waPhone)}" target="_blank" rel="noopener">WhatsApp</a></span>` : ''}</div></div>
      ${o.fulfillment === 'delivery'
        ? `<div class="row"><span>🛵</span><div>${esc(o.address)}${o.zone ? ` <span class="muted">(${esc(o.zone.name)})</span>` : ''}${o.location ? ` <span class="muted">· ${o.location.distance_km} km</span>` : ''}
            ${o.address_ref ? `<div class="muted small">${esc(o.address_ref)}</div>` : ''}
            <a class="small" href="https://www.google.com/maps/search/?api=1&query=${o.location ? `${o.location.lat},${o.location.lng}` : encodeURIComponent(o.address)}" target="_blank" rel="noopener">${o.location ? '📍 Ver ubicación en el mapa' : 'Ver en mapa'}</a></div></div>`
        : o.fulfillment === 'dine_in'
          ? `<div class="row"><span>🍽️</span><div><strong>Comer aquí · Mesa ${esc(o.table)}</strong></div></div>`
          : `<div class="row"><span>🏪</span><div><strong>${o.source === 'mesero' ? 'Para llevar' : 'Recoge en tienda'}</strong></div></div>`}
      <div class="order-items">
        ${o.items.map((i) => `
          <div class="it"><strong>${i.quantity}×</strong> ${esc(i.name)} <span class="muted" style="float:right">${money(i.line_total)}</span></div>
          ${i.toppings.length ? `<div class="extra">+ ${i.toppings.map((t) => esc(t.name) + (t.price > 0 ? ` (+${money(t.price)})` : "")).join(', ')}</div>` : ''}
          ${i.note ? `<div class="note">📝 ${esc(i.note)}</div>` : ''}`).join('')}
      </div>
      ${o.notes ? `<div class="row"><span>💬</span><div style="color:#b35c00;font-weight:600">${esc(o.notes)}</div></div>` : ''}
      <div class="row muted small"><span></span><div>Subtotal ${money(o.subtotal)}${o.fulfillment === 'delivery' ? ` · Envío ${money(o.delivery_fee)}` : ''}</div></div>
      <div class="order-total"><span>Total</span><span>${money(o.total)}</span></div>
      <div class="row" style="align-items:center;margin-top:6px">
        <span>${PAY_ICON[o.payment_method] || '💰'}</span>
        <div style="flex:1">${PAY_LABEL[o.payment_method] || esc(o.payment_method)}
          ${o.cash_amount ? `<div class="muted small">Paga con ${money(o.cash_amount)} · <strong>cambio ${money(o.change_due)}</strong></div>` : ''}</div>
        <button class="paid-chip ${o.paid ? 'yes' : 'no'}" data-action="paid" title="Cambiar estado de pago">${o.paid ? '✓ Pagado' : 'Sin pagar'}</button>
      </div>
    </div>
    ${o.fulfillment === 'delivery' && o.driver_text ? `
    <div class="order-driver">
      <span class="muted small">Grupo de repartidores:</span>
      <button class="btn btn-light btn-sm" data-action="driver-copy" data-text="${esc(o.driver_text)}">📋 Copiar</button>
      <a class="btn btn-light btn-sm" href="https://wa.me/?text=${encodeURIComponent(o.driver_text)}" target="_blank" rel="noopener">📤 Enviar por WhatsApp</a>
    </div>` : ''}
    <div class="order-foot">
      ${next ? `<button class="btn btn-sm" data-action="next" data-status="${next}">${NEXT_LABEL[next]}</button>` : ''}
      <select data-action="status" aria-label="Cambiar estado">
        ${Object.entries(STATUS).filter(([k]) => o.fulfillment === 'delivery' || k !== 'en_camino')
          .map(([k, l]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
  </article>`;
}

async function patchOrder(id, body) {
  const o = await A(`/orders/${id}`, { method: 'PATCH', body });
  const card = $(`.order[data-id="${id}"]`);
  const leaving = orderView === 'active' && ['entregado', 'cancelado'].includes(o.status);
  if (card) {
    if (leaving) card.remove();
    else card.outerHTML = orderCard(o);
  }
  if (orderView === 'active' && !$('.order')) renderOrderList([]);
  refreshStats();
  poll();
  return o;
}

view.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.tagName === 'SELECT') return;
  if (btn.dataset.action === 'driver-copy') {
    copy(btn.dataset.text, '📋 Copiado: pégalo en el grupo de repartidores');
    return;
  }
  const id = btn.closest('.order')?.dataset.id;
  if (!id) return;
  btn.disabled = true;
  try {
    if (btn.dataset.action === 'next') {
      await patchOrder(id, { status: btn.dataset.status });
      toast(`Pedido #${id}: ${STATUS[btn.dataset.status]}`);
    } else if (btn.dataset.action === 'paid') {
      const paid = !btn.classList.contains('yes');
      await patchOrder(id, { paid });
    }
  } catch (ex) {
    toast(ex.message);
    btn.disabled = false;
  }
});

view.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-action="status"]');
  if (!sel) return;
  const id = sel.closest('.order').dataset.id;
  if (sel.value === 'cancelado' && !confirm(`¿Cancelar el pedido #${id}?`)) { refreshOrders(); return; }
  try {
    await patchOrder(id, { status: sel.value });
    toast(`Pedido #${id}: ${STATUS[sel.value]}`);
  } catch (ex) { toast(ex.message); }
});

/* ======================= Hoja modal y formularios genéricos ======================= */

function openSheet(html) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop" role="dialog" aria-modal="true"><div class="sheet">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const bd = root.firstElementChild;
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeSheet));
  return bd.firstElementChild;
}
function closeSheet() {
  $('#sheet-root').innerHTML = '';
  document.body.style.overflow = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

/**
 * Campos: { name, label, type: text|number|textarea|select|checkbox|checks|image|password|url, options, hint, placeholder, step }
 */
function fieldHtml(f, value) {
  const id = `f-${f.name}`;
  const hint = f.hint ? `<div class="hint">${f.hint}</div>` : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  switch (f.type) {
    case 'hidden':
      return `<input type="hidden" name="${f.name}" value="${esc(value ?? '')}">`;
    case 'checkbox':
      return `<label class="check-field"><input type="checkbox" name="${f.name}" ${value === true || value === '1' || value === 1 ? 'checked' : ''}> <span>${esc(f.label)}</span></label>${hint}`;
    case 'textarea':
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea class="input" id="${id}" name="${f.name}" rows="${f.rows || 3}"${ph}>${esc(value ?? '')}</textarea>${hint}</div>`;
    case 'select':
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><select class="input" id="${id}" name="${f.name}">
        ${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>${hint}</div>`;
    case 'checks':
      return `<div class="field"><span class="label">${esc(f.label)}</span>${hint}<div class="check-list" data-checks="${f.name}">
        ${f.options.length ? f.options.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${(value || []).map(String).includes(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')
          : '<span class="muted small">No hay opciones todavía.</span>'}
      </div></div>`;
    case 'image':
      return `<div class="field"><span class="label">${esc(f.label)}</span><div class="img-field">
        ${value ? `<img class="preview" src="${esc(value)}" alt="">` : '<div class="preview">📷</div>'}
        <div style="flex:1">
          <input type="hidden" name="${f.name}" value="${esc(value || '')}">
          <label class="btn btn-light btn-sm" style="cursor:pointer">Subir foto<input type="file" accept="image/*" data-upload hidden></label>
          <button type="button" class="btn btn-ghost btn-sm${value ? '' : ' hidden'}" data-clear-img>Quitar</button>
          <div class="hint">JPG, PNG o WEBP · se ajusta sola al subirla</div>
        </div></div></div>`;
    default:
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}"
        ${f.type === 'number' ? `inputmode="decimal" step="${f.step || 'any'}" min="0"` : ''} value="${esc(value ?? '')}"${ph} ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>${hint}</div>`;
  }
}

function collect(form, fields, { checkboxAs = 'bool' } = {}) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'checks') {
      out[f.name] = $$(`[data-checks="${f.name}"] input:checked`, form).map((i) => Number(i.value));
    } else if (f.type === 'checkbox') {
      const c = form.elements[f.name].checked;
      out[f.name] = checkboxAs === 'flag' ? (c ? '1' : '0') : c;
    } else if (f.type === 'note') {
      continue;
    } else {
      out[f.name] = form.elements[f.name].value;
    }
  }
  return out;
}

/**
 * Reduce la foto en el navegador (máx. 1600 px, WebP/JPEG) antes de subirla:
 * sube más rápido desde el celular y respeta el límite de tamaño de AWS Lambda.
 */
async function shrinkImage(file, maxSide = 1600) {
  if (file.type === 'image/gif' || !/^image\//.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 700 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const toBlob = (type) => new Promise((res) => canvas.toBlob(res, type, 0.85));
    let blob = await toBlob('image/webp');
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg');
    return blob && blob.size < file.size ? new File([blob], 'foto' + (blob.type === 'image/webp' ? '.webp' : '.jpg'), { type: blob.type }) : file;
  } catch {
    return file;
  }
}

function wireImageFields(root) {
  $$('[data-upload]', root).forEach((input) => input.addEventListener('change', async () => {
    const original = input.files[0];
    if (!original) return;
    const box = input.closest('.img-field');
    box.querySelector('.hint').textContent = 'Preparando foto…';
    const file = await shrinkImage(original);
    if (file.size > 4 * 1024 * 1024) {
      box.querySelector('.hint').textContent = '⚠️ La foto es demasiado grande (máx. 4 MB)';
      input.value = '';
      return;
    }
    const fd = new FormData();
    fd.append('image', file);
    box.querySelector('.hint').textContent = 'Subiendo…';
    try {
      const { url } = await A('/upload', { method: 'POST', body: fd });
      box.querySelector('input[type=hidden]').value = url;
      box.querySelector('.preview').outerHTML = `<img class="preview" src="${esc(url)}" alt="">`;
      box.querySelector('[data-clear-img]').classList.remove('hidden');
      box.querySelector('.hint').textContent = '✓ Foto lista';
    } catch (e) {
      box.querySelector('.hint').textContent = `⚠️ ${e.message}`;
    }
    input.value = '';
  }));
  $$('[data-clear-img]', root).forEach((b) => b.addEventListener('click', () => {
    const box = b.closest('.img-field');
    box.querySelector('input[type=hidden]').value = '';
    box.querySelector('.preview').outerHTML = '<div class="preview">📷</div>';
    b.classList.add('hidden');
  }));
}

function openForm({ title, fields, values = {}, submitLabel = 'Guardar', onSubmit, onDelete, deleteConfirm }) {
  const sheet = openSheet(`
    <div class="sheet-title"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
    <form class="sheet-body" novalidate>
      ${fields.map((f) => fieldHtml(f, values[f.name])).join('')}
      <div class="error-msg hidden" data-error role="alert"></div>
    </form>
    <div class="sheet-foot">
      ${onDelete ? '<button class="btn btn-danger" data-delete>Eliminar</button>' : ''}
      <button class="btn btn-lg" style="flex:1" data-save>${esc(submitLabel)}</button>
    </div>`);
  const form = $('form', sheet);
  wireImageFields(sheet);
  setTimeout(() => form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=file]), textarea')?.focus(), 60);

  const error = (m) => { const b = $('[data-error]', sheet); b.textContent = m; b.classList.remove('hidden'); };
  const save = async () => {
    const btn = $('[data-save]', sheet);
    btn.disabled = true;
    try {
      await onSubmit(collect(form, fields));
      closeSheet();
    } catch (e) {
      error(e.message);
      btn.disabled = false;
    }
  };
  $('[data-save]', sheet).addEventListener('click', save);
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('[data-delete]', sheet)?.addEventListener('click', async () => {
    if (!confirm(deleteConfirm || '¿Seguro que quieres eliminarlo? No se puede deshacer.')) return;
    try {
      await onDelete();
      closeSheet();
    } catch (e) { error(e.message); }
  });
}

/** Panel de ajustes en línea (se guardan en /settings). */
function settingsPanel({ id, title, desc = '', fields, extra = '', two = false }) {
  return `
  <form class="panel" data-settings="${id}" novalidate>
    <h3>${esc(title)}</h3>
    ${desc ? `<p class="muted">${desc}</p>` : ''}
    <div class="form-grid${two ? ' two' : ''}">${fields.map((f) => fieldHtml(f, settings[f.name])).join('')}</div>
    ${extra}
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn">Guardar</button></div>
  </form>`;
}

function wireSettings(defs) {
  for (const def of defs) {
    const form = $(`[data-settings="${def.id}"]`);
    if (!form) continue;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button:not([type=button])', form);
      btn.disabled = true;
      try {
        settings = await A('/settings', { method: 'PUT', body: collect(form, def.fields, { checkboxAs: 'flag' }) });
        setCurrency(settings.locale, settings.currency);
        $('#top-name').textContent = 'Panel';
        toast('✓ Cambios guardados');
      } catch (ex) { toast(ex.message, 4000); }
      btn.disabled = false;
    });
  }
}

const copy = async (text, msg = 'Copiado') => {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copia este texto:', text); }
};

/* ================================== Menú ================================== */

async function renderMenu() {
  const [cats, products, groups] = await Promise.all([A('/categories'), A('/products'), A('/topping-groups')]);
  const catName = (id) => cats.find((c) => c.id === id)?.name;
  const groupOptions = groups.map((g) => ({ value: g.id, label: `${g.name} (${g.toppings.length} opciones)` }));

  const productFields = () => [
    { name: 'name', label: 'Nombre', placeholder: 'Ej. Bowl Grande' },
    { name: 'description', label: 'Descripción', type: 'textarea', rows: 2, placeholder: 'Ingredientes, porción…' },
    { name: 'price', label: 'Precio', type: 'number', step: '0.5' },
    { name: 'category_id', label: 'Categoría', type: 'select', options: [{ value: '', label: '— Sin categoría —' }, ...cats.map((c) => ({ value: c.id, label: c.name }))] },
    { name: 'image', label: 'Foto', type: 'image' },
    { name: 'topping_group_ids', label: 'Toppings / opciones', type: 'checks', options: groupOptions,
      hint: 'Elige qué grupos de opciones puede personalizar el cliente. Los grupos se crean en la pestaña Toppings.' },
    { name: 'included_count', label: 'Opciones incluidas en el precio', type: 'number', step: '1',
      hint: 'Ej. 2 = "incluye 2 toppings, spreads o frutas". 0 = todas se cobran.' },
    { name: 'included_value', label: 'Valor cubierto por cada opción incluida', type: 'number', step: '0.5',
      hint: 'Ej. 10 = cubre opciones de $10; si eligen una de $15 se cobra la diferencia ($5).' },
    { name: 'allow_notes', label: 'Permitir notas del cliente (ej. "sin plátano")', type: 'checkbox' },
    { name: 'featured', label: 'Marcar como favorito ⭐', type: 'checkbox' },
    { name: 'active', label: 'Disponible (visible en el menú)', type: 'checkbox' },
    { name: 'sort', label: 'Orden', type: 'number', step: '1', hint: 'Los números menores aparecen primero.' },
  ];

  const editProduct = (p) => openForm({
    title: p ? 'Editar producto' : 'Nuevo producto',
    fields: productFields(),
    values: p || { active: true, allow_notes: true, sort: products.length + 1, category_id: cats[0]?.id ?? '' },
    onSubmit: async (v) => {
      await A(p ? `/products/${p.id}` : '/products', { method: p ? 'PUT' : 'POST', body: v });
      toast(p ? '✓ Producto actualizado' : '✓ Producto creado');
      renderMenu();
    },
    onDelete: p ? async () => { await A(`/products/${p.id}`, { method: 'DELETE' }); toast('Producto eliminado'); renderMenu(); } : null,
    deleteConfirm: p ? `¿Eliminar "${p.name}"? Si solo quieres ocultarlo, desmarca "Disponible".` : '',
  });

  const editCategory = (c) => openForm({
    title: c ? 'Editar categoría' : 'Nueva categoría',
    fields: [
      { name: 'name', label: 'Nombre', placeholder: 'Ej. Bowls' },
      { name: 'active', label: 'Visible en el menú', type: 'checkbox' },
      { name: 'sort', label: 'Orden', type: 'number', step: '1' },
    ],
    values: c || { active: true, sort: cats.length + 1 },
    onSubmit: async (v) => { await A(c ? `/categories/${c.id}` : '/categories', { method: c ? 'PUT' : 'POST', body: v }); renderMenu(); },
    onDelete: c ? async () => { await A(`/categories/${c.id}`, { method: 'DELETE' }); renderMenu(); } : null,
    deleteConfirm: '¿Eliminar la categoría? Sus productos quedarán "Sin categoría".',
  });

  const sections = [...cats.map((c) => ({ id: c.id, name: c.name })), { id: null, name: 'Sin categoría' }]
    .map((c) => ({ ...c, items: products.filter((p) => (c.id === null ? !catName(p.category_id) : p.category_id === c.id)) }))
    .filter((c) => c.items.length);

  view.innerHTML = `
    <div class="view-head"><h2>Menú</h2><button class="btn" data-new-product>+ Nuevo producto</button></div>
    <div class="panel">
      <div class="panel-head"><h3>Productos</h3><span class="muted small">${products.length} en total</span></div>
      ${sections.length ? sections.map((s) => `
        <div class="cat-title">${esc(s.name)}</div>
        ${s.items.map((p) => `
          <div class="list-row ${p.active ? '' : 'inactive'}">
            ${p.image ? `<img class="mini-thumb" src="${esc(p.image)}" alt="">` : `<div class="mini-thumb">${emojiFor(p.id)}</div>`}
            <div class="grow">
              <div class="name">${esc(p.name)} ${p.featured ? '⭐' : ''}</div>
              <div class="sub">${money(p.price)}${p.topping_group_ids.length ? ` · ${p.topping_group_ids.length} grupo(s) de opciones` : ''}${p.included_count ? ` · incluye ${p.included_count}` : ''}${p.active ? '' : ' · Oculto'}</div>
            </div>
            <div class="row-actions">
              <label class="switch" title="Disponible"><input type="checkbox" data-toggle-product="${p.id}" ${p.active ? 'checked' : ''}><span class="slider"></span></label>
              <button class="btn btn-ghost btn-sm" data-recipe-btn="p${p.id}" data-recipe-name="${esc(p.name)}" title="Ingredientes que descuenta del inventario">🧾 Receta</button>
              <button class="btn btn-ghost btn-sm" data-edit-product="${p.id}">Editar</button>
            </div>
          </div>`).join('')}`).join('') : '<p class="muted">Aún no tienes productos. ¡Crea el primero!</p>'}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Categorías</h3><button class="btn btn-light btn-sm" data-new-cat>+ Nueva categoría</button></div>
      ${cats.map((c) => `
        <div class="list-row ${c.active ? '' : 'inactive'}">
          <div class="grow"><div class="name">${esc(c.name)}</div><div class="sub">${products.filter((p) => p.category_id === c.id).length} productos · orden ${c.sort}${c.active ? '' : ' · Oculta'}</div></div>
          <button class="btn btn-ghost btn-sm" data-edit-cat="${c.id}">Editar</button>
        </div>`).join('') || '<p class="muted">Sin categorías.</p>'}
    </div>`;

  $('[data-new-product]', view).addEventListener('click', () => editProduct(null));
  $('[data-new-cat]', view).addEventListener('click', () => editCategory(null));
  $$('[data-recipe-btn]', view).forEach((b) => b.addEventListener('click', () => openRecipe(b.dataset.recipeBtn, b.dataset.recipeName)));
  $$('[data-edit-product]', view).forEach((b) => b.addEventListener('click', () => editProduct(products.find((p) => p.id === Number(b.dataset.editProduct)))));
  $$('[data-edit-cat]', view).forEach((b) => b.addEventListener('click', () => editCategory(cats.find((c) => c.id === Number(b.dataset.editCat)))));
  $$('[data-toggle-product]', view).forEach((input) => input.addEventListener('change', async () => {
    try {
      await A(`/products/${input.dataset.toggleProduct}`, { method: 'PUT', body: { active: input.checked } });
      input.closest('.list-row').classList.toggle('inactive', !input.checked);
      toast(input.checked ? 'Producto visible' : 'Producto oculto (agotado)');
    } catch (e) { input.checked = !input.checked; toast(e.message); }
  }));
}

/* ================================ Toppings ================================ */

function ruleText(g) {
  if (g.min_select > 0 && g.max_select === g.min_select) return `Obligatorio · elige ${g.min_select}`;
  if (g.min_select > 0) return `Obligatorio · mín. ${g.min_select}${g.max_select ? `, máx. ${g.max_select}` : ''}`;
  return g.max_select ? `Opcional · hasta ${g.max_select}` : 'Opcional · sin límite';
}

async function renderToppings() {
  const groups = await A('/topping-groups');

  const groupFields = [
    { name: 'name', label: 'Nombre del grupo', placeholder: 'Ej. Toppings, Spreads, Frutas' },
    { name: 'min_select', label: 'Mínimo a elegir', type: 'number', step: '1', hint: '0 = opcional. 1 o más = obligatorio.' },
    { name: 'max_select', label: 'Máximo a elegir', type: 'number', step: '1', hint: '0 = sin límite. 1 = solo una opción.' },
    { name: 'sort', label: 'Orden', type: 'number', step: '1' },
  ];
  const toppingFields = [
    { name: 'name', label: 'Nombre', placeholder: 'Ej. Granola' },
    { name: 'price', label: 'Precio extra', type: 'number', step: '0.5', hint: '0 si no tiene costo adicional.' },
    { name: 'description', label: 'Descripción (opcional)', placeholder: 'Ej. Açaí, plátano, frutos rojos' },
    { name: 'active', label: 'Disponible', type: 'checkbox' },
    { name: 'sort', label: 'Orden', type: 'number', step: '1' },
  ];

  const editGroup = (g) => openForm({
    title: g ? 'Editar grupo' : 'Nuevo grupo de opciones',
    fields: groupFields,
    values: g || { min_select: 0, max_select: 0, sort: groups.length + 1 },
    onSubmit: async (v) => { await A(g ? `/topping-groups/${g.id}` : '/topping-groups', { method: g ? 'PUT' : 'POST', body: v }); renderToppings(); },
    onDelete: g ? async () => { await A(`/topping-groups/${g.id}`, { method: 'DELETE' }); renderToppings(); } : null,
    deleteConfirm: '¿Eliminar el grupo y todas sus opciones? Se quitará de los productos que lo usen.',
  });
  const editTopping = (g, t) => openForm({
    title: t ? 'Editar opción' : `Nueva opción en "${g.name}"`,
    fields: toppingFields,
    values: t || { price: 0, active: true, sort: g.toppings.length + 1 },
    onSubmit: async (v) => { await A(t ? `/toppings/${t.id}` : `/topping-groups/${g.id}/toppings`, { method: t ? 'PUT' : 'POST', body: v }); renderToppings(); },
    onDelete: t ? async () => { await A(`/toppings/${t.id}`, { method: 'DELETE' }); renderToppings(); } : null,
  });

  view.innerHTML = `
    <div class="view-head"><h2>Toppings y opciones</h2><button class="btn" data-new-group>+ Nuevo grupo</button></div>
    <p class="muted" style="margin-top:-4px">Un <strong>grupo</strong> reúne opciones que el cliente puede elegir (ej. "Proteína: elige 1" o "Extras: hasta 4").
      Después asígnalo a tus productos desde la pestaña <strong>Menú</strong>.</p>
    ${groups.map((g) => `
      <div class="panel">
        <div class="panel-head">
          <div><h3>${esc(g.name)}</h3><span class="muted small">${ruleText(g)}</span></div>
          <div class="row-actions">
            <button class="btn btn-light btn-sm" data-add-top="${g.id}">+ Opción</button>
            <button class="btn btn-ghost btn-sm" data-edit-group="${g.id}">Editar</button>
          </div>
        </div>
        ${g.toppings.map((t) => `
          <div class="list-row ${t.active ? '' : 'inactive'}">
            <div class="grow"><div class="name">${esc(t.name)}</div><div class="sub">${t.price > 0 ? '+' + money(t.price) : 'Sin costo'}${t.description ? ' · ' + esc(t.description) : ''}${t.active ? '' : ' · Agotado'}</div></div>
            <div class="row-actions">
              <label class="switch" title="Disponible"><input type="checkbox" data-toggle-top="${t.id}" ${t.active ? 'checked' : ''}><span class="slider"></span></label>
              <button class="btn btn-ghost btn-sm" data-recipe-btn="t${t.id}" data-recipe-name="${esc(t.name)}" title="Ingredientes que descuenta del inventario">🧾</button>
              <button class="btn btn-ghost btn-sm" data-edit-top="${g.id}:${t.id}">Editar</button>
            </div>
          </div>`).join('') || '<p class="muted small">Sin opciones todavía.</p>'}
      </div>`).join('') || '<div class="panel empty"><p>Aún no hay grupos de toppings.</p></div>'}`;

  $('[data-new-group]', view).addEventListener('click', () => editGroup(null));
  $$('[data-edit-group]', view).forEach((b) => b.addEventListener('click', () => editGroup(groups.find((g) => g.id === Number(b.dataset.editGroup)))));
  $$('[data-recipe-btn]', view).forEach((b) => b.addEventListener('click', () => openRecipe(b.dataset.recipeBtn, b.dataset.recipeName)));
  $$('[data-add-top]', view).forEach((b) => b.addEventListener('click', () => editTopping(groups.find((g) => g.id === Number(b.dataset.addTop)), null)));
  $$('[data-edit-top]', view).forEach((b) => b.addEventListener('click', () => {
    const [gid, tid] = b.dataset.editTop.split(':').map(Number);
    const g = groups.find((x) => x.id === gid);
    editTopping(g, g.toppings.find((t) => t.id === tid));
  }));
  $$('[data-toggle-top]', view).forEach((input) => input.addEventListener('change', async () => {
    try {
      await A(`/toppings/${input.dataset.toggleTop}`, { method: 'PUT', body: { active: input.checked } });
      input.closest('.list-row').classList.toggle('inactive', !input.checked);
    } catch (e) { input.checked = !input.checked; toast(e.message); }
  }));
}

/* ================================== Envío ================================== */

async function renderDelivery() {
  await loadSettings();
  const zones = await A('/zones');
  const defs = [
    {
      id: 'delivery', title: 'Entrega y recolección', two: true,
      fields: [
        { name: 'delivery_enabled', label: 'Ofrecer envío a domicilio', type: 'checkbox' },
        { name: 'pickup_enabled', label: 'Permitir recoger en tienda', type: 'checkbox' },
        { name: 'delivery_mode', label: '¿Cómo se cobra el envío?', type: 'select', options: [
          { value: 'distance', label: '📍 Por distancia (el cliente marca su ubicación en un mapa)' },
          { value: 'zones', label: '🗺️ Por zonas o costo fijo' },
        ] },
        { name: 'delivery_flat_fee', label: 'Costo de envío fijo', type: 'number', step: '0.5', hint: 'Solo en modo "por zonas", si no tienes zonas activas.' },
        { name: 'free_delivery_over', label: 'Envío gratis a partir de', type: 'number', step: '1', hint: '0 = desactivado.' },
        { name: 'min_order', label: 'Pedido mínimo', type: 'number', step: '1', hint: '0 = sin mínimo.' },
        { name: 'estimated_time', label: 'Tiempo estimado a domicilio', placeholder: 'Ej. 30 a 45 min' },
        { name: 'pickup_estimated_time', label: 'Tiempo estimado para recoger', placeholder: 'Ej. 10 a 15 min' },
        { name: 'pickup_address', label: 'Dirección para recoger', type: 'textarea', rows: 2, placeholder: 'Calle, número, colonia, referencias' },
      ],
    },
  ];

  const editZone = (z) => openForm({
    title: z ? 'Editar zona' : 'Nueva zona de envío',
    fields: [
      { name: 'name', label: 'Nombre de la zona / colonia', placeholder: 'Ej. Centro' },
      { name: 'fee', label: 'Costo de envío', type: 'number', step: '0.5' },
      { name: 'active', label: 'Activa', type: 'checkbox' },
      { name: 'sort', label: 'Orden', type: 'number', step: '1' },
    ],
    values: z || { active: true, fee: settings.delivery_flat_fee, sort: zones.length + 1 },
    onSubmit: async (v) => { await A(z ? `/zones/${z.id}` : '/zones', { method: z ? 'PUT' : 'POST', body: v }); renderDelivery(); },
    onDelete: z ? async () => { await A(`/zones/${z.id}`, { method: 'DELETE' }); renderDelivery(); } : null,
  });

  defs.push({
    id: 'distance', title: '📍 Envío por distancia',
    desc: 'Se mide la distancia por calle desde tu negocio hasta el punto que marca el cliente, y se cobra según estas tarifas.',
    fields: [
      { name: 'delivery_tiers', label: 'Tarifas (una por renglón: km máximos = costo)', type: 'textarea', rows: 6,
        placeholder: '2 = 35\n4 = 40\n6 = 45\n8 = 50\n10 = 55',
        hint: 'Ej. "2 = 35" → hasta 2 km cuesta $35. Más allá del último rango (ej. ejidos) no se acepta el envío y se le pide al cliente que te escriba por WhatsApp.' },
      { name: 'store_lat', type: 'hidden' },
      { name: 'store_lng', type: 'hidden' },
    ],
    extra: `
      <div class="field" style="margin-top:14px">
        <span class="label">Ubicación de tu negocio</span>
        <div class="hint">Arrastra el pin 🥣 o toca el mapa en el punto exacto de tu local. Después presiona Guardar.</div>
        <div class="search-row" style="margin-top:8px">
          <input class="input" id="store-search" type="search" placeholder="Buscar dirección">
          <button type="button" class="btn btn-light" data-store-search>Buscar</button>
        </div>
        <div class="map-box" data-store-map><div class="map-loading">Cargando mapa…</div></div>
        <div class="muted small" data-store-coords style="margin-top:6px"></div>
      </div>`,
  });

  view.innerHTML = `
    <div class="view-head"><h2>Envío</h2></div>
    ${settingsPanel(defs[0])}
    ${settingsPanel(defs[1])}
    <div class="panel">
      <div class="panel-head"><h3>Zonas de envío</h3><button class="btn btn-light btn-sm" data-new-zone>+ Nueva zona</button></div>
      <p class="muted">Solo se usan en modo "por zonas". Si tienes zonas activas, el cliente elige la suya y se cobra su costo; si no, se cobra el costo fijo.</p>
      ${zones.map((z) => `
        <div class="list-row ${z.active ? '' : 'inactive'}">
          <div class="grow"><div class="name">${esc(z.name)}</div><div class="sub">${z.fee > 0 ? money(z.fee) : 'Gratis'}${z.active ? '' : ' · Inactiva'}</div></div>
          <button class="btn btn-ghost btn-sm" data-edit-zone="${z.id}">Editar</button>
        </div>`).join('') || '<p class="muted small">Sin zonas: se usa el costo fijo.</p>'}
    </div>`;
  wireSettings(defs);
  wireStoreMap();
  $('[data-new-zone]', view).addEventListener('click', () => editZone(null));
  $$('[data-edit-zone]', view).forEach((b) => b.addEventListener('click', () => editZone(zones.find((z) => z.id === Number(b.dataset.editZone)))));
}

async function wireStoreMap() {
  const form = $('[data-settings="distance"]', view);
  const coords = $('[data-store-coords]', form);
  const point = () => ({ lat: Number(form.elements.store_lat.value), lng: Number(form.elements.store_lng.value) });
  const show = () => { const p = point(); coords.textContent = `Coordenadas: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`; };
  show();
  try {
    const picker = await createMap($('[data-store-map]', form), {
      store: null, pin: point(), pinEmoji: '🥣',
      onPick: (p) => { form.elements.store_lat.value = p.lat; form.elements.store_lng.value = p.lng; show(); },
    });
    $('.map-loading', form)?.remove();
    const search = async () => {
      const q = $('#store-search', form).value.trim();
      if (q.length < 3) return;
      try {
        const [r] = await searchAddress(q, point());
        if (r) picker.set(r); else toast('No encontramos esa dirección; mueve el pin a mano.', 4000);
      } catch (e) { toast(e.message, 4000); }
    };
    $('[data-store-search]', form).addEventListener('click', search);
    $('#store-search', form).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  } catch (e) {
    $('[data-store-map]', form).innerHTML = `<div class="map-loading">${esc(e.message)}</div>`;
  }
}

/* ================================= Ajustes ================================= */

async function renderSettings() {
  await loadSettings();
  const shopUrl = settings.public_url || location.origin;

  const defs = [
    {
      id: 'business', title: 'Tu negocio', two: true,
      fields: [
        { name: 'business_name', label: 'Nombre del negocio' },
        { name: 'tagline', label: 'Frase / eslogan' },
        { name: 'whatsapp_number', label: 'WhatsApp del negocio', placeholder: '5215512345678',
          hint: 'Con código de país, sin espacios ni "+". El cliente podrá enviarte su pedido a este número.' },
        { name: 'closed_message', label: 'Mensaje cuando está cerrado' },
        { name: 'currency', label: 'Moneda (código)', placeholder: 'MXN', hint: 'MXN, USD, COP, PEN, etc.' },
        { name: 'locale', label: 'Formato regional', placeholder: 'es-MX' },
        { name: 'public_url', label: 'URL pública de la tienda', type: 'url', placeholder: 'https://pedidos.tunegocio.com',
          hint: 'Cuando la publiques en internet. Se usa en los enlaces de las notificaciones.' },
      ],
    },
    {
      id: 'payments', title: 'Métodos de pago',
      fields: [
        { name: 'cash_enabled', label: '💵 Efectivo', type: 'checkbox' },
        { name: 'transfer_enabled', label: '🏦 Transferencia', type: 'checkbox' },
        { name: 'card_enabled', label: '💳 Tarjeta en sucursal (solo pedidos para recoger)', type: 'checkbox' },
        { name: 'bank_info', label: 'Datos para transferencia', type: 'textarea', rows: 4,
          hint: 'Se muestran al cliente cuando elige transferencia.' },
      ],
    },
    {
      id: 'notify', title: '🔔 Notificaciones al celular',
      desc: 'Elige uno o varios canales. Te llegará un mensaje con el detalle de cada pedido nuevo. Además, deja este panel abierto con el sonido 🔔 activado.',
      fields: [
        { name: 'notify_telegram_token', label: 'Telegram · Token del bot', placeholder: '123456:ABC…' },
        { name: 'notify_telegram_chat_id', label: 'Telegram · Chat ID', placeholder: '123456789' },
        { name: 'notify_callmebot_phone', label: 'WhatsApp (CallMeBot) · Tu número', placeholder: '+5215512345678' },
        { name: 'notify_callmebot_apikey', label: 'WhatsApp (CallMeBot) · API key' },
        { name: 'notify_twilio_sid', label: 'Twilio · Account SID' },
        { name: 'notify_twilio_token', label: 'Twilio · Auth token', type: 'password' },
        { name: 'notify_twilio_from', label: 'Twilio · Número de origen', placeholder: '+1415…' },
        { name: 'notify_twilio_to', label: 'Twilio · Tu número', placeholder: '+5215512345678' },
        { name: 'notify_twilio_sms', label: 'Twilio: enviarme SMS', type: 'checkbox' },
        { name: 'notify_twilio_whatsapp', label: 'Twilio: enviarme WhatsApp', type: 'checkbox' },
        { name: 'notify_twilio_call', label: 'Twilio: llamarme por teléfono 📞', type: 'checkbox' },
      ],
      two: true,
      extra: `
        <details class="help"><summary>¿Cómo configuro Telegram? (gratis, recomendado)</summary><ol>
          <li>En Telegram abre <strong>@BotFather</strong>, envía <code>/newbot</code> y sigue los pasos. Copia el <em>token</em>.</li>
          <li>Abre tu bot nuevo y envíale cualquier mensaje.</li>
          <li>Abre <strong>@userinfobot</strong> para ver tu <em>Chat ID</em> (o el de un grupo donde agregues al bot).</li>
          <li>Pega ambos datos aquí, guarda y presiona "Enviar prueba".</li></ol></details>
        <details class="help"><summary>¿Cómo recibo los pedidos en el WhatsApp de la tienda? (gratis, con CallMeBot)</summary><ol>
          <li>Desde el celular con el <strong>WhatsApp de la tienda</strong>, entra a <a href="https://www.callmebot.com/blog/free-api-whatsapp-messages/" target="_blank" rel="noopener">callmebot.com</a> y agrega a tus contactos el número que aparece ahí.</li>
          <li>Envíale por WhatsApp el mensaje: <code>I allow callmebot to send me messages</code></li>
          <li>En unos minutos te responde con tu <em>API key</em>.</li>
          <li>Escribe aquí el número de la tienda con código de país (ej. <code>+5216681234567</code>) y la key, guarda y presiona "Enviar prueba".</li></ol>
          <p class="small">Con cada pedido nuevo te llega un WhatsApp con todo el detalle. En los pedidos a domicilio trae al final el enlace <em>📤 Pasar al grupo de repartidores</em>: tócalo, elige el grupo y envía. También puedes copiar ese mensaje desde el pedido en este panel.</p></details>
        <details class="help"><summary>¿Y Twilio? (de pago: SMS, WhatsApp Business o llamada)</summary>
          <p>Crea una cuenta en twilio.com, compra un número y copia el Account SID y Auth token. La llamada lee en voz alta el número y total del pedido.</p></details>
        <div style="margin-top:12px"><button type="button" class="btn btn-light" data-test-notify>Enviar prueba</button></div>
        <div class="results" data-results></div>`,
    },
    {
      id: 'integrations', title: '🔌 API e integraciones',
      desc: 'Conecta tu sistema de registro de ventas. Puede leer los pedidos con la API o recibirlos al instante con un webhook.',
      fields: [
        { name: 'webhook_url', label: 'Webhook (URL que recibe cada pedido)', type: 'url', placeholder: 'https://mi-sistema.com/webhooks/pedidos',
          hint: 'Enviaremos un POST con el pedido en JSON cuando se cree o cambie de estado.' },
      ],
      extra: `
        <div class="field"><span class="label">API key</span>
          <div class="inline"><div class="code" style="flex:1" data-api-key>${esc(settings.api_key)}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-copy-key>Copiar</button></div>
          <div class="hint">Envíala en el header <code>X-API-Key</code>. Base: <code>${esc(shopUrl)}/api/v1</code> · Documentación en <code>docs/API.md</code></div>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" data-regen-key>Generar nueva key</button>
        </div>
        <div class="field"><span class="label">Secreto del webhook (firma HMAC)</span>
          <div class="inline"><div class="code" style="flex:1">${esc(settings.webhook_secret)}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-copy-secret>Copiar</button></div>
          <div class="hint">Cada envío incluye el header <code>X-Macai-Signature: sha256=…</code> para que verifiques que viene de aquí.</div>
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px" data-regen-secret>Generar nuevo secreto</button>
        </div>`,
    },
  ];

  view.innerHTML = `
    <div class="view-head"><h2>Ajustes</h2></div>
    <div class="panel">
      <h3>🔗 Link para tus clientes</h3>
      <p class="muted">Compártelo por WhatsApp, Instagram o imprímelo en un QR.</p>
      <div class="inline"><div class="code" style="flex:1">${esc(shopUrl)}/</div></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-sm" data-copy-link>Copiar link</button>
        ${navigator.share ? '<button class="btn btn-light btn-sm" data-share-link>Compartir</button>' : ''}
        <a class="btn btn-ghost btn-sm" href="/" target="_blank" rel="noopener">Abrir menú</a>
      </div>
    </div>
    ${defs.map(settingsPanel).join('')}
    <form class="panel" id="pw-form" novalidate>
      <h3>🔒 Seguridad</h3>
      <div class="form-grid two">
        ${fieldHtml({ name: 'current', label: 'Contraseña actual', type: 'password' })}
        ${fieldHtml({ name: 'next', label: 'Nueva contraseña (mín. 8 caracteres)', type: 'password' })}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px"><button class="btn">Cambiar contraseña</button></div>
    </form>
    <form class="panel" id="waiter-form" novalidate>
      <h3>🧑‍🍳 Modo mesero</h3>
      <p class="muted">Tus meseros toman pedidos desde su celular en <a href="/mesero/" target="_blank" rel="noopener">${esc(shopUrl)}/mesero/</a>
        (comer aquí con número de mesa, para llevar o a domicilio). Los pedidos llegan a este panel como cualquier otro.
        Entran con esta contraseña, que <strong>no</strong> da acceso al panel de admin.</p>
      <p class="small">${settings.waiter_enabled === '1' ? '✅ Acceso de meseros activado.' : '⚪ Sin contraseña de meseros: por ahora solo entras tú con la contraseña del admin.'}</p>
      <div class="form-grid two">
        ${fieldHtml({ name: 'waiter_password', label: settings.waiter_enabled === '1' ? 'Nueva contraseña de meseros (mín. 6)' : 'Contraseña de meseros (mín. 6 caracteres)', type: 'password' })}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px">
        <button type="button" class="btn btn-ghost btn-sm" data-copy-mesero>Copiar link de meseros</button>
        ${settings.waiter_enabled === '1' ? '<button type="button" class="btn btn-light" data-waiter-off>Desactivar acceso</button>' : ''}
        <button class="btn">${settings.waiter_enabled === '1' ? 'Cambiar contraseña' : 'Activar modo mesero'}</button>
      </div>
      <p class="hint">Al cambiarla o desactivarla se cierra la sesión en todos los celulares de meseros.</p>
    </form>`;

  wireSettings(defs);

  $('[data-copy-link]', view).addEventListener('click', () => copy(`${shopUrl}/`, 'Link copiado'));
  $('[data-share-link]', view)?.addEventListener('click', () => navigator.share({ title: settings.business_name, text: `Haz tu pedido en ${settings.business_name}`, url: `${shopUrl}/` }).catch(() => {}));
  $('[data-copy-key]', view).addEventListener('click', () => copy(settings.api_key, 'API key copiada'));
  $('[data-copy-secret]', view).addEventListener('click', () => copy(settings.webhook_secret, 'Secreto copiado'));
  $('[data-regen-key]', view).addEventListener('click', async () => {
    if (!confirm('¿Generar una nueva API key? Las apps conectadas con la key actual dejarán de funcionar hasta que la actualices.')) return;
    settings = await A('/settings/regenerate-api-key', { method: 'POST' });
    renderSettings();
    toast('Nueva API key generada');
  });
  $('[data-regen-secret]', view).addEventListener('click', async () => {
    if (!confirm('¿Generar un nuevo secreto de webhook?')) return;
    settings = await A('/settings/regenerate-webhook-secret', { method: 'POST' });
    renderSettings();
  });
  $('[data-test-notify]', view).addEventListener('click', async (e) => {
    const box = $('[data-results]', view);
    e.target.disabled = true;
    box.innerHTML = '<div class="muted">Enviando… (guarda primero si cambiaste algo)</div>';
    try {
      const { results } = await A('/notify/test', { method: 'POST' });
      box.innerHTML = results.map((r) => r.ok ? `<div class="ok">✓ ${esc(r.channel)}: enviado</div>` : `<div class="bad">✗ ${esc(r.error)}</div>`).join('');
    } catch (ex) { box.innerHTML = `<div class="bad">${esc(ex.message)}</div>`; }
    e.target.disabled = false;
  });
  $('[data-copy-mesero]', view).addEventListener('click', () => copy(`${shopUrl}/mesero/`, 'Link de meseros copiado'));
  $('#waiter-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = e.target.elements.waiter_password.value;
    if (pw.length < 6) return toast('La contraseña de meseros debe tener al menos 6 caracteres', 4000);
    try {
      settings = await A('/waiter-password', { method: 'POST', body: { password: pw } });
      renderSettings();
      toast('✓ Contraseña de meseros guardada');
    } catch (ex) { toast(ex.message, 4000); }
  });
  $('[data-waiter-off]', view)?.addEventListener('click', async () => {
    if (!confirm('¿Desactivar el acceso de meseros? Se cerrará su sesión en todos los celulares.')) return;
    try {
      settings = await A('/waiter-password', { method: 'POST', body: { password: '' } });
      renderSettings();
      toast('Acceso de meseros desactivado');
    } catch (ex) { toast(ex.message, 4000); }
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await A('/password', { method: 'POST', body: { current: f.elements.current.value, next: f.elements.next.value } });
      f.reset();
      toast('✓ Contraseña actualizada');
    } catch (ex) { toast(ex.message, 4000); }
  });
}

/* ================================ Inventario ================================ */

const INV_STATUS = { ok: 'OK', bajo: 'Por acabarse', agotado: 'Agotado' };
const MOV_LABEL = { compra: '📥 Compra', venta: '🧾 Venta', merma: '🗑️ Merma', conteo: '🔢 Conteo', devolucion: '↩️ Cancelación', ajuste: '✏️ Ajuste' };
let invSearch = '';
let invView = store.get('adm_inv_view', 'stock');
let costDays = 30;

const invHead = () => `
    <div class="view-head"><h2>Inventario</h2>
      <div class="filters">
        <button class="chip${invView === 'stock' ? ' active' : ''}" data-inv-view="stock">📦 Existencias</button>
        <button class="chip${invView === 'purchases' ? ' active' : ''}" data-inv-view="purchases">🧾 Compras</button>
        <button class="chip${invView === 'costs' ? ' active' : ''}" data-inv-view="costs">💰 Costos y ganancia</button>
      </div>
    </div>`;
function bindInvHead() {
  $$('[data-inv-view]', view).forEach((b) => b.addEventListener('click', () => {
    invView = b.dataset.invView;
    store.set('adm_inv_view', invView);
    renderInventory();
  }));
}

const fmtNum = (n) => {
  const v = Number(n) || 0;
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('es-MX') : Number(v.toFixed(2)).toLocaleString('es-MX');
};
const fmtQty = (n, unit) => `${fmtNum(n)} ${unit}`;
const UNIT_FACTOR = { g: 1, kg: 1000, ml: 1, L: 1000 };
const convertQty = (q, from, to) => (from === to || !UNIT_FACTOR[from] || !UNIT_FACTOR[to] ? q : (q * UNIT_FACTOR[from]) / UNIT_FACTOR[to]);
/** Cantidad de una línea de receta en la unidad en que se capturó (la receta guarda la del ingrediente). */
const lineQty = (l, item) => convertQty(l.qty, item.unit, l.unit || item.unit);
const urgency = (i) => (i.status === 'agotado' ? 0 : 1) * 1e6 + (i.days_left ?? 9999) * 10 + (i.min_stock ? i.stock / i.min_stock : 1);

/** Número de ingredientes por rellenar en la pestaña Inventario. */
function updateInvBadge(n) {
  const b = $('#inv-badge');
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}
const refreshInvBadge = () => A('/inventory').then((d) => updateInvBadge(d.summary.low + d.summary.out)).catch(() => {});

async function renderInventory() {
  if (invView === 'costs') return renderCosts();
  if (invView === 'purchases') return renderPurchases();
  const data = await A('/inventory');
  const items = data.items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const active = items.filter((i) => i.active !== false);
  const refill = active.filter((i) => i.status !== 'ok').sort((a, b) => urgency(a) - urgency(b));
  const s = data.summary;
  const [products, groups] = items.length ? await Promise.all([A('/products'), A('/topping-groups')]) : [[], []];
  updateInvBadge(refill.length);

  const recipeText = (key) => {
    const lines = data.recipes[key] || [];
    return lines.length
      ? lines.map((l) => { const it = byId.get(l.item_id); return it ? `${fmtQty(lineQty(l, it), l.unit || it.unit)} ${esc(it.name)}` : ''; }).filter(Boolean).join(' · ')
      : '<span class="muted">Sin receta</span>';
  };
  const recipeRow = (key, name, sub = '') => `
    <div class="list-row">
      <div class="grow"><div class="name">${esc(name)}${sub ? ` <span class="muted small">${esc(sub)}</span>` : ''}</div><div class="sub">${recipeText(key)}</div></div>
      <button class="btn btn-ghost btn-sm" data-recipe="${key}" data-recipe-name="${esc(name)}">Editar receta</button>
    </div>`;

  const itemRow = (i) => {
    const pct = i.par > 0 ? Math.max(0, Math.min(100, (i.stock / i.par) * 100)) : i.stock > 0 ? 100 : 0;
    return `
    <div class="inv-row s-${i.status}${i.active === false ? ' inactive' : ''}" data-search="${esc(i.name.toLowerCase())} ${esc((i.supplier || '').toLowerCase())}">
      <div class="inv-main">
        <div class="inv-name"><strong>${esc(i.name)}</strong> <span class="inv-chip s-${i.status}">${INV_STATUS[i.status]}</span></div>
        <div class="inv-bar" title="${fmtQty(i.stock, i.unit)} de ${fmtQty(i.par, i.unit)} ideales"><span style="width:${pct}%"></span>${i.par > 0 && i.min_stock > 0 ? `<i style="left:${Math.min(100, (i.min_stock / i.par) * 100)}%"></i>` : ''}</div>
        <div class="sub">
          <strong>${fmtQty(i.stock, i.unit)}</strong>${i.min_stock ? ` · avisa en ${fmtQty(i.min_stock, i.unit)}` : ''}
          ${i.avg_daily > 0 ? ` · usas ~${fmtQty(i.avg_daily, i.unit)}/día` : ''}
          ${i.days_left !== null ? ` · <strong>alcanza ~${i.days_left} ${i.days_left === 1 ? 'día' : 'días'}</strong>` : ''}
          ${i.supplier ? ` · ${esc(i.supplier)}` : ''}
          ${i.used_in.length ? `<br><span class="muted">En: ${esc(i.used_in.slice(0, 4).join(', '))}${i.used_in.length > 4 ? ` y ${i.used_in.length - 4} más` : ''}</span>` : '<br><span class="muted">Aún no está en ninguna receta</span>'}
        </div>
      </div>
      <div class="inv-actions">
        <button class="btn btn-sm" data-mov="compra" data-item="${i.id}">+ Entrada</button>
        <button class="btn btn-light btn-sm" data-mov="conteo" data-item="${i.id}">Conteo</button>
        <button class="btn btn-ghost btn-sm" data-mov="merma" data-item="${i.id}">Merma</button>
        <button class="btn btn-ghost btn-sm" data-edit-item="${i.id}">Editar</button>
      </div>
    </div>`;
  };

  view.innerHTML = `
    ${invHead()}
    <div class="inv-toolbar"><button class="btn" data-new-item>+ Ingrediente</button></div>
    <div class="stats">
      <div class="stat ${refill.length ? 'warn' : ''}"><small>Por rellenar</small><strong>${refill.length}</strong></div>
      <div class="stat ${s.out ? 'bad' : ''}"><small>Agotados</small><strong>${s.out}</strong></div>
      <div class="stat"><small>Ingredientes</small><strong>${s.total}</strong></div>
      <div class="stat"><small>Valor en inventario</small><strong>${money(s.value)}</strong></div>
    </div>

    ${!items.length ? `
    <div class="panel inv-onboard">
      <h3>📦 Empieza tu inventario en 3 pasos</h3>
      <ol>
        <li><strong>Ingredientes:</strong> lo que compras (granola, fresa, vasos…), con cuánto tienes y desde cuánto quieres que te avise.</li>
        <li><strong>Recetas:</strong> cuánto usa cada producto u opción (ej. el topping Granola usa 20 g).</li>
        <li>Listo: <strong>cada pedido descuenta solo</strong> sus ingredientes, y al cancelarlo se regresan. Aquí verás qué está por acabarse y te llega un aviso al celular.</li>
      </ol>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-seed>✨ Crear ingredientes desde mi menú</button>
        <button class="btn btn-ghost" data-new-item>+ Agregar a mano</button>
      </div>
      <p class="hint">"Crear desde mi menú" agrega un ingrediente por cada topping, spread y fruta, con una porción de 20–40 g y existencia en 0. Después ajusta cantidades y captura lo que tienes con <strong>Conteo</strong>. Las bases y los vasos agrégalos a mano (cambian según el tamaño).</p>
    </div>` : `
    <div class="panel inv-panel">
      <div class="panel-head">
        <div><h3>🛒 Por rellenar</h3><span class="muted small">${refill.length ? 'Lo más urgente primero.' : ''}${s.days_of_data ? ` Consumo calculado con ${s.days_of_data} ${s.days_of_data === 1 ? 'día' : 'días'} de ventas.` : ''}</span></div>
        ${refill.length ? `<div class="row-actions">
          <button class="btn btn-light btn-sm" data-copy-list>📋 Copiar lista</button>
          <a class="btn btn-light btn-sm" target="_blank" rel="noopener" data-wa-list>📤 WhatsApp</a>
        </div>` : ''}
      </div>
      ${refill.length ? refill.map((i) => `
        <div class="list-row">
          <div class="grow">
            <div class="name">${esc(i.name)} <span class="inv-chip s-${i.status}">${INV_STATUS[i.status]}</span></div>
            <div class="sub">Quedan ${fmtQty(i.stock, i.unit)}${i.min_stock ? ` (mínimo ${fmtQty(i.min_stock, i.unit)})` : ''}${i.days_left !== null ? ` · alcanza ~${i.days_left} ${i.days_left === 1 ? 'día' : 'días'}` : ''}${i.to_buy ? ` · <strong>comprar ~${fmtQty(i.to_buy, i.unit)}</strong>` : ''}</div>
          </div>
          <button class="btn btn-sm" data-mov="compra" data-item="${i.id}">+ Entrada</button>
        </div>`).join('') : '<p class="muted" style="margin:0">✅ Todo en orden: ningún ingrediente está por debajo de su mínimo.</p>'}
    </div>

    <div class="panel inv-panel">
      <div class="panel-head"><h3>📦 Ingredientes</h3>
        <input class="input inv-search" type="search" placeholder="Buscar…" value="${esc(invSearch)}" data-inv-search></div>
      <div data-inv-list>${items.map(itemRow).join('')}</div>
    </div>

    <div class="panel inv-panel">
      <h3>🍽️ Recetas</h3>
      <p class="muted small" style="margin-top:0">Cuánto se descuenta por cada <strong>producto</strong> (ej. vaso, base) y por cada <strong>opción o topping</strong> que elige el cliente. Se multiplica por la cantidad del pedido.</p>
      <details class="inv-recipes" open><summary>Productos</summary>
        ${products.map((p) => recipeRow(`p${p.id}`, p.name)).join('')}
      </details>
      ${groups.map((g) => `
        <details class="inv-recipes"><summary>${esc(g.name)} <span class="muted small">(${g.toppings.filter((t) => data.recipes[`t${t.id}`]?.length).length}/${g.toppings.length} con receta)</span></summary>
          ${g.toppings.map((t) => recipeRow(`t${t.id}`, t.name, g.name)).join('')}
        </details>`).join('')}
    </div>

    <div class="panel inv-panel">
      <h3>⚙️ Opciones</h3>
      <label class="check-field"><input type="checkbox" data-inv-setting="inventory_alerts" ${settings.inventory_alerts === '1' ? 'checked' : ''}>
        <span>🔔 Avisarme al celular cuando un ingrediente baje de su mínimo <span class="muted small">(usa los canales de Ajustes → Notificaciones)</span></span></label>
      <label class="check-field"><input type="checkbox" data-inv-setting="inventory_auto_disable" ${settings.inventory_auto_disable === '1' ? 'checked' : ''}>
        <span>🚫 Ocultar del menú lo que no alcance a prepararse <span class="muted small">(cuando un ingrediente se acaba, sus productos y toppings aparecen como agotados para clientes y meseros)</span></span></label>
      <p class="hint">Activa "ocultar" solo cuando ya hayas capturado tus existencias reales con <strong>Conteo</strong>; si no, lo que tenga existencia 0 dejaría de mostrarse.</p>
      ${items.length ? '<button class="btn btn-ghost btn-sm" data-seed style="margin-top:8px">✨ Agregar los toppings nuevos del menú</button>' : ''}
    </div>

    <div class="panel inv-panel">
      <h3>🕑 Movimientos recientes</h3>
      ${data.movements.length ? `<div class="inv-moves">${data.movements.slice(0, 40).map((m) => {
        const it = byId.get(m.item_id);
        return `<div class="inv-move">
          <span class="muted small">${new Date(m.at).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span>${MOV_LABEL[m.type] || esc(m.type)}${m.order_id ? ` #${m.order_id}` : ''}</span>
          <span class="grow">${esc(it?.name || '(eliminado)')}${m.note ? ` <span class="muted small">· ${esc(m.note)}</span>` : ''}</span>
          <strong class="${m.qty < 0 ? 'neg' : 'pos'}">${m.qty > 0 ? '+' : ''}${fmtQty(m.qty, it?.unit || '')}</strong>
        </div>`;
      }).join('')}</div>` : '<p class="muted small">Aún no hay movimientos.</p>'}
    </div>`}`;

  /* ---------- acciones ---------- */
  const itemFields = (isNew, unit = 'g') => [
    { name: 'name', label: 'Nombre', placeholder: 'Ej. Granola, Fresa, Vaso grande' },
    { name: 'unit', label: 'Unidad en que lo manejas', type: 'select', options: data.units.map((u) => ({ value: u, label: data.unit_labels?.[u] || u })),
      hint: 'Líquidos (leche, miel, jarabes): ml o L. Sólidos: g o kg. Vasos, tapas, cucharas: piezas. En las recetas puedes usar ml aunque lo compres en L (o g y kg).' },
    ...(isNew ? [{ name: 'stock', label: 'Existencia actual', type: 'number', step: 'any', hint: 'Cuánto tienes hoy. Puedes dejarlo en 0 y capturarlo después con Conteo.' }] : []),
    { name: 'min_stock', label: 'Avisarme cuando baje de', type: 'number', step: 'any', hint: `Cantidad mínima (en ${unit}). 0 = no avisar.` },
    { name: 'par', label: 'Cantidad ideal al rellenar', type: 'number', step: 'any', hint: 'Lo que te gusta tener lleno. Se usa para sugerir cuánto comprar.' },
    { name: 'cost', label: 'Costo por unidad (opcional)', type: 'number', step: 'any', hint: `Cuánto te cuesta 1 ${unit}. Se calcula solo si capturas el costo total al registrar una compra.` },
    { name: 'supplier', label: 'Proveedor (opcional)', placeholder: 'Ej. Costco, Central de abastos' },
    ...(isNew ? [] : [{ name: 'active', label: 'Activo', type: 'checkbox' }]),
  ];
  const editItem = (i) => openForm({
    title: i ? `Editar ${i.name}` : 'Nuevo ingrediente',
    fields: itemFields(!i, i?.unit),
    values: i || { unit: 'g', stock: 0, min_stock: 0, par: 0, cost: 0 },
    onSubmit: async (v) => { await A(i ? `/inventory/items/${i.id}` : '/inventory/items', { method: i ? 'PUT' : 'POST', body: v }); renderInventory(); },
    onDelete: i ? async () => { await A(`/inventory/items/${i.id}`, { method: 'DELETE' }); renderInventory(); } : null,
    deleteConfirm: '¿Eliminar este ingrediente? También se quita de las recetas.',
  });
  const movement = (type, i) => {
    if (type === 'compra') return purchaseForm({ ...i, units: data.unit_families?.[i.unit] || [i.unit] }, items, renderInventory);
    const titles = { compra: `📥 Entrada de ${i.name}`, merma: `🗑️ Merma de ${i.name}`, conteo: `🔢 Conteo de ${i.name}` };
    const fields = type === 'compra' ? [
      { name: 'qty', label: `¿Cuánto llegó? (${i.unit})`, type: 'number', step: 'any', hint: `Ahora tienes ${fmtQty(i.stock, i.unit)}.${i.to_buy ? ` Sugerido: ${fmtQty(i.to_buy, i.unit)}.` : ''}` },
      { name: 'total_cost', label: 'Costo total de la compra (opcional)', type: 'number', step: '0.01', hint: 'Si lo pones, se calcula el costo por unidad.' },
      { name: 'note', label: 'Nota (opcional)', placeholder: 'Ej. Costco, factura 123' },
    ] : type === 'merma' ? [
      { name: 'qty', label: `¿Cuánto se tiró? (${i.unit})`, type: 'number', step: 'any', hint: `Ahora tienes ${fmtQty(i.stock, i.unit)}.` },
      { name: 'note', label: 'Motivo', placeholder: 'Ej. se echó a perder, se cayó' },
    ] : [
      { name: 'qty', label: `¿Cuánto hay en realidad? (${i.unit})`, type: 'number', step: 'any', hint: `El sistema dice ${fmtQty(i.stock, i.unit)}. La diferencia se registra como ajuste.` },
      { name: 'note', label: 'Nota (opcional)', placeholder: 'Ej. conteo de cierre' },
    ];
    openForm({
      title: titles[type], fields, values: type === 'compra' && i.to_buy ? { qty: i.to_buy } : {},
      submitLabel: type === 'compra' ? 'Registrar entrada' : type === 'merma' ? 'Registrar merma' : 'Guardar conteo',
      onSubmit: async (v) => {
        await A(`/inventory/items/${i.id}/movements`, { method: 'POST', body: { type, ...v } });
        toast(type === 'compra' ? `✓ Entrada registrada: ${i.name}` : type === 'merma' ? '✓ Merma registrada' : '✓ Conteo guardado');
        renderInventory();
      },
    });
  };

  const shoppingText = () => {
    const bySupplier = new Map();
    for (const i of refill) {
      const k = i.supplier || '';
      if (!bySupplier.has(k)) bySupplier.set(k, []);
      bySupplier.get(k).push(i);
    }
    const L = [`🛒 Lista de compras · ${settings.business_name || ''} · ${new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })}`];
    for (const [sup, list] of bySupplier) {
      L.push('');
      if (sup) L.push(`*${sup}*`);
      for (const i of list) L.push(`• ${i.name}: ${i.to_buy ? fmtQty(i.to_buy, i.unit) : 'rellenar'} (quedan ${fmtQty(i.stock, i.unit)})`);
    }
    return L.join('\n');
  };

  bindInvHead();
  $$('[data-new-item]', view).forEach((b) => b.addEventListener('click', () => editItem(null)));
  $$('[data-edit-item]', view).forEach((b) => b.addEventListener('click', () => editItem(byId.get(Number(b.dataset.editItem)))));
  $$('[data-mov]', view).forEach((b) => b.addEventListener('click', () => movement(b.dataset.mov, byId.get(Number(b.dataset.item)))));
  $$('[data-recipe]', view).forEach((b) => b.addEventListener('click', () => editRecipe(b.dataset.recipe, b.dataset.recipeName, data, items, renderInventory)));
  $$('[data-seed]', view).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await A('/inventory/seed', { method: 'POST' });
      toast(r.created ? `✓ Se crearon ${r.created} ingredientes con su receta` : 'No había toppings nuevos que agregar', 3500);
      renderInventory();
    } catch (e) { b.disabled = false; toast(e.message, 4000); }
  }));
  $('[data-copy-list]', view)?.addEventListener('click', () => copy(shoppingText(), '📋 Lista de compras copiada'));
  const wa = $('[data-wa-list]', view);
  if (wa) wa.href = `https://wa.me/?text=${encodeURIComponent(shoppingText())}`;
  const search = $('[data-inv-search]', view);
  const applySearch = () => {
    invSearch = search.value.trim().toLowerCase();
    $$('[data-inv-list] .inv-row', view).forEach((r) => r.classList.toggle('hidden', !!invSearch && !r.dataset.search.includes(invSearch)));
  };
  search?.addEventListener('input', applySearch);
  if (search && invSearch) applySearch();
  $$('[data-inv-setting]', view).forEach((input) => input.addEventListener('change', async () => {
    try {
      settings = await A('/settings', { method: 'PUT', body: { [input.dataset.invSetting]: input.checked ? '1' : '0' } });
      toast('✓ Guardado');
    } catch (e) { input.checked = !input.checked; toast(e.message, 4000); }
  }));
}

/* -------------------------------- Compras -------------------------------- */

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthLabel = (ym, long = false) => { const [y, m] = ym.split('-').map(Number); return `${(long ? MONTHS_LONG : MONTHS_ES)[m - 1]} ${long ? y : String(y).slice(2)}`; };
const dayLabel = (d) => { const [, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS_ES[m - 1]}`; };
const PER = { kg: 'kg', L: 'litro', pz: 'pieza', porción: 'porción' };
const localToday = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
let purMonth = null;
let purItem = null;
let purRange = 12;

/** Precio promedio ponderado (por kg / L / pieza) de un grupo de compras. */
function avgPrice(list) {
  const priced = list.filter((p) => p.price_base > 0 && p.total_cost > 0);
  if (!priced.length) return null;
  const total = priced.reduce((a, p) => a + p.total_cost, 0);
  const qty = priced.reduce((a, p) => a + p.total_cost / p.price_base, 0);
  return qty ? total / qty : null;
}
const pct = (a, b) => (a && b ? Math.round(((b - a) / a) * 1000) / 10 : null);
const changeChip = (c) => (c === null ? '<span class="muted small">—</span>'
  : c > 0 ? `<span class="m-chip m-low">▲ ${c}%</span>` : c < 0 ? `<span class="m-chip m-good">▼ ${Math.abs(c)}%</span>` : '<span class="m-chip">= 0%</span>');

/**
 * Formulario de compra. item = ingrediente fijo (desde "+ Entrada") o null para elegirlo.
 * items: [{ id, name, unit, units, supplier, to_buy?, stock? }]
 */
function purchaseForm(item, items, onDone) {
  const pick = !item;
  const first = item || items[0];
  if (!first) return toast('Primero crea ingredientes en 📦 Existencias', 4000);
  const unitsOf = (it) => it.units || [it.unit];
  const fields = [
    ...(pick ? [{ name: 'item_id', label: 'Producto', type: 'select', options: items.map((i) => ({ value: i.id, label: i.name })) }] : []),
    { name: 'date', label: 'Fecha de compra', type: 'date' },
    { name: 'qty', label: '¿Cuánto compraste?', type: 'number', step: 'any', hint: item?.stock !== undefined ? `Ahora tienes ${fmtQty(item.stock, item.unit)}.${item.to_buy ? ` Sugerido: ${fmtQty(item.to_buy, item.unit)}.` : ''}` : '' },
    { name: 'unit', label: 'Unidad', type: 'select', options: unitsOf(first).map((u) => ({ value: u, label: u })) },
    { name: 'total_cost', label: 'Costo total que pagaste', type: 'number', step: '0.01', hint: '<span data-price-preview>Escribe cantidad y costo para ver el precio por kilo / litro / pieza.</span>' },
    { name: 'supplier', label: 'Proveedor (opcional)', placeholder: 'Ej. Costco, Central de abastos' },
    { name: 'note', label: 'Nota (opcional)', placeholder: 'Ej. marca, factura 123' },
    { name: 'add_stock', label: 'Sumar a la existencia del inventario', type: 'checkbox', hint: 'Desmárcalo si solo estás capturando una compra pasada para el historial de precios.' },
  ];
  openForm({
    title: item ? `📥 Compra de ${item.name}` : '📥 Registrar compra',
    fields,
    values: { item_id: first.id, date: localToday(), unit: first.unit, supplier: first.supplier || '', add_stock: true, ...(item?.to_buy ? { qty: item.to_buy } : {}) },
    submitLabel: 'Registrar compra',
    onSubmit: async (v) => {
      const id = pick ? Number(v.item_id) : item.id;
      await A(`/inventory/items/${id}/movements`, { method: 'POST', body: { type: 'compra', ...v } });
      toast(`✓ Compra registrada: ${(items.find((i) => i.id === id) || item).name}`);
      onDone?.();
    },
  });
  const form = document.querySelector('.sheet form');
  if (!form) return;
  const cur = () => (pick ? items.find((i) => i.id === Number(form.elements.item_id.value)) : item) || first;
  const preview = () => {
    const it = cur();
    const qty = Number(form.elements.qty.value);
    const cost = Number(form.elements.total_cost.value);
    const box = $('[data-price-preview]', form);
    if (!(qty > 0 && cost > 0)) { box.textContent = 'Escribe cantidad y costo para ver el precio por kilo / litro / pieza.'; return; }
    const u = form.elements.unit.value;
    const base = { g: 'kg', kg: 'kg', ml: 'L', L: 'L' }[it.unit] || it.unit;
    const qBase = base === 'kg' || base === 'L' ? convertQty(qty, u, base) : qty;
    box.innerHTML = `= <strong>${money(cost / qBase)} por ${PER[base] || base}</strong>`;
  };
  form.addEventListener('input', preview);
  if (pick) form.elements.item_id.addEventListener('change', () => {
    const it = cur();
    form.elements.unit.innerHTML = unitsOf(it).map((u) => `<option ${u === it.unit ? 'selected' : ''}>${u}</option>`).join('');
    if (!form.elements.supplier.value && it.supplier) form.elements.supplier.value = it.supplier;
    preview();
  });
}

async function renderPurchases() {
  const data = await A('/inventory/purchases?months=13');
  const all = data.purchases;
  const months = [...data.months].reverse(); // más reciente primero
  if (!purMonth || !data.months.includes(purMonth)) purMonth = months[0];
  const prevMonth = data.months[data.months.indexOf(purMonth) - 1] || null;
  const inMonth = all.filter((p) => p.date.startsWith(purMonth));
  const inPrev = prevMonth ? all.filter((p) => p.date.startsWith(prevMonth)) : [];
  const spent = inMonth.reduce((a, p) => a + (p.total_cost || 0), 0);
  const spentPrev = inPrev.reduce((a, p) => a + (p.total_cost || 0), 0);

  // Variación por producto: promedio del mes contra el mes anterior (o la última compra antes del mes)
  const ids = [...new Set(inMonth.map((p) => p.item_id))];
  const variation = ids.map((id) => {
    const mine = inMonth.filter((p) => p.item_id === id).sort((a, b) => a.date.localeCompare(b.date));
    const now = avgPrice(mine);
    const prevList = inPrev.filter((p) => p.item_id === id);
    let before = avgPrice(prevList);
    let beforeLabel = prevMonth ? monthLabel(prevMonth) : '';
    if (before === null) {
      const older = all.filter((p) => p.item_id === id && p.date < `${purMonth}-01` && p.price_base > 0)[0];
      if (older) { before = older.price_base; beforeLabel = dayLabel(older.date); }
    }
    const pricedMine = mine.filter((p) => p.price_base > 0);
    return {
      id, name: mine.at(-1).item_name, base: mine.at(-1).base_unit, n: mine.length,
      now, before, beforeLabel, change: pct(before, now),
      firstLast: pricedMine.length > 1 ? pct(pricedMine[0].price_base, pricedMine.at(-1).price_base) : null,
      spent: mine.reduce((a, p) => a + (p.total_cost || 0), 0),
    };
  }).sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
  const up = variation.filter((v) => v.change > 0).length;
  const down = variation.filter((v) => v.change < 0).length;

  // Productos con precio para la gráfica
  const chartItems = [...new Map(all.filter((p) => p.price_base > 0).map((p) => [p.item_id, p.item_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (!chartItems.some(([id]) => id === purItem)) purItem = chartItems[0]?.[0] ?? null;

  view.innerHTML = `
    ${invHead()}
    <div class="inv-toolbar"><button class="btn" data-new-purchase>+ Registrar compra</button></div>
    <div class="filters cost-range"><select class="input pur-month" data-pur-month>
      ${months.map((m) => `<option value="${m}" ${m === purMonth ? 'selected' : ''}>${monthLabel(m, true)}</option>`).join('')}
    </select></div>
    <div class="stats">
      <div class="stat"><small>Gastado en ${monthLabel(purMonth)}</small><strong>${money(spent)}</strong></div>
      <div class="stat"><small>Contra ${prevMonth ? monthLabel(prevMonth) : 'mes anterior'}</small><strong>${spentPrev ? `${pct(spentPrev, spent) > 0 ? '+' : ''}${pct(spentPrev, spent)}%` : '—'}</strong></div>
      <div class="stat"><small>Compras</small><strong>${inMonth.length}</strong></div>
      <div class="stat"><small>Subieron / bajaron</small><strong>▲${up} · ▼${down}</strong></div>
    </div>
    ${!all.length ? `<div class="panel inv-onboard"><h3>🧾 Historial de compras</h3><ol>
      <li>Cada vez que compres, registra la compra con <strong>+ Registrar compra</strong> (o con <strong>+ Entrada</strong> en Existencias): fecha, cantidad, unidad y lo que pagaste.</li>
      <li>Se calcula solo el <strong>precio por kilo, litro o pieza</strong>, se suma a tu inventario y se actualiza el costo de tus productos.</li>
      <li>Al final del mes verás qué subió o bajó de precio, y las gráficas de 3, 6 y 12 meses.</li></ol>
      <p class="hint">¿Tienes tickets de meses pasados? Captúralos con su fecha y desmarca "Sumar a la existencia" para que solo cuenten en el historial.</p></div>` : ''}

    ${variation.length ? `<div class="panel inv-panel"><h3>📊 Variación de precios · ${monthLabel(purMonth, true)}</h3>
      <p class="muted small" style="margin-top:0">Precio promedio del mes contra el mes anterior (o tu última compra antes de este mes).</p>
      <div class="cost-table pur-var">
        <div class="cost-tr th"><span>Producto</span><span>Antes</span><span>Ahora</span><span>Cambio</span></div>
        ${variation.map((v) => `<div class="cost-tr"><span>${esc(v.name)} <span class="muted small">${v.n} ${v.n === 1 ? 'compra' : 'compras'}${v.firstLast ? ` · en el mes ${v.firstLast > 0 ? '+' : ''}${v.firstLast}%` : ''}</span></span>
          <span>${v.before ? `${money(v.before)}<br><span class="muted small">${esc(v.beforeLabel)}</span>` : '<span class="muted small">primera vez</span>'}</span>
          <span>${v.now ? `${money(v.now)}<br><span class="muted small">por ${PER[v.base] || v.base}</span>` : '—'}</span>
          <span>${changeChip(v.change)}</span></div>`).join('')}
      </div></div>` : ''}

    ${chartItems.length ? `<div class="panel inv-panel"><div class="panel-head"><h3>📈 Precio en el tiempo</h3>
        <div class="filters">${[[3, 'Trimestral'], [6, 'Semestral'], [12, 'Anual']].map(([n, l]) => `<button class="chip${purRange === n ? ' active' : ''}" data-pur-range="${n}">${l}</button>`).join('')}</div></div>
      <select class="input pur-item" data-pur-item>${chartItems.map(([id, n]) => `<option value="${id}" ${id === purItem ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <div class="pur-summary" data-pur-summary></div>
      <div class="pur-chart" data-pur-chart></div>
    </div>` : ''}

    <div class="panel inv-panel"><h3>🧾 Compras de ${monthLabel(purMonth, true)}</h3>
      ${inMonth.length ? `<div class="pur-list">${inMonth.map((p) => `<div class="pur-row">
        <div class="pur-date">${dayLabel(p.date)}</div>
        <div class="grow"><strong>${esc(p.item_name)}</strong> <span class="muted">· ${fmtQty(p.qty, p.unit)}</span>
          <div class="muted small">${p.supplier ? esc(p.supplier) : ''}${p.note ? `${p.supplier ? ' · ' : ''}${esc(p.note)}` : ''}</div></div>
        <div class="pur-money">${p.total_cost !== null ? `<strong>${money(p.total_cost)}</strong>` : '<span class="muted">sin costo</span>'}
          ${p.price_base ? `<div class="muted small">${money(p.price_base)}/${p.base_unit}</div>` : ''}</div>
        <button class="icon-btn" data-del-purchase="${p.id}" aria-label="Borrar compra">×</button>
      </div>`).join('')}</div>` : '<p class="muted small">No hay compras registradas en este mes.</p>'}
    </div>`;

  bindInvHead();
  const reload = () => renderPurchases();
  $('[data-new-purchase]', view).addEventListener('click', () => purchaseForm(null, data.items, reload));
  $('[data-pur-month]', view).addEventListener('change', (e) => { purMonth = e.target.value; reload(); });
  $$('[data-pur-range]', view).forEach((b) => b.addEventListener('click', () => {
    purRange = Number(b.dataset.purRange);
    $$('[data-pur-range]', view).forEach((x) => x.classList.toggle('active', x === b));
    drawPriceChart(all, data.months);
  }));
  $('[data-pur-item]', view)?.addEventListener('change', (e) => { purItem = Number(e.target.value); drawPriceChart(all, data.months); });
  $$('[data-del-purchase]', view).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar esta compra del historial? La existencia del inventario no cambia (si hace falta, corrígela con Conteo).')) return;
    try { await A(`/inventory/purchases/${b.dataset.delPurchase}`, { method: 'DELETE' }); toast('✓ Compra borrada'); reload(); } catch (e) { toast(e.message, 4000); }
  }));
  if (chartItems.length) drawPriceChart(all, data.months);
}

/** Gráfica de línea: precio promedio por mes del producto elegido (trimestral, semestral o anual). */
function drawPriceChart(all, monthsAll) {
  const box = $('[data-pur-chart]', view);
  const sum = $('[data-pur-summary]', view);
  if (!box) return;
  const months = monthsAll.slice(-purRange);
  const mine = all.filter((p) => p.item_id === purItem && p.price_base > 0);
  const base = mine[0]?.base_unit || '';
  const pts = months.map((m, i) => {
    const list = mine.filter((p) => p.date.startsWith(m));
    const avg = avgPrice(list);
    return { m, i, avg, n: list.length, min: list.length ? Math.min(...list.map((p) => p.price_base)) : null, max: list.length ? Math.max(...list.map((p) => p.price_base)) : null };
  });
  const have = pts.filter((p) => p.avg !== null);
  if (!have.length) {
    sum.innerHTML = '';
    box.innerHTML = `<p class="muted small">Sin compras de este producto en los últimos ${purRange} meses.</p>`;
    return;
  }
  const firstP = have[0], lastP = have.at(-1);
  const ch = have.length > 1 ? pct(firstP.avg, lastP.avg) : null;
  const vals = have.flatMap((p) => [p.min, p.max, p.avg]);
  sum.innerHTML = have.length > 1
    ? `De <strong>${money(firstP.avg)}</strong> (${monthLabel(firstP.m)}) a <strong>${money(lastP.avg)}</strong> (${monthLabel(lastP.m)}) por ${PER[base] || base} ${changeChip(ch)}
       <span class="muted small">· mínimo ${money(Math.min(...vals))} · máximo ${money(Math.max(...vals))}</span>`
    : `<strong>${money(lastP.avg)}</strong> por ${PER[base] || base} en ${monthLabel(lastP.m)} <span class="muted small">· registra más compras para ver la tendencia</span>`;

  const W = Math.max(280, box.clientWidth), H = 220, L = 52, R = 14, T = 14, B = 28;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const step = (() => { const raw = (hi - lo) / 4; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (i) => L + (months.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (months.length - 1));
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  const path = have.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const colW = (W - L - R) / Math.max(1, months.length - 1);
  const showLabel = (i) => months.length <= 6 || i % 2 === (months.length - 1) % 2;

  box.innerHTML = `
    <svg width="${W}" height="${H}" role="img" aria-label="Precio por ${PER[base] || base} de ${esc(mine[0]?.item_name || '')}, últimos ${purRange} meses">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="pc-grid"/><text x="${L - 8}" y="${y(v) + 4}" class="pc-ax" text-anchor="end">${money(v).replace(/\.00$/, '')}</text>`).join('')}
      ${months.map((m, i) => (showLabel(i) ? `<text x="${i === months.length - 1 && months.length > 1 ? W - 2 : x(i)}" y="${H - 8}" class="pc-ax" text-anchor="${i === months.length - 1 && months.length > 1 ? 'end' : 'middle'}">${monthLabel(m)}</text>` : '')).join('')}
      ${have.filter((p) => p.n > 1 && p.max > p.min).map((p) => `<line x1="${x(p.i)}" x2="${x(p.i)}" y1="${y(p.max)}" y2="${y(p.min)}" class="pc-range"/>`).join('')}
      <path d="${path}" class="pc-line"/>
      <line class="pc-cross" y1="${T}" y2="${H - B}" x1="0" x2="0" style="display:none"/>
      ${have.map((p) => `<circle cx="${x(p.i)}" cy="${y(p.avg)}" r="5" class="pc-dot"/>`).join('')}
      ${months.map((m, i) => `<rect x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`).join('')}
    </svg>
    <div class="pc-tip" hidden></div>`;
  const tip = $('.pc-tip', box);
  const cross = $('.pc-cross', box);
  const show = (i) => {
    const p = pts[i];
    cross.style.display = '';
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    tip.hidden = false;
    tip.innerHTML = `<strong>${monthLabel(p.m, true)}</strong><br>${p.avg !== null
      ? `${money(p.avg)} por ${PER[base] || base}<br><span class="muted">${p.n} ${p.n === 1 ? 'compra' : 'compras'}${p.n > 1 && p.max > p.min ? ` · ${money(p.min)} – ${money(p.max)}` : ''}</span>`
      : '<span class="muted">Sin compras</span>'}`;
    const left = Math.min(W - tip.offsetWidth - 4, Math.max(4, x(i) - tip.offsetWidth / 2));
    tip.style.left = `${left}px`;
  };
  $$('rect[data-i]', box).forEach((r) => {
    r.addEventListener('mouseenter', () => show(Number(r.dataset.i)));
    r.addEventListener('click', () => show(Number(r.dataset.i)));
  });
  $('svg', box).addEventListener('mouseleave', () => { tip.hidden = true; cross.style.display = 'none'; });
}

/* --------------------------- Costos y ganancia --------------------------- */

const marginClass = (m) => (m === null ? '' : m >= 65 ? 'm-good' : m >= 50 ? 'm-ok' : 'm-low');
const marginChip = (m) => (m === null ? '<span class="muted small">—</span>' : `<span class="m-chip ${marginClass(m)}">${m}%</span>`);

async function renderCosts() {
  const data = await A(`/inventory/costs?days=${costDays}`);
  const sales = data.sales;
  const withData = data.products.filter((p) => p.has_any);
  const best = [...withData].sort((a, b) => (b.margin ?? -1) - (a.margin ?? -1));

  const lineList = (lines) => lines.map((l) => `<div class="cost-line"><span>${esc(l.name)} <span class="muted">${fmtQty(convertQty(l.qty, l.unit, l.display_unit), l.display_unit)}</span></span><span>${money(l.cost)}</span></div>`).join('');
  const productCard = (p) => `
    <details class="cost-card ${p.active ? '' : 'inactive'}">
      <summary>
        <div class="cost-head">
          <div class="grow"><div class="name">${esc(p.name)}${p.active ? '' : ' <span class="muted small">(oculto)</span>'}</div>
            <div class="sub">${p.has_any ? `${p.cost.min !== p.cost.max ? `Entre ${money(p.cost.min)} y ${money(p.cost.max)} según lo que elijan` : 'Costo fijo'}` : 'Sin recetas todavía'}</div></div>
          <div class="cost-nums">
            <span><small>Precio</small>${money(p.price)}</span>
            <span><small>Costo</small>${p.has_any ? money(p.cost.typical) : '—'}</span>
            <span><small>Ganancia</small><strong>${p.has_any ? money(p.profit) : '—'}</strong></span>
            ${p.has_any ? marginChip(p.margin) : '<span></span>'}
          </div>
        </div>
        ${p.warnings.length ? `<div class="cost-warn">⚠️ ${p.warnings.map(esc).join(' · ')}</div>` : ''}
      </summary>
      <div class="cost-body">
        <div class="cost-sec"><div class="cost-sec-head"><strong>Producto</strong> <span class="muted small">vaso, tapa, cuchara, base fija…</span>
          <button class="btn btn-ghost btn-sm" data-cost-recipe="p${p.id}" data-name="${esc(p.name)}">🧾 Receta</button></div>
          ${p.own.lines.length ? lineList(p.own.lines) : '<p class="muted small">Sin receta propia.</p>'}
          <div class="cost-line total"><span>Subtotal</span><span>${money(p.own.cost)}</span></div>
        </div>
        ${p.groups.filter((g) => g.required).map((g) => `
        <div class="cost-sec"><div class="cost-sec-head"><strong>${esc(g.name)}</strong> <span class="muted small">elige ${g.min_select} · promedio ${money(g.avg)}</span></div>
          ${g.options.map((o) => `<div class="cost-line">
            <span>${esc(o.name)} ${o.has_recipe ? `<span class="muted small">${o.specific ? '· receta de este producto' : '· receta general'}</span>` : '<span class="m-chip m-low">sin receta</span>'}</span>
            <span>${o.has_recipe ? money(o.cost) : ''} <button class="btn btn-ghost btn-sm" data-cost-recipe="p${p.id}t${o.id}" data-fallback="t${o.id}" data-name="${esc(`${o.name} en ${p.name}`)}">🧾</button></span>
          </div>`).join('')}
          <p class="hint">Usa 🧾 para poner el gramaje de cada sabor <strong>en este producto</strong> (ej. la base del bowl chico usa menos que la del grande).</p>
        </div>`).join('')}
        ${p.included_count ? `
        <div class="cost-sec"><div class="cost-sec-head"><strong>${p.included_count} opciones incluidas</strong> <span class="muted small">toppings, spreads y frutas</span></div>
          <div class="cost-line"><span>Promedio (${p.included_count} × ${money(p.included_cost / p.included_count)})</span><span>${money(p.included_cost)}</span></div>
          <p class="hint">Lo que se cobra de más por extras va aparte (ver "Extras").</p>
        </div>` : ''}
        <div class="cost-sec cost-sum">
          <div class="cost-line"><span>Precio de venta</span><span>${money(p.price)}</span></div>
          <div class="cost-line"><span>Costo típico</span><span>− ${money(p.cost.typical)}</span></div>
          <div class="cost-line total"><span>Ganancia por pieza</span><span>${money(p.profit)} ${marginChip(p.margin)}</span></div>
          ${p.cost.max !== p.cost.typical ? `<div class="cost-line muted small"><span>Si eligen lo más caro</span><span>${money(p.profit_worst)} (${p.margin_worst}%)</span></div>` : ''}
        </div>
      </div>
    </details>`;

  view.innerHTML = `
    ${invHead()}
    <div class="filters cost-range">${[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, l]) =>
      `<button class="chip${costDays === d ? ' active' : ''}" data-cost-days="${d}">${l}</button>`).join('')}</div>
    <div class="stats">
      <div class="stat"><small>Vendido (${sales.days} días)</small><strong>${money(sales.revenue)}</strong></div>
      <div class="stat"><small>Costo de ingredientes</small><strong>${money(sales.cost)}</strong></div>
      <div class="stat"><small>Ganancia bruta</small><strong>${money(sales.profit)}</strong></div>
      <div class="stat"><small>Margen</small><strong>${sales.margin === null ? '—' : `${sales.margin}%`}</strong></div>
    </div>
    ${!withData.length ? `<div class="panel inv-onboard"><h3>💰 Para ver tu ganancia</h3><ol>
      <li>En <strong>📦 Existencias</strong>, ponle a cada ingrediente su <strong>costo</strong> (Editar → Costo por unidad, o registra una <strong>+ Entrada</strong> con el costo total y se calcula solo).</li>
      <li>Captura las <strong>recetas</strong> (gramaje) de cada producto y opción.</li>
      <li>Aquí verás cuánto te cuesta hacer cada producto contra su precio y cuánto le ganas.</li></ol></div>` : ''}
    ${sales.uncosted_units ? `<p class="hint">⚠️ ${sales.uncosted_units} de ${sales.units} piezas vendidas no tienen receta: su costo cuenta como $0 y la ganancia real es menor.</p>` : ''}

    <div class="panel inv-panel">
      <div class="panel-head"><div><h3>🥗 Costo y ganancia por producto</h3>
        <span class="muted small">Con el costo actual de tus ingredientes. Toca un producto para ver el desglose.</span></div>
        <span class="muted small">${marginChip(70)} bien · ${marginChip(55)} regular · ${marginChip(40)} bajo</span></div>
      ${data.products.map(productCard).join('')}
    </div>

    ${best.length > 1 ? `<div class="panel inv-panel"><h3>🏆 De más a menos ganancia (%)</h3>
      ${best.map((p) => `<div class="cost-rank"><span class="grow">${esc(p.name)}</span>
        <span class="cost-bar"><span class="${marginClass(p.margin)}" style="width:${Math.max(0, Math.min(100, p.margin ?? 0))}%"></span></span>
        <span class="cost-rank-n">${money(p.profit)} · ${p.margin ?? '—'}%</span></div>`).join('')}</div>` : ''}

    ${data.extras.length ? `<div class="panel inv-panel"><h3>➕ Extras</h3>
      <p class="muted small" style="margin-top:0">Cuando el cliente pide una opción además de las incluidas: lo que cobras contra lo que te cuesta la porción.</p>
      <div class="cost-table">
        <div class="cost-tr th"><span>Opción</span><span>Cobras</span><span>Cuesta</span><span>Ganas</span></div>
        ${data.extras.map((e) => `<div class="cost-tr"><span>${esc(e.name)} <span class="muted small">${esc(e.group)}</span></span>
          <span>${money(e.price)}</span><span>${e.has_recipe ? money(e.cost) : '<span class="muted">sin receta</span>'}</span>
          <span>${e.has_recipe ? `${money(e.profit)} ${marginChip(e.margin)}` : ''}</span></div>`).join('')}
      </div></div>` : ''}

    <div class="panel inv-panel"><h3>📈 Lo que ya vendiste · últimos ${sales.days} días</h3>
      <p class="muted small" style="margin-top:0">${sales.orders} pedidos · ${sales.units} piezas. Calculado con los costos de hoy (incluye lo que cobraste por extras; no incluye envío).</p>
      ${sales.products.length ? `<div class="cost-table sales">
        <div class="cost-tr th"><span>Producto</span><span>Piezas</span><span>Vendido</span><span>Costo</span><span>Ganancia</span></div>
        ${sales.products.map((x) => `<div class="cost-tr"><span>${esc(x.name)}</span><span>${x.units}</span><span>${money(x.revenue)}</span><span>${money(x.cost)}</span>
          <span><strong>${money(x.profit)}</strong> ${marginChip(x.margin)}</span></div>`).join('')}
      </div>` : '<p class="muted small">Aún no hay ventas en este periodo.</p>'}
    </div>`;

  bindInvHead();
  $$('[data-cost-days]', view).forEach((b) => b.addEventListener('click', () => { costDays = Number(b.dataset.costDays); renderCosts(); }));
  $$('[data-cost-recipe]', view).forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    openRecipe(b.dataset.costRecipe, b.dataset.name, renderCosts, b.dataset.fallback);
  }));
}

/** Abre la receta de un producto (p12) u opción (t34) desde cualquier pestaña. */
async function openRecipe(key, name, onSaved, fallback) {
  try {
    const data = await A('/inventory');
    editRecipe(key, name, data, data.items, onSaved, fallback);
  } catch (e) { toast(e.message, 4000); }
}

function editRecipe(key, name, data, items, onSaved, fallback) {
  const byIdR = new Map(items.map((i) => [i.id, i]));
  const own = data.recipes[key] || [];
  const usingFallback = !own.length && fallback && data.recipes[fallback]?.length;
  let lines = (usingFallback ? data.recipes[fallback] : own).map((l) => {
    const it = byIdR.get(l.item_id);
    return it ? { item_id: l.item_id, unit: l.unit || it.unit, qty: Number(lineQty(l, it).toFixed(4)) } : { ...l };
  });
  const options = items.filter((i) => i.active !== false || lines.some((l) => l.item_id === i.id));
  const unitOf = (id) => items.find((i) => i.id === Number(id))?.unit || '';
  const unitSelect = (l) => {
    const base = unitOf(l.item_id);
    const opts = base ? data.unit_families?.[base] || [base] : [];
    if (!opts.includes(l.unit)) l.unit = base;
    return opts.length > 1
      ? `<select class="input recipe-unit" data-f="unit">${opts.map((u) => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>`
      : `<span class="muted small recipe-unit">${esc(base)}</span>`;
  };
  const sheet = openSheet(`
    <div class="sheet-title"><h2>Receta: ${esc(name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
    <div class="sheet-body">
      <p class="muted small" style="margin-top:0">Lo que se descuenta del inventario cada vez que se vende 1 ${/^p\d+$/.test(key) ? 'producto' : 'vez esta opción'}.</p>
      ${fallback ? `<p class="hint" style="margin-top:0">Receta solo para este producto. ${usingFallback ? 'Abajo está la receta general como punto de partida: ajústala y guarda.' : ''} Si la dejas vacía se usa la receta general de la opción.</p>` : ''}
      <div data-lines></div>
      <button class="btn btn-ghost btn-sm" data-add-line ${options.length ? '' : 'disabled'}>+ Agregar ingrediente</button>
      ${options.length ? '' : '<p class="muted small">Primero crea ingredientes en la pestaña 📦 Inventario.</p>'}
      <div class="error-msg hidden" data-error role="alert"></div>
    </div>
    <div class="sheet-foot"><button class="btn btn-lg btn-block" data-save>Guardar receta</button></div>`);
  const box = $('[data-lines]', sheet);
  const draw = () => {
    box.innerHTML = lines.length ? lines.map((l, idx) => `
      <div class="recipe-line" data-idx="${idx}">
        <select class="input" data-f="item_id">
          <option value="">Ingrediente…</option>
          ${options.map((i) => `<option value="${i.id}" ${i.id === Number(l.item_id) ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
        </select>
        <input class="input" data-f="qty" type="number" inputmode="decimal" step="any" min="0" placeholder="Cant." value="${l.qty ?? ''}">
        ${unitSelect(l)}
        <button class="icon-btn" data-remove aria-label="Quitar">×</button>
      </div>`).join('') : '<p class="muted small">Sin ingredientes: este producto no descuenta nada.</p>';
  };
  draw();
  box.addEventListener('input', (e) => {
    const row = e.target.closest('.recipe-line');
    if (!row) return;
    const l = lines[Number(row.dataset.idx)];
    l[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.f === 'item_id') { l.unit = unitOf(e.target.value); $('.recipe-unit', row).outerHTML = unitSelect(l); }
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    lines.splice(Number(b.closest('.recipe-line').dataset.idx), 1);
    draw();
  });
  $('[data-add-line]', sheet).addEventListener('click', () => { lines.push({ item_id: '', qty: '' }); draw(); $$('.recipe-line select', box).at(-1)?.focus(); });
  $('[data-save]', sheet).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await A(`/inventory/recipes/${key}`, { method: 'PUT', body: { lines: lines.filter((l) => l.item_id || l.qty) } });
      closeSheet();
      toast('✓ Receta guardada');
      onSaved?.();
    } catch (ex) {
      e.target.disabled = false;
      const err = $('[data-error]', sheet);
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
}

/* ================================= Inicio ================================= */

(async () => {
  try {
    await api('/api/admin/me');
    showApp();
  } catch {
    showLogin();
  }
})();
