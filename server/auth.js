import crypto from 'node:crypto';
import { getSettings, updateSettings } from './data.js';
import { HttpError } from './util.js';

const COOKIE = 'macai_admin';
const TTL_MS = 14 * 24 * 3600 * 1000;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function matchesHash(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(pw, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Se asegura de que exista una contraseña de admin:
 *  - Si hay una guardada (cambiada desde el panel), se usa esa.
 *  - Si no, se usa ADMIN_PASSWORD del entorno.
 *  - Si tampoco existe, se genera una y se imprime en consola (o en los logs de CloudWatch).
 */
export async function ensureAdminPassword() {
  if (process.env.ADMIN_PASSWORD_RESET === '1') {
    await updateSettings({ admin_password_hash: '' });
    console.log('ADMIN_PASSWORD_RESET=1: se borró la contraseña guardada.');
  }
  const s = await getSettings();
  if (s.admin_password_hash) return;
  if (process.env.ADMIN_PASSWORD) {
    await updateSettings({ admin_password_hash: hashPassword(process.env.ADMIN_PASSWORD) });
    return;
  }
  const pw = crypto.randomBytes(6).toString('base64url');
  await updateSettings({ admin_password_hash: hashPassword(pw) });
  console.log('\n==============================================');
  console.log(' No se definió ADMIN_PASSWORD.');
  console.log(` Contraseña generada para /admin:  ${pw}`);
  console.log(' Cámbiala desde el panel en Ajustes > Seguridad.');
  console.log('==============================================\n');
}

export async function verifyPassword(pw) {
  if (!pw) return false;
  return matchesHash(pw, (await getSettings()).admin_password_hash);
}

export async function changePassword(current, next) {
  if (!(await verifyPassword(current))) throw new HttpError(400, 'La contraseña actual no es correcta');
  if (!next || next.length < 8) throw new HttpError(400, 'La nueva contraseña debe tener al menos 8 caracteres');
  await updateSettings({ admin_password_hash: hashPassword(next) });
}

// La firma incluye el hash de la contraseña: al cambiarla se cierran todas las sesiones.
function sign(payload, s) {
  const key = s.session_secret + '|' + s.admin_password_hash;
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

async function createToken() {
  const s = await getSettings();
  const payload = String(Date.now() + TTL_MS);
  return `${payload}.${sign(payload, s)}`;
}

async function validToken(token) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload, await getSettings());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function setSessionCookie(req, res) {
  res.cookie(COOKIE, await createToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export async function requireAdmin(req, res, next) {
  if (await validToken(readCookie(req, COOKIE))) return next();
  next(new HttpError(401, 'Sesión no válida. Inicia sesión de nuevo.'));
}

export async function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const provided = req.headers['x-api-key'] || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  const expected = (await getSettings()).api_key;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (provided && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  next(new HttpError(401, 'API key inválida o ausente'));
}
