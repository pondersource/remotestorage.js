import { DocumentRevision, readLedger } from './document-ledger';

interface AtomicResource {
  subject: string;
  error?: Error;
  get(property: string): unknown;
  getSubjects(property: string): string[];
  hasClasses(subject: string): boolean;
  save(): Promise<string>;
}

interface AtomicAgent {
  subject: string;
  getPublicKey(): Promise<string>;
}

/** Structural interface for the pinned, application-local Atomic SDK build. */
export interface AtomicSDK {
  Agent: { fromCryptoKeyPair(keys: CryptoKeyPair, subject?: string): AtomicAgent };
  Client: new (request: typeof fetch) => {
    fetchResourceHTTP(subject: string, options: { serverURL: string }): Promise<{ resource: AtomicResource }>;
    postCommit(commit: object, endpoint: string): Promise<object>;
  };
  Store: new (options: {
    agent: AtomicAgent; serverUrl: string; noServer: boolean; requireOnlineWrites: boolean;
    commitTransport(commit: object): Promise<object>;
  }) => {
    addResource(resource: AtomicResource): void;
    newResource(options: { parent: string; propVals: Record<string, string> }): Promise<AtomicResource>;
  };
  LoroLoader: { initializeLoro(): Promise<unknown> };
  agentSubjectFromPublicKey(key: string): { subject: string };
  connectAgentUrl(origin: string, options: { publicKey: string; name: string; write: boolean; targets: string[] }): string;
  decodeB64(encoded: string): Uint8Array;
  decodeGenesisCert(encoded: Uint8Array): unknown;
  verifyGenesisCert(certificate: unknown, key: string): Promise<boolean>;
  genesisSignerDid(certificate: unknown): string;
  signRequest(url: string, agent: AtomicAgent, headers: HeadersInit): Promise<HeadersInit>;
  server: { classes: { drive: string } };
}

export interface AtomicConnection {
  drive: string;
  node: string;
  agent: string;
  keyPair: CryptoKeyPair;
}

const core = 'https://atomicdata.dev/properties/';
const collections = core + 'collection/';
const pageSize = 100;
const publicAgent = 'https://atomicdata.dev/agents/publicAgent';

export function atomicOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter an HTTPS Atomic server origin or a local development server.');
  }
  return url.origin;
}

export function atomicDrive(value: string): string {
  let subject = value.trim();
  if (!subject.startsWith('atomic:') && !subject.startsWith('did:ad:')) {
    try {
      const url = new URL(subject);
      subject = url.searchParams.get('subject') || url.searchParams.get('drive') ||
        decodeURIComponent(url.pathname.split('/').pop());
    } catch {
      throw new Error('Enter the DID or link of an Atomic drive.');
    }
  }
  const match = /^(?:atomic:|did:ad:)([A-Za-z0-9_-]{86})$/.exec(subject);
  if (!match) { throw new Error('Enter the DID or link of an Atomic drive.'); }
  return 'atomic:' + match[1];
}

export class AtomicGrantPending extends Error {}

