# Despliegue en AWS (QA y Producción)

Infraestructura como código con **AWS CDK** (carpeta `infra/`) y despliegue automático con **GitHub Actions**.

## Arquitectura (paga solo por uso)

```
Cliente / Admin ──► CloudFront (HTTPS, caché) ─┬─► S3 "site"     página: HTML, JS, CSS, logo
                                               ├─► S3 "uploads"  /uploads/*  fotos de productos
                                               └─► Lambda (URL)  /api/*  la misma app Express
                                                        │
                                                        └─► DynamoDB (on-demand)  pedidos, menú, ajustes
```

- **Nada encendido 24/7**: sin servidores, sin base de datos con cuota fija, sin NAT, sin balanceador.
- La Lambda corre la misma app de `server/`. En tu PC sigue usando SQLite (`npm run dev`), en AWS usa DynamoDB (`STORE=dynamodb`).
- Cada ambiente (`Macai-qa`, `Macai-prod`) tiene **su propia** tabla, buckets, Lambda y dominio de CloudFront.

| | QA | Prod |
|---|---|---|
| Se despliega | Automático en cada push a `main` | Manual ("Run workflow" → prod), solo desde `main`, con aprobación |
| Datos al borrar el stack | Se borran | **Se conservan** (tabla y fotos con `RETAIN`) |
| Respaldo de la tabla | No | Point-in-time recovery (35 días) |
| Protección contra borrado | No | Sí (stack y tabla) |
| Logs | 1 semana | 1 mes |
| Prueba después de desplegar | Completa (crea y cancela un pedido de prueba) | Solo lectura (no crea pedidos) |

## Costo estimado

Con poco tráfico (cientos de pedidos al mes y el panel abierto varias horas al día), **por ambiente**:

| Servicio | Uso típico | Costo |
|---|---|---|
| Lambda (ARM, 512 MB) | ~100 mil peticiones/mes | $0 (capa gratuita permanente: 1M peticiones) |
| DynamoDB on-demand | ~300 mil lecturas/mes | ~$0.05 |
| CloudFront | < 1 GB/mes | $0 (capa gratuita permanente: 1 TB) |
| S3 | < 1 GB | ~$0.03 |
| CloudWatch Logs | pocos MB | ~$0.01 |
| **Total** | | **≈ $0 – $0.50 USD/mes** |

Lo que más consume es el panel de admin abierto (revisa pedidos nuevos cada 10 s). Aun así queda dentro de la capa gratuita.

El **mapa de entrega** también es gratis: usa OpenStreetMap (mapa y búsqueda de direcciones con Nominatim) y OSRM (distancia por calle). Son servicios públicos pensados para poco tráfico, como el de esta app; si OSRM no responde, el envío se calcula con la distancia en línea recta × 1.3.

Opcional: una **alerta de presupuesto** (gratis) que te manda un correo si el mes va a pasar de $5 USD (paso 2).

---

## Configuración inicial (una sola vez)

Requisitos en tu PC: AWS CLI con credenciales de administrador, Node 22.13+ y el CLI `gh` de GitHub.

### 1. Preparar la cuenta de AWS (bootstrap de CDK)

```bash
cd infra
npm ci
npx cdk bootstrap aws://473320740975/us-east-1
```

Crea el stack `CDKToolkit` (bucket para artefactos y roles de despliegue). Cuesta centavos al mes.

### 2. Rol para GitHub Actions (OIDC, sin llaves guardadas)

```bash
npx cdk deploy Macai-github -c budgetEmail=tu@correo.com
```

- Crea el proveedor OIDC de GitHub y el rol `macai-github-deploy`, que **solo** puede desplegar desde los environments `qa` y `prod` de `GioGafo95/macai-menu`.
- `budgetEmail` es opcional: crea la alerta de presupuesto de $5 USD/mes (cámbialo con `-c budgetUsd=10`). AWS te enviará un correo para confirmar la suscripción.
- Si tu cuenta ya tenía el proveedor OIDC de GitHub, agrega `-c createOidcProvider=false`.

Copia el valor de salida `DeployRoleArn`.

### 3. Configurar GitHub

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --body "arn:aws:iam::473320740975:role/macai-github-deploy"
gh variable set AWS_REGION --body "us-east-1"
```

Crea los dos environments y su contraseña inicial del panel (cada ambiente con una distinta):

```bash
gh api -X PUT repos/GioGafo95/macai-menu/environments/qa
gh secret set ADMIN_PASSWORD --env qa
```

```bash
gh api -X PUT repos/GioGafo95/macai-menu/environments/prod
gh secret set ADMIN_PASSWORD --env prod
```

Protege producción en GitHub → **Settings → Environments → prod**:
- **Required reviewers**: agrégate a ti (cada despliegue a prod espera tu aprobación).
- **Deployment branches**: solo `main`.

### 4. Primer despliegue a QA

Haz push a `main`. En la pestaña **Actions** verás el workflow **Desplegar**:
1. **Pruebas**: revisa sintaxis, levanta la app y corre la prueba de punta a punta, y hace `cdk synth`.
2. **Desplegar (qa)**: `cdk deploy Macai-qa` y una prueba de humo contra la URL real.

El resumen del workflow muestra la URL (algo como `https://d1234abcd.cloudfront.net`). El panel está en `/admin/` y el modo mesero en `/mesero/` (actívalo en Ajustes → Modo mesero).

> La primera vez, la app carga sola el menú de Macaí (`server/catalog.js`). Configura en el panel tu WhatsApp, datos bancarios, zonas de envío y notificaciones de cada ambiente.

### 5. Desplegar a producción

GitHub → **Actions → Desplegar → Run workflow** → rama `main`, ambiente **prod** → aprobar.

---

## Día a día

| Quiero… | Cómo |
|---|---|
| Probar cambios | Push a `main` → se publica en QA en ~5 minutos |
| Publicar a clientes | Actions → Desplegar → Run workflow → `prod` |
| Ver qué cambiaría en AWS | `cd infra && npx cdk diff Macai-qa` |
| Desplegar desde mi PC | `cd infra && ADMIN_PASSWORD=... npx cdk deploy Macai-qa` |
| Ver logs de errores | AWS Console → CloudWatch → Log groups → `Macai-qa-ApiLogs…` |
| Recargar el menú de Macaí en AWS | `STORE=dynamodb TABLE_NAME=<TableName> AWS_REGION=us-east-1 npm run cargar-menu` (borra cambios del menú hechos en el panel) |
| Olvidé la contraseña del panel | `STORE=dynamodb TABLE_NAME=<TableName> AWS_REGION=us-east-1 node scripts/reset-password.mjs "nueva-clave"` |

### Contraseña del panel

- `ADMIN_PASSWORD` (secreto del environment) solo se usa la **primera vez**; después cámbiala desde el panel (Ajustes → Seguridad).
- La prueba de humo de **QA** inicia sesión con ese secreto: si cambias la contraseña de QA desde el panel, actualiza también el secreto (`gh secret set ADMIN_PASSWORD --env qa`).

## Pendiente / siguientes pasos

- **Dominio propio** (ej. `pedidos.macaibowls.com`): certificado gratis en ACM (us-east-1) + alias en CloudFront. Route 53 cuesta $0.50/mes por dominio; también funciona con tu proveedor de DNS actual.
- **Fotos de productos**: se suben desde el panel; el navegador las reduce a máx. 1600 px antes de enviarlas.

## Borrar un ambiente

```bash
cd infra
npx cdk destroy Macai-qa
```

En prod la tabla y las fotos se conservan aunque borres el stack (hay que quitarlas a mano si de verdad se quieren eliminar).
