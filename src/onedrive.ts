import { PublicClientApplication, type AccountInfo, type IPublicClientApplication } from '@azure/msal-browser';
import { RemoteBase, type Remote, type RemoteResponse, type RemoteSettings } from './remote';
import type RemoteStorage from './remotestorage';
import { decodeName, decodeRecord, encodeRecord, pathSegments } from './onedrive-format';
import UnauthorizedError from './unauthorized-error';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Files.ReadWrite.AppFolder'];
const POPUP_KEY = 'remotestorage:onedrive-popup';
interface DriveItem {
  id: string;
  name: string;
  eTag?: string;
  folder?: object;
  '@microsoft.graph.downloadUrl'?: string;
}

/** Experimental OneDrive app-folder backend. MSAL owns PKCE and token renewal.
 * Uses a shared OAuth application registration to share data between app origins.
 * Public rs.js paths remain private: getItemURL never grants sharing permission.
 */
class OneDrive extends RemoteBase implements Remote {
  folderETagsAreRecursive = false;
  clientId: string;
  private redirectUri: string;
  request: typeof fetch = globalThis.fetch?.bind(globalThis);
  private auth: IPublicClientApplication;
  private initialized: Promise<void>;
  private account: AccountInfo;
  private root: string;
  private generation = 0;
  private previousRemote: Remote;

  constructor(rs: RemoteStorage) {
    super(rs);
    this.online = true;
    this.storageApi = 'onedrive-rs-records-1';
    this.addEvents(['connected', 'not-connected']);
  }

  /** Configure a public Microsoft Entra SPA registration, never a client secret. */
  setClientId(clientId: string, redirectUri = window.location.origin + '/'): void {
    if (this.clientId === clientId && this.redirectUri === redirectUri) { return; }
    if (this.connected) { throw new Error('Disconnect OneDrive before changing its client ID.'); }
    const redirect = new URL(redirectUri);
    if (redirect.origin !== window.location.origin || redirect.hash || redirect.username || redirect.password) {
      throw new Error('The OneDrive redirect URI must belong to this app origin and have no fragment.');
    }
    // Optional provider configuration must not initialize MSAL or require Web
    // Crypto. Guest mode and other backends can run on an insecure development
    // origin. Reconfiguration also invalidates an in-flight connection attempt.
    this.generation++;
    this.clientId = clientId;
    this.redirectUri = redirect.href;
    this.auth = undefined;
    this.initialized = undefined;
    this.account = undefined;
    this.root = undefined;
    this.userAddress = undefined;
  }

  private async initializeAuth(): Promise<IPublicClientApplication> {
    if (!this.auth) {
      if (!globalThis.crypto?.subtle) {
        throw new Error('OneDrive sign-in requires Web Crypto in a secure context (HTTPS or localhost).');
      }
      this.auth = new PublicClientApplication({ auth: { clientId: this.clientId,
        authority: 'https://login.microsoftonline.com/consumers', redirectUri: this.redirectUri },
      cache: { cacheLocation: 'memoryStorage' } });
    }
    const auth = this.auth;
    try {
      this.initialized ||= auth.initialize();
      await this.initialized;
    } catch (error) {
      // A failed initialization is recoverable on a later explicit attempt;
      // it cannot reset a replacement registration's initialization state.
      if (this.auth === auth) { this.auth = undefined; this.initialized = undefined; }
      throw error;
    }
    return auth;
  }

  configure(settings: RemoteSettings): void {
    if (settings.token === null || settings.userAddress === null) {
      this.generation++;
      this.connected = false;
      this.account = undefined;
      this.root = undefined;
    }
    if (settings.userAddress === null) {
      this.userAddress = undefined;
      // Local disconnect never signs out of the user's Microsoft account globally.
      if (this.auth) {
        const auth = this.auth, initialized = this.initialized, generation = this.generation;
        this.auth = undefined;
        this.initialized = undefined;
        // Initialization and cleanup can overlap after an explicit cancellation.
        // A reconnect gets a new client so old cleanup cannot clear new tokens.
        void Promise.resolve(initialized).then(() => auth.clearCache()).catch(error => {
          if (this.rs.onedrive === this && generation === this.generation) { this.rs._emit('error', error); }
        });
      }
    }
  }

