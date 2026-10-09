import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [archive, evidencePath] = process.argv.slice(2);
assert.ok(archive && evidencePath);
const { ReviewService } = await import(pathToFileURL(join(archive, 'src/review.js')).href);
const { ScriptStore } = await import(pathToFileURL(join(archive, 'src/store.js')).href);
const { createHttpServer } = await import(pathToFileURL(join(archive, 'src/server.js')).href);
const scratch = mkdtempSync(join(tmpdir(), 'review03b-db125-'));
const report = { reviewed_sha: 'db12564279a7ab18d3c7e99759f24c69a6a78227', cases: [], http: [], failures: [] };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const day = instant => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
let server;

function disk(path) {
  const stat = statSync(path, { bigint: true });
  return { size: stat.size.toString(), inode: stat.ino.toString(), mtime_ns: stat.mtimeNs.toString(), sha256: sha(readFileSync(path)) };
}

function unchangedReject(service, store, id, path, action, code, status) {
  const raw = store.get(id);
  const before = disk(path);
  assert.throws(action, error => error.code === code && error.status === status);
  assert.deepEqual(store.get(id), raw);
  assert.deepEqual(disk(path), before);
  assert.equal('change_request_status' in store.get(id), false);
}

try {
  // Literal expected UTC boundaries are independent of the implementation's
  // binary search: leap day, year transition, historical DST start/end.
  const scenarios = [
    ['2024-02-29', '2024-03-01T03:00:00.000Z', '2024-03-01'],
    ['2026-12-31', '2027-01-01T03:00:00.000Z', '2027-01-01'],
    ['2017-10-15', '2017-10-16T02:00:00.000Z', '2017-10-16'],
    ['2017-02-18', '2017-02-19T03:00:00.000Z', '2017-02-19'],
  ];
  for (const [deadline, firstExpired, nextDeadline] of scenarios) {
    let now = new Date(Date.parse(firstExpired) - 3_600_000).toISOString();
    const path = join(scratch, 'domain-' + deadline + '.json');
    const store = new ScriptStore({ path });
    let saves = 0;
    const originalSave = store.save.bind(store);
    store.save = aggregate => { saves++; return originalSave(aggregate); };
    const service = new ReviewService({ store, clock: () => new Date(now), idFactory: () => 'case-' + deadline });
    const created = service.create({ creator_id: 'creator', brand_id: 'brand', content: 'Roteiro original: ' + deadline });
    assert.equal(created.change_request_status, null);
    const old = service.requestChanges(created.id, { brand_id: 'brand', expected_version: 1, reason: 'Motivo original', deadline });
    const renewal = { brand_id: 'brand', expected_version: 1, reason: 'Motivo renovado', deadline: nextDeadline };
    assert.equal(old.versions[0].change_request.expires_at, firstExpired);
    assert.equal(old.versions[0].change_request.valid_until, new Date(Date.parse(firstExpired) - 1).toISOString());
    assert.equal(day(old.versions[0].change_request.valid_until), deadline);
    assert.equal(day(firstExpired), nextDeadline);
    const originalStored = store.get(created.id);
    const originalDisk = disk(path);
    const savesBeforeGet = saves;
    now = old.versions[0].change_request.valid_until;
    assert.equal(service.get(created.id).change_request_status, 'active');
    unchangedReject(service, store, created.id, path, () => service.requestChanges(created.id, renewal), 'INVALID_STATE', 409);
    // First millisecond after the civil day: no automatic transition or write.
    now = firstExpired;
    for (let read = 0; read < 8; read++) assert.equal(service.get(created.id).change_request_status, 'expired');
    assert.equal(saves, savesBeforeGet);
    assert.deepEqual(store.get(created.id), originalStored);
    assert.deepEqual(disk(path), originalDisk);
    unchangedReject(service, store, created.id, path, () => service.submitVersion(created.id, { creator_id: 'creator', expected_version: 1, content: 'Tardio' }), 'DEADLINE_EXPIRED', 409);
    unchangedReject(service, store, created.id, path, () => service.approve(created.id, { brand_id: 'brand', expected_version: 1 }), 'INVALID_STATE', 409);
    for (const [input, code, status] of [
      [{ ...renewal, brand_id: 'intruso' }, 'WRONG_ACTOR', 403],
      [{ ...renewal, expected_version: 2 }, 'STALE_VERSION', 409],
      [{ ...renewal, expected_version: '1' }, 'INVALID_INPUT', 422],
      [{ ...renewal, deadline }, 'DEADLINE_EXPIRED', 422],
      [{ ...renewal, deadline: '2026-02-30' }, 'INVALID_INPUT', 422],
      [{ ...renewal, reason: '   ' }, 'INVALID_INPUT', 422],
    ]) unchangedReject(service, store, created.id, path, () => service.requestChanges(created.id, input), code, status);
    // Old persisted snapshots have no derived flag, and load without migration.
    const restarted = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date(now) });
    assert.equal(restarted.get(created.id).change_request_status, 'expired');
    const renewed = restarted.requestChanges(created.id, renewal);
    assert.equal(renewed.change_request_status, 'active');
    assert.equal(renewed.current_version, 1);
    assert.equal(renewed.versions.length, 1);
    assert.deepEqual(renewed.history.slice(0, old.history.length), old.history);
    assert.equal(renewed.history.at(-1).at, firstExpired);
    assert.equal(renewed.history.at(-1).reason, renewal.reason);
    assert.equal(renewed.history.at(-1).version, 1);
    const resubmitted = restarted.submitVersion(created.id, { creator_id: 'creator', expected_version: 1, content: 'Versão corrigida' });
    assert.equal(resubmitted.change_request_status, null);
    assert.equal(resubmitted.versions[0].content, created.versions[0].content);
    assert.equal(resubmitted.versions[0].superseded_by, 2);
    assert.deepEqual(resubmitted.history.slice(0, renewed.history.length), renewed.history);
    const approved = restarted.approve(created.id, { brand_id: 'brand', expected_version: 2 });
    assert.equal(approved.state, 'approved');
    assert.equal(approved.change_request_status, null);
    assert.equal(approved.history.length, 5);
    const final = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date(Date.parse(now) + 366 * 86_400_000) });
    const finalStore = final.store;
    assert.deepEqual(final.get(created.id), approved);
    for (const action of [
      () => final.requestChanges(created.id, { ...renewal, expected_version: 2 }),
      () => final.submitVersion(created.id, { creator_id: 'creator', expected_version: 2, content: 'Reabrir' }),
      () => final.approve(created.id, { brand_id: 'brand', expected_version: 2 }),
    ]) unchangedReject(final, finalStore, created.id, path, action, 'REVIEW_CLOSED', 409);
    assert.equal('change_request_status' in JSON.parse(readFileSync(path)).scripts[0], false);
    report.cases.push({ deadline, first_expired: firstExpired, next_deadline: nextDeadline, getter_reads_no_saves: 9, nonmutating_rejections: 12, preserved_history_events: 5, restart_approved: true, final_bytes: disk(path) });
  }

  // One real HTTP loopback flow focuses on the expired branch and concurrent
  // renewal; schema/transport implementation is unchanged from prior review.
  let now = '2026-10-09T22:30:00.000Z';
  const path = join(scratch, 'http.json');
  const store = new ScriptStore({ path });
  const service = new ReviewService({ store, clock: () => new Date(now), idFactory: () => 'http-renewal' });
  server = createHttpServer({ service });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const route = '/scripts/http-renewal';
  async function call(endpoint, payload) {
    const response = await fetch(origin + endpoint, { method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) });
    const data = await response.json();
    report.http.push({ clock: now, endpoint, payload, status: response.status, response: data });
    return { status: response.status, data };
  }
  assert.equal((await call('/scripts', { creator_id: 'creator', brand_id: 'brand', content: 'HTTP original' })).status, 201);
  const request = { brand_id: 'brand', expected_version: 1, reason: 'Primeiro HTTP', deadline: '2026-10-09' };
  const original = await call(route + '/change-requests', request);
  assert.equal(original.status, 200);
  assert.equal(original.data.change_request_status, 'active');
  const renewal = { ...request, reason: 'Renovação HTTP', deadline: '2026-10-10' };
  now = '2026-10-10T02:59:59.999Z';
  const unchanged = disk(path);
  assert.equal((await call(route + '/change-requests', renewal)).data.error.code, 'INVALID_STATE');
  assert.equal((await call(route)).data.change_request_status, 'active');
  assert.deepEqual(disk(path), unchanged);
  now = '2026-10-10T03:00:00.000Z';
  const expired = await call(route);
  assert.equal(expired.data.change_request_status, 'expired');
  assert.deepEqual(disk(path), unchanged);
  for (const [input, status, code] of [
    [{ ...renewal, brand_id: 'intruso' }, 403, 'WRONG_ACTOR'],
    [{ ...renewal, expected_version: 2 }, 409, 'STALE_VERSION'],
    [{ ...renewal, deadline: '2026-10-09' }, 422, 'DEADLINE_EXPIRED'],
    [{ ...renewal, deadline: '2026-02-30' }, 422, 'INVALID_INPUT'],
  ]) {
    const result = await call(route + '/change-requests', input);
    assert.equal(result.status, status);
    assert.equal(result.data.error.code, code);
    assert.deepEqual(disk(path), unchanged);
    assert.deepEqual((await call(route)).data, expired.data);
  }
  const races = await Promise.all(Array.from({ length: 12 }, (_, i) => call(route + '/change-requests', { ...renewal, reason: 'Concurrent-' + i })));
  assert.equal(races.filter(value => value.status === 200).length, 1);
  assert.equal(races.filter(value => value.status === 409 && value.data.error.code === 'INVALID_STATE').length, 11);
  const winner = races.find(value => value.status === 200).data;
  assert.equal(winner.history.length, 3);
  assert.deepEqual(winner.history.slice(0, 2), original.data.history);
  assert.deepEqual((await call(route)).data, winner);
  const submitted = await call(route + '/versions', { creator_id: 'creator', expected_version: 1, content: 'HTTP revisado' });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.versions[0].content, 'HTTP original');
  assert.equal(submitted.data.change_request_status, null);
  const staleBytes = disk(path);
  assert.equal((await call(route + '/approval', { brand_id: 'brand', expected_version: 1 })).data.error.code, 'STALE_VERSION');
  assert.deepEqual(disk(path), staleBytes);
  const approved = await call(route + '/approval', { brand_id: 'brand', expected_version: 2 });
  assert.equal(approved.status, 200);
  const approvedBytes = disk(path);
  for (const endpoint of ['change-requests', 'versions', 'approval']) {
    const input = endpoint === 'versions' ? { creator_id: 'creator', expected_version: 2, content: 'Fechado' } : endpoint === 'approval' ? { brand_id: 'brand', expected_version: 2 } : { ...renewal, expected_version: 2 };
    const closed = await call(route + '/' + endpoint, input);
    assert.equal(closed.status, 409);
    assert.equal(closed.data.error.code, 'REVIEW_CLOSED');
    assert.deepEqual(disk(path), approvedBytes);
  }
  const cold = new ReviewService({ store: new ScriptStore({ path }), clock: () => new Date(now) });
  assert.deepEqual(cold.get('http-renewal'), approved.data);
  report.concurrent_renewal = { attempted: 12, successful: 1, invalid_state: 11, versions: winner.versions.length, history_events: winner.history.length };
  report.http_restart_approved = true;
} finally {
  if (server) {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  rmSync(scratch, { recursive: true, force: true });
}

report.checks_passed = true;
writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ domain_boundaries: report.cases.length, domain_rejections: report.cases.reduce((sum, item) => sum + item.nonmutating_rejections, 0), http_requests: report.http.length, concurrent: report.concurrent_renewal, checks_passed: true }));
