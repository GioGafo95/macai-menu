import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './data.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import apiV1 from './routes/apiV1.js';
import meseroRoutes from './routes/mesero.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * En Lambda, serverless-http entrega el cuerpo ya leído en req.body (Buffer) y marca la petición
 * como terminada, así que express.json() la ignora. Aquí convertimos ese Buffer:
 *  - JSON → objeto
 *  - multipart (subida de imágenes) → se re-emite como stream para que multer lo procese
 */
function lambdaBody(req, res, next) {
  if (!Buffer.isBuffer(req.body)) return next();
  const raw = req.body;
  req.body = undefined;
  const type = String(req.headers['content-type'] || '');
  if (/^multipart\//i.test(type)) {
    req.complete = false;
    req.readable = true;
    req._read = () => {};
    // Node marca la petición como "abortada" si se destruye sin estar completa
    req.once('end', () => { req.complete = true; });
    req.push(raw);
    req.push(null);
    return next();
  }
  if (raw.length && /json/i.test(type)) {
    if (raw.length > 200 * 1024) return next(Object.assign(new Error('El cuerpo es demasiado grande'), { status: 413 }));
    try {
      req.body = JSON.parse(raw.toString('utf8'));
    } catch {
      return next(Object.assign(new Error('JSON inválido'), { status: 400, type: 'entity.parse.failed' }));
    }
  }
  next();
}

/**
 * Crea la app Express. La usan:
 *  - server/index.js  → servidor local (sirve también la página y las imágenes)
 *  - server/lambda.js → AWS Lambda (solo /api; la página y las imágenes las sirve CloudFront desde S3)
 */
export function createApp({ serveStatic = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v);
  }

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  if (!serveStatic) app.use(lambdaBody);
  app.use(express.json({ limit: '200kb' }));

  app.get(['/health', '/api/health'], (req, res) => res.json({ ok: true, store: store.kind }));
  app.use('/api/public', publicRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/v1', apiV1);
  app.use('/api/mesero', meseroRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  if (serveStatic) {
    if (store.uploadDir) app.use('/uploads', express.static(store.uploadDir, { maxAge: '30d', immutable: true }));
    app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  }

  // Manejo de errores: mensajes claros en español para el cliente
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') message = 'El cuerpo de la petición no es JSON válido';
    if (err.code === 'LIMIT_FILE_SIZE') { status = 400; message = 'La imagen pesa demasiado (máximo 5 MB)'; }
    if (status >= 500) {
      console.error(err);
      message = 'Ocurrió un error en el servidor. Intenta de nuevo.';
    }
    res.status(status).json({ error: message });
  });

  return app;
}
