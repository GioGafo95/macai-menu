import { bySort } from './data.js';
import { round2 } from './util.js';
import { recipeFor } from './inventory.js';

/**
 * Costo de producción y ganancia por producto, con el costo por unidad de cada ingrediente
 * (inventario) y las recetas de productos y opciones.
 *
 *  - Costo propio del producto: receta p<id> (vaso, tapa, cuchara, base fija…).
 *  - Grupos obligatorios (ej. sabor de la base): el cliente elige min_select; se toma el promedio
 *    de sus opciones (y se muestra la más barata y la más cara). Si una opción cuesta distinto según
 *    el producto (base de bowl chico vs grande) usa la receta p<id>t<id>.
 *  - Opciones incluidas (toppings, spreads, frutas): included_count opciones, costo promedio.
 *  - Extras: lo que cobras por cada opción adicional contra lo que te cuesta.
 */

const r4 = (n) => Math.round(n * 10000) / 10000;

/** Costo de una receta: { cost, lines, missing } (missing = ingredientes sin costo capturado). */
function recipeCost(lines, items) {
  let cost = 0;
  const out = [];
  const missing = [];
  for (const l of lines || []) {
    const it = items.get(l.item_id);
    if (!it) continue;
    const c = (it.cost || 0) * l.qty;
    cost += c;
    if (!(it.cost > 0)) missing.push(it.name);
    out.push({ item_id: it.id, name: it.name, qty: l.qty, unit: it.unit, display_unit: l.unit || it.unit, cost: round2(c) });
  }
  return { cost: r4(cost), lines: out, missing };
}

const stats = (arr) => {
  if (!arr.length) return { min: 0, avg: 0, max: 0 };
  return {
    min: r4(Math.min(...arr)),
    avg: r4(arr.reduce((a, b) => a + b, 0) / arr.length),
    max: r4(Math.max(...arr)),
  };
};

const margin = (price, cost) => (price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null);

/** Costo de una opción dentro de un producto (usa la receta específica si existe). */
function optionCost(inv, items, pid, t) {
  const { key, lines } = recipeFor(inv, pid, t.id);
  const rc = recipeCost(lines, items);
  return { ...rc, key, has_recipe: lines.length > 0, specific: key.includes('t') && key.startsWith('p') };
}

