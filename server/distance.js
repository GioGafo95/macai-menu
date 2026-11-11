/**
 * Costo de envío por distancia desde el negocio.
 *
 * - Distancia por calle con OSRM (servicio público y gratuito de OpenStreetMap).
 * - Si OSRM no responde, se usa la distancia en línea recta × 1.3 (aproximación de la ruta).
 * - Tarifas por rangos de km, editables en el panel (Envío → Tarifas por distancia).
 */
import { HttpError, round2 } from './util.js';

export const DEFAULT_TIERS = '2 = 35\n4 = 40\n6 = 45\n8 = 50\n10 = 55';

/** Convierte "2 = 35\n4 = 40" → [{ km: 2, fee: 35 }, { km: 4, fee: 40 }] ordenado por km. */
export function parseTiers(text, { strict = false } = {}) {
  const tiers = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+(?:[.,]\d+)?)\s*(?:km)?\s*[=:→-]+\s*\$?\s*(\d+(?:[.,]\d+)?)$/i);
    if (!m) {
      if (strict) throw new HttpError(400, `No entendí la tarifa "${line}". Usa el formato: 2 = 35 (hasta 2 km cuesta $35)`);
      continue;
    }
    tiers.push({ km: Number(m[1].replace(',', '.')), fee: Number(m[2].replace(',', '.')) });
  }
  tiers.sort((a, b) => a.km - b.km);
  if (strict && !tiers.length) throw new HttpError(400, 'Agrega al menos una tarifa por distancia (ej. 2 = 35)');
  return tiers;
}

export function storeLocation(s) {
  const lat = Number(s.store_lat), lng = Number(s.store_lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null;
}

export function parsePoint(input) {
  const lat = Number(input?.lat), lng = Number(input?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

export function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';

/** Distancia en km manejando por calle; null si el servicio no responde. */
async function roadKm(from, to) {
  if (process.env.OSRM_URL === 'off') return null;
  try {
    const url = `${OSRM_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'macai-menu/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meters = data?.routes?.[0]?.distance;
    return Number.isFinite(meters) ? meters / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Cotiza el envío a un punto.
 * → { distance_km, fee, available, max_km, method: 'ruta' | 'aprox', message? }
 */
export async function quoteDelivery(point, s) {
  const origin = storeLocation(s);
  if (!origin) throw new HttpError(503, 'El negocio aún no tiene ubicación configurada para calcular el envío.');
  const to = parsePoint(point);
  if (!to) throw new HttpError(400, 'Marca tu ubicación en el mapa');

  const straight = haversineKm(origin, to);
  const tiers = parseTiers(s.delivery_tiers);
  const max_km = tiers.length ? tiers[tiers.length - 1].km : 0;

  // Muy lejos: ni siquiera consultamos la ruta
  let km = null, method = 'ruta';
  if (straight <= max_km * 1.5 + 1) km = await roadKm(origin, to);
  if (km == null) { km = straight * 1.3; method = 'aprox'; }

  const distance_km = Math.round(km * 10) / 10; // los repartidores cobran por rangos de 0.1 km
  const tier = tiers.find((t) => distance_km <= t.km);
  if (!tier) {
    return {
      distance_km, fee: null, available: false, max_km, method,
      message: `Tu dirección está a ${distance_km} km. Enviamos hasta ${max_km} km; para lugares más lejanos (como ejidos) escríbenos por WhatsApp y te cotizamos.`,
    };
  }
  return { distance_km, fee: round2(tier.fee), available: true, max_km, method };
}
