// Punto de entrada para AWS Lambda (Function URL detrás de CloudFront).
import serverless from 'serverless-http';
import { init } from './data.js';
import { createApp } from './app.js';

await init();

const app = createApp({ serveStatic: false });

export const handler = serverless(app, {
  binary: ['image/*', 'multipart/form-data'],
});
