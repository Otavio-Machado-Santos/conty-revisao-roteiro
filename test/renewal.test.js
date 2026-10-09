import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewService } from '../src/review.js';
import { ScriptStore } from '../src/store.js';
import { createHttpServer } from '../src/server.js';

const change = { brand_id: 'b', expected_version: 1, reason: 'Primeiro motivo', deadline: '2026-03-13' };
const renewal = { ...change, reason: 'Novo motivo', deadline: '2026-03-14' };
const submission = { creator_id: 'c', expected_version: 1, content: 'Revisado' };
const error = (code, status) => (value) => value.code === code && value.status === status;

function fixture(t, { persistent = false, clock = '2026-03-13T15:00:00.000Z' } = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'conty-renewal-')) : undefined;
  if (directory) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = directory ? join(directory, 'scripts.json') : undefined;
  const store = new ScriptStore({ path });
  const service = new ReviewService({ store, clock: () => new Date(clock), idFactory: () => 'renewal-1' });
  const initial = service.create({ creator_id: 'c', brand_id: 'b', content: 'Original' });
  return { service, store, initial, path, directory, setClock: (value) => { clock = value; } };
}

async function httpFixture(t) {
  const setup = fixture(t, { persistent: true });
  const server = createHttpServer({ service: setup.service });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const route = `/scripts/${setup.initial.id}`;
  async function call(suffix = '', input) {
    const response = await fetch(`${origin}${route}${suffix}`, {
      method: input === undefined ? 'GET' : 'POST',
      ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    });
    return { status: response.status, data: await response.json() };
  }
  return { ...setup, call };
}

test('pedido expirado permite novo pedido válido, reenvio e aprovação no mesmo roteiro', () => {
  let clock = '2026-03-13T15:00:00.000Z';
  const service = new ReviewService({ clock: () => new Date(clock), idFactory: () => 'renewal-1' });
  const initial = service.create({ creator_id: 'c', brand_id: 'b', content: 'Original' });
  service.requestChanges(initial.id, { brand_id: 'b', expected_version: 1, reason: 'Primeiro motivo', deadline: '2026-03-13' });
  clock = '2026-03-14T03:00:00.000Z';
  const renewed = service.requestChanges(initial.id, { brand_id: 'b', expected_version: 1, reason: 'Segundo motivo', deadline: '2026-03-14' });
  assert.equal(renewed.current_version, 1);
  assert.equal(renewed.history.length, 3);
  const submitted = service.submitVersion(initial.id, { creator_id: 'c', expected_version: 1, content: 'Revisado' });
  assert.equal(submitted.current_version, 2);
  const approved = service.approve(initial.id, { brand_id: 'b', expected_version: 2 });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.versions[0].content, 'Original');
  assert.equal(approved.history[1].reason, 'Primeiro motivo');
});

for (const [deadline, lastInstant, firstExpired, nextDeadline] of [
  ['2026-03-13', '2026-03-14T02:59:59.999Z', '2026-03-14T03:00:00.000Z', '2026-03-14'],
  ['2018-11-04', '2018-11-05T01:59:59.999Z', '2018-11-05T02:00:00.000Z', '2018-11-05'],
  ['2019-02-16', '2019-02-17T02:59:59.999Z', '2019-02-17T03:00:00.000Z', '2019-02-17'],
]) {
  test(`renovação de ${deadline}: último ms bloqueia, primeiro ms permite, sem apagar pedido anterior`, (t) => {
    const { service, store, initial, setClock } = fixture(t, { clock: new Date(Date.parse(lastInstant) - 60_000).toISOString() });
    const requested = service.requestChanges(initial.id, { ...change, deadline });
    const original = store.get(initial.id);
    const nextRequest = { ...renewal, deadline: nextDeadline };
    setClock(lastInstant);
    assert.equal(service.get(initial.id).change_request_status, 'active');
    assert.throws(() => service.requestChanges(initial.id, nextRequest), error('INVALID_STATE', 409));
    assert.deepEqual(store.get(initial.id), original);
    setClock(firstExpired);
    const expired = service.get(initial.id);
    assert.equal(expired.state, 'changes_requested');
    assert.equal(expired.change_request_status, 'expired');
    assert.equal(expired.current_version, 1);
    assert.throws(() => service.submitVersion(initial.id, submission), error('DEADLINE_EXPIRED', 409));
    assert.throws(() => service.approve(initial.id, { brand_id: 'b', expected_version: 1 }), error('INVALID_STATE', 409));
    assert.deepEqual(store.get(initial.id), original);
    const renewed = service.requestChanges(initial.id, nextRequest);
    assert.equal(renewed.change_request_status, 'active');
    assert.equal(renewed.current_version, 1);
    assert.equal(renewed.versions.length, 1);
    assert.deepEqual(renewed.history.slice(0, 2), requested.history);
    assert.equal(renewed.history[1].reason, change.reason);
    assert.equal(renewed.history[1].deadline, deadline);
    assert.equal(renewed.history[1].actor_id, 'b');
    assert.equal(renewed.history[1].at, requested.versions[0].change_request.requested_at);
    assert.equal(renewed.history[1].expires_at, firstExpired);
    assert.equal(renewed.history[2].at, firstExpired);
    assert.equal(renewed.history[2].version, 1);
    assert.throws(() => service.requestChanges(initial.id, nextRequest), error('INVALID_STATE', 409));
    assert.deepEqual(service.get(initial.id), renewed);
  });
}

