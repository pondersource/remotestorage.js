import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);
import OneDrive from '../../build/onedrive.js';
import { RemoteStorage } from '../../build/remotestorage.js';
import { encodeName, decodeName, encodeRecord, decodeRecord } from '../../build/onedrive-format.js';

function fixture() {
  const calls = [], events = [];
  const rs = { remote: { connected: false }, local: {}, apiKeys: {}, _fireReady() {},
    setBackend(value) { this.backend = value; }, _emit(...args) { events.push(args); } };
  const backend = new OneDrive(rs);
  backend.auth = { async loginPopup() { return { account: { username: 'alice@example.test' } }; },
    async acquireTokenSilent() { return { accessToken: 'graph-test-token' }; }, async clearCache() {} };
  backend.clientId = 'test-client-id';
  backend.initialized = Promise.resolve();
  backend.redirectUri = 'https://app.example.test/';
  const routes = new Map();
  routes.set('https://graph.microsoft.com/v1.0/me/drive/special/approot', () => json({ id: 'root', folder: {} }));
  backend.request = async (url, init = {}) => {
    calls.push({ url, init });
    if (!routes.has(url)) throw new Error('Unexpected URL: ' + url);
    return routes.get(url)(init);
  };
  return { backend, rs, routes, calls, events };
}
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
const item = 'https://graph.microsoft.com/v1.0/me/drive/items/root:/';

