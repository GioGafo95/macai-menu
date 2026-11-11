import crypto from 'node:crypto';
import { store, ConflictError } from './store/index.js';
import { DEFAULT_TIERS } from './distance.js';

export { store };

/* ============================== Ajustes ============================== */

const DEFAULTS = {
  business_name: 'Macaí Bowls',
  tagline: 'Comida saludable, hecha al momento',
  whatsapp_number: '',
  currency: 'MXN',
  locale: 'es-MX',
  estimated_time: '30 a 45 min',
  store_open: '1',
  closed_message: 'Por ahora estamos cerrados. ¡Vuelve pronto!',
  delivery_enabled: '1',
  // 'distance' = costo por km desde el negocio (mapa) · 'zones' = zonas o costo fijo
  delivery_mode: 'distance',
  // Calle General Ángel Flores, Centro, Los Mochis (ajustable desde el panel)
  store_lat: '25.794786',
  store_lng: '-108.992708',
  delivery_tiers: DEFAULT_TIERS,
  delivery_flat_fee: '30',
  free_delivery_over: '0',
  min_order: '0',
  pickup_enabled: '1',
  pickup_address: 'Calle General Ángel Flores 14, Centro, 81200 Los Mochis, Sin.',
  cash_enabled: '1',
  transfer_enabled: '1',
  bank_info: 'Banco: \nTitular: \nCLABE: \nConcepto: tu número de pedido',
  notify_telegram_token: '',
  notify_telegram_chat_id: '',
  notify_callmebot_phone: '',
  notify_callmebot_apikey: '',
  notify_twilio_sid: '',
  notify_twilio_token: '',
  notify_twilio_from: '',
  notify_twilio_to: '',
  notify_twilio_sms: '0',
  notify_twilio_whatsapp: '0',
  notify_twilio_call: '0',
  public_url: '',
  webhook_url: '',
  webhook_secret: '',
  api_key: '',
  session_secret: '',
  admin_password_hash: '',
};

/** Ajustes que nunca salen del servidor. */
export const PRIVATE_KEYS = new Set(['session_secret', 'admin_password_hash']);

/** Ajustes visibles para cualquier cliente en la página de pedidos. */
export const PUBLIC_KEYS = [
  'business_name', 'tagline', 'whatsapp_number', 'currency', 'locale', 'estimated_time',
  'store_open', 'closed_message', 'delivery_enabled', 'delivery_flat_fee', 'free_delivery_over',
  'delivery_mode', 'store_lat', 'store_lng', 'delivery_tiers', 'min_order', 'pickup_enabled', 'pickup_address', 'cash_enabled', 'transfer_enabled', 'bank_info',
];

export const EDITABLE_KEYS = Object.keys(DEFAULTS).filter(
  (k) => !PRIVATE_KEYS.has(k) && k !== 'api_key' && k !== 'webhook_secret',
);

export const randomKey = (prefix = '') => prefix + crypto.randomBytes(24).toString('hex');

/** Lee un documento, aplica cambios y guarda; reintenta si otra instancia escribió al mismo tiempo. */
async function mutateDoc(key, initial, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getDoc(key);
    const data = structuredClone(cur?.data ?? initial());
    const result = await fn(data);
    try {
      await store.putDoc(key, data, cur ? cur.version : null);
      return result === undefined ? data : result;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new Error(`No se pudo guardar "${key}" por escrituras simultáneas. Intenta de nuevo.`);
}

export async function getSettings() {
  const doc = await store.getDoc('settings');
  return { ...DEFAULTS, ...(doc?.data || {}) };
}

/** patch: { clave: valor } (los valores se guardan como texto) */
export async function updateSettings(patch) {
  const data = await mutateDoc('settings', () => ({}), (s) => {
    for (const [k, v] of Object.entries(patch)) s[k] = v == null ? '' : String(v);
  });
  return { ...DEFAULTS, ...data };
}

/* ============================== Catálogo ============================== */

export const emptyCatalog = () => ({
  categories: [], products: [], groups: [], zones: [],
  seq: { category: 0, product: 0, group: 0, topping: 0, zone: 0 },
});

export async function getCatalog() {
  const doc = await store.getDoc('catalog');
  return doc?.data ?? emptyCatalog();
}

/** fn(catalog) modifica el catálogo en memoria; lo que regrese fn es el resultado. */
export function mutateCatalog(fn) {
  return mutateDoc('catalog', emptyCatalog, fn);
}

export function nextSeq(cat, kind) {
  cat.seq ||= {};
  cat.seq[kind] = (cat.seq[kind] || 0) + 1;
  return cat.seq[kind];
}

export const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id;

/* ============================ Inicialización ============================ */

let initPromise = null;

/**
 * Prepara la base la primera vez: claves secretas, contraseña de admin y menú inicial.
 * Es seguro llamarlo varias veces y desde varias instancias.
 */
export function init() {
  initPromise ||= (async () => {
    const s = await getSettings();
    const patch = {};
    if (!s.api_key) patch.api_key = randomKey('mk_');
    if (!s.webhook_secret) patch.webhook_secret = randomKey('whsec_');
    if (!s.session_secret) patch.session_secret = randomKey();
    if (Object.keys(patch).length) {
      await mutateDoc('settings', () => ({}), (d) => {
        for (const [k, v] of Object.entries(patch)) if (!d[k]) d[k] = v; // otra instancia pudo haberlo creado ya
      });
    }
    const { ensureAdminPassword } = await import('./auth.js');
    await ensureAdminPassword();

    if (!(await store.getDoc('catalog'))) {
      const { buildMacaiCatalog } = await import('./catalog.js');
      try {
        await store.putDoc('catalog', buildMacaiCatalog(), null);
        console.log('Se cargó el menú de Macaí Bowls. Puedes editarlo desde /admin');
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}
