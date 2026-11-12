import { $, esc, money, setCurrency, api, toast } from './common.js';

const params = new URLSearchParams(location.search);
const token = params.get('t');
const isNew = params.get('nuevo') === '1';
let timer;

const FLOW = {
  delivery: [['nuevo', 'Pedido recibido'], ['preparando', 'Preparando'], ['listo', 'Listo'], ['en_camino', 'En camino'], ['entregado', 'Entregado']],
  pickup: [['nuevo', 'Pedido recibido'], ['preparando', 'Preparando'], ['listo', 'Listo para recoger'], ['entregado', 'Entregado']],
  dine_in: [['nuevo', 'Pedido recibido'], ['preparando', 'Preparando'], ['listo', 'Listo'], ['entregado', 'Entregado']],
};

async function load() {
  if (!token) return renderError('No encontramos tu pedido.');
  try {
    const o = await api(`/api/public/orders/${encodeURIComponent(token)}`);
    render(o);
    clearTimeout(timer);
    if (!['entregado', 'cancelado'].includes(o.status)) timer = setTimeout(load, 15000);
  } catch (e) {
    if (e.status === 404) renderError('No encontramos tu pedido. Revisa el enlace.');
    else timer = setTimeout(load, 15000);
  }
}

function renderError(msg) {
  $('#root').innerHTML = `<div class="card empty"><div class="big">🔍</div><p>${esc(msg)}</p><a class="btn" href="/">Ir al menú</a></div>`;
}

function render(o) {
  setCurrency(o.locale, o.currency);
  document.title = `Pedido #${o.id} · ${o.business_name}`;
  const flow = FLOW[o.fulfillment] || FLOW.delivery;
  const idx = flow.findIndex(([k]) => k === o.status);
  const cancelled = o.status === 'cancelado';

  $('#root').innerHTML = `
    <a href="/"><img class="track-logo" src="/logo.png" alt="${esc(o.business_name)}"></a>
    <div class="card success-head">
      <div class="big">${cancelled ? '❌' : o.status === 'entregado' ? '🎉' : isNew && o.status === 'nuevo' ? '✅' : '🥣'}</div>
      <h1>${cancelled ? 'Pedido cancelado' : isNew && o.status === 'nuevo' ? '¡Pedido enviado!' : `Pedido #${o.id}`}</h1>
      <p class="muted" style="margin:0">
        ${cancelled ? 'Si tienes dudas, escríbenos por WhatsApp.'
          : `Pedido <strong>#${o.id}</strong> · ${esc(o.customer_name)}${o.estimated_time && o.status !== 'entregado' ? `<br>Tiempo estimado: ${esc(o.estimated_time)}` : ''}`}
      </p>
    </div>

    ${!cancelled ? `
    <div class="card">
      <h2>Estado</h2>
      <ol class="timeline">
        ${flow.map(([k, label], i) => `
          <li class="${i < idx || o.status === 'entregado' ? 'done' : i === idx ? 'current' : ''}">
            <span class="dot">${i < idx || o.status === 'entregado' ? '✓' : i + 1}</span>${esc(label)}
          </li>`).join('')}
      </ol>
      <p class="muted small" style="margin:8px 0 0">Esta página se actualiza sola.</p>
    </div>` : ''}

    ${o.payment_method === 'transfer' && !o.paid && !cancelled ? `
    <div class="card">
      <h2>🏦 Paga por transferencia</h2>
      <p style="margin:0">Total a transferir: <strong>${money(o.total)}</strong></p>
      ${o.bank_info ? `<div class="box" id="bank">${esc(o.bank_info)}</div>
      <div class="actions" style="grid-template-columns:1fr">
        <button class="btn btn-light" id="copy-bank">Copiar datos bancarios</button>
      </div>` : ''}
      <p class="muted small" style="margin:10px 0 0">Usa como concepto: <strong>Pedido ${o.id}</strong>. Envíanos tu comprobante por WhatsApp.</p>
    </div>` : ''}

    ${o.paid ? '<div class="card"><strong>✅ Pago recibido.</strong> ¡Gracias!</div>' : ''}

    <div class="card">
      <h2>Resumen</h2>
      ${o.items.map((i) => `
        <div class="line-item">
          <div>
            <div><strong>${i.quantity}×</strong> ${esc(i.name)}</div>
            ${i.toppings.length ? `<div class="extra">${i.toppings.map((t) => esc(t.name) + (t.price > 0 ? ` (+${money(t.price)})` : "")).join(', ')}</div>` : ''}
            ${i.note ? `<div class="extra">📝 ${esc(i.note)}</div>` : ''}
          </div>
          <div>${money(i.line_total)}</div>
        </div>`).join('')}
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
        ${o.fulfillment === 'delivery' ? `<div class="row"><span>Envío${o.zone ? ` (${esc(o.zone)})` : ''}</span><span>${o.delivery_fee > 0 ? money(o.delivery_fee) : 'Gratis'}</span></div>` : ''}
        <div class="row total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>
      <div class="box" style="background:#f4f5f2">
${o.fulfillment === 'delivery' ? `🛵 Envío a: ${esc(o.address)}` : `🏪 Recoges en tienda${o.pickup_address ? `: ${esc(o.pickup_address)}` : ''}`}
${o.payment_method === 'cash' ? `💵 Efectivo${o.cash_amount ? ` · pagas con ${money(o.cash_amount)} (cambio ${money(o.change_due)})` : ''}` : '🏦 Transferencia'}${o.notes ? `\n💬 ${esc(o.notes)}` : ''}</div>
    </div>

    <div class="actions">
      ${o.whatsapp_url ? `<a class="btn btn-wa btn-lg" href="${esc(o.whatsapp_url)}" target="_blank" rel="noopener">💬 Enviar pedido por WhatsApp</a>` : ''}
      <a class="btn btn-ghost" href="/">Volver al menú</a>
    </div>`;

  $('#copy-bank')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${o.bank_info}\nMonto: ${money(o.total)}\nConcepto: Pedido ${o.id}`);
      toast('Datos copiados');
    } catch {
      toast('No se pudo copiar. Mantén presionado el texto para copiarlo.');
    }
  });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
load();
