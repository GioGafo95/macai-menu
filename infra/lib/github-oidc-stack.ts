import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as budgets from 'aws-cdk-lib/aws-budgets';

export interface GithubOidcStackProps extends StackProps {
  /** "dueño/repositorio" de GitHub */
  repo: string;
  /**
   * Prefijo "sub" del token de GitHub cuando el repo usa sujetos inmutables
   * (gh api repos/<dueño>/<repo>/actions/oidc/customization/sub → sub_claim_prefix),
   * ej. "repo:dueño@123/repo@456". Se aceptan ambos formatos.
   */
  subjectPrefix?: string;
  /** false si la cuenta ya tiene el proveedor OIDC de GitHub (sólo puede existir uno) */
  createProvider?: boolean;
  /** Correo para la alerta de presupuesto mensual (opcional) */
  budgetEmail?: string;
  /** Presupuesto mensual en USD (default 5) */
  budgetUsd?: number;
}

/**
 * Permite que GitHub Actions despliegue en AWS sin guardar llaves de acceso:
 * GitHub entrega un token temporal (OIDC) y AWS lo cambia por credenciales de 1 hora.
 *
 * El rol sólo puede asumir los roles de CDK creados por `cdk bootstrap`, y sólo desde los
 * environments "qa" y "prod" de este repositorio.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);
    if (!props.repo) throw new Error('Falta el contexto "githubRepo" (dueño/repositorio) en cdk.json');

    const issuer = 'token.actions.githubusercontent.com';
    const providerArn = props.createProvider === false
      ? `arn:aws:iam::${this.account}:oidc-provider/${issuer}`
      : new iam.OidcProviderNative(this, 'GithubProvider', {
        url: `https://${issuer}`,
        clientIds: ['sts.amazonaws.com'],
      }).oidcProviderArn;

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'macai-github-deploy',
      description: `Despliegues de ${props.repo} desde GitHub Actions`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { [`${issuer}:aud`]: 'sts.amazonaws.com' },
        StringLike: {
          [`${issuer}:sub`]: [`repo:${props.repo}`, props.subjectPrefix]
            .filter((p): p is string => !!p)
            .flatMap((p) => [`${p}:environment:qa`, `${p}:environment:prod`]),
        },
      }),
    });

    // Sólo puede usar los roles de CDK (publicar assets y desplegar con CloudFormation)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
    }));

    // Alerta de gasto (opcional): correo si el mes va a pasar del presupuesto
    if (props.budgetEmail) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: props.budgetEmail }];
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'macai-mensual',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.budgetUsd ?? 5, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers },
          { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
        ],
      });
    }

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Ponlo en GitHub: Settings → Secrets and variables → Actions → Variables → AWS_DEPLOY_ROLE_ARN',
    });
  }
}
