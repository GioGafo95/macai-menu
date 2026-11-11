export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const nowIso = () => new Date().toISOString();

/** Texto recortado; '' si no es string/number. */
export function str(v, max = 255) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).trim().slice(0, max);
}

/** Texto obligatorio. */
export function reqStr(v, label, max = 255) {
  const s = str(v, max);
  if (!s) throw new HttpError(400, `${label} es obligatorio`);
  return s;
}

export function int(v, def = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function num(v, label, { min = 0, max = 1_000_000 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} no es válido`);
  return round2(n);
}

export function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

export function money(n, settings = {}) {
  try {
    return new Intl.NumberFormat(settings.locale || 'es-MX', {
      style: 'currency',
      currency: settings.currency || 'MXN',
    }).format(Number(n) || 0);
  } catch {
    return `$${(Number(n) || 0).toFixed(2)}`;
  }
}

/** Limitador de peticiones simple en memoria, por IP. */
export function rateLimit({ windowMs, max, message = 'Demasiadas solicitudes, intenta en unos minutos.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) return next(new HttpError(429, message));
    next();
  };
}

/** Acepta 'YYYY-MM-DD' o ISO completo; devuelve ISO UTC o null. */
export function parseDate(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v);
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  } else {
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Fecha inválida: ${s}`);
  return d.toISOString();
}

export function isSafeImageUrl(u) {
  if (!u) return true;
  return /^\/uploads\/[\w.-]+$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u);
}

/** true cuando corre dentro de AWS Lambda. */
export const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

/**
 * Tareas "en segundo plano" (notificaciones, webhook).
 * En Lambda la ejecución se congela al responder, así que ahí se espera a que terminen;
 * en un servidor normal no se espera para responder más rápido.
 *   await settle(tarea)
 */
export function settle(promise, label = 'tarea') {
  const p = Promise.resolve(promise).catch((e) => console.error(`[${label}]`, e));
  return IS_LAMBDA ? p : undefined;
}

/** URL base pública a partir de la petición (en AWS, una función de CloudFront envía x-original-host). */
export function baseUrlOf(req) {
  const host = req.get('x-original-host') || req.get('x-forwarded-host') || req.get('host');
  return `${req.protocol}://${host}`;
}
