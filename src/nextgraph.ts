import type { Session } from '@ng-org/web';
import type { DiscreteOrmSubscription } from '@ng-org/orm';
import { RemoteBase, type Remote, type RemoteResponse, type RemoteSettings } from './remote';
import type RemoteStorage from './remotestorage';
import { decodeRecord, encodeRecord, unbase64url, type OneDriveRecord } from './onedrive-format';
import { readLedger, documentHeads, documentRevision, validateDocumentPath, type DocumentRevision } from './document-ledger';

const COLLECTION = 'https://pondersource.com/ns/remotestorage/DocumentLedgerV1';
interface NativeSDK {
  web: typeof import('@ng-org/web');
  orm: typeof import('@ng-org/orm');
}
let sdkPromise: Promise<NativeSDK>;
let sessionPromise: Promise<Session>;

/** Load native SDK values only after a connection request, never at app startup. */
function nativeSDK(): Promise<NativeSDK> {
  if (!sdkPromise) {
    // The pinned ORM evaluates Set.union while loading. Check its requirement
    // only for Nextgraph; do not polyfill the app's global runtime for an
    // optional backend or let it prevent guest/other-provider startup.
    const prototype = Set.prototype as unknown as { union?: unknown };
    if (typeof prototype.union !== 'function') {
      return Promise.reject(new Error('Nextgraph requires Set.union support. Update your browser or choose another storage backend.'));
    }
    // tsc's CommonJS output defers these requires inside promise callbacks.
    // Webpack bundles both modules in this file, without extra chunk assets.
    sdkPromise = Promise.all([import('@ng-org/web'), import('@ng-org/orm')])
      .then(([web, orm]) => ({ web, orm }))
      .catch(error => {
        throw new Error('The Nextgraph SDK could not start in this browser. Update your browser or choose another storage backend.', { cause: error });
      });
  }
  return sdkPromise;
}
const failedCollections = new Set<string>();
const collectionOwners = new Map<string, NextGraph>();
function nativeSession(sdk: NativeSDK): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = new Promise<Session>((resolve, reject) => {
      sdk.web.init(event => {
        if (event.status !== 'loggedin' || !event.session?.private_store_id) { reject(new Error('Nextgraph did not return a private store.')); return; }
        sdk.orm.initNg(sdk.web.ng, event.session); resolve(event.session);
      }, true, []).catch(reject);
    }).catch(error => { sessionPromise = undefined; throw error; });
  }
  // The pinned web SDK does not deliver a rejection event when wallet consent
  // is denied. Keep its single initialization promise (late consent can still
  // resolve it), but let this UI attempt stop waiting instead of hanging forever.
  return new Promise<Session>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Nextgraph wallet confirmation timed out. Reload this app to retry.')), 120000);
    sessionPromise.then(session => { clearTimeout(timer); resolve(session); }, error => { clearTimeout(timer); reject(error); });
  });
}

interface Snapshot {
  format: 'pondersource-rs-documents';
  version: 1;
  records: { path: string; file: OneDriveRecord }[];
}

/** Experimental native wallet backend. Nextgraph owns local persistence and
 * encrypted replication. rs.js exposes its document view; no broker delivery
 * acknowledgement is inferred from an SDK transaction completing locally.
 */
