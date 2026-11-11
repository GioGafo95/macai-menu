# API v1 — Integración con tu sistema de ventas

Base: `https://TU-DOMINIO/api/v1` (en local: `http://localhost:3000/api/v1`)

## Autenticación

Copia la **API key** desde el panel: **Ajustes → API e integraciones**. Envíala en cada petición:

```
X-API-Key: mk_xxxxxxxx
```

o bien `Authorization: Bearer mk_xxxxxxxx`. Sin key válida la respuesta es `401`.

Errores: siempre JSON `{ "error": "mensaje" }` con el código HTTP correspondiente (400, 401, 404, 429, 500).

---

## Pedidos

### `GET /orders`

Lista pedidos (más recientes primero).

| Parámetro        | Ejemplo                    | Descripción |
|------------------|----------------------------|-------------|
| `from`           | `2026-11-01` o ISO         | Creados desde (incluye) |
| `to`             | `2026-11-30` o ISO         | Creados hasta (incluye el día completo si es fecha) |
| `updated_since`  | `2026-11-11T15:00:00Z`     | Sólo pedidos creados **o modificados** después de esta fecha. Ideal para sincronizar. Ordena por `updated_at`. |
| `status`         | `entregado` o `nuevo,listo`| Uno o varios estados separados por coma |
| `paid`           | `true` / `false`           | Filtra por pagado |
| `fulfillment`    | `delivery` / `pickup`      | Tipo de entrega |
| `payment_method` | `cash` / `transfer`        | Método de pago |
| `limit`          | `100`                      | 1–500 (default 100) |
| `offset`         | `0`                        | Paginación |
| `sort`           | `asc` / `desc`             | Orden (default `desc`) |

Respuesta:

```json
{
  "data": [ { ...pedido... } ],
  "pagination": { "total": 42, "limit": 100, "offset": 0 }
}
```

### `GET /orders/:id`

Devuelve un pedido.

### `PATCH /orders/:id`

Cambia estado y/o pago. Body JSON:

```json
{ "status": "entregado", "paid": true }
```

Estados: `nuevo`, `preparando`, `listo`, `en_camino`, `entregado`, `cancelado`.

### Objeto pedido

```json
{
  "id": 12,
  "token": "z-9BMHJ3D0oH",
  "created_at": "2026-11-11T14:12:50.718Z",
  "updated_at": "2026-11-11T14:20:03.101Z",
  "status": "entregado",
  "status_label": "Entregado",
  "customer": { "name": "Ana", "phone": "5512345678" },
  "fulfillment": "delivery",
  "address": "Calle 1 #23",
  "address_ref": "Casa azul",
  "zone": { "id": 1, "name": "Centro" },
  "payment_method": "cash",
  "cash_amount": 500,
  "change_due": 25,
  "paid": true,
  "notes": null,
  "subtotal": 445,
  "delivery_fee": 30,
  "total": 475,
  "items": [
    {
      "product_id": 1,
      "name": "Bowl Mediterráneo",
      "quantity": 2,
      "unit_price": 200,
      "toppings": [
        { "id": 2, "name": "Salmón", "price": 35, "group": "Proteína" },
        { "id": 5, "name": "Aguacate", "price": 20, "group": "Extras" }
      ],
      "note": "sin cebolla",
      "line_total": 400
    }
  ]
}
```

- Fechas en ISO 8601 UTC.
- `unit_price` ya incluye el precio de los toppings.
- `token` es el identificador del enlace de seguimiento del cliente (`/pedido.html?t=TOKEN`).

---

## Ventas

### `GET /sales/summary?from=2026-11-01&to=2026-11-30`

Resumen del periodo (excluye cancelados):

```json
{
  "from": "...", "to": "...",
  "orders": 120,
  "cancelled_orders": 3,
  "total": 18450,
  "subtotal": 16900,
  "delivery_fees": 1550,
  "paid_total": 18000,
  "unpaid_total": 450,
  "average_ticket": 153.75,
  "by_payment_method": { "cash": { "orders": 70, "total": 10200 }, "transfer": { "orders": 50, "total": 8250 } },
  "by_fulfillment":   { "delivery": { "orders": 90, "total": 15000 }, "pickup": { "orders": 30, "total": 3450 } },
  "top_products": [ { "product_id": 1, "name": "Bowl Mediterráneo", "quantity": 80, "total": 12000 } ]
}
```

## Productos

### `GET /products`

```json
{ "data": [ { "id": 1, "name": "Bowl Mediterráneo", "description": "...", "price": 145, "active": true, "category_id": 1, "category": "Bowls" } ] }
```

---

## Webhook (tiempo real)

En **Ajustes → API e integraciones** pon la URL de tu sistema. Por cada evento enviamos un `POST` JSON:

```json
{ "event": "order.created", "sent_at": "2026-11-11T14:12:51.000Z", "data": { ...pedido... } }
```

Eventos: `order.created`, `order.updated` (cambio de estado o pago) y `test` (botón "Enviar prueba").

Headers:

- `X-Macai-Event`: nombre del evento
- `X-Macai-Signature`: `sha256=` + HMAC-SHA256 del body crudo usando el **secreto del webhook**

Verificación (Node.js):

```js
import crypto from 'node:crypto';

function isValid(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signatureHeader?.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}
```

Responde con un código 2xx. Si tu sistema no responde, el pedido no se pierde: puedes recuperarlo con `GET /orders?updated_since=...`.

### Estrategia de sincronización recomendada

1. Recibe el webhook para registrar ventas al instante.
2. Cada cierto tiempo (ej. cada 15 min) llama `GET /orders?updated_since=<última fecha sincronizada>&sort=asc` como respaldo, y guarda el `updated_at` más reciente.
3. Usa `id` como llave única para no duplicar.

## Ejemplos con curl

```bash
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/v1/orders?from=2026-11-01&status=entregado"
curl -H "X-API-Key: $KEY" -X PATCH -H "Content-Type: application/json" \
     -d '{"paid":true}' http://localhost:3000/api/v1/orders/12
curl -H "X-API-Key: $KEY" "http://localhost:3000/api/v1/sales/summary?from=2026-11-01&to=2026-11-30"
```