export async function atomicClient(sdk: AtomicSDK, connection: AtomicConnection, namespace: string, signal?: AbortSignal) {
  const drive = atomicDrive(connection.drive);
  const node = atomicOrigin(connection.node);
  const agent = sdk.Agent.fromCryptoKeyPair(connection.keyPair, connection.agent);
  if (sdk.agentSubjectFromPublicKey(await agent.getPublicKey()).subject !== agent.subject) {
    throw new Error('The saved Atomic app key does not match its public identifier.');
  }

  const client = new sdk.Client(async (input, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== node) { throw new Error('Atomic request left the selected server.'); }
    signal?.throwIfAborted();
    const method = init.method ?? 'GET';
    // GET resource and query handlers use Atomic's URL-bound read signature.
    // Commits carry a separate signature over the complete commit body.
    const headers = method === 'GET' ? await sdk.signRequest(url.href, agent, init.headers) : init.headers;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason || init.signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    init.signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || init.signal?.aborted) { abort(); }
    const deadline = setTimeout(() => controller.abort(), 20000);
    try {
      // The Atomic user's browser session is never attached to this request.
      return await fetch(url.href, { ...init, headers, signal: controller.signal,
        credentials: 'omit', redirect: 'error', cache: 'no-store' });
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      init.signal?.removeEventListener('abort', abort);
    }
  });

  async function read(subject: string): Promise<AtomicResource> {
    const { resource } = await client.fetchResourceHTTP(subject, { serverURL: node });
    if (resource.error) { throw resource.error; }
    return resource;
  }

  async function grant() {
    let root: AtomicResource;
    try {
      root = await read(drive);
    } catch (error) {
      if (/(^|\D)404(\D|$)|no .*read right|not found/i.test(String(error))) {
        throw new AtomicGrantPending('Approve Read and edit for the selected drive in Atomic.');
      }
      throw error;
    }
    const encoded = root.get(core + 'genesis');
    if (root.subject !== drive || !root.hasClasses(sdk.server.classes.drive) || typeof encoded !== 'string') {
      throw new Error('The selected server did not return the requested Atomic drive.');
    }
    const certificate = sdk.decodeGenesisCert(sdk.decodeB64(encoded));
    if (!(await sdk.verifyGenesisCert(certificate, drive.slice('atomic:'.length))) ||
        root.get(core + 'createdBy') !== sdk.genesisSignerDid(certificate)) {
      throw new Error('The selected server returned an invalid Atomic drive certificate.');
    }
    const readers = root.getSubjects(core + 'read');
    const writers = root.getSubjects(core + 'write');
    if (root.get(core + 'parent') || readers.includes(publicAgent) || writers.includes(publicAgent)) {
      throw new Error('Choose a private Atomic drive for your app data.');
    }
    if (!readers.includes(agent.subject) || !writers.includes(agent.subject)) {
      throw new AtomicGrantPending('Approve Read and edit for the selected drive in Atomic.');
    }
    return root;
  }

  const title = 'Ponder Source documents v1 ' + namespace;
  let store: InstanceType<AtomicSDK['Store']>;
  return {
    grant,
    async readRevisions() {
      await grant();
      const seen = new Set<string>();
      const raw: Record<string, string> = Object.create(null);
      let total: number;
      for (let page = 0; ; page++) {
        const query = new URL('/query', node);
        query.search = new URLSearchParams({ drive, property: core + 'parent', value: drive,
          filters: JSON.stringify([{ property: core + 'name', value: title }]),
          page_size: String(pageSize), current_page: String(page) }).toString();
        const result = await read(query.href);
        const ids = result.getSubjects(collections + 'members');
        const count = result.get(collections + 'totalMembers');
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 ||
            ids.length !== Math.min(pageSize, Math.max(0, count - page * pageSize)) ||
            total !== undefined && total !== count) {
          throw new Error('Atomic returned incomplete or changing document history. Try again.');
        }
        total = count;
        for (const id of ids) {
          if (atomicDrive(id) !== id || seen.has(id)) { throw new Error('Atomic returned inconsistent document history.'); }
          seen.add(id);
        }
        for (const resource of await Promise.all(ids.map(id => read(id)))) {
          const revision = resource.get(core + 'description');
          const key = resource.get(core + 'shortname');
          if (resource.get(core + 'parent') !== drive || resource.get(core + 'name') !== title ||
              typeof revision !== 'string' || typeof key !== 'string' ||
              Object.prototype.hasOwnProperty.call(raw, 'rs_revision_' + key)) {
            throw new Error('Atomic returned an invalid document revision.');
          }
          raw['rs_revision_' + key] = revision;
        }
        if (seen.size === total) { return readLedger(raw); }
      }
    },
    async append(revision: DocumentRevision) {
      const root = await grant();
      if (!store) {
        await sdk.LoroLoader.initializeLoro();
        store = new sdk.Store({ agent, serverUrl: node, noServer: true, requireOnlineWrites: true,
          commitTransport: commit => client.postCommit(commit, new URL('/commit', node).href) });
      }
      store.addResource(root);
      const row = await store.newResource({ parent: drive, propVals: { [core + 'name']: title,
        [core + 'shortname']: revision.id, [core + 'description']: JSON.stringify(revision) } });
      if (await row.save() !== 'persisted') { throw new Error('Atomic did not confirm saving this document revision.'); }
    }
  };
}
