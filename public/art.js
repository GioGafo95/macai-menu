/**
 * Ilustraciones de producto (SVG) cuando no hay foto: un bowl visto desde arriba, un vaso de smoothie
 * o un waffle, con los colores de los ingredientes que menciona la descripción.
 * Si el producto tiene foto subida desde el panel, se usa la foto.
 */

// Colores por ingrediente (lo que aparezca primero en nombre + descripción manda en la base)
const INGREDIENTS = [
  [/a[çc]a[ií]|macai|frutos rojos|berry|zarzamora/, '#6b2d5c'],
  [/pitahaya|kimbi|dragon/, '#d6336c'],
  [/fresa|strawberry/, '#e8485d'],
  [/frambuesa/, '#d93a6b'],
  [/mango/, '#ffb627'],
  [/pi[ñn]a/, '#ffd23f'],
  [/papaya/, '#ff8c42'],
  [/matcha|espinaca|kiwi|verde/, '#7cb342'],
  [/cacao|choco|cocoa|chocolate/, '#7b4a2e'],
  [/cacahuate|peanut|crema de/, '#c98b4f'],
  [/pl[aá]tano|banana/, '#f6d878'],
  [/coco/, '#f4eee2'],
  [/yogur|vainilla|leche/, '#fbf6ee'],
  [/blueberr|mora azul|ar[aá]ndano/, '#3d5a98'],
];

