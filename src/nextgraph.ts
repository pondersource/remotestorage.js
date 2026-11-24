import type { Session } from '@ng-org/web';
import type { DiscreteOrmSubscription } from '@ng-org/orm';
import { RemoteBase, type Remote, type RemoteResponse, type RemoteSettings } from './remote';
import type RemoteStorage from './remotestorage';
import { decodeRecord, encodeRecord, unbase64url, type OneDriveRecord } from './onedrive-format';
import { readLedger, documentHeads, documentRevision, validateDocumentPath, type DocumentRevision } from './document-ledger';
import { NextGraphJournal, mergeJournalRecords } from './nextgraph-journal';
import { DEFAULT_WALLET_URL, normalizeWalletURL, requestedWalletURL, rememberWalletURL, rememberedWalletURL, forgetWalletHandoff } from './nextgraph-wallet';

const COLLECTION = 'https://pondersource.com/ns/remotestorage/DocumentLedgerV1';
interface NativeSDK {
  web: typeof import('@ng-org/web');
  orm: typeof import('@ng-org/orm');
}
let sdkPromise: Promise<NativeSDK>;
let sessionPromise: Promise<Session>;
let sessionWalletURL: string;

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
function nativeSession(sdk: NativeSDK, walletURL: string): Promise<Session> {
  if (sessionPromise && sessionWalletURL !== walletURL) {
    return Promise.reject(new Error('Reload this app before changing Nextgraph wallet servers.'));
  }
  if (!sessionPromise) {
    sessionWalletURL = walletURL;
    sessionPromise = new Promise<Session>((resolve, reject) => {
      // The audited build patch adds an optional origin to the pinned SDK's init.
      const init = sdk.web.init as (callback: Parameters<NativeSDK['web']['init']>[0], singleton: boolean, requests: [], origin: string) => Promise<void>;
      init(event => {
        if (event.status !== 'loggedin' || !event.session?.private_store_id) { reject(new Error('Nextgraph did not return a private store.')); return; }
        sdk.orm.initNg(sdk.web.ng, event.session); resolve(event.session);
      }, true, [], walletURL).catch(reject);
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

interface RecoverySnapshot {
  format: 'pondersource-nextgraph-revisions';
  version: 1;
  store: string;
  collection: string;
  records: DocumentRevision[];
}

interface CacheRecoveryCandidate {
  path: string;
  source: string;
  revision?: string;
  deleted: boolean;
  bodyUnavailable?: boolean;
  file?: OneDriveRecord;
}

/** Experimental native wallet backend. An append-only IndexedDB journal owns
 * durable local recovery; the native SDK owns encrypted replication. Neither
 * local journal completion nor SDK completion acknowledges broker delivery.
 */
class NextGraph extends RemoteBase implements Remote {
  private walletURL = requestedWalletURL() || rememberedWalletURL() || DEFAULT_WALLET_URL;

  /** Wallet frontend origin; not the address of a broker or a private store. */
  getWalletURL(): string { return this.walletURL; }

  readonly supportsAtomicCreate = false;
  getStorageIdentity(): string { return JSON.stringify([this.session?.private_store_id || '', this.collection || '']); }
  folderETagsAreRecursive = false;
  deliveryState: 'local' | 'needs-attention' = 'local';
  requiresReload = false;
  collection: string;
  private session: Session;
  private subscription: DiscreteOrmSubscription<Record<string, unknown>>;
  private documents: Record<string, unknown>;
  private journal: NextGraphJournal;
  private archived: DocumentRevision[] = [];
  private previousRemote: Remote;
  private generation = 0;
  private connecting = false;
  private resume: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private coordinatedSelection = false;
  private resuming: Promise<boolean>;
  private nextResume = 0;
  private networkResume = (): void => this.tryResume();

  constructor(rs: RemoteStorage) {
    super(rs); this.online = true; this.storageApi = 'nextgraph-document-ledger-1';
    this.addEvents(['connected', 'not-connected']);
    if (typeof window !== 'undefined') { window.addEventListener('online', this.networkResume); }
  }

  configure(settings: RemoteSettings): void {
    if (settings.token === null || settings.userAddress === null) {
      this.generation++; this.connected = false;
      if (collectionOwners.get(this.getStorageIdentity()) === this) { collectionOwners.delete(this.getStorageIdentity()); }
      this.subscription?.close(); this.subscription = undefined; this.documents = undefined;
    }
    if (settings.userAddress === null) {
      forgetWalletHandoff();
      this.session = undefined; this.userAddress = undefined; this.collection = undefined;
      this.journal = undefined; this.archived = [];
    }
  }

  /** Native wallet consent may navigate/reload the app inside Nextgraph. */
  async connect(walletURL = this.walletURL): Promise<void> {
    if (this.connecting) { throw new Error('A Nextgraph connection is already in progress.'); }
    const origin = normalizeWalletURL(walletURL);
    if (sessionPromise && sessionWalletURL !== origin) { throw new Error('Reload this app before changing Nextgraph wallet servers.'); }
    this.walletURL = origin;
    this.connecting = true;
    const generation = this.generation;
    try {
      const sdk = await nativeSDK();
      if (sessionPromise && sessionWalletURL !== origin) { throw new Error('Reload this app before changing Nextgraph wallet servers.'); }
      rememberWalletURL(origin);
      this.rs.setBackend('nextgraph');
      const session = await nativeSession(sdk, origin);
      const select = async (): Promise<void> => {
        if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
        await this.open();
      };
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request('remotestorage:nextgraph-collection:' + session.private_store_id, async () => {
          this.coordinatedSelection = true;
          try { await select(); } finally { this.coordinatedSelection = false; }
        });
      } else { await select(); }
    } finally { this.connecting = false; }
  }

  private async guardUnassignedCache(native: DocumentRevision[] = []): Promise<void> {
    if (typeof this.rs.local?.forAllNodes !== 'function') {
      if (typeof this.rs.local?.get !== 'function' || !(await this.exportSnapshot()).records.length) { return; }
    } else {
      const recovery = await this.exportCacheRecovery();
      const byId = new Map(native.map(record => [record.id, record]));
      if (recovery.candidates.every(candidate => {
        const record = byId.get(candidate.revision);
        return record && record.path === candidate.path && record.deleted === candidate.deleted &&
          (candidate.bodyUnavailable || candidate.deleted || record.file?.version === candidate.file?.version &&
            record.file?.contentType === candidate.file?.contentType && record.file?.data === candidate.file?.data);
      })) { return; }
    }
    throw new Error('Existing cached documents need explicit recovery before a Nextgraph collection can be selected. Export guest data and keep that file; no cached candidate was removed.');
  }

  private async open(): Promise<void> {
    if (this.rs.remote.connected) { throw new Error('Disconnect the current storage before connecting Nextgraph.'); }
    const generation = ++this.generation;
    const sdk = await nativeSDK();
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    // Persist only after SDK startup succeeds, so an unsupported optional SDK
    // leaves the guest/current-provider selection unchanged.
    this.rs.setBackend('nextgraph');
    const session = await nativeSession(sdk, this.walletURL);
    const ng = sdk.web.ng;
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    const store = 'did:ng:' + session.private_store_id;
    const discover = async (): Promise<string[]> => {
      const found = await ng.sparql_query(session.session_id,
        `SELECT ?id WHERE { GRAPH ?id { ?id a <${COLLECTION}> } }`, undefined, store);
      return [...new Set<string>((found?.results?.bindings || []).map(row => row.id?.value).filter(id => typeof id === 'string'))];
    };
    const known = await NextGraphJournal.collections(session.private_store_id);
    let ids: string[] = [];
    let unavailable = false;
    try { ids = await discover(); }
    catch (error) {
      if (!known.length) { await this.guardUnassignedCache(); throw error; }
      unavailable = true;
    }
    const candidates = [...new Set([...known, ...ids])];
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    if (candidates.length > 1) { throw new Error('Multiple remoteStorage collections exist in this Nextgraph store. Select or reconcile them before syncing.'); }
    if (!candidates.length) {
      await this.guardUnassignedCache();
      if (!this.coordinatedSelection) { throw new Error('This browser needs Web Locks to safely create a first Nextgraph collection.'); }
      // An empty/missing offline view is not evidence that a remote collection
      // does not exist. Require a native connection before first creation.
      const connections = await ng.user_connect(await ng.client_info(), String(session.user), typeof location === 'undefined' ? undefined : location.href);
      if (!Object.values(connections || {}).some((connection: { error?: string }) => !connection.error || connection.error === 'PeerAlreadyConnected')) {
        throw new Error('Go online to discover or create your first Nextgraph collection.');
      }
      ids = await discover();
      if (ids.length > 1) { throw new Error('Multiple remoteStorage collections exist in this Nextgraph store.'); }
    }
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    const collection = candidates[0] || ids[0] || await ng.doc_create(session.session_id, 'Automerge', 'data:json', 'store', undefined);
    if (!/^did:ng:[A-Za-z0-9:_-]+$/.test(collection)) { throw new Error('Nextgraph returned an invalid collection identifier.'); }
    const created = !candidates.length && !ids.length;
    if (created) {
      // Only SDK-returned, validated NURIs enter this query.
      await ng.sparql_update(session.session_id,
        `INSERT DATA { GRAPH <${collection}> { <${collection}> a <${COLLECTION}> } }`, collection);
    }
    // Detect duplicate first connections already visible in the private store.
    // Offline creation on another device can still arrive later: recheck on reconnect.
    if (created && (await discover()).some(id => id !== collection)) {
      throw new Error('Multiple remoteStorage collections exist in this Nextgraph store. Reconcile them before syncing.');
    }
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    const owner = JSON.stringify([session.private_store_id, collection]);
    if (collectionOwners.has(owner) && collectionOwners.get(owner) !== this) {
      throw new Error('Use one remoteStorage instance per Nextgraph collection in this app.');
    }
    this.session = session; this.collection = collection; this.userAddress = store;
    this.journal = new NextGraphJournal(session.private_store_id, collection);
    this.archived = (await this.journal.transact([], () => ({ value: undefined }), false)).records;
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    collectionOwners.set(owner, this);
    let subscription: DiscreteOrmSubscription<Record<string, unknown>>;
    let documents: Record<string, unknown>;
    try {
      if (!unavailable && (ids.includes(collection) || created) && !failedCollections.has(owner)) {
        subscription = sdk.orm.DiscreteOrmSubscription.getOrCreate<Record<string, unknown>>(collection);
        documents = await Promise.race([subscription.readyPromise, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Nextgraph did not open the collection. Reload this app to retry.')), 30000);
          subscription.readyPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        })]);
        // Persist only a completely validated union; corrupt native data never
        // overwrites or poisons the prior valid recovery archive.
        const native = readLedger(documents);
        if (!known.length) { await this.guardUnassignedCache(native); }
        this.archived = (await this.journal.transact(native, () => ({ value: undefined }))).records;
      }
      if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    } catch (error) {
      subscription?.close();
      // A corrupt view must fail explicitly. Only an unavailable native graph
      // with a known archive may fall back to durable local recovery.
      if (documents || !known.includes(collection) || generation !== this.generation) {
        if (collectionOwners.get(owner) === this) { collectionOwners.delete(owner); }
        throw error;
      }
      failedCollections.add(owner); this.requiresReload = true;
    }
    this.subscription = documents ? subscription : undefined; this.documents = documents;
    this.connected = true; this.deliveryState = documents ? 'local' : 'needs-attention';
    if (documents) { await this.publish(this.archived); }
    if (generation !== this.generation) { throw new Error('Nextgraph connection was cancelled.'); }
    if (this.rs.remote !== this) {
      this.previousRemote = this.rs.remote; this.rs.remote = this;
      if (!this.rs.local) { this.rs._setGPD(this, this); }
      this.rs._fireReady(); this.rs._emit('connected');
    } else if (this.previousRemote) { this.rs._emit('connected'); }
    else { this._emit('connected'); }
  }

  private records(path: string, mode: 'r' | 'rw' = 'r'): DocumentRevision[] {
    if (!this.connected || !this.journal) { throw new Error('Nextgraph is not connected.'); }
    validateDocumentPath(path);
    if (!this.rs.access.checkPathPermission(path, mode)) { throw new Error('This app has not requested access to that data scope.'); }
    return this.archived;
  }

  private nativeRecords(): DocumentRevision[] {
    try { return this.documents ? readLedger(this.documents) : []; }
    catch (error) { this.deliveryState = 'needs-attention'; throw error; }
  }

  private async refresh(): Promise<void> {
    if (!this.connected || !this.journal) { throw new Error('Nextgraph is not connected.'); }
    this.tryResume();
    const generation = this.generation, journal = this.journal;
    const result = await journal.transact(this.nativeRecords(), () => ({ value: undefined }));
    if (generation !== this.generation || journal !== this.journal) { throw new Error('Nextgraph request was cancelled.'); }
    this.archived = result.records;
  }

  private tryResume(): void {
    if (!this.connected || this.documents || this.requiresReload || Date.now() < this.nextResume) { return; }
    this.nextResume = Date.now() + 2000;
    this.resumeNative().catch(error => { this.deliveryState = 'needs-attention'; this.rs._emit('error', error); });
  }

  /** Reopen the same native collection when the SDK's graph becomes available.
   * Journal replay uses the original IDs and only the SDK's own write API.
   * No new collection, direct broker queue or delivery acknowledgement is made.
   */
  async resumeNative(): Promise<boolean> {
    if (!this.connected || !this.journal || this.requiresReload) { return false; }
    if (this.documents) { return true; }
    if (this.resuming) { return this.resuming; }
    const generation = this.generation, journal = this.journal, session = this.session;
    const attempt = (async (): Promise<boolean> => {
      const sdk = await nativeSDK();
      let found;
      try {
        found = await sdk.web.ng.sparql_query(session.session_id,
          `SELECT ?id WHERE { GRAPH ?id { ?id a <${COLLECTION}> } }`, undefined, 'did:ng:' + session.private_store_id);
      } catch { return false; }
      const ids = [...new Set<string>((found?.results?.bindings || []).map(row => row.id?.value).filter(id => typeof id === 'string'))];
      if ([...new Set([...ids, ...await NextGraphJournal.collections(session.private_store_id)])].length > 1) {
        throw new Error('Multiple Nextgraph collections need reconciliation before native replay.');
      }
      if (!ids.includes(journal.collection) || generation !== this.generation) { return false; }
      const subscription = sdk.orm.DiscreteOrmSubscription.getOrCreate<Record<string, unknown>>(journal.collection);
      try {
        const documents = await Promise.race([subscription.readyPromise, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Reload to reopen the native Nextgraph view. Your recovery archive is retained.')), 30000);
          subscription.readyPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        })]);
        const merged = await journal.transact(readLedger(documents), () => ({ value: undefined }));
        if (generation !== this.generation || journal !== this.journal) { subscription.close(); return false; }
        this.archived = merged.records; this.documents = documents; this.subscription = subscription;
        await this.exclusive(() => this.publish(this.archived));
        return generation === this.generation && Boolean(this.documents);
      } catch (error) {
        subscription.close();
        if (generation === this.generation) { failedCollections.add(this.getStorageIdentity()); this.requiresReload = true; }
        throw error;
      }
    })();
    this.resuming = attempt;
    attempt.finally(() => { if (this.resuming === attempt) { this.resuming = undefined; } }).catch(() => undefined);
    return attempt;
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    await this.refresh();
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
    this.queue = result.catch(() => { this.deliveryState = 'needs-attention'; }); return result;
  }

  private async publish(records: DocumentRevision[]): Promise<void> {
    if (!this.subscription || !this.documents) { this.deliveryState = 'needs-attention'; return; }
    const generation = this.generation;
    const subscription = this.subscription, documents = this.documents, identity = this.getStorageIdentity();
    try {
      mergeJournalRecords(this.nativeRecords(), records);
      const pending = records.filter(record => !Object.prototype.hasOwnProperty.call(documents, 'rs_revision_' + record.id));
      if (!pending.length) { return; }
      subscription.beginTransaction();
      for (const record of pending) { documents['rs_revision_' + record.id] = JSON.stringify(record); }
      await subscription.commitTransaction();
      if (generation !== this.generation) { return; }
      this.deliveryState = this.listConflicts().length ? 'needs-attention' : 'local';
    } catch (error) {
      if (generation !== this.generation) { return; }
      // The journal already committed. Keep local readback/recovery available;
      // native failure cannot discard its immutable candidates or prove delivery.
      failedCollections.add(identity); this.requiresReload = true;
      subscription.close(); this.subscription = undefined; this.documents = undefined;
      this.deliveryState = 'needs-attention';
      this.rs._emit('error', error);
    }
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (options.ifNoneMatch && options.ifNoneMatch !== '*') { throw new Error('Nextgraph writes support only If-None-Match: *.'); }
    const generation = this.generation;
    const file = JSON.parse(await encodeRecord(body, contentType)) as OneDriveRecord;
    if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
    return this.exclusive(async () => {
      this.tryResume();
      this.records(path, 'rw');
      const result = await this.journal.transact<RemoteResponse>(this.nativeRecords(), records => {
        const heads = documentHeads(records, path);
        if (heads.length > 1) { this.deliveryState = 'needs-attention'; return { value: { statusCode: 409 } }; }
        const current = heads[0], exists = current && !current.deleted;
        if (options.ifNoneMatch === '*' && exists || options.ifMatch && (!exists || options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== current.id)) { return { value: { statusCode: 412 } }; }
        const record = documentRevision(path, heads, file);
        return { value: { statusCode: exists ? 200 : 201, revision: record.id }, append: [record] };
      });
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      this.archived = result.records;
      await this.publish(result.records);
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      return result.value;
    });
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    const generation = this.generation;
    return this.exclusive(async () => {
      this.records(path, 'rw');
      const result = await this.journal.transact<RemoteResponse>(this.nativeRecords(), records => {
        const heads = documentHeads(records, path);
        if (heads.length > 1) { this.deliveryState = 'needs-attention'; return { value: { statusCode: 409 } }; }
        const current = heads[0];
        if (!current || current.deleted) { return { value: { statusCode: 404 } }; }
        if (options.ifMatch && options.ifMatch !== '*' && this.stripQuotes(options.ifMatch) !== current.id) { return { value: { statusCode: 412 } }; }
        const record = documentRevision(path, heads);
        return { value: { statusCode: 204, revision: record.id }, append: [record] };
      });
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      this.archived = result.records;
      await this.publish(result.records);
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      return result.value;
    });
  }

  /** Both candidates remain durable until an explicit application decision. */
  getConflicts(path: string): DocumentRevision[] {
    return documentHeads(mergeJournalRecords(this.records(path), this.nativeRecords()), path);
  }

  listConflicts(): { path: string; revisions: DocumentRevision[] }[] {
    if (!this.connected || !this.journal) { throw new Error('Nextgraph is not connected.'); }
    // The synchronous UI must see newly received native heads before its next
    // async read. Persistence and conflict decisions still await the journal.
    const records = mergeJournalRecords(this.archived, this.nativeRecords());
    return [...new Set(records.map(record => record.path))]
      .filter(path => this.rs.access.checkPathPermission(path, 'r'))
      .map(path => ({path, revisions: documentHeads(records, path)}))
      .filter(item => item.revisions.length > 1);
  }

  async resolveConflict(path: string, chosenRevision: string, expectedHeads?: string[]): Promise<void> {
    const generation = this.generation;
    this.records(path, 'rw');
    const reviewed = expectedHeads || this.getConflicts(path).map(record => record.id);
    return this.exclusive(async () => {
      this.records(path, 'rw');
      const result = await this.journal.transact(this.nativeRecords(), records => {
        const heads = documentHeads(records, path);
        if (heads.map(record => record.id).sort().join(',') !== [...reviewed].sort().join(',')) {
          throw new Error('Conflict versions changed. Review them again before choosing.');
        }
        const chosen = heads.find(record => record.id === chosenRevision);
        if (!chosen) { throw new Error('The selected revision is no longer a conflict candidate.'); }
        return { value: undefined, append: [documentRevision(path, heads, chosen.deleted ? undefined : chosen.file)] };
      });
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      this.archived = result.records; await this.publish(result.records);
    });
  }

  /** Export every accessible immutable version and tombstone from this selected
   * native account/collection. This never fetches another account or deletes data.
   */
  async exportRecovery(): Promise<RecoverySnapshot> {
    if (!this.journal || !this.session) { throw new Error('Select a Nextgraph account and collection before exporting recovery data.'); }
    const journal = this.journal, generation = this.generation;
    const archive = await journal.transact(this.nativeRecords(), () => ({ value: undefined }), false);
    if (generation !== this.generation || journal !== this.journal) { throw new Error('Nextgraph request was cancelled.'); }
    return { format: 'pondersource-nextgraph-revisions', version: 1, store: journal.store,
      collection: journal.collection, records: archive.records.filter(record => this.rs.access.checkPathPermission(record.path, 'r')) };
  }

  async importRecovery(snapshot: RecoverySnapshot): Promise<void> {
    const generation = this.generation;
    if (!this.connected || !this.journal || snapshot?.format !== 'pondersource-nextgraph-revisions' || snapshot.version !== 1 ||
      snapshot.store !== this.journal.store || snapshot.collection !== this.journal.collection || !Array.isArray(snapshot.records)) {
      throw new Error('Recovery data must match the selected Nextgraph account and collection.');
    }
    const records = mergeJournalRecords(snapshot.records);
    for (const record of records) { this.records(record.path, 'rw'); }
    return this.exclusive(async () => {
      const result = await this.journal.transact(this.nativeRecords(), () => ({ value: undefined, append: records }));
      if (generation !== this.generation) { throw new Error('Nextgraph request was cancelled.'); }
      this.archived = result.records; await this.publish(result.records);
    });
  }

  /** Preserve every accessible old cache candidate without guessing its native
   * account/collection. No migration, remote read or deletion is performed.
   */
  async exportCacheRecovery(): Promise<{ format: 'pondersource-rs-cache-recovery'; version: 1; candidates: CacheRecoveryCandidate[] }> {
    if (!this.rs.local || this.rs.remote.connected) { throw new Error('Export old cached candidates before connecting storage.'); }
    const pending: Promise<CacheRecoveryCandidate>[] = [];
    await this.rs.local.forAllNodes(node => {
      validateDocumentPath(node.path);
      if (node.path.endsWith('/') || !this.rs.access.checkPathPermission(node.path, 'r')) { return; }
      const versions = ['common', 'local', 'push', 'remote'].map(source => ({ source, item: node[source] }));
      if (node.push?.operation?.base) { versions.push({ source: 'push.base', item: node.push.operation.base }); }
      if (node.push?.operation?.observed) { versions.push({ source: 'push.observed', item: node.push.operation.observed }); }
      for (const { source, item } of versions) {
        if (!item) { continue; }
        const candidate: CacheRecoveryCandidate = { path: node.path, source, deleted: item.body === false };
        if (typeof item.revision === 'string') { candidate.revision = item.revision; }
        if (item.body === undefined) { candidate.bodyUnavailable = true; }
        if (candidate.deleted || candidate.bodyUnavailable) { pending.push(Promise.resolve(candidate)); continue; }
        if (typeof item.contentType !== 'string') { throw new Error('A cached candidate has no MIME type. Keep its browser storage intact.'); }
        const body = typeof item.body === 'object' && !(item.body instanceof ArrayBuffer) && !ArrayBuffer.isView(item.body) &&
          !(typeof Blob !== 'undefined' && item.body instanceof Blob)
          ? JSON.stringify(item.body) : item.body;
        pending.push(encodeRecord(body, item.contentType).then(file => ({ ...candidate, file: JSON.parse(file) as OneDriveRecord })));
      }
    });
    return { format: 'pondersource-rs-cache-recovery', version: 1, candidates: await Promise.all(pending) };
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
        const body = typeof value.body === 'object' && !(value.body instanceof ArrayBuffer) && !ArrayBuffer.isView(value.body) &&
          !(typeof Blob !== 'undefined' && value.body instanceof Blob)
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
    // A URL only prefills a destination. In a new browser-storage partition the
    // user confirms it again; an embedding page cannot authorize itself by URL.
    if (rs.backend === 'nextgraph') {
      rs.nextgraph.previousRemote = rs.remote; rs.remote = rs.nextgraph;
      if (window.self !== window.top && (!requestedWalletURL() || requestedWalletURL() === rememberedWalletURL())) {
        rs.nextgraph.resume = () => rs.nextgraph.connect().catch(error => rs._emit('error', error));
        rs.on('features-loaded', rs.nextgraph.resume);
      }
    }
  }
  static _rs_cleanup(rs: RemoteStorage): void {
    const backend = rs.nextgraph;
    if (!backend) { return; }
    if (typeof window !== 'undefined') { window.removeEventListener('online', backend.networkResume); }
    if (backend.resume) { rs.removeEventListener('features-loaded', backend.resume); }
    backend.configure({ userAddress: null, token: null });
    if (rs.remote === backend && backend.previousRemote) { rs.remote = backend.previousRemote; }
    delete rs.nextgraph;
  }
}

export = NextGraph;