  /** User gesture required: opens Microsoft's account chooser in a popup. */
  async connect(): Promise<void> {
    if (this.rs.remote.connected) { throw new Error('Disconnect the current storage before connecting OneDrive.'); }
    if (!this.clientId) { throw new Error('Configure a OneDrive SPA client ID before connecting.'); }
    const generation = ++this.generation;
    const auth = await this.initializeAuth();
    if (generation !== this.generation) { throw new Error('OneDrive connection was cancelled.'); }
    // The registered popup callback may load the app itself. Leave its OAuth
    // parameters to MSAL, including before rs.backend has been selected.
    let popup: string;
    if (typeof sessionStorage !== 'undefined') {
      const callback = new URL(this.redirectUri);
      popup = JSON.stringify({ url: callback.origin + callback.pathname, created: Date.now(), generation });
      sessionStorage.setItem(POPUP_KEY, popup);
    }
    let login;
    try { login = await auth.loginPopup({ scopes: SCOPES, prompt: 'select_account' }); }
    finally {
      if (popup && sessionStorage.getItem(POPUP_KEY) === popup) { sessionStorage.removeItem(POPUP_KEY); }
    }
    if (generation !== this.generation) { throw new Error('OneDrive connection was cancelled.'); }
    this.account = login.account;
    if (!this.account) { throw new Error('Microsoft did not return an account.'); }
    const response = await this.send('/me/drive/special/approot');
    if (!response.ok) { throw new Error('Could not open the OneDrive app folder (HTTP ' + response.status + ').'); }
    const root = await response.json() as DriveItem;
    if (!root.id || !root.folder || generation !== this.generation) { throw new Error('OneDrive app folder is unavailable.'); }
    this.root = root.id;
    this.userAddress = this.account.username || this.account.homeAccountId;
    this.connected = true;
    this.rs.setBackend('onedrive');
    if (this.rs.remote !== this) {
      this.previousRemote = this.rs.remote;
      this.rs.remote = this;
      if (!this.rs.local) { this.rs._setGPD(this, this); }
      this.rs._fireReady();
      this.rs._emit('connected');
    } else if (this.previousRemote) { this.rs._emit('connected'); }
    else { this._emit('connected'); }
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path.startsWith('/') ? GRAPH + path : path);
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) {
      throw new Error('Refusing OneDrive credentials for an untrusted URL.');
    }
    const generation = this.generation;
    if (!this.account) { throw new Error('Reconnect OneDrive to sign in.'); }
    let token;
    try { token = await this.auth.acquireTokenSilent({ scopes: SCOPES, account: this.account }); }
    catch (error) {
      if (generation === this.generation && ['interaction_required', 'login_required', 'consent_required'].includes(error.errorCode)) {
        this.rs._emit('error', new UnauthorizedError('Reconnect OneDrive to renew authorization.'));
      }
      throw error;
    }
    if (generation !== this.generation) { throw new Error('OneDrive request was cancelled.'); }
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token.accessToken);
    let response: Response;
    try {
      response = await this.request(url.href, { ...init, headers, credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000) });
    } catch (error) {
      if (generation === this.generation) { this.setOnline(false); }
      throw error;
    }
    if (generation !== this.generation) { throw new Error('OneDrive request was cancelled.'); }
    this.setOnline(true);
    if (response.status === 401) { this.rs._emit('error', new UnauthorizedError('Reconnect OneDrive to renew authorization.')); }
    return response;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation || !this.connected) { throw new Error('OneDrive request was cancelled.'); }
  }

  private setOnline(online: boolean): void {
    if (this.online === online) { return; }
    this.online = online;
    this.rs._emit(online ? 'network-online' : 'network-offline');
  }

  private itemPath(path: string): string {
    if (!this.root || !this.connected) { throw new Error('OneDrive is not connected.'); }
    const parts = pathSegments(path);
    return '/me/drive/items/' + encodeURIComponent(this.root) + (parts.length ? ':/' + parts.join('/') : '');
  }

  private async metadata(path: string): Promise<{ response: Response; item?: DriveItem }> {
    const generation = this.generation;
    const response = await this.send(this.itemPath(path));
    const item = response.ok ? await response.json() : undefined;
    this.assertGeneration(generation);
    return { response, item };
  }

  async get(path: string, options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    const generation = this.generation;
    const { response, item } = await this.metadata(path);
    if (!response.ok) { return { statusCode: response.status }; }
    if (!item.eTag) { throw new Error('OneDrive did not supply an item validator.'); }
    if (options.ifMatch && options.ifMatch !== '*' && this.addQuotes(options.ifMatch) !== item.eTag) { return { statusCode: 412 }; }
    // Folder ETags need not cover descendants. Always enumerate the children.
    if (!item.folder && options.ifNoneMatch && (options.ifNoneMatch === '*' || this.addQuotes(options.ifNoneMatch) === item.eTag)) {
      return { statusCode: 304, revision: this.stripQuotes(item.eTag) };
    }
    if (path.endsWith('/')) {
      if (!item.folder) { return { statusCode: 404 }; }
      const items: Record<string, { ETag: string }> = {};
      let next = '/me/drive/items/' + encodeURIComponent(item.id) + '/children';
      const visited = new Set<string>();
      while (next) {
        if (visited.has(next)) { throw new Error('OneDrive returned a pagination cycle.'); }
        visited.add(next);
        const page = await this.send(next);
        if (!page.ok) { return { statusCode: page.status }; }
        const data = await page.json();
        this.assertGeneration(generation);
        if (!Array.isArray(data.value)) { throw new Error('Invalid OneDrive directory listing.'); }
        for (const child of data.value as DriveItem[]) {
          const name = decodeName(child.name);
          if (name === undefined) { continue; }
          if (!child.eTag) { throw new Error('OneDrive returned a child without a validator.'); }
          items[name + (child.folder ? '/' : '')] = { ETag: this.stripQuotes(child.eTag) };
        }
        next = data['@odata.nextLink'];
      }
      return { statusCode: 200, revision: this.stripQuotes(item.eTag), contentType: 'application/ld+json',
        body: { '@context': 'http://remotestorage.io/spec/folder-description', items } };
    }
    if (item.folder) { return { statusCode: 404 }; }
    const downloadURL = new URL(item['@microsoft.graph.downloadUrl']);
    if (downloadURL.protocol !== 'https:' || downloadURL.username || downloadURL.password) {
      throw new Error('Invalid OneDrive download URL.');
    }
    // A Graph download URL is a short-lived capability. Never attach the Graph token.
    const file = await this.request(downloadURL.href, { credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (generation !== this.generation) { throw new Error('OneDrive download was cancelled.'); }
    if (!file.ok) { return { statusCode: file.status }; }
    const decoded = decodeRecord(await file.json());
    this.assertGeneration(generation);
    // The item may have changed between metadata and download. Never label newer
    // bytes with an older validator (which would corrupt conflict detection).
    const after = await this.metadata(path);
    if (!after.response.ok || after.item.eTag !== item.eTag) {
      throw new Error('OneDrive changed during download; retry the read.');
    }
    return { statusCode: 200, revision: this.stripQuotes(item.eTag), ...decoded };
  }

  private async ensureParents(path: string, generation: number): Promise<RemoteResponse | undefined> {
    const parts = pathSegments(path);
    let parent = this.root;
    for (const name of parts.slice(0, -1)) {
      this.assertGeneration(generation);
      const endpoint = '/me/drive/items/' + encodeURIComponent(parent);
      let response = await this.send(endpoint + ':/' + name);
      this.assertGeneration(generation);
      if (response.status === 404) {
        response = await this.send(endpoint + '/children', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
        if (response.status === 409) { response = await this.send(endpoint + ':/' + name); }
      }
      if (!response.ok) { return { statusCode: response.status }; }
      const item = await response.json() as DriveItem;
      this.assertGeneration(generation);
      if (!item.folder || !item.id) { throw new Error('OneDrive parent is not a folder.'); }
      parent = item.id;
    }
  }

  async put(path: string, body: XMLHttpRequestBodyInit, contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) { throw new Error('Cannot PUT a OneDrive folder.'); }
    const generation = this.generation;
    this.itemPath(path);
    const payload = await encodeRecord(body, contentType);
    this.assertGeneration(generation);
    const parentError = await this.ensureParents(path, generation);
    if (parentError) { return parentError; }
    this.assertGeneration(generation);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.ifMatch) { headers.set('If-Match', this.addQuotes(options.ifMatch)); }
    const createOnly = options.ifNoneMatch === '*';
    if (options.ifNoneMatch && !createOnly) { throw new Error('Unsupported OneDrive write condition.'); }
    // Fail atomically on a name collision instead of silently replacing it.
    const response = await this.send(this.itemPath(path) + ':/content' +
      (createOnly ? '?@microsoft.graph.conflictBehavior=fail' : ''), { method: 'PUT', headers, body: payload });
    if (createOnly && response.status === 409) { return { statusCode: 412 }; }
    if (!response.ok) { return { statusCode: response.status }; }
    const item = await response.json() as DriveItem;
    this.assertGeneration(generation);
    if (!item.eTag) { throw new Error('OneDrive write returned no validator; re-read before retrying.'); }
    return { statusCode: response.status, revision: this.stripQuotes(item.eTag) };
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    if (path.endsWith('/')) { throw new Error('Cannot delete a OneDrive folder through rs.js.'); }
    const headers = new Headers();
    if (options.ifMatch) { headers.set('If-Match', this.addQuotes(options.ifMatch)); }
    const response = await this.send(this.itemPath(path), { method: 'DELETE', headers });
    return { statusCode: response.status };
  }

  /** OneDrive records are private; connection must never publish them implicitly. */
  async getItemURL(): Promise<undefined> { return undefined; }

  static isRedirect(url: string): boolean {
    try {
      if (!window.opener) { return false; }
      const pending = JSON.parse(sessionStorage.getItem(POPUP_KEY));
      const current = new URL(url);
      return pending?.url === current.origin + current.pathname &&
        Date.now() >= pending.created && Date.now() - pending.created < 10 * 60 * 1000;
    } catch { return false; }
  }

  static _rs_init(rs: RemoteStorage): void {
    rs.onedrive = new OneDrive(rs);
    const key = rs.apiKeys.onedrive?.clientId;
    if (key) { rs.onedrive.setClientId(key); }
    if (rs.backend === 'onedrive') {
      rs.onedrive.previousRemote = rs.remote;
      rs.remote = rs.onedrive;
    }
  }

  static _rs_supported(): boolean { return typeof window !== 'undefined' && typeof fetch === 'function'; }

  static _rs_cleanup(rs: RemoteStorage): void {
    const backend = rs.onedrive;
    if (!backend) { return; }
    backend.configure({ userAddress: null, token: null });
    if (rs.remote === backend && backend.previousRemote) { rs.remote = backend.previousRemote; }
    delete rs.onedrive;
  }
}

export = OneDrive;