class NextGraph extends RemoteBase implements Remote {
  folderETagsAreRecursive = false;
  deliveryState: 'local' | 'needs-attention' = 'local';
  requiresReload = false;
  collection: string;
  private session: Session;
  private subscription: DiscreteOrmSubscription<Record<string, unknown>>;
  private documents: Record<string, unknown>;
  private previousRemote: Remote;
  private generation = 0;
  private connecting = false;
  private resume: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rs: RemoteStorage) {
    super(rs); this.online = true; this.storageApi = 'nextgraph-document-ledger-1';
    this.addEvents(['connected', 'not-connected']);
  }

  configure(settings: RemoteSettings): void {
    if (settings.token === null || settings.userAddress === null) {
      this.generation++; this.connected = false;
      if (collectionOwners.get(this.collection) === this) { collectionOwners.delete(this.collection); }
      this.subscription?.close(); this.subscription = undefined; this.documents = undefined;
    }
    if (settings.userAddress === null) { this.session = undefined; this.userAddress = undefined; this.collection = undefined; }
  }

  /** Native wallet consent may navigate/reload the app inside Nextgraph. */
  async connect(): Promise<void> {
    if (this.connecting) { throw new Error('A Nextgraph connection is already in progress.'); }
    this.connecting = true;
    try { await this.open(); } finally { this.connecting = false; }
  }

  private async open(): Promise<void> {
    if (this.requiresReload) { throw new Error('Reload this app to reopen Nextgraph after a local store error.'); }
    if (this.rs.remote.connected) { throw new Error('Disconnect the current storage before connecting Nextgraph.'); }
    const generation = ++this.generation;
    const sdk = await nativeSDK();
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    // Persist only after SDK startup succeeds, so an unsupported optional SDK
    // leaves the guest/current-provider selection unchanged.
    this.rs.setBackend('nextgraph');
    const session = await nativeSession(sdk);
    const ng = sdk.web.ng;
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    const store = 'did:ng:' + session.private_store_id;
    const discover = async (): Promise<string[]> => {
      const found = await ng.sparql_query(session.session_id,
        `SELECT ?id WHERE { GRAPH ?id { ?id a <${COLLECTION}> } }`, undefined, store);
      return [...new Set<string>((found?.results?.bindings || []).map(row => row.id?.value).filter(id => typeof id === 'string'))];
    };
    const ids = await discover();
    if (ids.length > 1) { throw new Error('Multiple remoteStorage collections exist in this Nextgraph store. Select or reconcile them before syncing.'); }
    const collection = ids[0] || await ng.doc_create(session.session_id, 'Automerge', 'data:json', 'store', undefined);
    if (!/^did:ng:[A-Za-z0-9:_-]+$/.test(collection)) { throw new Error('Nextgraph returned an invalid collection identifier.'); }
    if (!ids.length) {
      // Only SDK-returned, validated NURIs enter this query.
      await ng.sparql_update(session.session_id,
        `INSERT DATA { GRAPH <${collection}> { <${collection}> a <${COLLECTION}> } }`, collection);
    }
    // Detect duplicate first connections already visible in the private store.
    // Offline creation on another device can still arrive later: recheck on reconnect.
    if (!ids.length && (await discover()).some(id => id !== collection)) {
      throw new Error('Multiple remoteStorage collections exist in this Nextgraph store. Reconcile them before syncing.');
    }
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    if (failedCollections.has(collection)) {
      this.requiresReload = true;
      throw new Error('Reload this app to reopen Nextgraph after a local store error.');
    }
    if (collectionOwners.has(collection) && collectionOwners.get(collection) !== this) {
      throw new Error('Use one remoteStorage instance per Nextgraph collection in this app.');
    }
    collectionOwners.set(collection, this);
    let subscription: DiscreteOrmSubscription<Record<string, unknown>>;
    let documents: Record<string, unknown>;
    try {
      subscription = sdk.orm.DiscreteOrmSubscription.getOrCreate<Record<string, unknown>>(collection);
      documents = await Promise.race([subscription.readyPromise, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Nextgraph did not open the collection. Reload this app to retry.')), 30000);
        subscription.readyPromise.finally(() => clearTimeout(timer));
      })]);
      readLedger(documents);
      if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    } catch (error) {
      subscription?.close();
      if (collectionOwners.get(collection) === this) { collectionOwners.delete(collection); }
      if (generation === this.generation) { failedCollections.add(collection); this.requiresReload = true; }
      throw error;
    }
    this.session = session; this.subscription = subscription; this.documents = documents;
    this.collection = collection; this.userAddress = store; this.connected = true; this.deliveryState = 'local';
    if (this.rs.remote !== this) {
      this.previousRemote = this.rs.remote; this.rs.remote = this;
      if (!this.rs.local) { this.rs._setGPD(this, this); }
      this.rs._fireReady(); this.rs._emit('connected');
    } else if (this.previousRemote) { this.rs._emit('connected'); }
    else { this._emit('connected'); }
  }

  private records(path: string, mode: 'r' | 'rw' = 'r'): DocumentRevision[] {
    if (!this.connected || !this.documents) { throw new Error('Nextgraph is not connected.'); }
    validateDocumentPath(path);
    if (!this.rs.access.checkPathPermission(path, mode)) { throw new Error('This app has not requested access to that data scope.'); }
    try { return readLedger(this.documents); }
    catch (error) { this.deliveryState = 'needs-attention'; throw error; }
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    const records = this.records(path);
    if (path.endsWith('/')) {
      const items: Record<string, { ETag: string }> = {};
      const revisions: Record<string, string[]> = {};
      for (const file of new Set(records.map(record => record.path))) {
        if (!file.startsWith(path) || !this.rs.access.checkPathPermission(file, 'r')) { continue; }
        const heads = documentHeads(records, file);
        if (heads.length === 1 && heads[0].deleted) { continue; }
        const rest = file.slice(path.length), slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash + 1);
        (revisions[name] ||= []).push(...heads.map(record => record.id));
      }
      for (const [name, ids] of Object.entries(revisions)) { items[name] = { ETag: ids.sort().join(',') }; }
      return { statusCode: path !== '/' && !Object.keys(items).length ? 404 : 200,
        contentType: 'application/ld+json', body: { '@context': 'http://remotestorage.io/spec/folder-description', items } };
    }
    const heads = documentHeads(records, path);
    if (heads.length > 1) { this.deliveryState = 'needs-attention'; return { statusCode: 409, body: { conflictRevisions: heads.map(record => record.id) } }; }
    const current = heads[0];
    if (!current || current.deleted) { return { statusCode: 404 }; }
    if (options.ifMatch && options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== current.id) { return { statusCode: 412 }; }
    if (options.ifNoneMatch && (options.ifNoneMatch === '*' || this.stripQuotes(options.ifNoneMatch) === current.id)) { return { statusCode: 304, revision: current.id }; }
    try { return { statusCode: 200, revision: current.id, ...decodeRecord(current.file) }; }
    catch (error) { this.deliveryState = 'needs-attention'; throw error; }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.queue.then(() => {
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      return work();
    });
    this.queue = result.catch(() => undefined); return result;
  }

  private async commit(record: DocumentRevision): Promise<void> {
    const generation = this.generation;
    this.subscription.beginTransaction();
    this.documents['rs_revision_' + record.id] = JSON.stringify(record);
    try {
      await this.subscription.commitTransaction();
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      this.deliveryState = this.listConflicts().length ? 'needs-attention' : 'local';
    } catch (error) {
      // A failed SDK call may have committed locally. Re-open the engine view
      // before another operation; never expose its unacknowledged signal object.
      failedCollections.add(this.collection); this.requiresReload = true;
      this.configure({ token: null }); this.deliveryState = 'needs-attention';
      throw error;
    }
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (options.ifNoneMatch && options.ifNoneMatch !== '*') { throw new Error('Nextgraph writes support only If-None-Match: *.'); }
    const generation = this.generation;
    const file = JSON.parse(await encodeRecord(body, contentType)) as OneDriveRecord;
    if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
    return this.exclusive(async () => {
      const heads = documentHeads(this.records(path, 'rw'), path);
      if (heads.length > 1) { this.deliveryState = 'needs-attention'; return { statusCode: 409 }; }
      const current = heads[0], exists = current && !current.deleted;
      if (options.ifNoneMatch === '*' && exists || options.ifMatch && (!exists || options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== current.id)) { return { statusCode: 412 }; }
      const record = documentRevision(path, heads, file);
      await this.commit(record);
      return { statusCode: exists ? 200 : 201, revision: record.id };
    });
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    return this.exclusive(async () => {
      const heads = documentHeads(this.records(path, 'rw'), path);
      if (heads.length > 1) { this.deliveryState = 'needs-attention'; return { statusCode: 409 }; }
      const current = heads[0];
      if (!current || current.deleted) { return { statusCode: 404 }; }
      if (options.ifMatch && options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== current.id) { return { statusCode: 412 }; }
      const record = documentRevision(path, heads); await this.commit(record);
      return { statusCode: 204, revision: record.id };
    });
  }

  /** Both candidates remain durable until an explicit application decision. */
  getConflicts(path: string): DocumentRevision[] { return documentHeads(this.records(path), path); }

  listConflicts(): { path: string; revisions: DocumentRevision[] }[] {
    if (!this.connected || !this.documents) { throw new Error('Nextgraph is not connected.'); }
    const records = readLedger(this.documents);
    return [...new Set(records.map(record => record.path))]
      .filter(path => this.rs.access.checkPathPermission(path, 'r'))
      .map(path => ({path, revisions: documentHeads(records, path)}))
      .filter(item => item.revisions.length > 1);
  }

  async resolveConflict(path: string, chosenRevision: string, expectedHeads?: string[]): Promise<void> {
    return this.exclusive(async () => {
      const heads = documentHeads(this.records(path, 'rw'), path);
      if (expectedHeads && heads.map(record => record.id).sort().join(',') !== [...expectedHeads].sort().join(',')) {
        throw new Error('Conflict versions changed. Review them again before choosing.');
      }
      const chosen = heads.find(record => record.id === chosenRevision);
      if (!chosen) { throw new Error('The selected revision is no longer a conflict candidate.'); }
      await this.commit(documentRevision(path, heads, chosen.deleted ? undefined : chosen.file));
    });
  }

  /** Explicit export of this app's local cache only; it never fetches other accounts. */
  async exportSnapshot(): Promise<Snapshot> {
    if (!this.rs.local || this.rs.remote.connected) { throw new Error('Export guest data before connecting storage.'); }
    const snapshot: Snapshot = { format: 'pondersource-rs-documents', version: 1, records: [] };
    const visited = new Set<string>();
    const walk = async (path: string): Promise<void> => {
      validateDocumentPath(path);
      if (visited.has(path)) { return; }
      visited.add(path);
      const value = await this.rs.local.get(path, undefined, async () => { throw new Error('Guest export cannot fetch remote data.'); });
      if (value.statusCode === 404) { return; }
      if (value.statusCode !== 200) { throw new Error('Could not read local document: ' + path); }
      if (path.endsWith('/')) {
        for (const key of Object.keys(value.body || {})) {
          if (!key || key.replace(/\/$/, '').includes('/')) { throw new Error('Invalid local folder entry.'); }
          await walk(path + key);
        }
      } else {
        if (!this.rs.access.checkPathPermission(path, 'r')) { throw new Error('Scope not requested: ' + path); }
        const body = typeof value.body === 'object' && !(value.body instanceof ArrayBuffer) && !ArrayBuffer.isView(value.body)
          ? JSON.stringify(value.body) : value.body;
        const file = JSON.parse(await encodeRecord(body as XMLHttpRequestBodyInit, value.contentType)) as OneDriveRecord;
        snapshot.records.push({ path, file });
        if (snapshot.records.length > 10000) { throw new Error('Export exceeds 10000 documents.'); }
      }
    };
    for (const path of this.rs.access.rootPaths) { await walk(path); }
    return snapshot;
  }

  /** Explicit first import. Existing documents are refused and source files stay intact. */
  async importSnapshot(snapshot: Snapshot): Promise<{ path: string; statusCode: number }[]> {
    if (snapshot?.format !== 'pondersource-rs-documents' || snapshot.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > 10000) {
      throw new Error('Unsupported remoteStorage snapshot.');
    }
    // Validate the whole snapshot before writing any of it.
    const seen = new Set<string>();
    for (const record of snapshot.records) {
      this.records(record.path, 'rw'); decodeRecord(record.file);
      if (record.path.endsWith('/') || seen.has(record.path)) { throw new Error('Duplicate or folder snapshot path.'); }
      seen.add(record.path);
    }
    const results = [];
    for (const record of snapshot.records) {
      const value = decodeRecord(record.file);
      const body = new Uint8Array(unbase64url(record.file.data)).buffer;
      const result = await this.put(record.path, body, value.contentType, { ifNoneMatch: '*' });
      results.push({ path: record.path, statusCode: result.statusCode });
    }
    return results;
  }

  async getItemURL(): Promise<undefined> { return undefined; }

  static _rs_supported(): boolean { return typeof window !== 'undefined' && typeof MessageChannel !== 'undefined'; }
  static _rs_init(rs: RemoteStorage): void {
    rs.nextgraph = new NextGraph(rs);
    if (rs.backend === 'nextgraph') {
      rs.nextgraph.previousRemote = rs.remote; rs.remote = rs.nextgraph;
      if (window.self !== window.top) {
        rs.nextgraph.resume = () => rs.nextgraph.connect().catch(error => rs._emit('error', error));
        rs.on('features-loaded', rs.nextgraph.resume);
      }
    }
  }
  static _rs_cleanup(rs: RemoteStorage): void {
    const backend = rs.nextgraph;
    if (!backend) { return; }
    if (backend.resume) { rs.removeEventListener('features-loaded', backend.resume); }
    backend.configure({ userAddress: null, token: null });
    if (rs.remote === backend && backend.previousRemote) { rs.remote = backend.previousRemote; }
    delete rs.nextgraph;
  }
}

export = NextGraph;
