import { RemoteBase } from './remote';
import type { Remote, RemoteResponse, RemoteSettings } from './remote';
import { discoverLWS } from './lws-discovery';
import LWSPathMap from './lws-path-map';
import LWSOpenID from './lws-openid';

const SETTINGS_KEY = 'remotestorage:lws';
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
type Discovery = Awaited<ReturnType<typeof discoverLWS>>;
type LWSCredentialProvider = (context: {
  storage: string; authorizationServer: string; metadata: any; interactive?: boolean;
}) => Promise<{ token: string; type: string }>;

/** Experimental adapter for LWS, with an rs.js index for server-assigned names.
 * Identity credentials are obtained through an application-supplied provider;
 * Solid-OIDC access tokens must not be reused as LWS access tokens.
 */
class LWS extends RemoteBase implements Remote {
  readonly supportsAtomicCreate = true;
  getStorageIdentity(): string { return JSON.stringify([this.discovery?.storage || this.storageURL || '', this.discovery?.root || this.href || '']); }
  href: string;
  storageURL: string;
  discovery: Discovery;
  credentialProvider: LWSCredentialProvider;
  request: typeof fetch = globalThis.fetch?.bind(globalThis);
  token: string;
  folderETagsAreRecursive = false;
  private expires = 0;
  private generation = 0;
  private refreshing: Promise<void>;
  private bridged = false;
  private paths: LWSPathMap;
  private openID: LWSOpenID;
  private openIDOptions: string;

  constructor(rs) {
    super(rs);
    this.online = true;
    this.storageApi = 'lws-1.0-experimental';
    this.addEvents(['connected', 'not-connected']);
  }

