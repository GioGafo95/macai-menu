#!/usr/bin/env node
/**
 * Reemplaza el catálogo por el menú de Macaí (server/catalog.js).
 * Conserva pedidos, ajustes y zonas de envío.
 *
 *   npm run cargar-menu                                         → base local (SQLite)
 *   STORE=dynamodb TABLE_NAME=<tabla> AWS_REGION=us-east-1 npm run cargar-menu   → base en AWS
 */
import { mutateCatalog, init, store } from '../server/data.js';
import { buildMacaiCatalog } from '../server/catalog.js';

await init();
await mutateCatalog((cat) => {
  const fresh = buildMacaiCatalog({ zones: cat.zones });
  Object.keys(cat).forEach((k) => delete cat[k]);
  Object.assign(cat, fresh);
});
console.log(`Menú de Macaí Bowls cargado en ${store.kind} (se conservaron pedidos, ajustes y zonas).`);
