import { readLedger, type DocumentRevision } from './document-ledger';
import { decodeRecord } from './onedrive-format';

const DATABASE = 'remotestorage-nextgraph-journal';
const databases = new WeakMap<IDBFactory, Promise<IDBDatabase>>();
interface Row { store: string; collection: string; id: string; record: string }
interface Collection { version: 1; store: string; collection: string }
export interface JournalChange<T> { value: T; append?: DocumentRevision[] }

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    }
    return item;
  });
}

/** Validate a complete union before any write. Duplicate immutable IDs must
 * identify exactly the same JSON, including fields this adapter does not use.
 */
export function mergeJournalRecords(...sources: DocumentRevision[][]): DocumentRevision[] {
  const records = new Map<string, string>();
  for (const source of sources) {
    for (const record of source) {
      const serialized = canonical(record);
      if (records.has(record.id) && records.get(record.id) !== serialized) {
        throw new Error('Nextgraph has mismatched content for an immutable revision ID. Export recovery data before reconciling it.');
      }
      records.set(record.id, serialized);
    }
  }
  const ledger = Object.fromEntries([...records].map(([id, record]) => ['rs_revision_' + id, record]));
  const result = readLedger(ledger);
  for (const record of result) {
    if (!record.id || record.deleted && record.file !== undefined) { throw new Error('Invalid Nextgraph journal revision.'); }
    if (!record.deleted) { decodeRecord(record.file); }
  }
  return result;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') { return Promise.reject(new Error('Nextgraph needs IndexedDB for durable local recovery.')); }
  const factory = indexedDB;
  if (!databases.has(factory)) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('collections', { keyPath: ['store', 'collection'] }).createIndex('store', 'store');
        db.createObjectStore('revisions', { keyPath: ['store', 'collection', 'id'] }).createIndex('namespace', ['store', 'collection']);
      };
      request.onerror = () => { settled = true; reject(request.error); };
      request.onblocked = () => { settled = true; reject(new Error('Close another tab to open Nextgraph recovery storage.')); };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => { db.close(); databases.delete(factory); };
        resolve(db);
      };
    }).catch(error => { databases.delete(factory); throw error; });
    databases.set(factory, opening);
  }
  return databases.get(factory);
}

function collection(value: unknown, store: string): Collection {
  const item = value as Collection;
  if (item?.version !== 1 || item.store !== store || typeof item.collection !== 'string' || !item.collection) {
    throw new Error('Unrecognized Nextgraph recovery collection.');
  }
  return item;
}

/** This journal is a durable readback/recovery archive, not a broker queue.
 * It never deletes revisions or changes the SDK's session/peer sequence data.
 */
export class NextGraphJournal {
  constructor(readonly store: string, readonly collection: string) {
    if (typeof store !== 'string' || !store || typeof collection !== 'string' || !collection) {
      throw new Error('A native private store and collection are required for Nextgraph recovery.');
    }
  }

  static async collections(store: string): Promise<string[]> {
    if (typeof store !== 'string' || !store) { throw new Error('A native private store is required for Nextgraph recovery.'); }
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('collections', 'readonly');
      let result: string[];
      let failure: unknown;
      const request = transaction.objectStore('collections').index('store').getAll(store);
      request.onsuccess = () => {
        try { result = request.result.map(item => collection(item, store).collection); }
        catch (error) { failure = error; transaction.abort(); }
      };
      transaction.onerror = event => { failure ||= (event.target as IDBRequest).error; };
      transaction.onabort = () => reject(failure || transaction.error || new Error('Nextgraph recovery read aborted.'));
      transaction.oncomplete = () => failure ? reject(failure) : resolve(result);
    });
  }

  /** Read heads, check preconditions, validate union and append within one short
   * read/write transaction. No network or native SDK operation runs under it.
   * Promise settlement follows the actual terminal commit/abort event.
   */
  async transact<T>(native: DocumentRevision[], work: (records: DocumentRevision[]) => JournalChange<T>, registerCollection = true): Promise<{ value: T; records: DocumentRevision[] }> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['collections', 'revisions'], 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('revisions');
      const catalogue = registerCollection ? transaction.objectStore('collections').index('store').getAll(this.store) : undefined;
      const request = store.index('namespace').getAll([this.store, this.collection]);
      let failure: unknown;
      let value: T;
      let records: DocumentRevision[];
      let catalogueReady = !catalogue;
      let rowsReady = false;
      const abort = (error: unknown): void => {
        failure ||= error;
        try { transaction.abort(); } catch { /* The terminal event still owns settlement. */ }
      };
      const prepare = (): void => {
        if (!catalogueReady || !rowsReady) { return; }
        try {
          const rows = request.result as Row[];
          const existing = rows.map(row => {
            const record = JSON.parse(row.record) as DocumentRevision;
            if (row.store !== this.store || row.collection !== this.collection || row.id !== record.id) {
              throw new Error('Corrupt Nextgraph recovery namespace or revision.');
            }
            return record;
          });
          records = mergeJournalRecords(existing, native);
          const change = work(records);
          records = mergeJournalRecords(records, change.append || []);
          value = change.value;
          const oldIds = new Set(existing.map(record => record.id));
          for (const record of records) {
            if (!oldIds.has(record.id)) {
              store.add({ store: this.store, collection: this.collection, id: record.id, record: canonical(record) } satisfies Row);
            }
          }
          if (registerCollection) {
            transaction.objectStore('collections').put({ version: 1, store: this.store, collection: this.collection } satisfies Collection);
          }
        } catch (error) { abort(error); }
      };
      if (catalogue) {
        catalogue.onsuccess = () => {
          try {
            const existing = catalogue.result.map(item => collection(item, this.store).collection);
            if (existing.some(id => id !== this.collection)) { throw new Error('Multiple Nextgraph collections need reconciliation before journal updates.'); }
            catalogueReady = true; prepare();
          } catch (error) { abort(error); }
        };
      }
      request.onsuccess = () => { rowsReady = true; prepare(); };
      transaction.onerror = event => abort((event.target as IDBRequest).error || transaction.error || new Error('Nextgraph recovery write failed.'));
      transaction.onabort = () => reject(failure || transaction.error || new Error('Nextgraph recovery write aborted.'));
      transaction.oncomplete = () => failure ? reject(failure) : resolve({ value, records });
    });
  }
}
