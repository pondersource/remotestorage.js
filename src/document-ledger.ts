import type { OneDriveRecord } from './onedrive-format';

/** Immutable revisions stored in separate CRDT map keys. Byte strings themselves
 * are not mergeable: concurrent heads remain explicit until the user resolves them.
 */
export interface DocumentRevision {
  version: 1;
  id: string;
  path: string;
  parents: string[];
  created: number;
  deleted: boolean;
  file?: OneDriveRecord;
}

export function validateDocumentPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') ||
      path.split('/').some(part => part === '.' || part === '..') || path.includes('\\') || path.includes(String.fromCharCode(0))) {
    throw new Error('Invalid document path.');
  }
}

export function readLedger(root: Record<string, unknown>): DocumentRevision[] {
  const result: DocumentRevision[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith('rs_revision_')) { continue; }
    if (typeof value !== 'string') { throw new Error('An unrecognized document revision needs attention.'); }
    const record = JSON.parse(value) as DocumentRevision;
    if (record.version !== 1 || key !== 'rs_revision_' + record.id || typeof record.id !== 'string' ||
        !Array.isArray(record.parents) || !record.parents.every(id => typeof id === 'string') ||
        !Number.isFinite(record.created) || typeof record.deleted !== 'boolean' ||
        (!record.deleted && (record.file?.version !== 1 || typeof record.file.contentType !== 'string' || typeof record.file.data !== 'string'))) {
      throw new Error('An unrecognized document revision needs attention.');
    }
    validateDocumentPath(record.path);
    if (record.path.endsWith('/')) { throw new Error('A revision must name a document.'); }
    result.push(record);
  }
  const byId = new Map(result.map(record => [record.id, record]));
  for (const record of result) {
    if (record.parents.some(id => id === record.id || byId.has(id) && byId.get(id).path !== record.path)) {
      throw new Error('Document history references an unrelated revision.');
    }
  }
  // Do not turn a corrupt cycle into an apparently empty/deleted document.
  const complete = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { throw new Error('Document history contains a cycle.'); }
    if (complete.has(id)) { return; }
    visiting.add(id);
    for (const parent of byId.get(id)?.parents || []) { if (byId.has(parent)) { visit(parent); } }
    visiting.delete(id); complete.add(id);
  };
  for (const record of result) { visit(record.id); }
  return result;
}

export function documentHeads(records: DocumentRevision[], path: string): DocumentRevision[] {
  const candidates = records.filter(record => record.path === path);
  const parents = new Set(candidates.flatMap(record => record.parents));
  return candidates.filter(record => !parents.has(record.id)).sort((a, b) => a.id.localeCompare(b.id));
}

export function documentRevision(path: string, parents: DocumentRevision[], file?: OneDriveRecord): DocumentRevision {
  validateDocumentPath(path);
  if (path.endsWith('/')) { throw new Error('A revision must name a document.'); }
  return { version: 1, id: crypto.randomUUID(), path, parents: parents.map(record => record.id),
    created: Date.now(), deleted: file === undefined, ...(file ? { file } : {}) };
}
