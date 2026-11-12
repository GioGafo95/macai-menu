/**
 * Menú de Macaí Bowls (tomado del menú en PDF).
 *
 * Para reemplazar el catálogo actual (conserva pedidos, ajustes y zonas de envío)
 * usa scripts/cargar-menu.mjs (npm run cargar-menu).
 */

const TOPPINGS = [
  ['Chía', 10], ['Oreo', 10], ['Nuez', 10], ['Granola', 10], ['Mazapán', 10],
  ['Almendra', 10], ['Amaranto', 10], ['Cacahuate', 10], ['Cacao nibs', 10], ['Coco rallado', 10],
  ['Arroz inflado', 10], ['Chispas de chocolate', 10], ['Quinoa inflada', 10], ['Arándanos', 10],
  ['Chispas de chocolate sin azúcar', 15],
];
const SPREADS = [
  ['Crema de cacahuate', 10], ['Crema de galleta', 10], ['Miel de agave', 10],
  ['Crema de avellanas', 10], ['Cajeta', 10], ['Crema de almendras', 15],
];
const FRUTAS = [
  ['Kiwi', 10], ['Fresa', 10], ['Plátano', 10],
  ['Mango', 10, 'De temporada'], ['Blueberries', 10, 'De temporada'],
];
// Chilibowls (desactivados por el momento)
const CHILITOPPINGS = [
  ['Cacahuates enchilados', 10], ['Arándanos enchilados', 10], ['Coco enchilado', 10], ['Chamoy sin azúcar', 10],
];
const BASES = [
  ['Macaí', 0, 'Açaí, plátano, frutos rojos'],
  ['Strawberry cream', 0, 'Fresa, plátano, yogur griego'],
  ['Chocobanana', 0, 'Plátano, crema de almendras, cacao, vainilla, canela'],
  ['Mangopiña', 0, 'Mango, piña, plátano, frambuesa, crema de cacahuate s/a, yogur griego s/a'],
  ['Matcha Lover', 0, 'Plátano, espinaca, matcha'],
  ['Kimbitahaya', 0, 'Pitahaya, piña, plátano, fresa'],
];
const CHILI_BASES = [['Chilipiña', 0], ['Chilifresa', 0], ['Chili mango', 0]];

const SMOOTHIES = [
  ['Chocovibes', 85, 'Plátano, cacao nibs, cocoa, chispas s/a, dátil, granola, avena, leche de coco.'],
  ['Peanut Power', 85, 'Plátano, crema de cacahuate, cacahuate, amaranto, dátil, leche de almendras.'],
  ['Sunset mango', 80, 'Mango, yogur griego, coco rallado, dátil, leche de coco.'],
  ['Strawberry glow', 80, 'Fresa, avena, almendras, dátil, leche de coco.'],
  ['Coco dream', 85, 'Coco, plátano, coco rallado, nuez, leche de coco, vainilla y un toque de canela.'],
  ['Papaya boom', 80, 'Papaya, linaza, crema de almendras, dátil, leche de coco.'],
  ['Bieber', 85, 'Plátano, fresa, aguacate, dátil, miel de agave, leche de almendras.'],
];

/** Construye el documento de catálogo completo. */
export function buildMacaiCatalog({ zones } = {}) {
  const cat = {
    categories: [], products: [], groups: [], zones: [],
    seq: { category: 0, product: 0, group: 0, topping: 0, zone: 0 },
  };
  const next = (k) => ++cat.seq[k];

  const category = (name, sort) => {
    const c = { id: next('category'), name, sort, active: true };
    cat.categories.push(c);
    return c.id;
  };
  const group = (name, min, max, sort, items) => {
    const g = {
      id: next('group'), name, min_select: min, max_select: max, sort,
      toppings: items.map(([n, price, description = ''], i) => ({
        id: next('topping'), name: n, price, description, active: true, sort: i + 1,
      })),
    };
    cat.groups.push(g);
    return g.id;
  };
  const product = (category_id, name, description, price, { featured = false, sort = 0, groups = [], included = 0 } = {}) => {
    cat.products.push({
      id: next('product'), category_id, name, description, price, image: null,
      active: true, featured, allow_notes: true, sort,
      included_count: included, included_value: included ? 10 : 0, group_ids: groups,
    });
  };

  const bowls = category('Arma tu Bowl', 1);
  // Chilibowls desactivados por el momento: para regresarlos, descomenta las líneas marcadas con «Chilibowls».
  // const chili = category('Chilibowls', 2); // Chilibowls
  const waffles = category('Waffles', 3);
  const smoothies = category('Smoothies', 4);

  const base = group('Sabor de tu base', 1, 1, 1, BASES);
  // const chiliBase = group('Sabor de tu base', 1, 1, 2, CHILI_BASES); // Chilibowls
  const toppings = group('Toppings', 0, 0, 3, TOPPINGS);
  const spreads = group('Spreads', 0, 0, 4, SPREADS);
  const frutas = group('Frutas', 0, 0, 5, FRUTAS);
  // const chiliToppings = group('Chilitoppings', 0, 0, 6, CHILITOPPINGS); // Chilibowls
  const nieve = group('Sabor de tu nieve (2 bolas)', 1, 1, 7, BASES);

  const bowlGroups = [base, toppings, spreads, frutas];
  product(bowls, 'Bowl Chico', 'Elige tu base. Incluye 2 opciones entre toppings, spreads y frutas.', 90, { sort: 1, groups: bowlGroups, included: 2 });
  product(bowls, 'Bowl Grande', 'Elige tu base. Incluye 3 opciones entre toppings, spreads y frutas.', 130, { featured: true, sort: 2, groups: bowlGroups, included: 3 });

  // Chilibowls
  // const chiliGroups = [chiliBase, chiliToppings, toppings, spreads, frutas];
  // product(chili, 'Chilibowl Chico', 'Base enchilada. Incluye 2 opciones entre toppings, chilitoppings, spreads y frutas.', 110, { sort: 1, groups: chiliGroups, included: 2 });
  // product(chili, 'Chilibowl Grande', 'Base enchilada. Incluye 3 opciones entre toppings, chilitoppings, spreads y frutas.', 150, { sort: 2, groups: chiliGroups, included: 3 });

  product(waffles, 'Waffle', 'Waffle con 2 bolas de nieve del sabor que elijas. Incluye 3 opciones entre toppings, spreads y frutas.', 160,
    { sort: 1, groups: [nieve, toppings, spreads, frutas], included: 3 });

  SMOOTHIES.forEach(([n, price, d], i) => product(smoothies, n, d, price, { sort: i + 1 }));

  if (zones?.length) {
    cat.zones = zones;
    cat.seq.zone = zones.reduce((m, z) => Math.max(m, z.id), 0);
  } else {
    cat.zones = [
      { id: next('zone'), name: 'Zona cercana (ejemplo)', fee: 30, active: true, sort: 1 },
      { id: next('zone'), name: 'Zona lejana (ejemplo)', fee: 45, active: true, sort: 2 },
    ];
  }
  return cat;
}
