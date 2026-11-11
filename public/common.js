export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
export function setCurrency(locale, currency) {
  try { fmt = new Intl.NumberFormat(locale || 'es-MX', { style: 'currency', currency: currency || 'MXN' }); } catch { /* usa el anterior */ }
}
export const money = (n) => fmt.format(Number(n) || 0);

export async function api(path, { method = 'GET', body, headers } = {}) {
  const opts = { method, headers: { ...(headers || {}) }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('Sin conexión. Revisa tu internet e intenta de nuevo.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
export function toast(msg, ms = 2400) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}

export const store = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* modo privado */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* modo privado */ }
  },
};

export const PLACEHOLDER_EMOJI = ['🥣', '🍓', '🥭', '🫐', '🍌', '🥥', '🥝', '🍍'];
export const emojiFor = (id) => PLACEHOLDER_EMOJI[(Number(id) || 0) % PLACEHOLDER_EMOJI.length];
