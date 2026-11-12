import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const ROOT = path.join(__dirname, '..', '..');

export interface MacaiStackProps extends StackProps {
  envName: 'qa' | 'prod';
  /** Contraseña inicial del panel (solo se usa la primera vez). */
  adminPassword?: string;
  /** Dominio propio (ej. pedidos.macai.com.mx). Requiere certificateArn de ACM en us-east-1, ya validado. */
  domainName?: string;
  certificateArn?: string;
}

/**
 * Macaí Bowls — arquitectura serverless de muy bajo costo (paga solo por uso):
 *
 *   Navegador ──► CloudFront ─┬─► S3 "site"      (página: HTML, JS, CSS, logo)
 *                             ├─► S3 "uploads"   (/uploads/* fotos de productos)
 *                             └─► Lambda URL     (/api/*  Express)  ──► DynamoDB (on-demand)
 *
 * Sin servidores encendidos 24/7, sin NAT, sin balanceadores, sin VPC.
 */
export class MacaiStack extends Stack {
  constructor(scope: Construct, id: string, props: MacaiStackProps) {
    super(scope, id, props);
    const isProd = props.envName === 'prod';
    // En prod los datos sobreviven aunque se borre el stack; en QA se borra todo.
    const dataRemoval = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    Tags.of(this).add('env', props.envName);

    /* ------------------------------ Datos ------------------------------ */

    const gsi = (n: number): dynamodb.GlobalSecondaryIndexPropsV2 => ({
      indexName: `GSI${n}`,
      partitionKey: { name: `GSI${n}PK`, type: dynamodb.AttributeType.STRING },
      sortKey: { name: `GSI${n}SK`, type: dynamodb.AttributeType.STRING },
    });

    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [gsi(1), gsi(2), gsi(3)],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      deletionProtection: isProd,
      removalPolicy: dataRemoval,
    });

    const uploadsBucket = new s3.Bucket(this, 'Uploads', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: dataRemoval,
      autoDeleteObjects: !isProd,
    });

    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // El contenido se regenera desde el repositorio en cada despliegue
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /* ------------------------------ API (Lambda) ------------------------------ */

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new nodejs.NodejsFunction(this, 'Api', {
      description: `Macai API (${props.envName})`,
      entry: path.join(ROOT, 'server', 'lambda.js'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // ~20% más barato que x86
      memorySize: 512,
      timeout: Duration.seconds(20),
      logGroup,
      environment: {
        STORE: 'dynamodb',
        TABLE_NAME: table.tableName,
        UPLOADS_BUCKET: uploadsBucket.bucketName,
        TRUST_PROXY: 'true',
        APP_ENV: props.envName,
        NODE_OPTIONS: '--enable-source-maps',
        ...(props.adminPassword ? { ADMIN_PASSWORD: props.adminPassword } : {}),
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        mainFields: ['module', 'main'],
        // El SDK v3 de AWS ya viene incluido en el runtime de Lambda
        externalModules: ['@aws-sdk/*'],
        // Express y otras dependencias son CommonJS: esto les da `require` dentro del bundle ESM
        banner: "import { createRequire as __macaiCreateRequire } from 'node:module'; const require = __macaiCreateRequire(import.meta.url);",
      },
    });
    table.grantReadWriteData(api);
    uploadsBucket.grantPut(api);

    const apiUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    /* ------------------------------ CloudFront ------------------------------ */

    // "/admin/" → "/admin/index.html", "/admin" → redirección a "/admin/" (igual con /mesero)
    const pagesFn = new cloudfront.Function(this, 'PagesRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Rutas de carpeta a index.html',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var r = event.request;
  if (r.uri === '/admin' || r.uri === '/mesero') {
    return { statusCode: 301, statusDescription: 'Moved', headers: { location: { value: r.uri + '/' } } };
  }
  if (r.uri.endsWith('/')) r.uri += 'index.html';
  return r;
}`),
    });

    // Lambda recibe el host de la Function URL; le pasamos el dominio público para armar enlaces
    const apiHostFn = new cloudfront.Function(this, 'ApiHost', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Pasa el host original a la API',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var r = event.request;
  r.headers['x-original-host'] = { value: r.headers.host.value };
  return r;
}`),
    });

    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    const uploadsOrigin = origins.S3BucketOrigin.withOriginAccessControl(uploadsBucket);

    const customDomain = props.domainName && props.certificateArn
      ? {
          domainNames: [props.domainName],
          certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
        }
      : {};

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `Macai Bowls (${props.envName})`,
      ...customDomain,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // la opción más barata (NA + Europa; México incluido)
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [{ function: pagesFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [{ function: apiHostFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
        '/uploads/*': {
          origin: uploadsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: false,
        },
      },
    });

    // Sube public/ al bucket y limpia la caché de CloudFront en cada despliegue
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'public'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      memoryLimit: 256,
      // El navegador siempre revalida (los archivos no llevan hash); CloudFront sí los guarda en caché
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
    });

    /* ------------------------------ Salidas ------------------------------ */

    const siteUrl = `https://${props.domainName && props.certificateArn ? props.domainName : distribution.distributionDomainName}`;
    new CfnOutput(this, 'Url', { value: siteUrl, description: 'Menú para clientes' });
    // Siempre funciona, aunque el DNS del dominio propio aún no esté listo (lo usa la prueba de humo)
    new CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.distributionDomainName}` });
    if (props.domainName && props.certificateArn) {
      new CfnOutput(this, 'DnsCname', {
        value: `${props.domainName} CNAME ${distribution.distributionDomainName}`,
        description: 'Registro para tu DNS (GoDaddy): apunta el dominio a CloudFront',
      });
    }
    new CfnOutput(this, 'AdminUrl', { value: `${siteUrl}/admin/`, description: 'Panel de administración' });
    new CfnOutput(this, 'MeseroUrl', { value: `${siteUrl}/mesero/`, description: 'Modo mesero (tomar pedidos)' });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'FunctionName', { value: api.functionName });
  }
}
