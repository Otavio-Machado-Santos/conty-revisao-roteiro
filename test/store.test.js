import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScriptStore } from '../src/store.js';
import { ReviewService } from '../src/review.js';

test('arquivo conserva roteiro aprovado e versões após reiniciar a aplicação', () => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-roteiro-'));
  try {
    const path = join(directory, 'scripts.json');
    const service = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date('2026-03-13T15:00:00Z') });
    const initial = service.create({ creator_id: 'creator-1', brand_id: 'brand-1', content: 'Original' });
    service.requestChanges(initial.id, { brand_id: 'brand-1', expected_version: 1, reason: 'Ajuste o final.', deadline: '2026-03-13' });
    service.submitVersion(initial.id, { creator_id: 'creator-1', expected_version: 1, content: 'Revisado' });
    const approved = service.approve(initial.id, { brand_id: 'brand-1', expected_version: 2 });
    const restarted = new ReviewService({ store: new ScriptStore({ path }) });
    assert.deepEqual(restarted.get(initial.id), approved);
    assert.throws(() => restarted.submitVersion(initial.id, { creator_id: 'creator-1', expected_version: 2, content: 'Reaberto?' }), (error) => error.code === 'REVIEW_CLOSED');
    assert.deepEqual(readdirSync(directory), ['scripts.json']);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema_version, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('armazenamento corrompido falha explicitamente e nunca é substituído por banco vazio', () => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-roteiro-'));
  try {
    const path = join(directory, 'scripts.json');
    for (const content of ['{broken', '{"schema_version":2,"scripts":[]}', '{"schema_version":1,"scripts":[{"id":"x"}]}']) {
      writeFileSync(path, content);
      assert.throws(() => new ScriptStore({ path }));
      assert.equal(readFileSync(path, 'utf8'), content);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