export function productCosts(inv, cat) {
  const items = new Map(inv.items.map((i) => [i.id, i]));
  const cats = new Map(cat.categories.map((c) => [c.id, c]));
  const groupsById = new Map(cat.groups.map((g) => [g.id, g]));

  const products = [...cat.products].sort((a, b) =>
    (cats.get(a.category_id)?.sort ?? 99) - (cats.get(b.category_id)?.sort ?? 99) || bySort(a, b),
  ).map((p) => {
    const own = recipeCost(inv.recipes[`p${p.id}`], items);
    const warnings = [];
    if (!own.lines.length && !(p.group_ids || []).length) warnings.push('Sin receta');
    const groups = [];
    let reqMin = 0, reqAvg = 0, reqMax = 0;
    const optional = [];
    for (const gid of p.group_ids || []) {
      const g = groupsById.get(gid);
      if (!g) continue;
      const options = [...g.toppings].filter((t) => t.active).sort(bySort).map((t) => {
        const oc = optionCost(inv, items, p.id, t);
        return { id: t.id, name: t.name, price: t.price, cost: oc.cost, has_recipe: oc.has_recipe, specific: oc.specific, key: oc.key, missing: oc.missing, lines: oc.lines };
      });
      const st = stats(options.filter((o) => o.has_recipe).map((o) => o.cost));
      const required = g.min_select > 0;
      if (required) {
        reqMin += st.min * g.min_select; reqAvg += st.avg * g.min_select; reqMax += st.max * g.min_select;
      } else optional.push(...options.filter((o) => o.has_recipe));
      const noRecipe = options.filter((o) => !o.has_recipe).length;
      if (noRecipe) warnings.push(`${noRecipe} de ${options.length} en "${g.name}" sin receta`);
      groups.push({ id: g.id, name: g.name, required, min_select: g.min_select, options, ...st });
    }

    const n = p.included_count || 0;
    const optSorted = optional.map((o) => o.cost).sort((a, b) => a - b);
    const incl = {
      min: n ? r4(optSorted.slice(0, n).reduce((a, b) => a + b, 0)) : 0,
      avg: n ? r4(stats(optSorted).avg * Math.min(n, optSorted.length || n)) : 0,
      max: n ? r4(optSorted.slice(-n).reduce((a, b) => a + b, 0)) : 0,
    };
    const missing = new Set([...own.missing, ...groups.flatMap((g) => g.options.flatMap((o) => o.missing))]);
    if (missing.size) warnings.push(`Sin costo: ${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? ` y ${missing.size - 5} más` : ''}`);

    const cost = {
      min: round2(own.cost + reqMin + incl.min),
      typical: round2(own.cost + reqAvg + incl.avg),
      max: round2(own.cost + reqMax + incl.max),
    };
    return {
      id: p.id, name: p.name, category: cats.get(p.category_id)?.name || '', active: p.active,
      price: p.price, included_count: n, included_value: p.included_value || 0,
      own: { cost: round2(own.cost), lines: own.lines },
      required_cost: round2(reqAvg), included_cost: round2(incl.avg),
      groups,
      cost,
      profit: round2(p.price - cost.typical),
      margin: margin(p.price, cost.typical),
      profit_worst: round2(p.price - cost.max),
      margin_worst: margin(p.price, cost.max),
      complete: !warnings.length,
      has_any: own.lines.length > 0 || groups.some((g) => g.options.some((o) => o.has_recipe)),
      warnings,
    };
  });

  // Extras: cada opción opcional cobrada aparte (precio normal) vs su costo general
  const extras = [];
  for (const g of [...cat.groups].sort(bySort)) {
    if (g.min_select > 0) continue;
    if (!cat.products.some((p) => (p.group_ids || []).includes(g.id))) continue;
    for (const t of [...g.toppings].filter((x) => x.active).sort(bySort)) {
      const rc = recipeCost(inv.recipes[`t${t.id}`], items);
      extras.push({
        id: t.id, group: g.name, name: t.name, price: t.price, cost: round2(rc.cost), has_recipe: rc.lines.length > 0,
        profit: round2(t.price - rc.cost), margin: margin(t.price, rc.cost), missing: rc.missing,
      });
    }
  }
  return { products, extras };
}

/** Ganancia real de pedidos ya vendidos (con los costos de hoy). */
export function salesProfit(orders, inv) {
  const items = new Map(inv.items.map((i) => [i.id, i]));
  const byProduct = new Map();
  let revenue = 0, cost = 0, units = 0, uncosted = 0;
  for (const o of orders) {
    if (o.status === 'cancelado') continue;
    for (const it of o.items || []) {
      let c = recipeCost(inv.recipes[`p${it.product_id}`], items).cost;
      let known = (inv.recipes[`p${it.product_id}`] || []).length > 0;
      for (const t of it.toppings || []) {
        const { lines } = recipeFor(inv, it.product_id, t.id);
        if (lines.length) known = true;
        c += recipeCost(lines, items).cost;
      }
      const lineCost = c * it.quantity;
      const k = it.product_id;
      const cur = byProduct.get(k) || { product_id: k, name: it.name, units: 0, revenue: 0, cost: 0 };
      cur.units += it.quantity;
      cur.revenue += it.line_total;
      cur.cost += lineCost;
      byProduct.set(k, cur);
      revenue += it.line_total;
      cost += lineCost;
      units += it.quantity;
      if (!known) uncosted += it.quantity;
    }
  }
  const rows = [...byProduct.values()].map((x) => ({
    ...x, revenue: round2(x.revenue), cost: round2(x.cost), profit: round2(x.revenue - x.cost), margin: margin(x.revenue, x.cost),
  })).sort((a, b) => b.profit - a.profit);
  return {
    orders: orders.filter((o) => o.status !== 'cancelado').length,
    units, uncosted_units: uncosted,
    revenue: round2(revenue), cost: round2(cost), profit: round2(revenue - cost), margin: margin(revenue, cost),
    products: rows,
  };
}
