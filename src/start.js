import { ScriptStore } from './store.js';
import { ReviewService } from './review.js';
import { createHttpServer } from './server.js';

const port = Number(process.env.PORT ?? 3003);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT deve estar entre 1 e 65535.');
const store = new ScriptStore({ path: process.env.DATA_FILE || 'data/scripts.json' });
const server = createHttpServer({ service: new ReviewService({ store }), onError: (error) => console.error(`Falha interna: ${error.name}`) });
server.listen(port, '127.0.0.1', () => console.log(`API de revisão: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
