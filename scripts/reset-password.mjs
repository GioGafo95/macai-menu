#!/usr/bin/env node
/**
 * Restablece la contraseña del panel de admin (cierra todas las sesiones abiertas).
 *
 *   node scripts/reset-password.mjs "nueva-clave"                                   → base local
 *   STORE=dynamodb TABLE_NAME=<tabla> AWS_REGION=us-east-1 node scripts/reset-password.mjs "nueva-clave"   → AWS
 */
import { updateSettings, store } from '../server/data.js';
import { hashPassword } from '../server/auth.js';

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error('Uso: node scripts/reset-password.mjs "nueva-clave"   (mínimo 8 caracteres)');
  process.exit(2);
}
await updateSettings({ admin_password_hash: await hashPassword(pw) });
console.log(`Contraseña del panel actualizada (${store.kind}).`);
