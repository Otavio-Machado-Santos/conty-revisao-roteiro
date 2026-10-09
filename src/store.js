import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function load(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const document = JSON.parse(raw);
  if (document?.schema_version !== 1 || !Array.isArray(document.scripts)) {
    throw new Error('Formato de armazenamento inválido; nenhum dado foi sobrescrito.');
  }
  const ids = new Set();
  for (const script of document.scripts) {
    if (!script || typeof script.id !== 'string' || ids.has(script.id)
      || !Array.isArray(script.versions) || script.versions.length === 0
      || !Array.isArray(script.history) || script.history.length === 0
      || !['awaiting_review', 'changes_requested', 'approved'].includes(script.state)
      || script.current_version !== script.versions.at(-1)?.number) {
      throw new Error('Roteiro inválido no armazenamento; nenhum dado foi sobrescrito.');
    }
    ids.add(script.id);
  }
  return document.scripts;
}

export class ScriptStore {
  constructor({ path } = {}) {
    this.path = path ? resolve(path) : undefined;
    this.scripts = new Map((this.path ? load(this.path) : []).map((script) => [script.id, script]));
  }

  get(id) {
    const script = this.scripts.get(id);
    return script ? structuredClone(script) : undefined;
  }

  save(script) {
    const copy = structuredClone(script);
    const candidate = new Map(this.scripts);
    candidate.set(script.id, copy);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, scripts: [...candidate.values()] }, null, 2)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        });
        renameSync(temporary, this.path);
      } finally {
        try { unlinkSync(temporary); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    this.scripts = candidate;
    return structuredClone(copy);
  }
}
