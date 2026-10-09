import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

const origin = process.env.BASE_URL || 'http://127.0.0.1:3003';
const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date()).map(({ type, value }) => [type, value]));
const deadline = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
const transcript = { captured_at: new Date().toISOString(), origin, synthetic_data: true, steps: [] };

async function call(method, path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json();
  transcript.steps.push({ method, path, ...(payload ? { request: payload } : {}), status: response.status, response: data });
  console.log(`${method} ${path} → ${response.status}\n${JSON.stringify(data, null, 2)}\n`);
  return { status: response.status, data };
}

try {
  const created = await call('POST', '/scripts', { creator_id: 'criador-demo', brand_id: 'marca-demo', content: 'Apresentação do produto sem explicar o benefício.' });
  assert.equal(created.status, 201);
  const path = `/scripts/${created.data.id}`;
  const requested = await call('POST', `${path}/change-requests`, { brand_id: 'marca-demo', expected_version: 1, reason: 'Explique o benefício antes da chamada de compra.', deadline });
  assert.equal(requested.status, 200);
  const submitted = await call('POST', `${path}/versions`, { creator_id: 'criador-demo', expected_version: 1, content: 'O produto reduz o trabalho manual. Veja como usar e onde comprar.' });
  assert.equal(submitted.status, 201);
  const approved = await call('POST', `${path}/approval`, { brand_id: 'marca-demo', expected_version: 2 });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.state, 'approved');
  const blocked = await call('POST', `${path}/versions`, { creator_id: 'criador-demo', expected_version: 2, content: 'Tentativa após aprovação.' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, 'REVIEW_CLOSED');
  const final = await call('GET', path);
  assert.deepEqual(final.data, approved.data);
  assert.equal(final.data.versions[0].content, created.data.versions[0].content);
  assert.equal(final.data.history.length, 4);
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/http-flow.json', `${JSON.stringify(transcript, null, 2)}\n`);
  console.log(`Fluxo validado. Histórico: ${origin}${path}`);
} catch (error) {
  console.error(`Falha na demonstração: ${error.message}. Inicie npm start antes de npm run demo.`);
  process.exitCode = 1;
}
