import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConflictError, ACTIVE_STATUSES } from './common.js';

/**
 * Diseño de tabla única (PK, SK):
 *   DOC#<key>       _   → documentos (ajustes, catálogo) con "version" para escritura optimista
 *   COUNTER#<name>  _   → contadores atómicos
 *   ORDER#<id>      _   → pedido (JSON en "data")
 *   TOKEN#<token>   _   → token de seguimiento → id
 * Índices:
 *   GSI1 (GSI1PK='ORDERS', GSI1SK=created_at#id)   pedidos por fecha de creación
 *   GSI2 (GSI2PK='ORDERS', GSI2SK=updated_at#id)   pedidos por última modificación (sincronización)
 *   GSI3 (GSI3PK='ACTIVE', GSI3SK=created_at#id)   índice disperso: sólo pedidos activos
 */
export function createDynamoStore({ table, uploadsBucket }) {
  if (!table) throw new Error('Falta TABLE_NAME');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({});

  const pad = (id) => String(id).padStart(10, '0');
  const isConflict = (e) => e?.name === 'ConditionalCheckFailedException' || e?.name === 'TransactionCanceledException';

  function orderItem(o) {
    const item = {
      PK: `ORDER#${o.id}`, SK: '_', data: JSON.stringify(o),
      GSI1PK: 'ORDERS', GSI1SK: `${o.created_at}#${pad(o.id)}`,
      GSI2PK: 'ORDERS', GSI2SK: `${o.updated_at}#${pad(o.id)}`,
    };
    if (ACTIVE_STATUSES.includes(o.status)) {
      item.GSI3PK = 'ACTIVE';
      item.GSI3SK = `${o.created_at}#${pad(o.id)}`;
    }
    return item;
  }

  const INDEX = {
    created: { name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK', value: 'ORDERS' },
    updated: { name: 'GSI2', pk: 'GSI2PK', sk: 'GSI2SK', value: 'ORDERS' },
    active: { name: 'GSI3', pk: 'GSI3PK', sk: 'GSI3SK', value: 'ACTIVE' },
  };

  return {
    kind: 'dynamodb',

    async getDoc(key) {
      const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `DOC#${key}`, SK: '_' }, ConsistentRead: true }));
      return Item ? { data: JSON.parse(Item.data), version: Item.version } : null;
    },

    async putDoc(key, data, expectedVersion) {
      const version = expectedVersion == null ? 1 : expectedVersion + 1;
      try {
        await ddb.send(new PutCommand({
          TableName: table,
          Item: { PK: `DOC#${key}`, SK: '_', data: JSON.stringify(data), version },
          ...(expectedVersion == null
            ? { ConditionExpression: 'attribute_not_exists(PK)' }
            : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': expectedVersion } }),
        }));
      } catch (e) {
        if (isConflict(e)) throw new ConflictError(key);
        throw e;
      }
      return version;
    },

    async nextId(name) {
      const { Attributes } = await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { PK: `COUNTER#${name}`, SK: '_' },
        UpdateExpression: 'ADD #v :one',
        ExpressionAttributeNames: { '#v': 'value' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }));
      return Number(Attributes.value);
    },

    async createOrder(o) {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: table, Item: orderItem(o), ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: table, Item: { PK: `TOKEN#${o.token}`, SK: '_', id: o.id }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }));
    },

    async putOrder(o) {
      await ddb.send(new PutCommand({ TableName: table, Item: orderItem(o) }));
    },

    async getOrder(id) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) return null;
      const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `ORDER#${n}`, SK: '_' }, ConsistentRead: true }));
      return Item ? JSON.parse(Item.data) : null;
    },

    async getOrderByToken(token) {
      if (!token || typeof token !== 'string' || token.length > 64) return null;
      const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `TOKEN#${token}`, SK: '_' } }));
      return Item ? this.getOrder(Item.id) : null;
    },

    async queryOrders({ index = 'created', from, to, desc = true, limit = 5000 } = {}) {
      const ix = INDEX[index] || INDEX.created;
      const names = { '#pk': ix.pk, '#sk': ix.sk };
      const values = { ':pk': ix.value };
      let cond = '#pk = :pk';
      if (index === 'updated' && from) {
        cond += ' AND #sk > :from';
        values[':from'] = `${from}#~`; // estrictamente después de esa fecha
      } else if (from || to) {
        cond += ' AND #sk BETWEEN :from AND :to';
        values[':from'] = from || '0';
        values[':to'] = `${to || '9999'}#~`;
      }
      const out = [];
      let ExclusiveStartKey;
      do {
        const res = await ddb.send(new QueryCommand({
          TableName: table, IndexName: ix.name, KeyConditionExpression: cond,
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
          ScanIndexForward: !desc, ExclusiveStartKey, Limit: Math.min(1000, limit - out.length),
        }));
        for (const it of res.Items || []) out.push(JSON.parse(it.data));
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey && out.length < limit);
      return out;
    },

    async saveUpload(buffer, ext, contentType) {
      if (!uploadsBucket) throw new Error('Falta UPLOADS_BUCKET');
      const name = crypto.randomBytes(12).toString('hex') + ext;
      await s3.send(new PutObjectCommand({
        Bucket: uploadsBucket, Key: `uploads/${name}`, Body: buffer,
        ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable',
      }));
      return `/uploads/${name}`;
    },
  };
}
