import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ReviewService } from '../src/review.js';
import { createHttpServer } from '../src/server.js';

async function fixture(run) {
  let clock = '2026-03-13T15:00:00.000Z';
  const server = createHttpServer({ service: new ReviewService({ clock: () => new Date(clock) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, input, options = {}) {
    const response = await fetch(`${origin}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      ...(input !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}),
      ...options,
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  try { await run({ call, setClock: (value) => { clock = value; } }); }
  finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

test('HTTP executa criação → alteração → nova versão → aprovação, e rejeita reabertura', async () => {
  await fixture(async ({ call }) => {
    const created = await call('/scripts', { creator_id: 'creator-1', brand_id: 'brand-1', content: 'Original' });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), `/scripts/${created.data.id}`);
    const path = created.headers.get('location');
    const requested = await call(`${path}/change-requests`, { brand_id: 'brand-1', expected_version: 1, reason: 'Explique o benefício.', deadline: '2026-03-13' });
    assert.equal(requested.status, 200);
    assert.equal(requested.data.versions[0].change_request.valid_until, '2026-03-14T02:59:59.999Z');
    const submitted = await call(`${path}/versions`, { creator_id: 'creator-1', expected_version: 1, content: 'Revisado' });
    assert.equal(submitted.status, 201);
    const approved = await call(`${path}/approval`, { brand_id: 'brand-1', expected_version: 2 });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.state, 'approved');
    const read = await call(path);
    assert.equal(read.status, 200);
    assert.equal(read.data.history.length, 4);
    assert.equal(read.data.versions[0].content, 'Original');
    const reopen = await call(`${path}/versions`, { creator_id: 'creator-1', expected_version: 2, content: 'Terceiro' });
    assert.equal(reopen.status, 409);
    assert.equal(reopen.data.error.code, 'REVIEW_CLOSED');
    assert.deepEqual((await call(path)).data, approved.data);
  });
});

test('HTTP comprova limite de prazo com relógio injetado e erros auditáveis', async () => {
  await fixture(async ({ call, setClock }) => {
    const created = await call('/scripts', { creator_id: 'c', brand_id: 'b', content: 'Original' });
    const path = created.headers.get('location');
    setClock('2026-03-14T02:59:59.999Z');
    assert.equal((await call(`${path}/change-requests`, { brand_id: 'b', expected_version: 1, reason: 'Ajuste', deadline: '2026-03-13' })).status, 200);
    setClock('2026-03-14T03:00:00.000Z');
    const tooLate = await call(`${path}/versions`, { creator_id: 'c', expected_version: 1, content: 'Tardio' });
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.data.error.code, 'DEADLINE_EXPIRED');
    assert.equal((await call(path)).data.current_version, 1);
  });
});

test('HTTP valida motivo, prazo, estado, ator e versão atual', async () => {
  await fixture(async ({ call }) => {
    const created = await call('/scripts', { creator_id: 'c', brand_id: 'b', content: 'Original' });
    const path = created.headers.get('location');
    for (const payload of [
      { brand_id: 'b', expected_version: 1, deadline: '2026-03-13' },
      { brand_id: 'b', expected_version: 1, reason: 'Ajuste' },
    ]) {
      const result = await call(`${path}/change-requests`, payload);
      assert.equal(result.status, 422);
      assert.equal(result.data.error.code, 'INVALID_INPUT');
    }
    assert.equal((await call(`${path}/approval`, { brand_id: 'outra', expected_version: 1 })).status, 403);
    assert.equal((await call(`${path}/approval`, { brand_id: 'b', expected_version: 2 })).status, 409);
    assert.equal((await call(`${path}/versions`, { creator_id: 'c', expected_version: 1, content: 'Antes do pedido' })).status, 409);
    assert.equal((await call(path)).data.history.length, 1);
  });
});

test('HTTP rejeita JSON inválido, tipo incorreto, corpo grande e métodos incompatíveis', async () => {
  await fixture(async ({ call }) => {
    assert.equal((await call('/health')).status, 200);
    const method = await call('/health', {});
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET');
    assert.equal((await call('/scripts/missing')).status, 404);
    assert.equal((await call('/unknown')).status, 404);
    assert.equal((await call('/scripts/%E0%A4%A')).status, 400);
    const malformed = await call('/scripts', {}, { body: '{broken' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.data.error.code, 'INVALID_JSON');
    assert.equal((await call('/scripts', {}, { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await call('/scripts', { content: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await call('/scripts', [])).status, 422);
  });
});