  setStorageURL(address: string): void {
    const url = new URL(address);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Use an HTTPS storage URL, or HTTP on localhost.');
    }
    if (url.username || url.password) { throw new Error('Storage URLs must not contain credentials.'); }
    url.hash = '';
    this.storageURL = url.href;
  }

  setCredentialProvider(provider: LWSCredentialProvider): void {
    this.credentialProvider = provider;
  }

  configureOpenID(options: ConstructorParameters<typeof LWSOpenID>[0]): void {
    const signature = JSON.stringify(options);
    if (this.openID && this.openIDOptions === signature) { return; }
    if (this.openID) { this.openID.clear(); }
    this.openID = new LWSOpenID(options);
    this.openIDOptions = signature;
    this.setCredentialProvider(context => this.openID.get({ storage: context.storage,
      authorizationServer: context.authorizationServer, storageURL: this.storageURL, interactive: context.interactive }));
  }

  async handleIncomingRedirect(): Promise<boolean> {
    if (!this.openID) { return false; }
    const context = await this.openID.handleIncomingRedirect();
    if (!context) { return false; }
    this.setStorageURL(context.storageURL);
    // Rediscovery must still bind to the same storage and authorization server.
    const fresh = await discoverLWS(this.storageURL, { fetch: this.request });
    if (fresh.storage !== context.storage || !fresh.authorizationServers.includes(context.authorizationServer)) {
      this.openID.clear();
      throw new Error('LWS storage authorization changed during sign-in.');
    }
    await this.connect();
    return true;
  }

  configure(settings: RemoteSettings): void {
    // rs.disconnect and rs.reconnect both clear token state. Never persist tokens.
    if (settings.token === null || settings.userAddress === null) {
      this.generation++;
      this.connected = false;
      this.token = undefined;
      this.expires = 0;
    }
    if (settings.userAddress === null) {
      if (this.openID) { this.openID.clear(); }
      this.storageURL = this.href = this.userAddress = undefined;
      this.discovery = undefined;
      this.paths = undefined;
      try { localStorage.removeItem(SETTINGS_KEY); } catch { /* unavailable */ }
    } else if (settings.href) {
      this.setStorageURL(settings.href);
    }
  }

  private async authenticate(discovery: Discovery, generation: number, interactive = false): Promise<void> {
    if (!discovery.authorizationServers.length) { return; }
    if (!this.credentialProvider) {
      throw new Error('This LWS storage requires sign-in. Configure lws.setCredentialProvider() for its authentication suite.');
    }
    // No credentials are sent during discovery. Do not silently try other issuers.
    if (discovery.authorizationServers.length !== 1) {
      throw new Error('This storage advertises multiple authorization servers; explicit server selection is not implemented yet.');
    }
    const issuer = discovery.authorizationServers[0];
    const issuerURL = new URL(issuer);
    const metadataURL = new URL('/.well-known/lws-configuration' + issuerURL.pathname.replace(/\/$/, ''), issuerURL);
    const response = await this.request(metadataURL.href, {
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' }
    });
    if (!response.ok) { throw new Error('Could not read LWS authorization server metadata.'); }
    const metadata = await response.json();
    if (metadata.issuer !== issuer) { throw new Error('LWS authorization server issuer mismatch.'); }
    if (!metadata.grant_types_supported?.includes(EXCHANGE)) { throw new Error('LWS token exchange is not advertised.'); }
    const endpoint = new URL(metadata.token_endpoint);
    if (endpoint.origin !== issuerURL.origin || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('LWS token endpoint must be on the advertised issuer origin.');
    }
    const credential = await this.credentialProvider({ storage: discovery.storage, authorizationServer: issuer, metadata, interactive });
    if (!credential?.token || !credential.type) { throw new Error('No LWS authentication credential was supplied.'); }
    if (metadata.subject_token_types_supported && !metadata.subject_token_types_supported.includes(credential.type)) {
      throw new Error('The LWS server does not support this credential type.');
    }
    if (generation !== this.generation) { throw new Error('LWS connection was cancelled.'); }
    const exchanged = await this.request(endpoint.href, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: EXCHANGE, resource: discovery.storage,
        subject_token: credential.token, subject_token_type: credential.type }).toString()
    });
    if (!exchanged.ok) { throw new Error('LWS token exchange failed (HTTP ' + exchanged.status + ').'); }
    const result = await exchanged.json();
    if (result.token_type?.toLowerCase() !== 'bearer' || typeof result.access_token !== 'string' ||
        !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw new Error('Invalid LWS access token response.');
    }
    if (generation !== this.generation) { throw new Error('LWS connection was cancelled.'); }
    this.token = result.access_token;
    this.expires = Date.now() + result.expires_in * 1000;
  }

  async connect(): Promise<void> {
    if (this.rs.remote.connected) { throw new Error('Disconnect the current storage before connecting LWS.'); }
    if (!this.storageURL) { throw new Error('Enter an LWS storage URL.'); }
    if (this.openID) { this.openID.cancelPending(); }
    this.token = undefined;
    this.expires = 0;
    const generation = ++this.generation;
    const discovery = await discoverLWS(this.storageURL, { fetch: this.request });
    await this.authenticate(discovery, generation, true);
    if (generation !== this.generation) { throw new Error('LWS connection was cancelled.'); }
    this.discovery = discovery;
    this.href = discovery.root;
    this.userAddress = discovery.storage;
    this.connected = true;
    this.online = true;
    this.paths = new LWSPathMap(discovery.storage, discovery.root, this.send.bind(this));
    try {
      await this.paths.load();
      if (generation !== this.generation) { throw new Error('LWS connection was cancelled.'); }
    } catch (error) {
      this.connected = false; this.token = undefined; this.paths = undefined;
      throw error;
    }
    this.rs.setBackend('lws');
    if (this.rs.remote !== this) {
      this.rs._lwsPreviousRemote = this.rs.remote;
      this.bridged = true;
      this.rs.remote = this;
      // The normal cached sync path reads rs.remote dynamically.
      if (!this.rs.local) { this.rs._setGPD(this, this); }
      this.rs._fireReady();
      this.rs._emit('connected');
    } else if (this.bridged) {
      this.rs._emit('connected');
    } else {
      this._emit('connected');
    }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ href: this.storageURL })); } catch { /* unavailable */ }
  }

  getFileURL(path: string): string {
    if (!this.href) { throw new Error('LWS is not connected.'); }
    const relative = path.replace(/^\//, '');
    if (relative.split('/').some(part => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || /[\\/]/.test(decoded);
    }) || /[?#\\]/.test(relative)) { throw new Error('Invalid LWS resource path.'); }
    if (this.paths?.lookup('/' + relative)) { return this.paths.lookup('/' + relative); }
    if (!relative) { return this.href; }
    if (!new URL(this.href).pathname.endsWith('/') || new URL(this.href).search) { return undefined; }
    const url = new URL(relative, this.href);
    if (!url.href.startsWith(this.href)) { throw new Error('LWS path escapes the storage root.'); }
    return url.href;
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.connected) { throw new Error('LWS is not connected.'); }
    const generation = this.generation;
    if (new URL(url).origin !== new URL(this.href).origin) { throw new Error('Refusing an LWS request to another origin.'); }
    if (this.token && Date.now() >= this.expires - 5000) {
      if (!this.refreshing) { this.refreshing = this.authenticate(this.discovery, this.generation).finally(() => { this.refreshing = undefined; }); }
      await this.refreshing;
    }
    if (generation !== this.generation || !this.connected) { throw new Error('LWS connection was cancelled.'); }
    const headers = new Headers(init.headers);
    if (this.token) { headers.set('Authorization', 'Bearer ' + this.token); }
    try {
      const response = await this.request(url, { ...init, headers, credentials: 'omit', redirect: 'error',
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      if (generation !== this.generation) { throw new Error('LWS connection was cancelled.'); }
      this.online = true;
      return response;
    } catch (error) { this.online = false; throw error; }
  }

  private conditions(options: { ifMatch?: string; ifNoneMatch?: string }): Headers {
    const headers = new Headers();
    if (options.ifMatch) { headers.set('If-Match', this.addQuotes(options.ifMatch)); }
    if (options.ifNoneMatch) { headers.set('If-None-Match', this.addQuotes(options.ifNoneMatch)); }
    return headers;
  }

  private result(response: Response): RemoteResponse {
    return { statusCode: response.status, revision: this.stripQuotes(response.headers.get('etag')),
      contentType: response.headers.get('content-type') };
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    this.getFileURL(path); // Validate before index/network access.
    await this.paths.load();
    const logical = '/' + path.replace(/^\//, '');
    const url = this.getFileURL(path);
    if (!path.endsWith('/')) { return url ? this.read(url, path, options) : { statusCode: 404 }; }
    const virtual = await this.paths.listing(logical);
    const native = url ? await this.read(url, path, options) : { statusCode: 404 } as RemoteResponse;
    if (native.statusCode === 404 && Object.keys(virtual).length) { return { statusCode: 200, body: virtual, contentType: 'application/json' }; }
    if (native.statusCode === 200) {
      for (const key of Object.keys(virtual)) {
        if (native.body[key]) { throw new Error('Mapped and native LWS paths collide: ' + key); }
        native.body[key] = virtual[key];
      }
    }
    return native;
  }

  private async read(url: string, path: string, options: { ifMatch?: string; ifNoneMatch?: string }): Promise<RemoteResponse> {
    const headers = this.conditions(options);
    const folder = path.endsWith('/');
    headers.set('Accept', folder ? 'application/lws+json' : '*/*');
    const response = await this.send(url, { headers });
    const result = this.result(response);
    if (response.status !== 200) { return result; }
    if (folder) {
      const listing = Object.create(null);
      const visited = new Set<string>();
      let page = response, pageURL = url;
      while (true) {
        if (visited.has(pageURL) || visited.size >= 1000) { throw new Error('Invalid LWS pagination loop.'); }
        visited.add(pageURL);
        const document = await page.json();
        if (!Array.isArray(document.items) || new URL(document.id, pageURL).href !== url) { throw new Error('Invalid LWS container.'); }
        for (const item of document.items) {
          const itemURL = new URL(item.id, pageURL);
          if (this.paths.isInternal(itemURL.href)) { continue; }
          // Opaque IDs belonging to other apps have no rs.js filename. Preserve
          // them without projecting them into our namespace.
          if (!itemURL.href.startsWith(url)) { continue; }
          const name = itemURL.href.slice(url.length);
          if (!name || name.replace(/\/$/, '').includes('/') || itemURL.search || itemURL.hash) { throw new Error('Invalid LWS child resource.'); }
          // Container item metadata need not contain an ETag. HEAD obtains a real validator.
          const head = await this.send(itemURL.href, { method: 'HEAD' });
          if (!head.ok) { throw new Error('Cannot read LWS member metadata (HTTP ' + head.status + ').'); }
          const revision = this.stripQuotes(head.headers.get('etag'));
          if (!revision) { throw new Error('LWS member ETag was not exposed by the server.'); }
          listing[name] = { ETag: revision, 'Content-Type': item.format,
            'Content-Length': item.size, 'Last-Modified': item.modified };
        }
        const next = /<([^>]+)>\s*;\s*rel="?next"?(?:\s*[,;]|$)/i.exec(page.headers.get('link') || '');
        if (!next) { break; }
        pageURL = new URL(next[1], pageURL).href;
        page = await this.send(pageURL, { headers: { Accept: 'application/lws+json' } });
        if (!page.ok) { throw new Error('Could not read the next LWS container page.'); }
      }
      result.body = listing;
      result.contentType = 'application/json; charset=UTF-8';
      // A paginated container validator does not necessarily cover every page.
      delete result.revision;
    } else if (/^(text\/|application\/(?:[^;]+\+)?json\b)/i.test(result.contentType || '')) {
      const text = await response.text();
      // Remote responses retain wire text, as WireClient does. BaseClient's
      // object API parses JSON; the sync cache must compare identical body types.
      result.body = text;
    } else {
      result.body = await response.arrayBuffer();
    }
    return result;
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) { throw new Error('Cannot PUT an LWS container.'); }
    this.getFileURL(path);
    await this.paths.load();
    const logical = '/' + path.replace(/^\//, '');
    const url = this.getFileURL(path);
    const exists = url ? await this.send(url, { method: 'HEAD' }) : new Response(null, { status: 404 });
    if (exists.status === 404) {
      if (options.ifMatch) { return { statusCode: 412 }; }
      return this.result(await this.paths.create(logical, body as BodyInit, contentType, this.paths.lookup(logical)));
    }
    if (!exists.ok) { return this.result(exists); }
    if (options.ifNoneMatch === '*') { return { statusCode: 412 }; }
    const headers = this.conditions(options);
    headers.set('Content-Type', contentType);
    return this.result(await this.send(url, { method: 'PUT', headers, body: body as BodyInit }));
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) { throw new Error('Cannot delete an LWS container through rs.js.'); }
    this.getFileURL(path);
    await this.paths.load();
    const logical = '/' + path.replace(/^\//, '');
    const mapped = this.paths.lookup(logical), url = this.getFileURL(path);
    if (!url) { return { statusCode: 404 }; }
    const response = await this.send(url, { method: 'DELETE', headers: this.conditions(options) });
    if (mapped && (response.ok || response.status === 404)) { await this.paths.forget(logical, mapped); }
    return this.result(response);
  }

  static isRedirect(url: string): boolean { return LWSOpenID.isRedirect(url); }

  static _rs_init(rs): void {
    rs.lws = new LWS(rs);
    if (rs.backend === 'lws') {
      rs._lwsPreviousRemote = rs.remote;
      rs.remote = rs.lws;
      // Restore only the address. Authentication is explicit, never a silent redirect.
      try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (saved?.href) { rs.lws.setStorageURL(saved.href); } } catch { /* unavailable */ }
    }
  }

  static _rs_supported(): boolean { return typeof globalThis.fetch === 'function'; }

  static _rs_cleanup(rs): void {
    if (rs._lwsPreviousRemote) { rs.remote = rs._lwsPreviousRemote; delete rs._lwsPreviousRemote; }
    if (rs.lws) { rs.lws.configure({ userAddress: null, token: null }); }
  }
}

export = LWS;
