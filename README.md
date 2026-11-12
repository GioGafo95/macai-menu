# macai-menu

Menú digital y sistema de pedidos para negocio de comida saludable.

- **Clientes** (`/`): ven el menú desde el celular, personalizan con toppings y notas, eligen envío a domicilio (con costo por zona) o recoger en tienda, y pagan en efectivo o transferencia. Reciben un enlace para seguir el estado de su pedido y un botón para mandarlo por WhatsApp.
- **Admin** (`/admin/`): productos, precios, fotos, categorías, toppings, zonas de envío, pedidos en tiempo real con sonido, estados, cobro y ajustes.
- **Inventario** (`/admin/` → 📦 Inventario): ingredientes con existencias, recetas por producto y topping, descuento automático con cada pedido (se regresa al cancelar), dashboard de lo que está por acabarse con lista de compras, entradas, mermas, conteos, aviso al celular y opción de ocultar del menú lo agotado.
- **Compras** (📦 Inventario → 🧾 Compras): historial de compras con fecha, cantidad, unidad, costo total y precio por kilo, litro o pieza; variación de precio del mes contra el anterior y gráfica trimestral, semestral y anual por producto. Se pueden capturar compras pasadas solo para el historial. El costo de cada ingrediente es el de su compra más reciente.
- **Costos y ganancia** (📦 Inventario → 💰 Costos y ganancia): costo de producción de cada producto con el costo de sus ingredientes y sus recetas, contra su precio (ganancia y margen por pieza, rango según lo que elija el cliente), ganancia de cada extra y ganancia real de lo vendido en 7, 30 o 90 días. Las opciones pueden tener receta distinta por producto (ej. la base del bowl chico vs el grande).
- **Modo mesero** (`/mesero/`): el personal toma pedidos desde su celular (comer aquí con número de mesa, para llevar o a domicilio) y ve cuáles ya están listos. Se activa en el panel → Ajustes → Modo mesero, con una contraseña propia que no da acceso al panel.
- **Notificaciones** al celular por cada pedido: Telegram (gratis), WhatsApp vía CallMeBot (gratis) o Twilio (SMS, WhatsApp o llamada).
- **API REST + webhook** para conectar tu sistema de registro de ventas → [docs/API.md](docs/API.md).

## Requisitos

- Node.js 22.13 o superior (usa SQLite integrado en Node, no necesita base de datos externa).

## Arrancar en tu computadora

```bash
npm install
```

```bash
cp .env.example .env
```

Edita `.env` y pon tu `ADMIN_PASSWORD`. Luego:

```bash
npm run dev
```

- Menú: http://localhost:3000/
- Panel: http://localhost:3000/admin/
- Modo mesero: http://localhost:3000/mesero/

La primera vez se carga el **menú de Macaí Bowls** (bowls, chilibowls, toppings y smoothies), definido en `server/catalog.js`. Edítalo desde el panel.

Para volver a cargar ese menú desde cero (borra categorías, productos y toppings; conserva pedidos, ajustes y zonas):

```bash
npm run cargar-menu
```

Para probar desde tu celular en la misma red Wi-Fi, abre `http://IP-DE-TU-PC:3000`.

## Primeros pasos en el panel

1. **Ajustes → Tu negocio**: nombre, WhatsApp del negocio (con código de país, ej. `5215512345678`).
2. **Ajustes → Métodos de pago**: pon tus datos bancarios para transferencia.
3. **Envío**: activa domicilio/recoger, dirección de la tienda, zonas y sus costos (o costo fijo), envío gratis y pedido mínimo.
4. **Toppings**: crea grupos (ej. "Proteína: elige 1", "Extras: hasta 4") con sus precios extra.
5. **Menú**: crea categorías y productos, sube fotos y asígnales los grupos de toppings.
6. **Ajustes → Notificaciones**: configura Telegram o WhatsApp y presiona "Enviar prueba".
7. Activa el **🔔** arriba a la derecha para escuchar un sonido con cada pedido nuevo.
8. Comparte el link de **Ajustes → Link para tus clientes**.

El interruptor **Abierto/Cerrado** de arriba detiene la recepción de pedidos al instante.

## Despliegue en AWS (QA y Producción)

Serverless y casi gratis con poco tráfico (CloudFront + S3 + Lambda + DynamoDB), con infraestructura como código (AWS CDK en `infra/`) y GitHub Actions:

- Push a `main` → se despliega a **QA** automáticamente.
- Actions → Desplegar → Run workflow → **prod** (con aprobación).

Guía completa, configuración inicial y costos: **[docs/DESPLIEGUE.md](docs/DESPLIEGUE.md)**.

## Estructura

```
server/
  app.js            app Express (compartida por el servidor local y Lambda)
  index.js          servidor local (npm run dev)
  lambda.js         entrada para AWS Lambda
  data.js           ajustes, catálogo e inicialización
  store/            almacenamiento: sqlite.js (local) y dynamo.js (AWS: DynamoDB + S3)
  catalog.js        menú de Macaí Bowls
  auth.js           sesión de admin y API key
  orders.js         validación, cálculo de precios, consultas y resumen de ventas
  notify.js         Telegram, CallMeBot, Twilio y webhook
  routes/           public (/api/public), admin (/api/admin), apiV1 (/api/v1)
public/             página del menú, seguimiento y panel de admin
infra/              AWS CDK (stacks Macai-qa, Macai-prod y Macai-github)
scripts/            prueba de humo, cargar menú, restablecer contraseña
.github/workflows/  pruebas y despliegue
data/               base local e imágenes (se crea sola, no se sube a git)
```

Los precios siempre se recalculan en el servidor; el cliente no puede alterarlos.

## Pruebas

Con el servidor corriendo:

```bash
npm test -- http://localhost:3000 "tu-contraseña"
```

## Respaldo

- Local: todo vive en `data/` (`macai.db` + `uploads/`). Copiarla es tu respaldo.
- AWS prod: la tabla de DynamoDB tiene respaldo continuo (point-in-time recovery, 35 días).