test('renovação inválida não altera estado, pedido, histórico ou arquivo', (t) => {
  const { service, store, initial, path, setClock } = fixture(t, { persistent: true });
  service.requestChanges(initial.id, change);
  setClock('2026-03-14T03:00:00.000Z');
  const original = store.get(initial.id);
  const bytes = readFileSync(path, 'utf8');
  for (const [input, code, status] of [
    [{ ...renewal, deadline: '2026-03-13' }, 'DEADLINE_EXPIRED', 422],
    [{ ...renewal, deadline: '2026-03-12' }, 'DEADLINE_EXPIRED', 422],
    [{ ...renewal, deadline: '2026-02-30' }, 'INVALID_INPUT', 422],
    [{ ...renewal, deadline: undefined }, 'INVALID_INPUT', 422],
    [{ ...renewal, reason: '   ' }, 'INVALID_INPUT', 422],
    [{ ...renewal, reason: undefined }, 'INVALID_INPUT', 422],
    [{ ...renewal, brand_id: 'outra-marca' }, 'WRONG_ACTOR', 403],
    [{ ...renewal, expected_version: 2 }, 'STALE_VERSION', 409],
    [{ ...renewal, expected_version: '1' }, 'INVALID_INPUT', 422],
    [{ ...renewal, '': true }, 'INVALID_INPUT', 422],
    [{ ...renewal, extra: true }, 'INVALID_INPUT', 422],
  ]) {
    assert.throws(() => service.requestChanges(initial.id, input), error(code, status));
    assert.deepEqual(store.get(initial.id), original);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.equal(service.get(initial.id).change_request_status, 'expired');
  }
  assert.throws(() => service.submitVersion(initial.id, { ...submission, creator_id: 'outro' }), error('WRONG_ACTOR', 403));
  assert.throws(() => service.submitVersion(initial.id, { ...submission, expected_version: 2 }), error('STALE_VERSION', 409));
  assert.deepEqual(store.get(initial.id), original);
  assert.equal(readFileSync(path, 'utf8'), bytes);
});

test('renovações sucessivas conservam motivos, prazos, autores e datas até aprovação terminal', (t) => {
  const { service, initial, setClock } = fixture(t);
  const requested = service.requestChanges(initial.id, change);
  setClock('2026-03-14T03:00:00.000Z');
  const renewed = service.requestChanges(initial.id, renewal);
  setClock('2026-03-15T03:00:00.000Z');
  const twiceRenewed = service.requestChanges(initial.id, { ...renewal, reason: 'Terceiro motivo', deadline: '2026-03-15' });
  assert.deepEqual(twiceRenewed.history.slice(0, 3), renewed.history);
  assert.deepEqual(twiceRenewed.history.slice(0, 2), requested.history);
  const submitted = service.submitVersion(initial.id, submission);
  assert.equal(submitted.change_request_status, null);
  assert.equal(submitted.versions[0].content, 'Original');
  assert.equal(submitted.versions[0].superseded_by, 2);
  assert.equal(submitted.versions[0].change_request.reason, 'Terceiro motivo');
  assert.throws(() => service.requestChanges(initial.id, renewal), error('STALE_VERSION', 409));
  const approved = service.approve(initial.id, { brand_id: 'b', expected_version: 2 });
  assert.equal(approved.change_request_status, null);
  assert.equal(approved.history.length, 6);
  assert.deepEqual(approved.history.filter(({ type }) => type === 'changes_requested').map(({ reason, deadline, actor_id, at, version }) => ({ reason, deadline, actor_id, at, version })), [
    { reason: 'Primeiro motivo', deadline: '2026-03-13', actor_id: 'b', at: '2026-03-13T15:00:00.000Z', version: 1 },
    { reason: 'Novo motivo', deadline: '2026-03-14', actor_id: 'b', at: '2026-03-14T03:00:00.000Z', version: 1 },
    { reason: 'Terceiro motivo', deadline: '2026-03-15', actor_id: 'b', at: '2026-03-15T03:00:00.000Z', version: 1 },
  ]);
  setClock('2026-03-20T15:00:00.000Z');
  for (const action of [
    () => service.requestChanges(initial.id, { ...renewal, expected_version: 2, deadline: '2026-03-21' }),
    () => service.submitVersion(initial.id, { ...submission, expected_version: 2 }),
    () => service.approve(initial.id, { brand_id: 'b', expected_version: 2 }),
  ]) {
    assert.throws(action, error('REVIEW_CLOSED', 409));
    assert.deepEqual(service.get(initial.id), approved);
  }
});