export function palette(text = '', fallback = null) {
  const t = text.toLowerCase();
  const found = [];
  for (const [re, color] of INGREDIENTS) {
    const i = t.search(re);
    if (i >= 0) found.push([i, color]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const colors = [...new Set(found.map((f) => f[1]))];
  if (!colors.length && fallback) return fallback;
  return {
    base: colors[0] || '#f29e5c',
    a: colors[1] || '#f6d878',
    b: colors[2] || '#e8485d',
  };
}

const kindOf = (p, catName = '') => {
  const t = `${catName} ${p.name}`.toLowerCase();
  if (/smoothie|bebida|jugo|licuado|frapp|latte|caf[eé]/.test(t)) return 'cup';
  if (/waffle|crepa|hot ?cake|pancake/.test(t)) return 'waffle';
  return 'bowl';
};

let uid = 0;
const ACAI = { base: '#6b2d5c', a: '#3d5a98', b: '#e8485d' };

/** Bowl visto desde arriba: base del color del sabor + plátano, fresa, granola, coco y moras. */
function bowl(c, seed) {
  const id = `b${++uid}`;
  const r = (n) => ((Math.sin(seed * 9301 + n * 49297) + 1) / 2); // pseudoaleatorio estable
  const granola = Array.from({ length: 16 }, (_, i) => {
    const a = -0.2 + (i / 16) * 1.5 + r(i) * 0.1;
    const d = 18 + r(i + 40) * 20;
    return `<circle cx="${(60 + Math.cos(a) * d).toFixed(1)}" cy="${(60 + Math.sin(a) * d).toFixed(1)}" r="${(2.6 + r(i + 7) * 1.6).toFixed(1)}" fill="#e2b56f" stroke="#c99550" stroke-width=".6"/>`;
  }).join('');
  const banana = [0, 1, 2, 3].map((i) => {
    const a = 2.2 + i * 0.42;
    return `<g transform="translate(${(60 + Math.cos(a) * 28).toFixed(1)} ${(60 + Math.sin(a) * 28).toFixed(1)})"><circle r="8.5" fill="#fbeaa6" stroke="#ecd27a" stroke-width="1.2"/><circle r="2.2" fill="#e8cf86"/></g>`;
  }).join('');
  const fruit = [0, 1, 2].map((i) => {
    const a = 3.9 + i * 0.5;
    return `<path transform="translate(${(60 + Math.cos(a) * 27).toFixed(1)} ${(60 + Math.sin(a) * 27).toFixed(1)}) rotate(${(a * 57).toFixed(0)})" d="M0-9c6 0 9 5 7 10-2 5-5 8-7 8s-5-3-7-8c-2-5 1-10 7-10z" fill="${c.b}"/>`;
  }).join('');
  const berries = [0, 1, 2, 3, 4].map((i) => `<circle cx="${(52 + i * 5 + r(i + 90) * 3).toFixed(1)}" cy="${(36 + r(i + 30) * 8).toFixed(1)}" r="3.4" fill="${c.a === '#3d5a98' ? c.a : '#3d5a98'}"/>`).join('');
  return `
  <svg viewBox="0 0 120 120" class="art" aria-hidden="true">
    <defs><radialGradient id="${id}" cx="45%" cy="40%" r="65%"><stop offset="0" stop-color="${c.base}" stop-opacity=".88"/><stop offset="1" stop-color="${c.base}"/></radialGradient></defs>
    <circle cx="60" cy="62" r="56" fill="rgba(18,48,74,.10)"/>
    <circle cx="60" cy="60" r="56" fill="#fffdf9" stroke="#efe4d8" stroke-width="2"/>
    <circle cx="60" cy="60" r="47" fill="url(#${id})"/>
    <path d="M60 13a47 47 0 0 1 40 22L60 60z" fill="#f7f2e8" opacity=".95"/>
    <g opacity=".9">${Array.from({ length: 14 }, (_, i) => `<path d="M${(70 + r(i) * 22).toFixed(1)} ${(20 + r(i + 5) * 16).toFixed(1)}l4 1" stroke="#e6dccb" stroke-width="1.6" stroke-linecap="round"/>`).join('')}</g>
    ${granola}${banana}${fruit}${berries}
    <path d="M28 76c3 2 6 2 9 0" stroke="#fff" stroke-opacity=".35" stroke-width="2" fill="none" stroke-linecap="round"/>
  </svg>`;
}

/** Vaso de smoothie con capas del color del sabor. */
function cup(c) {
  const id = `c${++uid}`;
  return `
  <svg viewBox="0 0 120 120" class="art" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.a}"/><stop offset=".45" stop-color="${c.base}"/><stop offset="1" stop-color="${c.base}"/></linearGradient>
      <clipPath id="${id}k"><path d="M36 30h48l-6 76a6 6 0 0 1-6 5H48a6 6 0 0 1-6-5z"/></clipPath>
    </defs>
    <ellipse cx="60" cy="113" rx="26" ry="4" fill="rgba(18,48,74,.10)"/>
    <path d="M70 6l-6 34" stroke="${c.b}" stroke-width="5" stroke-linecap="round"/>
    <g clip-path="url(#${id}k)">
      <rect x="30" y="38" width="60" height="80" fill="url(#${id})"/>
      <path d="M30 40q8-6 15 0t15 0 15 0 15 0v4H30z" fill="#fffdf9" opacity=".75"/>
      <circle cx="48" cy="70" r="2" fill="#fff" opacity=".45"/><circle cx="66" cy="86" r="1.6" fill="#fff" opacity=".4"/><circle cx="56" cy="96" r="1.3" fill="#fff" opacity=".35"/>
    </g>
    <path d="M36 30h48l-6 76a6 6 0 0 1-6 5H48a6 6 0 0 1-6-5z" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2.5"/>
    <rect x="32" y="25" width="56" height="7" rx="3.5" fill="#fffdf9" stroke="#efe4d8" stroke-width="1.5"/>
    <path d="M44 40l3 60" stroke="#fff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

/** Waffle con dos bolas de nieve. */
function waffle(c) {
  const grid = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) grid.push(`<rect x="${27 + i * 17}" y="${33 + j * 17}" width="12" height="12" rx="2.5" fill="#d99a45"/>`);
  return `
  <svg viewBox="0 0 120 120" class="art" aria-hidden="true">
    <circle cx="60" cy="62" r="54" fill="rgba(18,48,74,.08)"/>
    <circle cx="60" cy="60" r="54" fill="#fffdf9" stroke="#efe4d8" stroke-width="2"/>
    <rect x="22" y="28" width="76" height="72" rx="12" fill="#efb55e" transform="rotate(-6 60 64)"/>
    <g transform="rotate(-6 60 64)">${grid.join('')}</g>
    <circle cx="48" cy="52" r="15" fill="${c.base}"/><circle cx="44" cy="47" r="4" fill="#fff" opacity=".3"/>
    <circle cx="72" cy="58" r="15" fill="${c.a}"/><circle cx="68" cy="53" r="4" fill="#fff" opacity=".3"/>
    <path d="M58 82l6-8 6 9" fill="${c.b}"/><circle cx="40" cy="80" r="3.5" fill="#3d5a98"/><circle cx="82" cy="80" r="3.5" fill="#3d5a98"/>
  </svg>`;
}

/** SVG del producto. */
export function productArt(p, catName = '') {
  const k = kindOf(p, catName);
  // Bowls sin ingredientes en la descripción: el clásico de açaí
  const c = palette(`${p.name} ${p.description || ''}`, k === 'bowl' ? ACAI : null);
  return k === 'cup' ? cup(c) : k === 'waffle' ? waffle(c) : bowl(c, p.id || 1);
}

/** Bowl grande para la portada (decorativo). */
export const heroArt = () => bowl(ACAI, 7);
