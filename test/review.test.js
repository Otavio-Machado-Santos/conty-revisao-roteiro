import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review.js';
import { ScriptStore } from '../src/store.js';

function fixture(instant = '2026-03-13T15:00:00.000Z') {
  let now = instant;
  let ids = 0;
  const service = new ReviewService({ clock: () => new Date(now), idFactory: () => `script-${++ids}` });
  const initial = service.create({ creator_id: 'creator-1', brand_id: 'brand-1', content: 'Primeiro roteiro\nSem corte.' });
  return { service, initial, setClock: (value) => { now = value; } };
}

const change = { brand_id: 'brand-1', expected_version: 1, reason: 'Explique o benefício antes do preço.', deadline: '2026-03-13' };
const newVersion = { creator_id: 'creator-1', expected_version: 1, content: 'Segundo roteiro, com benefício antes do preço.' };

function error(code, status) { return (value) => value.code === code && (!status || value.status === status); }

test('fluxo completo preserva versões, pedido, autores e histórico sequencial', () => {
  const { service, initial, setClock } = fixture();
  assert.equal(initial.state, 'awaiting_review');
  assert.equal(initial.current_version, 1);
  const requested = service.requestChanges(initial.id, change);
  assert.equal(requested.state, 'changes_requested');
  assert.equal(requested.versions[0].change_request.reason, change.reason);
  setClock('2026-03-13T17:00:00.000Z');
  const submitted = service.submitVersion(initial.id, newVersion);
  assert.equal(submitted.state, 'awaiting_review');
  assert.equal(submitted.current_version, 2);
  assert.equal(submitted.versions[0].content, 'Primeiro roteiro\nSem corte.');
  assert.equal(submitted.versions[0].state, 'changes_requested');
  assert.equal(submitted.versions[0].superseded_by, 2);
  assert.equal(submitted.versions[1].content, newVersion.content);
  const approved = service.approve(initial.id, { brand_id: 'brand-1', expected_version: 2 });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.versions[1].state, 'approved');
  assert.equal(approved.approved_at, '2026-03-13T17:00:00.000Z');
  assert.deepEqual(approved.history.map(({ sequence, type, actor_role, version }) => [sequence, type, actor_role, version]), [
    [1, 'version_submitted', 'creator', 1], [2, 'changes_requested', 'brand', 1],
    [3, 'version_submitted', 'creator', 2], [4, 'approved', 'brand', 2],
  ]);
  assert.deepEqual(service.get(initial.id), approved);
});

test('último instante do dia em São Paulo aceita pedido e reenvio', () => {
  const { service, initial } = fixture('2026-03-14T02:59:59.999Z');
  service.requestChanges(initial.id, change);
  assert.equal(service.submitVersion(initial.id, newVersion).current_version, 2);
});

test('primeiro instante do dia seguinte rejeita novo pedido sem alterar o roteiro', () => {
  const { service, initial } = fixture('2026-03-14T03:00:00.000Z');
  assert.throws(() => service.requestChanges(initial.id, change), error('DEADLINE_EXPIRED', 422));
  assert.deepEqual(service.get(initial.id), initial);
});

test('primeiro instante do dia seguinte rejeita reenvio, conservando pedido e versão antiga', () => {
  const { service, initial, setClock } = fixture();
  const requested = service.requestChanges(initial.id, change);
  setClock('2026-03-14T03:00:00.000Z');
  assert.throws(() => service.submitVersion(initial.id, newVersion), error('DEADLINE_EXPIRED', 409));
  assert.deepEqual(service.get(initial.id), requested);
});

test('pedido exige motivo e prazo válidos e não aceita prazo passado', () => {
  for (const invalid of [
    { reason: undefined }, { reason: '' }, { reason: '  \n ' }, { reason: null },
    { deadline: undefined }, { deadline: '' }, { deadline: '2026-02-30' }, { deadline: '2026-03-12' },
  ]) {
    const { service, initial } = fixture();
    assert.throws(() => service.requestChanges(initial.id, { ...change, ...invalid }), (value) => ['INVALID_INPUT', 'DEADLINE_EXPIRED'].includes(value.code));
    assert.deepEqual(service.get(initial.id), initial);
  }
});

test('aprovação encerra revisão: nova versão, pedido ou segunda aprovação não mutam nada', () => {
  const { service, initial } = fixture();
  const approved = service.approve(initial.id, { brand_id: 'brand-1', expected_version: 1 });
  for (const action of [
    () => service.submitVersion(initial.id, newVersion),
    () => service.requestChanges(initial.id, change),
    () => service.approve(initial.id, { brand_id: 'brand-1', expected_version: 1 }),
  ]) {
    assert.throws(action, error('REVIEW_CLOSED', 409));
    assert.deepEqual(service.get(initial.id), approved);
  }
});

