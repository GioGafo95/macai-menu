/**
 * Almacenamiento intercambiable:
 *  - STORE=sqlite (por defecto): archivo local en DATA_DIR. Para desarrollo en tu PC.
 *  - STORE=dynamodb: DynamoDB + S3. Para AWS Lambda.
 *
 * Interfaz (todas async):
 *  getDoc(key) → { data, version } | null
 *  putDoc(key, data, expectedVersion|null) → nueva versión (lanza ConflictError si alguien escribió antes)
 *  nextId(name) → número consecutivo
 *  createOrder(order) / putOrder(order) / getOrder(id) / getOrderByToken(token)
 *  queryOrders({ index: 'created'|'updated'|'active', from, to, desc, limit }) → pedidos
 *  saveUpload(buffer, ext, contentType) → URL pública ('/uploads/xxx')
 */
export { ConflictError, ACTIVE_STATUSES } from './common.js';

const kind = (process.env.STORE || 'sqlite').toLowerCase();

export const store = kind === 'dynamodb'
  ? (await import('./dynamo.js')).createDynamoStore({
    table: process.env.TABLE_NAME,
    uploadsBucket: process.env.UPLOADS_BUCKET,
  })
  : await (await import('./sqlite.js')).createSqliteStore({ dataDir: process.env.DATA_DIR || 'data' });
