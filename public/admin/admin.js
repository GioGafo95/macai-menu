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
};
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

const TABS = { orders: renderOrders, menu: renderMenu, toppings: renderToppings, delivery: renderDelivery, settings: renderSettings };

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
      <div class="row"><span>👤</span><div><strong>${esc(o.customer.name)}</strong>
        <span class="contact-links"><a href="tel:${esc(phone)}">📞 ${esc(o.customer.phone)}</a>
        <a href="https://wa.me/${esc(waPhone.length === 10 ? '52' + waPhone : waPhone)}" target="_blank" rel="noopener">WhatsApp</a></span></div></div>
      ${o.fulfillment === 'delivery'
        ? `<div class="row"><span>🛵</span><div>${esc(o.address)}${o.zone ? ` <span class="muted">(${esc(o.zone.name)})</span>` : ''}${o.location ? ` <span class="muted">· ${o.location.distance_km} km</span>` : ''}
            ${o.address_ref ? `<div class="muted small">${esc(o.address_ref)}</div>` : ''}
            <a class="small" href="https://www.google.com/maps/search/?api=1&query=${o.location ? `${o.location.lat},${o.location.lng}` : encodeURIComponent(o.address)}" target="_blank" rel="noopener">${o.location ? '📍 Ver ubicación en el mapa' : 'Ver en mapa'}</a></div></div>`
        : '<div class="row"><span>🏪</span><div><strong>Recoge en tienda</strong></div></div>'}
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
        <span>${o.payment_method === 'cash' ? '💵' : '🏦'}</span>
        <div style="flex:1">${o.payment_method === 'cash' ? 'Efectivo' : 'Transferencia'}
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
              <button class="btn btn-ghost btn-sm" data-edit-top="${g.id}:${t.id}">Editar</button>
            </div>
          </div>`).join('') || '<p class="muted small">Sin opciones todavía.</p>'}
      </div>`).join('') || '<div class="panel empty"><p>Aún no hay grupos de toppings.</p></div>'}`;

  $('[data-new-group]', view).addEventListener('click', () => editGroup(null));
  $$('[data-edit-group]', view).forEach((b) => b.addEventListener('click', () => editGroup(groups.find((g) => g.id === Number(b.dataset.editGroup)))));
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
        { name: 'estimated_time', label: 'Tiempo estimado', placeholder: 'Ej. 30 a 45 min' },
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

/* ================================= Inicio ================================= */

(async () => {
  try {
    await api('/api/admin/me');
    showApp();
  } catch {
    showLogin();
  }
})();
