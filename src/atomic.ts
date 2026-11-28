import { atomicClient, atomicDrive, atomicOrigin, AtomicGrantPending, type AtomicConnection, type AtomicSDK } from './atomic-client';
import { documentHeads, documentRevision, validateDocumentPath, type DocumentRevision } from './document-ledger';
import { decodeRecord, encodeRecord, type OneDriveRecord } from './onedrive-format';
import { RemoteBase, type Remote, type RemoteResponse, type RemoteSettings } from './remote';
import type RemoteStorage from './remotestorage';

const databaseName = 'remotestorage-atomic-v1';
const hostedApproval = 'https://atomic.place';
const hostedNode = 'https://node1.atomicserver.eu';
const storageKey = 'connection';

async function connectionRecord(mode: IDBTransactionMode, operation: (records: IDBObjectStore) => IDBRequest): Promise<AtomicConnection | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(databaseName, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('atomic');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      try {
        const transaction = db.transaction('atomic', mode);
        const request = operation(transaction.objectStore('atomic'));
        transaction.oncomplete = () => { db.close(); resolve(request.result); };
        transaction.onabort = () => { db.close(); reject(transaction.error || request.error); };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

function wait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Use immutable, app-scoped Atomic document revisions with the signed-in user's approved app key. */
class Atomic extends RemoteBase implements Remote {
  /** Configure with an application-local, version-pinned SDK loader before creating RemoteStorage. */
  static loadSDK?: () => Promise<AtomicSDK>;

  readonly supportsAtomicCreate = false;
  readonly folderETagsAreRecursive = false;
  private connection?: AtomicConnection;
  private client?: Awaited<ReturnType<typeof atomicClient>>;
  private previousRemote?: Remote;
  private attempt?: AbortController;
  private lifetime?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(rs: RemoteStorage) {
    super(rs);
    this.online = true;
    this.storageApi = 'atomic-application-key-v1';
    this.addEvents(['connected', 'not-connected']);
  }

  getStorageIdentity(): string {
    return JSON.stringify([this.connection?.drive || '', window.location.host]);
  }

  configure(settings: RemoteSettings): void {
    if (settings.userAddress === null || settings.token === null) {
      this.attempt?.abort();
      this.lifetime?.abort();
      this.connection = undefined;
      this.client = undefined;
      this.userAddress = undefined;
      this.connected = false;
    }
  }

  /** Return the approval link without exposing the app-owned private key. */
  async requestAppKey(server: string, options: { drive: string; signal: AbortSignal }) {
    if (this.rs.remote.connected) { throw new Error('Disconnect the current storage first.'); }
    if (this.attempt) { throw new Error('An Atomic connection is already in progress.'); }
    const origin = atomicOrigin(server);
    const drive = atomicDrive(options.drive);
    const sdk = await Atomic.loadSDK();
    options.signal.throwIfAborted();
    const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
    const publicKey = await sdk.Agent.fromCryptoKeyPair(keyPair).getPublicKey();
    const agent = sdk.agentSubjectFromPublicKey(publicKey).subject;
    const node = origin === hostedApproval || origin === 'https://app.atomic.place' ? hostedNode : origin;
    const connection = { drive, node, keyPair, agent };
    const approval = origin === hostedApproval ? 'https://app.atomic.place' : origin;
    const grantUrl = sdk.connectAgentUrl(approval, { publicKey, name: window.location.host, write: true, targets: [drive] });
    return { publicKey, grantUrl, waitForGrant: () => this.completeConnection(sdk, connection, options.signal) };
  }

  private async completeConnection(sdk: AtomicSDK, connection: AtomicConnection, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.attempt || this.rs.remote.connected) { throw new Error('A storage connection is already open.'); }
    const attempt = new AbortController();
    this.attempt = attempt;
    const abort = () => attempt.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => attempt.abort(new Error('Atomic approval timed out. Please try again.')), 15 * 60 * 1000);
    try {
      const client = await atomicClient(sdk, connection, window.location.host, attempt.signal);
      for (;;) {
        attempt.signal.throwIfAborted();
        try {
          await client.grant();
          break;
        } catch (error) {
          if (!(error instanceof AtomicGrantPending)) { throw error; }
          await wait(attempt.signal);
        }
      }
      attempt.signal.throwIfAborted();
      if (this.rs.remote.connected) { throw new Error('Disconnect the current storage first.'); }
      await connectionRecord('readwrite', records => records.put(connection, storageKey));
      if (attempt.signal.aborted || this.rs.remote.connected) {
        await connectionRecord('readwrite', records => records.delete(storageKey));
        attempt.signal.throwIfAborted();
        throw new Error('Disconnect the current storage first.');
      }
      this.activate(connection, client, attempt);
    } finally {
      signal.removeEventListener('abort', abort);
      clearTimeout(deadline);
      this.attempt = undefined;
    }
  }

  private activate(connection: AtomicConnection, client: Awaited<ReturnType<typeof atomicClient>>, lifetime: AbortController) {
    this.connection = connection;
    this.client = client;
    this.lifetime = lifetime;
    this.userAddress = connection.drive;
    this.connected = true;
    this.rs.setBackend('atomic');
    if (this.rs.remote !== this) {
      this.previousRemote = this.rs.remote;
      this.rs.remote = this;
      if (!this.rs.local) { this.rs._setGPD(this, this); }
      this.rs._fireReady();
      this.rs._emit('connected');
    } else {
      this._emit('connected');
    }
  }

  private async restore(): Promise<void> {
    const lifetime = new AbortController();
    this.attempt = lifetime;
    try {
      const connection = await connectionRecord('readonly', records => records.get(storageKey));
      if (!connection) { return; }
      const sdk = await Atomic.loadSDK();
      const client = await atomicClient(sdk, connection, window.location.host, lifetime.signal);
      lifetime.signal.throwIfAborted();
      // Restore the previously approved identity even while offline. Every
      // storage operation revalidates the grant with a signed request.
      if (!this.rs.remote.connected) { this.activate(connection, client, lifetime); }
    } catch (error) {
      if (!lifetime.signal.aborted) { this.rs._emit('error', error); }
    } finally {
      this.attempt = undefined;
    }
  }

  private check(path: string, mode: 'r' | 'rw'): Awaited<ReturnType<typeof atomicClient>> {
    validateDocumentPath(path);
    if (!this.connected || !this.client) { throw new Error('Atomic is not connected.'); }
    if (path !== '/' && !this.rs.access.checkPathPermission(path, mode)) {
      throw new Error('This app has no access to ' + path);
    }
    return this.client;
  }

  private list(records: DocumentRevision[], path: string): RemoteResponse {
    const entries = new Map<string, string[]>();
    for (const file of new Set(records.map(record => record.path))) {
      if (!file.startsWith(path) || !this.rs.access.checkPathPermission(file, 'r')) { continue; }
      const heads = documentHeads(records, file);
      if (heads.length === 1 && heads[0].deleted) { continue; }
      const tail = file.slice(path.length);
      const slash = tail.indexOf('/');
      const name = slash === -1 ? tail : tail.slice(0, slash + 1);
      const revisions = entries.get(name) || [];
      revisions.push(...heads.map(record => record.id));
      entries.set(name, revisions);
    }
    const items = Object.fromEntries([...entries].map(([name, revisions]) => [name, { ETag: revisions.sort().join(',') }]));
    return { statusCode: path !== '/' && !entries.size ? 404 : 200, contentType: 'application/ld+json',
      body: { '@context': 'http://remotestorage.io/spec/folder-description', items } };
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    const records = await this.check(path, 'r').readRevisions();
    if (path.endsWith('/')) { return this.list(records, path); }
    const heads = documentHeads(records, path);
    if (heads.length > 1) { return this.conflict(heads); }
    const head = heads[0];
    if (!head || head.deleted) { return { statusCode: options.ifMatch ? 412 : 404 }; }
    if (options.ifMatch && options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== head.id) { return { statusCode: 412 }; }
    if (options.ifNoneMatch && (options.ifNoneMatch === '*' || this.stripQuotes(options.ifNoneMatch) === head.id)) {
      return { statusCode: 304, revision: head.id };
    }
    return { statusCode: 200, revision: head.id, ...decodeRecord(head.file) };
  }

  private conflict(heads: DocumentRevision[]): RemoteResponse {
    return { statusCode: 409, body: { conflictRevisions: heads.map(record => record.id) } };
  }

  private write(path: string, file: OneDriveRecord | undefined, options: { ifMatch?: string; ifNoneMatch?: string }): Promise<RemoteResponse> {
    if (path.endsWith('/')) { return Promise.reject(new Error('Atomic writes need a document path.')); }
    if (path.startsWith('/public/')) { return Promise.reject(new Error('Public sharing is unavailable in this Atomic storage adapter.')); }
    const client = this.check(path, 'rw');
    const request = this.queue.then(async () => {
      const heads = documentHeads(await client.readRevisions(), path);
      if (heads.length > 1) { return this.conflict(heads); }
      const head = heads[0];
      const exists = head && !head.deleted;
      if (options.ifNoneMatch && exists &&
          (options.ifNoneMatch === '*' || this.stripQuotes(options.ifNoneMatch) === head.id) ||
          options.ifMatch && (!exists || options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== head.id)) {
        return { statusCode: 412 };
      }
      if (!file && !exists) { return { statusCode: 404 }; }
      const revision = documentRevision(path, heads, file);
      await client.append(revision);
      return { statusCode: file ? exists ? 200 : 201 : 204, revision: revision.id };
    });
    this.queue = request.catch(() => undefined);
    return request;
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    const file = JSON.parse(await encodeRecord(body, contentType)) as OneDriveRecord;
    return this.write(path, file, options);
  }

  delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    return this.write(path, undefined, options);
  }

  async getItemURL(): Promise<undefined> { return undefined; }

  static _rs_supported(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && !!window.crypto?.subtle && !!Atomic.loadSDK;
  }

  static _rs_init(rs: RemoteStorage): void {
    const atomic = rs.atomic = new Atomic(rs);
    if (rs.backend === 'atomic') {
      atomic.previousRemote = rs.remote;
      rs.remote = atomic;
      rs.on('features-loaded', atomic.restoreSession);
    }
  }

  private restoreSession = () => this.restore();

  static async _rs_cleanup(rs: RemoteStorage): Promise<void> {
    const atomic = rs.atomic;
    if (!atomic) { return; }
    atomic.configure({ userAddress: null, token: null });
    rs.removeEventListener('features-loaded', atomic.restoreSession);
    if (rs.remote === atomic && atomic.previousRemote) { rs.remote = atomic.previousRemote; }
    delete rs.atomic;
    if (rs.backend === 'atomic') {
      rs.setBackend(undefined);
      try {
        await connectionRecord('readwrite', records => records.delete(storageKey));
      } catch (error) { rs._emit('error', error); }
    }
  }
}

export = Atomic;
