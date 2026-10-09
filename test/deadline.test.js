import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineBoundary, isDeadlineExpired } from '../src/deadline.js';

test('prazo civil de São Paulo inclui o último milissegundo apesar do dia UTC já ter virado', () => {
  const boundary = deadlineBoundary('2026-03-13');
  assert.deepEqual(boundary, {
    deadline: '2026-03-13', time_zone: 'America/Sao_Paulo',
    valid_until: '2026-03-14T02:59:59.999Z', expires_at: '2026-03-14T03:00:00.000Z',
  });
  assert.equal(isDeadlineExpired(boundary, new Date(boundary.valid_until)), false);
  assert.equal(isDeadlineExpired(boundary, new Date(boundary.expires_at)), true);
});

test('calendário trata ano bissexto e virada de ano', () => {
  assert.equal(deadlineBoundary('2024-02-29').expires_at, '2024-03-01T03:00:00.000Z');
  assert.equal(deadlineBoundary('2026-12-31').expires_at, '2027-01-01T03:00:00.000Z');
});

test('não fixa UTC-03: início e fim históricos do horário de verão mantêm o dia completo', () => {
  assert.equal(deadlineBoundary('2018-11-03').expires_at, '2018-11-04T03:00:00.000Z');
  assert.equal(deadlineBoundary('2018-11-04').expires_at, '2018-11-05T02:00:00.000Z');
  assert.equal(deadlineBoundary('2019-02-16').expires_at, '2019-02-17T03:00:00.000Z');
});

test('rejeita datas impossíveis, formatos permissivos, objetos e prazo ausente', () => {
  for (const value of [undefined, null, {}, 20260313, '', '2026-3-13', '2026-03-13T00:00:00Z', '2026-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '0000-01-01']) {
    assert.throws(() => deadlineBoundary(value), (error) => error.code === 'INVALID_INPUT' && error.details.field === 'deadline', String(value));
  }
});