describe('OneDrive experimental backend', function() {
  it('configures an optional registration without initializing MSAL or needing Web Crypto', async function() {
    const descriptors = ['window', 'crypto'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://app:8000' } } });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    try {
      const f = fixture();
      f.backend.setClientId('public-registration');
      expect(f.backend.auth).to.equal(undefined);
      expect(f.backend.initialized).to.equal(undefined);
      await expect(f.backend.connect()).to.be.rejectedWith('secure context');
      expect(f.backend.auth).to.equal(undefined);
      expect(f.rs.remote).not.to.equal(f.backend);
      expect(f.calls).to.have.length(0);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) { Object.defineProperty(globalThis, name, descriptor); } else { delete globalThis[name]; }
      }
    }
  });

  it('cancels a disconnected attempt before initialization can open a popup', async function() {
    const f = fixture(); let initialize, popups = 0;
    f.backend.initialized = new Promise(resolve => { initialize = resolve; });
    f.backend.auth.loginPopup = async () => { popups++; return { account: {} }; };
    const pending = f.backend.connect();
    f.backend.configure({ userAddress: null, token: null });
    initialize();
    await expect(pending).to.be.rejectedWith('cancelled');
    expect(popups).to.equal(0);
    expect(f.calls).to.have.length(0);
  });

  it('drops a pending initialization when the registration is replaced', async function() {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://app.example.test' } } });
    try {
      const f = fixture(); let initialize, popups = 0;
      f.backend.initialized = new Promise(resolve => { initialize = resolve; });
      f.backend.auth.loginPopup = async () => { popups++; return { account: {} }; };
      const pending = f.backend.connect();
      f.backend.setClientId('replacement-registration');
      initialize();
      await expect(pending).to.be.rejectedWith('cancelled');
      expect(f.backend.clientId).to.equal('replacement-registration');
      expect(f.backend.auth).to.equal(undefined);
      expect(popups).to.equal(0);
      expect(f.calls).to.have.length(0);
    } finally {
      if (descriptor) { Object.defineProperty(globalThis, 'window', descriptor); } else { delete globalThis.window; }
    }
  });

  it('does not remove a replacement popup callback marker when an old login finishes', async function() {
    const descriptors = ['window', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { opener: {}, location: { origin: 'https://app.example.test' } } });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
    try {
      const f = fixture(); let oldLogin, newLogin;
      f.backend.auth.loginPopup = () => new Promise(resolve => { oldLogin = resolve; });
      const old = f.backend.connect();
      await new Promise(resolve => setImmediate(resolve));
      f.backend.setClientId('replacement-registration');
      f.backend.auth = { ...fixture().backend.auth, loginPopup: () => new Promise(resolve => { newLogin = resolve; }) };
      f.backend.initialized = Promise.resolve();
      const replacement = f.backend.connect();
      await new Promise(resolve => setImmediate(resolve));
      const marker = storage.getItem('remotestorage:onedrive-popup');
      oldLogin({ account: { username: 'old@example.test' } });
      await expect(old).to.be.rejectedWith('cancelled');
      expect(storage.getItem('remotestorage:onedrive-popup')).to.equal(marker);
      expect(OneDrive.isRedirect('https://app.example.test/?code=native')).to.equal(true);
      newLogin({ account: { username: 'replacement@example.test' } });
      await replacement;
      expect(f.backend.userAddress).to.equal('replacement@example.test');
      expect(storage.getItem('remotestorage:onedrive-popup')).to.equal(null);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) { Object.defineProperty(globalThis, name, descriptor); } else { delete globalThis[name]; }
      }
    }
  });

  it('clears a failed MSAL initialization and exposes a recoverable connection error', async function() {
    const f = fixture();
    f.backend.initialized = Promise.reject(new Error('Initialization failed'));
    await expect(f.backend.connect()).to.be.rejectedWith('Initialization failed');
    expect(f.backend.auth).to.equal(undefined);
    expect(f.backend.initialized).to.equal(undefined);
    expect(f.calls).to.have.length(0);
  });

  it('observes MSAL cleanup failures instead of leaving an unhandled rejection', async function() {
    const f = fixture(); f.rs.onedrive = f.backend;
    f.backend.auth.clearCache = async () => { throw new Error('Cleanup failed'); };
    f.backend.configure({ userAddress: null, token: null });
    expect(f.backend.auth).to.equal(undefined);
    expect(f.backend.initialized).to.equal(undefined);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.events.some(event => event[0] === 'error' && event[1].message === 'Cleanup failed')).to.equal(true);
  });

  it('connects through MSAL and opens only the consenting account app folder', async function() {
    const f = fixture();
    await f.backend.connect();
    expect(f.rs.backend).to.equal('onedrive');
    expect(f.rs.remote).to.equal(f.backend);
    expect(f.backend.userAddress).to.equal('alice@example.test');
    expect(f.events).to.deep.equal([['connected']]);
    expect(new Headers(f.calls[0].init.headers).get('Authorization')).to.equal('Bearer graph-test-token');
    expect(f.calls[0].init).to.include({ credentials: 'omit', redirect: 'error' });
  });

  it('preserves Unicode names, text, JSON, binary bytes and MIME types', async function() {
    expect(decodeName(encodeName('café: notes?.json'))).to.equal('café: notes?.json');
    for (const [body, contentType, expected] of [
      ['hello 😀', 'text/plain;charset=utf-8', 'hello 😀'],
      ['{"title":"Café"}', 'application/json', { title: 'Café' }],
      [new Uint8Array([0, 255, 1]).buffer, 'image/png', new Uint8Array([0, 255, 1]).buffer]
    ]) {
      expect(decodeRecord(JSON.parse(await encodeRecord(body, contentType)))).to.deep.equal({ body: expected, contentType });
    }
    expect(decodeRecord(JSON.parse(await encodeRecord('{broken', 'application/json'))).body).to.equal('{broken');
    for (const type of ['text/plain', 'text/plain;charset=utf-16']) {
      const bytes = new Uint8Array([255, 254, 65, 0]).buffer;
      expect(decodeRecord(JSON.parse(await encodeRecord(bytes, type))).body).to.deep.equal(bytes);
    }
    expect(() => decodeRecord({ version: 99 })).to.throw('Unrecognized');
  });

  it('downloads a capability without Graph credentials and revalidates metadata', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set(item + encodeName('note'), () => json({ id: 'note', eTag: '"1"', '@microsoft.graph.downloadUrl': 'https://download.example.test/file' }));
    f.routes.set('https://download.example.test/file', init => {
      expect(new Headers(init.headers).has('Authorization')).to.equal(false);
      expect(init.credentials).to.equal('omit');
      return json({ version: 1, contentType: 'text/plain', data: 'aGVsbG8' });
    });
    expect(await f.backend.get('/note')).to.deep.equal({ statusCode: 200, revision: '1', contentType: 'text/plain', body: 'hello' });
    expect((await f.backend.get('/note', { ifNoneMatch: '1' })).statusCode).to.equal(304);
    expect((await f.backend.get('/note', { ifNoneMatch: '*' })).statusCode).to.equal(304);
    expect((await f.backend.get('/note', { ifMatch: '*' })).statusCode).to.equal(200);
  });

  it('never attaches an old validator to bytes from a concurrent edit', async function() {
    const f = fixture(); await f.backend.connect(); let reads = 0;
    f.routes.set(item + encodeName('note'), () => json({ id: 'note', eTag: '"' + (++reads) + '"', '@microsoft.graph.downloadUrl': 'https://download.example.test/file' }));
    f.routes.set('https://download.example.test/file', () => json({ version: 1, contentType: 'text/plain', data: 'aGVsbG8' }));
    await expect(f.backend.get('/note')).to.be.rejectedWith('changed during download');
  });

  it('reads all listing pages and omits foreign files without modifying them', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root', () => json({ id: 'root', folder: {}, eTag: '"root1"' }));
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root/children', () => json({ value: [
      { name: encodeName('notes'), folder: {}, eTag: '"d1"' }, { name: 'foreign.json', eTag: '"other"' }
    ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }));
    f.routes.set('https://graph.microsoft.com/v1.0/next', () => json({ value: [{ name: encodeName('x'), eTag: '"x1"' }] }));
    const result = await f.backend.get('/', { ifNoneMatch: 'root1' });
    expect(result.statusCode).to.equal(200);
    expect(result.body.items).to.deep.equal({ 'notes/': { ETag: 'd1' }, x: { ETag: 'x1' } });
    expect(f.backend.folderETagsAreRecursive).to.equal(false);
  });

  it('rejects off-origin pagination without disclosing a token', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root', () => json({ id: 'root', folder: {}, eTag: '"1"' }));
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root/children', () => json({ value: [], '@odata.nextLink': 'https://evil.example/steal' }));
    await expect(f.backend.get('/')).to.be.rejectedWith('untrusted URL');
    expect(f.calls.some(call => call.url.includes('evil.example'))).to.equal(false);
  });

  it('sends compare-and-swap conditions and exposes create/update conflicts', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set(item + encodeName('note') + ':/content', init => {
      expect(new Headers(init.headers).get('If-Match')).to.equal('"old"');
      return json(null, 412);
    });
    f.routes.set(item + encodeName('note') + ':/content?@microsoft.graph.conflictBehavior=fail', () => json(null, 409));
    expect((await f.backend.put('/note', 'new', 'text/plain', { ifMatch: 'old' })).statusCode).to.equal(412);
    expect((await f.backend.put('/note', 'new', 'text/plain', { ifNoneMatch: '*' })).statusCode).to.equal(412);
  });

  it('returns the write validator and preserves the single record envelope', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set(item + encodeName('note') + ':/content', init => {
      expect(decodeRecord(JSON.parse(init.body))).to.deep.equal({ body: 'new', contentType: 'text/plain' });
      return json({ id: 'note', eTag: '"new1"' }, 201);
    });
    expect(await f.backend.put('/note', 'new', 'text/plain')).to.deep.equal({ statusCode: 201, revision: 'new1' });
  });

  it('creates parents with fail-on-conflict and discovers a concurrent parent', async function() {
    const f = fixture(); await f.backend.connect(); let reads = 0;
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root:/' + encodeName('notes'), () =>
      ++reads === 1 ? json(null, 404) : json({ id: 'parent', folder: {} }));
    f.routes.set('https://graph.microsoft.com/v1.0/me/drive/items/root/children', init => {
      expect(JSON.parse(init.body)['@microsoft.graph.conflictBehavior']).to.equal('fail'); return json(null, 409);
    });
    f.routes.set(item + encodeName('notes') + '/' + encodeName('a') + ':/content', () => json({ eTag: '"new"' }, 201));
    expect((await f.backend.put('/notes/a', 'hello', 'text/plain')).statusCode).to.equal(201);
  });

  it('deletes conditionally, forbids folders, and never publishes a private record', async function() {
    const f = fixture(); await f.backend.connect();
    f.routes.set(item + encodeName('note'), init => {
      expect(init.method).to.equal('DELETE'); expect(new Headers(init.headers).get('If-Match')).to.equal('"1"'); return json(null, 204);
    });
    expect((await f.backend.delete('/note', { ifMatch: '1' })).statusCode).to.equal(204);
    await expect(f.backend.delete('/notes/')).to.be.rejectedWith('folder');
    expect(await f.backend.getItemURL('/public/note')).to.equal(undefined);
  });

  it('rejects traversal and malformed paths before making network requests', async function() {
    const f = fixture(); await f.backend.connect(); const count = f.calls.length;
    for (const path of ['/../a', '/a//b', '/a/./b', '/a\\b', 'relative']) {
      await expect(f.backend.get(path)).to.be.rejected;
    }
    expect(f.calls.length).to.equal(count);
  });

  it('discard results from in-flight requests after disconnect', async function() {
    const f = fixture(); await f.backend.connect(); let release;
    f.routes.set(item + encodeName('note'), () => new Promise(resolve => { release = resolve; }));
    const pending = f.backend.get('/note');
    await new Promise(resolve => setImmediate(resolve));
    f.backend.configure({ userAddress: null, token: null });
    release(json({ id: 'note', eTag: '"1"' }));
    await expect(pending).to.be.rejectedWith('cancelled');
    expect(f.backend.connected).to.equal(false);
  });

  it('cannot write an old account payload after a delayed Blob conversion', async function() {
    const f = fixture(); await f.backend.connect(); let release;
    const body = new Blob(['old account content']);
    body.arrayBuffer = () => new Promise(resolve => { release = resolve; });
    const pending = f.backend.put('/note', body, 'text/plain');
    const count = f.calls.length;
    f.backend.configure({ userAddress: null, token: null });
    release(new TextEncoder().encode('old account content').buffer);
    await expect(pending).to.be.rejectedWith('cancelled');
    expect(f.calls.length).to.equal(count);
  });

  it('does not mark a new session offline when an old network request fails', async function() {
    const f = fixture(); await f.backend.connect(); let rejectRequest;
    f.routes.set(item + encodeName('note'), () => new Promise((resolve, reject) => { rejectRequest = reject; }));
    const pending = f.backend.get('/note');
    await new Promise(resolve => setImmediate(resolve));
    f.backend.configure({ userAddress: null, token: null });
    rejectRequest(new Error('Old network failure'));
    await expect(pending).to.be.rejectedWith('Old network failure');
    expect(f.events.some(event => event[0] === 'network-offline')).to.equal(false);
    expect(f.backend.online).to.equal(true);
  });

  it('reports a rejected native reconnect through the normal error event', async function() {
    const f = fixture(); await f.backend.connect();
    f.backend.auth.loginPopup = async () => { throw new Error('Popup cancelled'); };
    RemoteStorage.prototype.reconnect.call(f.rs);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.events.some(event => event[0] === 'error' && event[1].message === 'Popup cancelled')).to.equal(true);
  });

  it('drops an old metadata body that finishes after disconnect', async function() {
    const f = fixture(); await f.backend.connect(); let release;
    f.routes.set(item + encodeName('note'), () => {
      const response = json({});
      response.json = () => new Promise(resolve => { release = resolve; });
      return response;
    });
    const pending = f.backend.get('/note');
    await new Promise(resolve => setImmediate(resolve));
    f.backend.configure({ userAddress: null, token: null });
    release({ id: 'note', eTag: '"1"' });
    await expect(pending).to.be.rejectedWith('cancelled');
  });
});
