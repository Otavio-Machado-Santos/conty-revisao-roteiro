import { createServer } from 'node:http';
import { DomainError } from './errors.js';
import { ReviewService } from './review.js';
import { BRAND_TIME_ZONE } from './deadline.js';

const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

async function body(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
    request.resume();
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Envie Content-Type: application/json.', 415);
  }
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) oversized = true;
    else if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw new DomainError('PAYLOAD_TOO_LARGE', 'O corpo excede 64 KiB.', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('INVALID_JSON', 'Envie um corpo JSON válido.', 400); }
}

export function createHttpServer({ service = new ReviewService(), onError = () => {} } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
      if (pathname === '/health') {
        if (request.method !== 'GET') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, { allow: 'GET' });
        return json(response, 200, { status: 'ok', time_zone: BRAND_TIME_ZONE });
      }
      if (pathname === '/scripts') {
        if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, { allow: 'POST' });
        const script = service.create(await body(request));
        return json(response, 201, script, { location: `/scripts/${encodeURIComponent(script.id)}` });
      }
      const route = pathname.match(/^\/scripts\/([^/]+)(?:\/(change-requests|versions|approval))?$/);
      if (!route) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      let id;
      try { id = decodeURIComponent(route[1]); }
      catch { throw new DomainError('INVALID_URL', 'Identificador inválido na URL.', 400); }
      const action = route[2];
      const method = action ? 'POST' : 'GET';
      if (request.method !== method) return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` } }, { allow: method });
      if (!action) return json(response, 200, service.get(id));
      const input = await body(request);
      const result = action === 'change-requests' ? service.requestChanges(id, input)
        : action === 'versions' ? service.submitVersion(id, input)
          : service.approve(id, input);
      return json(response, action === 'versions' ? 201 : 200, result);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof DomainError) {
        return json(response, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      }
      onError(error);
      return json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação.' } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