test('GET projeta expiração pelo relógio sem persistir status, mutar histórico ou exigir migração', (t) => {
  const { service, initial, path, setClock } = fixture(t, { persistent: true });
  const requested = service.requestChanges(initial.id, change);
  const bytes = readFileSync(path, 'utf8');
  assert.equal('change_request_status' in JSON.parse(bytes).scripts[0], false);
  setClock('2026-03-14T03:00:00.000Z');
  const expired = service.get(initial.id);
  assert.deepEqual(expired, { ...requested, change_request_status: 'expired' });
  assert.equal(readFileSync(path, 'utf8'), bytes);
  const restarted = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date('2026-03-14T03:00:00.000Z') });
  assert.deepEqual(restarted.get(initial.id), expired);
  expired.versions[0].change_request.reason = 'Manipulado';
  expired.history.length = 0;
  assert.deepEqual(restarted.get(initial.id), { ...requested, change_request_status: 'expired' });
  const renewed = restarted.requestChanges(initial.id, renewal);
  const again = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date('2026-03-14T03:00:00.000Z') });
  assert.deepEqual(again.get(initial.id), renewed);
  assert.equal(again.submitVersion(initial.id, submission).current_version, 2);
});

test('falha ao persistir renovação conserva o pedido expirado e o arquivo anterior', (t) => {
  const { service, store, initial, path, directory, setClock } = fixture(t, { persistent: true });
  service.requestChanges(initial.id, change);
  setClock('2026-03-14T03:00:00.000Z');
  const expired = service.get(initial.id);
  const bytes = readFileSync(path, 'utf8');
  store.save = () => { throw new Error('disco indisponível'); };
  assert.throws(() => service.requestChanges(initial.id, renewal), /disco indisponível/);
  assert.deepEqual(service.get(initial.id), expired);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.deepEqual(readdirSync(directory), ['scripts.json']);
});

test('HTTP mostra expiração, rejeita escritas inválidas sem efeitos e retoma até aprovação', async (t) => {
  const { call, path, setClock } = await httpFixture(t);
  const requested = await call('/change-requests', change);
  assert.equal(requested.status, 200);
  assert.equal(requested.data.change_request_status, 'active');
  setClock('2026-03-14T02:59:59.999Z');
  const lastInstant = await call('/change-requests', renewal);
  assert.equal(lastInstant.status, 409);
  assert.equal(lastInstant.data.error.code, 'INVALID_STATE');
  assert.deepEqual((await call()).data, requested.data);
  setClock('2026-03-14T03:00:00.000Z');
  const expired = (await call()).data;
  assert.equal(expired.change_request_status, 'expired');
  const bytes = readFileSync(path, 'utf8');
  for (const [route, input, status, code] of [
    ['/versions', submission, 409, 'DEADLINE_EXPIRED'],
    ['/approval', { brand_id: 'b', expected_version: 1 }, 409, 'INVALID_STATE'],
    ['/change-requests', change, 422, 'DEADLINE_EXPIRED'],
    ['/change-requests', { ...renewal, brand_id: 'outra' }, 403, 'WRONG_ACTOR'],
    ['/change-requests', { ...renewal, expected_version: 2 }, 409, 'STALE_VERSION'],
    ['/change-requests', { ...renewal, reason: '' }, 422, 'INVALID_INPUT'],
    ['/change-requests', { ...renewal, '': true }, 422, 'INVALID_INPUT'],
  ]) {
    const rejected = await call(route, input);
    assert.equal(rejected.status, status);
    assert.equal(rejected.data.error.code, code);
    assert.deepEqual((await call()).data, expired);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
  const renewed = await call('/change-requests', renewal);
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.change_request_status, 'active');
  assert.deepEqual(renewed.data.history.slice(0, 2), requested.data.history);
  const submitted = await call('/versions', submission);
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.change_request_status, null);
  assert.equal(submitted.data.versions[0].content, 'Original');
  const stale = await call('/approval', { brand_id: 'b', expected_version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'STALE_VERSION');
  const approved = await call('/approval', { brand_id: 'b', expected_version: 2 });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.state, 'approved');
  assert.equal(approved.data.history.length, 5);
  for (const [route, input] of [
    ['/change-requests', { ...renewal, expected_version: 2 }],
    ['/versions', { ...submission, expected_version: 2 }],
    ['/approval', { brand_id: 'b', expected_version: 2 }],
  ]) {
    const closed = await call(route, input);
    assert.equal(closed.status, 409);
    assert.equal(closed.data.error.code, 'REVIEW_CLOSED');
    assert.deepEqual((await call()).data, approved.data);
  }
});

test('HTTP serializa duas renovações concorrentes: somente a primeira substitui o pedido expirado', async (t) => {
  const { call, setClock } = await httpFixture(t);
  const requested = await call('/change-requests', change);
  setClock('2026-03-14T03:00:00.000Z');
  const responses = await Promise.all([
    call('/change-requests', { ...renewal, reason: 'Renovação A' }),
    call('/change-requests', { ...renewal, reason: 'Renovação B' }),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
  const winner = responses.find(({ status }) => status === 200);
  const loser = responses.find(({ status }) => status === 409);
  assert.equal(loser.data.error.code, 'INVALID_STATE');
  assert.equal(winner.data.history.length, 3);
  assert.deepEqual(winner.data.history.slice(0, 2), requested.data.history);
  assert.deepEqual((await call()).data, winner.data);
});
