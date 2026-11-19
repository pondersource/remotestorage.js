import { RemoteBase } from './remote';
import type { Remote, RemoteResponse, RemoteSettings } from './remote';
import { discoverLWS } from './lws-discovery';

const SETTINGS_KEY = 'remotestorage:lws';
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
type Discovery = Awaited<ReturnType<typeof discoverLWS>>;
type LWSCredentialProvider = (context: {
  storage: string; authorizationServer: string; metadata: any;
}) => Promise<{ token: string; type: string }>;

/** Experimental adapter for LWS servers preserving hierarchical resource names.
 * Identity credentials are obtained through an application-supplied provider;
 * Solid-OIDC access tokens must not be reused as LWS access tokens.
 */
class LWS extends RemoteBase implements Remote {
  href: string;
  storageURL: string;
  discovery: Discovery;
  credentialProvider: LWSCredentialProvider;
  request: typeof fetch = globalThis.fetch?.bind(globalThis);
  private token: string;
  private expires = 0;
  private generation = 0;
  private refreshing: Promise<void>;
  private bridged = false;

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
    if (url.username || url.password) throw new Error('Storage URLs must not contain credentials.');
    url.hash = '';
    this.storageURL = url.href;
  }

  setCredentialProvider(provider: LWSCredentialProvider): void {
    this.credentialProvider = provider;
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
      this.storageURL = this.href = this.userAddress = undefined;
      this.discovery = undefined;
      try { localStorage.removeItem(SETTINGS_KEY); } catch { /* unavailable */ }
    } else if (settings.href) {
      this.setStorageURL(settings.href);
    }
  }

  private async authenticate(discovery: Discovery, generation: number): Promise<void> {
    if (!discovery.authorizationServers.length) return;
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
    if (!response.ok) throw new Error('Could not read LWS authorization server metadata.');
    const metadata = await response.json();
    if (metadata.issuer !== issuer) throw new Error('LWS authorization server issuer mismatch.');
    if (!metadata.grant_types_supported?.includes(EXCHANGE)) throw new Error('LWS token exchange is not advertised.');
    const endpoint = new URL(metadata.token_endpoint);
    if (endpoint.origin !== issuerURL.origin || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('LWS token endpoint must be on the advertised issuer origin.');
    }
    const credential = await this.credentialProvider({ storage: discovery.storage, authorizationServer: issuer, metadata });
    if (!credential?.token || !credential.type) throw new Error('No LWS authentication credential was supplied.');
    if (metadata.subject_token_types_supported && !metadata.subject_token_types_supported.includes(credential.type)) {
      throw new Error('The LWS server does not support this credential type.');
    }
    if (generation !== this.generation) throw new Error('LWS connection was cancelled.');
    const exchanged = await this.request(endpoint.href, {
      method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: EXCHANGE, resource: discovery.storage,
        subject_token: credential.token, subject_token_type: credential.type }).toString()
    });
    if (!exchanged.ok) throw new Error('LWS token exchange failed (HTTP ' + exchanged.status + ').');
    const result = await exchanged.json();
    if (result.token_type?.toLowerCase() !== 'bearer' || typeof result.access_token !== 'string' ||
        !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw new Error('Invalid LWS access token response.');
    }
    if (generation !== this.generation) throw new Error('LWS connection was cancelled.');
    this.token = result.access_token;
    this.expires = Date.now() + result.expires_in * 1000;
  }

  async connect(): Promise<void> {
    if (this.rs.remote.connected) throw new Error('Disconnect the current storage before connecting LWS.');
    if (!this.storageURL) throw new Error('Enter an LWS storage URL.');
    this.token = undefined;
    this.expires = 0;
    const generation = ++this.generation;
    const discovery = await discoverLWS(this.storageURL, { fetch: this.request });
    await this.authenticate(discovery, generation);
    if (generation !== this.generation) throw new Error('LWS connection was cancelled.');
    // rs.js paths need a directory-like root. Other naming schemes need a persistent path mapping.
    if (!new URL(discovery.root).pathname.endsWith('/') || new URL(discovery.root).search) {
      throw new Error('This experimental LWS adapter requires a directory-style storage root.');
    }
    this.discovery = discovery;
    this.href = discovery.root;
    this.userAddress = discovery.storage;
    this.connected = true;
    this.online = true;
    this.rs.setBackend('lws');
    if (this.rs.remote !== this) {
      this.rs._lwsPreviousRemote = this.rs.remote;
      this.bridged = true;
      this.rs.remote = this;
      // The normal cached sync path reads rs.remote dynamically.
      if (!this.rs.local) this.rs._setGPD(this, this);
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
    if (!this.href) throw new Error('LWS is not connected.');
    const relative = path.replace(/^\//, '');
    if (relative.split('/').some(part => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || /[\\/]/.test(decoded);
    }) || /[?#\\]/.test(relative)) throw new Error('Invalid LWS resource path.');
    const url = new URL(relative, this.href);
    if (!url.href.startsWith(this.href)) throw new Error('LWS path escapes the storage root.');
    return url.href;
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.connected) throw new Error('LWS is not connected.');
    const generation = this.generation;
    if (new URL(url).origin !== new URL(this.href).origin) throw new Error('Refusing an LWS request to another origin.');
    if (this.token && Date.now() >= this.expires - 5000) {
      if (!this.refreshing) this.refreshing = this.authenticate(this.discovery, this.generation).finally(() => { this.refreshing = undefined; });
      await this.refreshing;
    }
    if (generation !== this.generation || !this.connected) throw new Error('LWS connection was cancelled.');
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', 'Bearer ' + this.token);
    try {
      const response = await this.request(url, { ...init, headers, credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      if (generation !== this.generation) throw new Error('LWS connection was cancelled.');
      this.online = true;
      return response;
    } catch (error) { this.online = false; throw error; }
  }

  private conditions(options: { ifMatch?: string; ifNoneMatch?: string }): Headers {
    const headers = new Headers();
    if (options.ifMatch) headers.set('If-Match', this.addQuotes(options.ifMatch));
    if (options.ifNoneMatch) headers.set('If-None-Match', this.addQuotes(options.ifNoneMatch));
    return headers;
  }

  private result(response: Response): RemoteResponse {
    return { statusCode: response.status, revision: this.stripQuotes(response.headers.get('etag')),
      contentType: response.headers.get('content-type') };
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    const url = this.getFileURL(path);
    const headers = this.conditions(options);
    const folder = path.endsWith('/');
    headers.set('Accept', folder ? 'application/lws+json' : '*/*');
    const response = await this.send(url, { headers });
    const result = this.result(response);
    if (response.status !== 200) return result;
    if (folder) {
      const listing = Object.create(null);
      const visited = new Set<string>();
      let page = response, pageURL = url;
      while (true) {
        if (visited.has(pageURL) || visited.size >= 1000) throw new Error('Invalid LWS pagination loop.');
        visited.add(pageURL);
        const document = await page.json();
        if (!Array.isArray(document.items) || new URL(document.id, pageURL).href !== url) throw new Error('Invalid LWS container.');
        for (const item of document.items) {
          const itemURL = new URL(item.id, pageURL);
          if (!itemURL.href.startsWith(url)) throw new Error('This server needs an opaque-URI path mapping.');
          const name = itemURL.href.slice(url.length);
          if (!name || name.replace(/\/$/, '').includes('/') || itemURL.search || itemURL.hash) throw new Error('Invalid LWS child resource.');
          // Container item metadata need not contain an ETag. HEAD obtains a real validator.
          const head = await this.send(itemURL.href, { method: 'HEAD' });
          if (!head.ok) throw new Error('Cannot read LWS member metadata (HTTP ' + head.status + ').');
          const revision = this.stripQuotes(head.headers.get('etag'));
          if (!revision) throw new Error('LWS member ETag was not exposed by the server.');
          listing[name] = { ETag: revision, 'Content-Type': item.format,
            'Content-Length': item.size, 'Last-Modified': item.modified };
        }
        const next = /<([^>]+)>\s*;\s*rel="?next"?(?:\s*[,;]|$)/i.exec(page.headers.get('link') || '');
        if (!next) break;
        pageURL = new URL(next[1], pageURL).href;
        page = await this.send(pageURL, { headers: { Accept: 'application/lws+json' } });
        if (!page.ok) throw new Error('Could not read the next LWS container page.');
      }
      result.body = listing;
      result.contentType = 'application/json; charset=UTF-8';
      // A paginated container validator does not necessarily cover every page.
      delete result.revision;
    } else if (/^(text\/|application\/(?:[^;]+\+)?json\b)/i.test(result.contentType || '')) {
      const text = await response.text();
      result.body = /json/i.test(result.contentType) ? JSON.parse(text) : text;
    } else {
      result.body = await response.arrayBuffer();
    }
    return result;
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) throw new Error('Cannot PUT an LWS container.');
    const url = this.getFileURL(path);
    const headers = this.conditions(options);
    headers.set('Content-Type', contentType);
    // Initial slice updates existing resources only. Creation is POST with server-assigned
    // identifiers, so pretending PUT creates a deterministic rs.js path would lose data.
    if (options.ifNoneMatch === '*') throw new Error('LWS resource creation requires the pending persistent path-mapping implementation.');
    return this.result(await this.send(url, { method: 'PUT', headers, body: body as BodyInit }));
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) throw new Error('Cannot delete an LWS container through rs.js.');
    return this.result(await this.send(this.getFileURL(path), { method: 'DELETE', headers: this.conditions(options) }));
  }

  static _rs_init(rs): void {
    rs.lws = new LWS(rs);
    if (rs.backend === 'lws') {
      rs._lwsPreviousRemote = rs.remote;
      rs.remote = rs.lws;
      // Restore only the address. Authentication is explicit, never a silent redirect.
      try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); if (saved?.href) rs.lws.setStorageURL(saved.href); } catch { /* unavailable */ }
    }
  }

  static _rs_supported(): boolean { return typeof globalThis.fetch === 'function'; }

  static _rs_cleanup(rs): void {
    if (rs._lwsPreviousRemote) { rs.remote = rs._lwsPreviousRemote; delete rs._lwsPreviousRemote; }
    if (rs.lws) rs.lws.configure({ userAddress: null, token: null });
  }
}

export = LWS;
