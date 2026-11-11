// Servidor local (tu PC). En AWS se usa server/lambda.js.
import { init } from './data.js';
import { createApp } from './app.js';

await init();

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Macaí corriendo en http://localhost:${PORT}`);
  console.log(`  Menú para clientes:  http://localhost:${PORT}/`);
  console.log(`  Panel de admin:      http://localhost:${PORT}/admin/`);
});
