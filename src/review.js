import { randomUUID } from 'node:crypto';
import { BRAND_TIME_ZONE, deadlineBoundary, isDeadlineExpired } from './deadline.js';
import { DomainError } from './errors.js';
import { ScriptStore } from './store.js';

function inputObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('INVALID_INPUT', 'O corpo deve ser um objeto JSON.');
  }
  const extra = Object.keys(input).find((field) => !allowed.includes(field));
  if (extra !== undefined) throw new DomainError('INVALID_INPUT', `Campo desconhecido: ${extra}.`, 422, { field: extra });
}

function text(value, field, maximum, { preserve = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new DomainError('INVALID_INPUT', `${field} deve ser texto não vazio com até ${maximum} caracteres.`, 422, { field });
  }
  return preserve ? value : value.trim();
}

function expectedVersion(input, script) {
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    throw new DomainError('INVALID_INPUT', 'expected_version deve ser um inteiro positivo.', 422, { field: 'expected_version' });
  }
  if (input.expected_version !== script.current_version) {
    throw new DomainError('STALE_VERSION', 'A ação deve se referir à versão atual.', 409, { current_version: script.current_version });
  }
}

function actor(input, role, script) {
  const field = `${role}_id`;
  const id = text(input[field], field, 100);
  if (id !== script[field]) throw new DomainError('WRONG_ACTOR', `Somente o ${role === 'brand' ? 'identificador da marca' : 'identificador do criador'} deste roteiro pode executar esta ação.`, 403);
  return id;
}

function editable(script) {
  if (script.state === 'approved') throw new DomainError('REVIEW_CLOSED', 'A revisão foi aprovada e não pode ser reaberta.', 409);
}

function requireState(script, state, message) {
  if (script.state !== state) throw new DomainError('INVALID_STATE', message, 409, { current_state: script.state });
}

function storedScript(store, id) {
  const script = store.get(id);
  if (!script) throw new DomainError('SCRIPT_NOT_FOUND', 'Roteiro não encontrado.', 404);
  return script;
}

function present(script, now) {
  return { ...script, change_request_status: script.state === 'changes_requested'
    ? (isDeadlineExpired(script.versions.at(-1).change_request, now) ? 'expired' : 'active')
    : null };
}

function version(number, content, timestamp) {
  return { number, content, state: 'awaiting_review', submitted_at: timestamp, change_request: null, superseded_by: null, approved_at: null };
}

function record(script, type, role, actorId, timestamp, metadata = {}) {
  script.history.push({ sequence: script.history.length + 1, type, actor_role: role, actor_id: actorId, at: timestamp, version: script.current_version, ...metadata });
  script.updated_at = timestamp;
}

export class ReviewService {
  constructor({ store = new ScriptStore(), clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.store = store;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  now() {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Relógio inválido.');
    return value;
  }

  get(id) {
    return present(storedScript(this.store, id), this.now());
  }

  create(input) {
    inputObject(input, ['creator_id', 'brand_id', 'content']);
    const creatorId = text(input.creator_id, 'creator_id', 100);
    const brandId = text(input.brand_id, 'brand_id', 100);
    const content = text(input.content, 'content', 20_000, { preserve: true });
    const now = this.now();
    const timestamp = now.toISOString();
    const script = {
      id: this.idFactory(), creator_id: creatorId, brand_id: brandId, time_zone: BRAND_TIME_ZONE,
      state: 'awaiting_review', current_version: 1, created_at: timestamp, updated_at: timestamp, approved_at: null,
      versions: [version(1, content, timestamp)], history: [],
    };
    record(script, 'version_submitted', 'creator', creatorId, timestamp);
    return present(this.store.save(script), now);
  }

  requestChanges(id, input) {
    inputObject(input, ['brand_id', 'expected_version', 'reason', 'deadline']);
    const script = storedScript(this.store, id);
    editable(script);
    const actorId = actor(input, 'brand', script);
    expectedVersion(input, script);
    const now = this.now();
    const current = script.versions.at(-1);
    const renewingExpiredRequest = script.state === 'changes_requested' && isDeadlineExpired(current.change_request, now);
    if (!renewingExpiredRequest) requireState(script, 'awaiting_review', 'A marca só pode pedir alterações em uma versão aguardando revisão ou renovar um pedido expirado.');
    const reason = text(input.reason, 'reason', 2_000);
    const boundary = deadlineBoundary(input.deadline);
    if (isDeadlineExpired(boundary, now)) throw new DomainError('DEADLINE_EXPIRED', 'O dia do prazo já terminou em America/Sao_Paulo.', 422, { deadline: input.deadline });
    const timestamp = now.toISOString();
    current.state = script.state = 'changes_requested';
    current.change_request = { reason, ...boundary, requested_at: timestamp, requested_by: actorId };
    record(script, 'changes_requested', 'brand', actorId, timestamp, { reason, deadline: boundary.deadline, expires_at: boundary.expires_at });
    return present(this.store.save(script), now);
  }

  submitVersion(id, input) {
    inputObject(input, ['creator_id', 'expected_version', 'content']);
    const script = storedScript(this.store, id);
    editable(script);
    const actorId = actor(input, 'creator', script);
    expectedVersion(input, script);
    requireState(script, 'changes_requested', 'Uma nova versão exige um pedido de alteração da marca.');
    const content = text(input.content, 'content', 20_000, { preserve: true });
    const now = this.now();
    const previous = script.versions.at(-1);
    if (isDeadlineExpired(previous.change_request, now)) {
      throw new DomainError('DEADLINE_EXPIRED', 'O prazo para reenviar terminou em America/Sao_Paulo.', 409, { deadline: previous.change_request.deadline });
    }
    const timestamp = now.toISOString();
    const number = script.current_version + 1;
    previous.superseded_by = number;
    script.versions.push(version(number, content, timestamp));
    script.current_version = number;
    script.state = 'awaiting_review';
    record(script, 'version_submitted', 'creator', actorId, timestamp, { replaces_version: number - 1 });
    return present(this.store.save(script), now);
  }

  approve(id, input) {
    inputObject(input, ['brand_id', 'expected_version']);
    const script = storedScript(this.store, id);
    editable(script);
    const actorId = actor(input, 'brand', script);
    expectedVersion(input, script);
    requireState(script, 'awaiting_review', 'A marca só pode aprovar uma versão aguardando revisão.');
    const now = this.now();
    const timestamp = now.toISOString();
    script.state = 'approved';
    script.approved_at = timestamp;
    const current = script.versions.at(-1);
    current.state = 'approved';
    current.approved_at = timestamp;
    record(script, 'approved', 'brand', actorId, timestamp);
    return present(this.store.save(script), now);
  }
}