test('bloqueia transições fora do fluxo e decisões sobre versões antigas', () => {
  const { service, initial } = fixture();
  assert.throws(() => service.submitVersion(initial.id, newVersion), error('INVALID_STATE', 409));
  service.requestChanges(initial.id, change);
  assert.throws(() => service.requestChanges(initial.id, change), error('INVALID_STATE', 409));
  assert.throws(() => service.approve(initial.id, { brand_id: 'brand-1', expected_version: 1 }), error('INVALID_STATE', 409));
  service.submitVersion(initial.id, newVersion);
  assert.throws(() => service.approve(initial.id, { brand_id: 'brand-1', expected_version: 1 }), error('STALE_VERSION', 409));
  assert.throws(() => service.requestChanges(initial.id, change), error('STALE_VERSION', 409));
  assert.equal(service.get(initial.id).history.length, 3);
});

test('identificadores da marca e do criador precisam corresponder ao roteiro', () => {
  const { service, initial } = fixture();
  assert.throws(() => service.requestChanges(initial.id, { ...change, brand_id: 'outra-marca' }), error('WRONG_ACTOR', 403));
  service.requestChanges(initial.id, change);
  assert.throws(() => service.submitVersion(initial.id, { ...newVersion, creator_id: 'outro-criador' }), error('WRONG_ACTOR', 403));
  service.submitVersion(initial.id, newVersion);
  assert.throws(() => service.approve(initial.id, { brand_id: 'outra-marca', expected_version: 2 }), error('WRONG_ACTOR', 403));
});

test('rejeita entradas malformadas e versão esperada ausente, fracionária ou inválida', () => {
  const { service, initial } = fixture();
  for (const value of [null, [], 'roteiro', {}, { creator_id: '', brand_id: 'brand-1', content: 'x' }, { creator_id: 'creator-1', brand_id: 'brand-1', content: ' ' }, { creator_id: 'creator-1', brand_id: 'brand-1', content: 'x', unexpected: true }]) {
    assert.throws(() => service.create(value), error('INVALID_INPUT', 422));
  }
  for (const expected_version of [undefined, null, '1', 0, -1, 1.2, Number.MAX_VALUE]) {
    assert.throws(() => service.requestChanges(initial.id, { ...change, expected_version }), error('INVALID_INPUT', 422));
  }
  assert.throws(() => service.get('missing'), error('SCRIPT_NOT_FOUND', 404));
  assert.deepEqual(service.get(initial.id), initial);
});

test('mais de um ciclo de alteração conserva todo o histórico e a marca pode aprovar após o prazo de reenvio', () => {
  const { service, initial, setClock } = fixture();
  service.requestChanges(initial.id, change);
  service.submitVersion(initial.id, newVersion);
  service.requestChanges(initial.id, { ...change, expected_version: 2, deadline: '2026-03-14', reason: 'Adicione a chamada final.' });
  service.submitVersion(initial.id, { ...newVersion, expected_version: 2, content: 'Terceiro roteiro com chamada final.' });
  setClock('2026-03-16T15:00:00.000Z');
  const approved = service.approve(initial.id, { brand_id: 'brand-1', expected_version: 3 });
  assert.equal(approved.versions.length, 3);
  assert.equal(approved.history.length, 6);
  assert.equal(approved.versions[0].change_request.reason, change.reason);
  assert.equal(approved.versions[1].change_request.reason, 'Adicione a chamada final.');
  assert.equal(approved.state, 'approved');
});

test('objetos devolvidos não permitem editar o estado persistido por fora das transições', () => {
  const { service, initial } = fixture();
  initial.versions[0].content = 'Mudança externa';
  initial.state = 'approved';
  const read = service.get(initial.id);
  assert.equal(read.state, 'awaiting_review');
  assert.equal(read.versions[0].content, 'Primeiro roteiro\nSem corte.');
  read.history.length = 0;
  assert.equal(service.get(initial.id).history.length, 1);
});

test('falha ao persistir uma mudança não modifica o agregado anterior', () => {
  const store = new ScriptStore();
  const service = new ReviewService({ store, clock: () => new Date('2026-03-13T15:00:00Z') });
  const initial = service.create({ creator_id: 'creator-1', brand_id: 'brand-1', content: 'Roteiro.' });
  store.save = () => { throw new Error('disco indisponível'); };
  assert.throws(() => service.requestChanges(initial.id, change), /disco indisponível/);
  assert.deepEqual(service.get(initial.id), initial);
});
