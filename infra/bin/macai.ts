#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { MacaiStack } from '../lib/macai-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

const app = new App();

// Dominio propio (DNS en GoDaddy). Va en UN solo ambiente a la vez (domainStage en cdk.json):
// para pasarlo de QA a prod, primero se despliega QA sin él y luego prod con él.
// El certificado se creó aparte en ACM (us-east-1) y se validó con un CNAME en GoDaddy.
const domainFor = (stage: string) => (app.node.tryGetContext('domainStage') === stage
  ? { domainName: app.node.tryGetContext('domain'), certificateArn: app.node.tryGetContext('domainCertificateArn') }
  : {});

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Dos ambientes en la misma cuenta. La contraseña inicial del panel llega desde GitHub Actions
// (secreto ADMIN_PASSWORD de cada environment); después se cambia desde el panel.
new MacaiStack(app, 'Macai-qa', {
  env,
  envName: 'qa',
  adminPassword: process.env.ADMIN_PASSWORD,
  description: 'Macai Bowls - ambiente QA',
  ...domainFor('qa'),
});

new MacaiStack(app, 'Macai-prod', {
  env,
  envName: 'prod',
  adminPassword: process.env.ADMIN_PASSWORD,
  description: 'Macai Bowls - produccion',
  terminationProtection: true,
  ...domainFor('prod'),
});

// Una sola vez, desde tu PC: permite que GitHub Actions despliegue sin llaves de AWS guardadas (OIDC).
new GithubOidcStack(app, 'Macai-github', {
  env,
  repo: app.node.tryGetContext('githubRepo'),
  subjectPrefix: app.node.tryGetContext('githubSubjectPrefix'),
  createProvider: String(app.node.tryGetContext('createOidcProvider')) !== 'false',
  // npx cdk deploy Macai-github -c budgetEmail=tu@correo.com [-c budgetUsd=5]
  budgetEmail: app.node.tryGetContext('budgetEmail'),
  budgetUsd: Number(app.node.tryGetContext('budgetUsd')) || undefined,
  description: 'Macai Bowls - rol de despliegue para GitHub Actions (OIDC)',
});

Tags.of(app).add('app', 'macai');
