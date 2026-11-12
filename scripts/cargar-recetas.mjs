#!/usr/bin/env node
/**
 * Carga las recetas (gramaje) de las bases de los bowls usando la API del panel.
 * Crea los ingredientes que falten (con existencia 0) y no toca los que ya existen.
 * Se puede correr varias veces: reemplaza solo las recetas de abajo.
 *
 *   node scripts/cargar-recetas.mjs http://localhost:3000 <contraseña-admin>
 *   node scripts/cargar-recetas.mjs https://pedidos.macai.com.mx <contraseña-admin>
 *
 * Cantidades en g (sólidos) o ml (líquidos), para 1 bowl. Las "OPCION" de leche (sustitutos) no se descuentan.
 */

// Ingredientes: nombre en el inventario, unidad y otros nombres con que puede existir
const INGREDIENTES = {
  acai: { name: 'Açaí', unit: 'g', alias: ['asai', 'acai', 'pulpa de acai'] },
  blueberry: { name: 'Blueberries', unit: 'g', alias: ['blueberry', 'mora azul', 'arandano azul'] },
  frambuesa: { name: 'Frambuesa', unit: 'g' },
  zarzamora: { name: 'Zarzamora', unit: 'g' },
  fresa: { name: 'Fresa', unit: 'g' },
  platano: { name: 'Plátano', unit: 'g' },
  datil: { name: 'Dátil', unit: 'g' },
  aguaCoco: { name: 'Agua de coco', unit: 'ml' },
  lecheCoco: { name: 'Leche de coco', unit: 'ml' },
  pina: { name: 'Piña', unit: 'g' },
  mango: { name: 'Mango', unit: 'g' },
  yogur: { name: 'Yogur griego light', unit: 'g', alias: ['yogur griego', 'yogurt griego'] },
  cremaCacahuate: { name: 'Crema de cacahuate', unit: 'g' },
  miel: { name: 'Miel de agave', unit: 'g' },
  matcha: { name: 'Matcha', unit: 'g' },
  espinaca: { name: 'Espinaca', unit: 'g' },
  cocoa: { name: 'Cocoa', unit: 'g', alias: ['cacao en polvo'] },
  cremaAlmendras: { name: 'Crema de almendras', unit: 'g' },
  vainilla: { name: 'Vainilla', unit: 'ml' },
  canela: { name: 'Canela', unit: 'g' },
};

// Bowl Grande · receta de cada sabor de base [ingrediente, cantidad]
const BOWL_GRANDE = {
  'Macaí': [['acai', 25], ['blueberry', 15], ['frambuesa', 15], ['zarzamora', 15], ['fresa', 80], ['platano', 110], ['datil', 10], ['aguaCoco', 40]],
  'Mangopiña': [['pina', 70], ['mango', 70], ['frambuesa', 15], ['platano', 105], ['lecheCoco', 40], ['yogur', 30], ['cremaCacahuate', 30]],
  'Strawberry cream': [['fresa', 130], ['platano', 130], ['aguaCoco', 40], ['yogur', 30], ['miel', 30]],
  'Matcha Lover': [['matcha', 40], ['platano', 200], ['espinaca', 20], ['lecheCoco', 40]],
  'Chocobanana': [['platano', 260], ['cocoa', 30], ['cremaAlmendras', 30], ['vainilla', 5], ['canela', 1]],
};

const [base, password] = process.argv.slice(2);
if (!base || !password) {
  console.log('Uso: node scripts/cargar-recetas.mjs <url-base> <contraseña-admin>');
  process.exit(1);
}
const URL_BASE = base.replace(/\/$/, '');
let cookie = '';
async function A(path, { method = 'GET', body } = {}) {
  const r = await fetch(URL_BASE + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

await A('/api/admin/login', { method: 'POST', body: { password } });
let inv = await A('/api/admin/inventory');
const products = await A('/api/admin/products');
const groups = await A('/api/admin/topping-groups');

const grande = products.find((p) => norm(p.name) === 'bowl grande');
if (!grande) throw new Error('No encontré el producto "Bowl Grande"');
const baseGroup = groups.find((g) => (grande.group_ids || []).includes(g.id) && g.min_select > 0);
if (!baseGroup) throw new Error('No encontré el grupo de sabores de base del Bowl Grande');

// Ingredientes: usa los existentes (por nombre o alias) o los crea
const ids = {};
let created = 0;
for (const [key, def] of Object.entries(INGREDIENTES)) {
  const names = [def.name, ...(def.alias || [])].map(norm);
  let item = inv.items.find((i) => names.includes(norm(i.name)));
  if (!item) {
    inv = await A('/api/admin/inventory/items', { method: 'POST', body: { name: def.name, unit: def.unit, stock: 0, min_stock: 0, par: 0 } });
    item = inv.items.find((i) => norm(i.name) === norm(def.name));
    created++;
  }
  ids[key] = item;
}

// Recetas: solo para el Bowl Grande (p<grande>t<sabor>); el chico usa su propia receta o la general
const done = [];
for (const [flavor, lines] of Object.entries(BOWL_GRANDE)) {
  const t = baseGroup.toppings.find((x) => norm(x.name) === norm(flavor));
  if (!t) { console.log(`⚠️  No encontré el sabor "${flavor}" en "${baseGroup.name}"`); continue; }
  // Si el ingrediente ya existía en kg o L, la cantidad se manda en g/ml y el servidor la convierte
  const body = { lines: lines.map(([k, qty]) => ({ item_id: ids[k].id, qty, unit: INGREDIENTES[k].unit })) };
  await A(`/api/admin/inventory/recipes/p${grande.id}t${t.id}`, { method: 'PUT', body });
  done.push(`${flavor} (${lines.reduce((a, [, q]) => a + q, 0)} g/ml)`);
}

console.log(`✓ ${created} ingredientes nuevos · recetas del Bowl Grande cargadas: ${done.join(', ')}`);
const missing = baseGroup.toppings.filter((t) => !Object.keys(BOWL_GRANDE).some((f) => norm(f) === norm(t.name)));
if (missing.length) console.log(`   Sin receta todavía: ${missing.map((t) => t.name).join(', ')}`);
