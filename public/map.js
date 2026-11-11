/**
 * Mapa para marcar la ubicación de entrega (Leaflet + OpenStreetMap, sin API keys ni costo).
 * Leaflet se carga solo cuando se necesita el mapa.
 */

const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
let leafletPromise = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ||= new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), {
      rel: 'stylesheet', href: `${LEAFLET}leaflet.css`, crossOrigin: '',
      integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
    });
    const js = Object.assign(document.createElement('script'), {
      src: `${LEAFLET}leaflet.js`, crossOrigin: '',
      integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
    });
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletPromise = null; reject(new Error('No se pudo cargar el mapa. Revisa tu conexión.')); };
    document.head.append(css, js);
  });
  return leafletPromise;
}

const pinIcon = (L, cls, emoji) => L.divIcon({
  className: '', iconSize: [36, 44], iconAnchor: [18, 42],
  html: `<div class="map-pin ${cls}"><span>${emoji}</span></div>`,
});

/**
 * Crea un mapa en `el`.
 *  - store: {lat,lng} del negocio (pin fijo)
 *  - pin: {lat,lng} inicial del cliente (opcional)
 *  - onPick({lat,lng}) cuando el cliente toca el mapa, arrastra el pin o busca una dirección
 */
export async function createMap(el, { store, pin = null, onPick, storeLabel = 'Aquí estamos', pinEmoji = '🏠' }) {
  const L = await loadLeaflet();
  const map = L.map(el, { scrollWheelZoom: false }).setView(pin || store, pin ? 16 : 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    referrerPolicy: 'strict-origin-when-cross-origin', // OpenStreetMap pide el origen del sitio
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);

  if (store) L.marker(store, { icon: pinIcon(L, 'store', '🥣'), keyboard: false, zIndexOffset: -100 }).addTo(map).bindTooltip(storeLabel);

  let marker = null;
  const round = (ll) => ({ lat: Math.round(ll.lat * 1e6) / 1e6, lng: Math.round(ll.lng * 1e6) / 1e6 });

  function set(latlng, { fly = true, notify = true } = {}) {
    if (!marker) {
      marker = L.marker(latlng, { icon: pinIcon(L, 'home', pinEmoji), draggable: true, autoPan: true }).addTo(map);
      marker.on('dragend', () => onPick?.(round(marker.getLatLng())));
    } else {
      marker.setLatLng(latlng);
    }
    if (fly) map.setView(latlng, Math.max(map.getZoom(), 16));
    if (notify) onPick?.(round(L.latLng(latlng)));
  }

  map.on('click', (e) => set(e.latlng, { fly: false }));
  if (pin) set(pin, { fly: false, notify: false });

  return { map, set, refresh: () => map.invalidateSize() };
}

/* ------------------------- Búsqueda de direcciones ------------------------- */
// Nominatim (OpenStreetMap): gratis, máximo 1 consulta por segundo → solo al presionar "Buscar".

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export async function searchAddress(q, near) {
  const d = 0.3; // ~30 km alrededor del negocio
  const params = new URLSearchParams({
    format: 'jsonv2', q, limit: '5', countrycodes: 'mx', 'accept-language': 'es', addressdetails: '1',
    ...(near ? { viewbox: `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`, bounded: '1' } : {}),
  });
  const res = await fetch(`${NOMINATIM}/search?${params}`);
  if (!res.ok) throw new Error('No pudimos buscar la dirección. Intenta tocando el mapa.');
  const seen = new Set();
  return (await res.json())
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: shortAddress(r.address) || r.display_name }))
    .filter((r) => !seen.has(r.label) && seen.add(r.label)); // una calle puede venir en varios tramos
}

export async function reverseAddress({ lat, lng }) {
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: '18', addressdetails: '1', 'accept-language': 'es' });
    const res = await fetch(`${NOMINATIM}/reverse?${params}`);
    if (!res.ok) return '';
    return shortAddress((await res.json()).address);
  } catch { return ''; }
}

function shortAddress(a = {}) {
  const street = [a.road || a.pedestrian || a.footway, a.house_number].filter(Boolean).join(' ');
  const area = a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet || '';
  const city = a.city || a.town || a.village || '';
  return [street, area, area === city ? '' : city].filter(Boolean).join(', ');
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Tu navegador no permite obtener la ubicación.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1
        ? 'No diste permiso para usar tu ubicación. Búscala o toca el mapa.'
        : 'No pudimos obtener tu ubicación. Búscala o toca el mapa.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}
