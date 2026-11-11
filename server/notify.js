import crypto from 'node:crypto';
import { getSettings } from './data.js';
import { formatOrderText, STATUS_LABELS } from './orders.js';
import { money } from './util.js';

const TIMEOUT = 10_000;

async function check(res, name) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${name}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return name;
}

/* ----------------------------- Canales ----------------------------- */

// Telegram: gratis y llega como notificación push al celular.
async function telegram(s, text) {
  const res = await fetch(`https://api.telegram.org/bot${s.notify_telegram_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: s.notify_telegram_chat_id, text }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return check(res, 'Telegram');
}

// CallMeBot: mensaje de WhatsApp gratis a TU propio número (uso personal).
async function callmebot(s, text) {
  const url = new URL('https://api.callmebot.com/whatsapp.php');
  url.searchParams.set('phone', s.notify_callmebot_phone);
  url.searchParams.set('text', text);
  url.searchParams.set('apikey', s.notify_callmebot_apikey);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  return check(res, 'WhatsApp (CallMeBot)');
}

// Twilio: SMS, WhatsApp Business o llamada telefónica (de pago).
async function twilio(s, path, params, name) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.notify_twilio_sid}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${s.notify_twilio_sid}:${s.notify_twilio_token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return check(res, name);
}

const xmlEscape = (t) => String(t).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function channelsFor(s, text, voiceText) {
  const tasks = [];
  if (s.notify_telegram_token && s.notify_telegram_chat_id) tasks.push(() => telegram(s, text));
  if (s.notify_callmebot_phone && s.notify_callmebot_apikey) tasks.push(() => callmebot(s, text));
  const tw = s.notify_twilio_sid && s.notify_twilio_token && s.notify_twilio_from && s.notify_twilio_to;
  if (tw && s.notify_twilio_sms === '1') {
    tasks.push(() => twilio(s, 'Messages.json', { To: s.notify_twilio_to, From: s.notify_twilio_from, Body: text.slice(0, 1500) }, 'SMS (Twilio)'));
  }
  if (tw && s.notify_twilio_whatsapp === '1') {
    tasks.push(() => twilio(s, 'Messages.json', {
      To: `whatsapp:${s.notify_twilio_to}`, From: `whatsapp:${s.notify_twilio_from}`, Body: text,
    }, 'WhatsApp (Twilio)'));
  }
  if (tw && s.notify_twilio_call === '1') {
    const twiml = `<Response><Say language="es-MX">${xmlEscape(voiceText)}</Say><Pause length="1"/><Say language="es-MX">${xmlEscape(voiceText)}</Say></Response>`;
    tasks.push(() => twilio(s, 'Calls.json', { To: s.notify_twilio_to, From: s.notify_twilio_from, Twiml: twiml }, 'Llamada (Twilio)'));
  }
  return tasks;
}

/* ----------------------------- Webhook ----------------------------- */

/**
 * Envía el evento a la URL configurada (p. ej. tu app de registro de ventas).
 * Firma: header X-Macai-Signature = "sha256=" + HMAC_SHA256(webhook_secret, body)
 */
export async function sendWebhook(event, order, s) {
  s ||= await getSettings();
  if (!s.webhook_url) return null;
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data: order });
  const sig = crypto.createHmac('sha256', s.webhook_secret).update(body).digest('hex');
  const res = await fetch(s.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'macai-menu-webhook/1.0',
      'X-Macai-Event': event,
      'X-Macai-Signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return check(res, 'Webhook');
}

/* ------------------------------ Público ------------------------------ */

async function runAll(tasks) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  return results.map((r) => (r.status === 'fulfilled' ? { ok: true, channel: r.value } : { ok: false, error: r.reason?.message || String(r.reason) }));
}

export async function notifyNewOrder(order, baseUrl) {
  const s = await getSettings();
  const text = formatOrderText(order, s, { baseUrl: s.public_url || baseUrl });
  const voice = `Nuevo pedido número ${order.id} de ${order.customer.name}, por ${money(order.total, s)}. Revisa el panel.`;
  const tasks = channelsFor(s, text, voice);
  if (s.webhook_url) tasks.push(() => sendWebhook('order.created', order, s));
  const results = await runAll(tasks);
  for (const r of results) if (!r.ok) console.error(`[notificación] pedido #${order.id}: ${r.error}`);
  return results;
}

export async function notifyOrderUpdated(order) {
  const s = await getSettings();
  if (!s.webhook_url) return;
  try {
    await sendWebhook('order.updated', order, s);
  } catch (e) {
    console.error(`[webhook] pedido #${order.id}: ${e.message}`);
  }
}

export async function sendTest() {
  const s = await getSettings();
  const text = `✅ Prueba de notificación de ${s.business_name}. Si ves esto, ¡ya quedó configurado!`;
  const tasks = channelsFor(s, text, `Esta es una prueba de notificaciones de ${s.business_name}.`);
  if (s.webhook_url) {
    tasks.push(() => sendWebhook('test', { message: text, status_labels: STATUS_LABELS }, s));
  }
  if (!tasks.length) return [{ ok: false, error: 'No hay ningún canal configurado todavía.' }];
  return runAll(tasks);
}
