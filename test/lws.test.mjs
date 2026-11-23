import assert from 'node:assert/strict';
import { test } from 'node:test';
const { default: LWS } = await import(process.env.LWS_TEST_MODULE || '../build/lws.js');
const storage = 'https://pods.example/alice';
const root = 'https://pods.example/data/';
const issuer = 'https://login.example';
const metadata = 'https://pods.example/metadata';
const desc = { id: storage, type: 'Storage', service: [{ type: 'StorageRoot', serviceEndpoint: root }] };
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
function fixture(protectedPod = false) {
  const events = [], calls = [];
  const rs = { remote: { connected: false }, local: {}, _emit: (...args) => events.push(args), _fireReady() {}, setBackend(value) { this.backend = value; } };
  const backend = new LWS(rs);
  const routes = new Map([
    [storage, () => response(desc)],
    [root, options => protectedPod && !new Headers(options.headers).has('Authorization') ? response(null, 401, { 'WWW-Authenticate': 'Bearer resource_metadata="' + metadata + '"' }) : response({ id: root, type: 'Container', items: [] })],
    [metadata, () => response({ resource: root, authorization_servers: [issuer] })],
    [issuer + '/.well-known/lws-configuration', () => response({ issuer, grant_types_supported: ['urn:ietf:params:oauth:grant-type:token-exchange'], token_endpoint: issuer + '/token' })],
    [issuer + '/token', () => response({ token_type: 'Bearer', access_token: 'secret-access-token', expires_in: 300 })]
  ]);
  backend.request = async (url, options) => {
    calls.push({ url, options });
    assert.ok(routes.has(url), 'Unexpected request: ' + url);
    return routes.get(url)(options);
  };
  backend.setStorageURL(storage);
  return { backend, rs, calls, routes, events };
}

test('storage URL discovery activates LWS and emits connected only when ready', async () => {
  const { backend, rs, events } = fixture();
  await backend.connect();
  assert.equal(rs.backend, 'lws');
  assert.equal(rs.remote, backend);
  assert.equal(backend.href, root);
  assert.equal(backend.userAddress, storage);
  assert.deepEqual(events, [['connected']]);
  assert.equal(backend.getFileURL('/notes/a.json'), root + 'notes/a.json');
});

test('protected storage without a credential provider never reports connected', async () => {
  const { backend, rs, events } = fixture(true);
  await assert.rejects(backend.connect(), /requires sign-in/);
  assert.equal(rs.backend, undefined);
  assert.equal(backend.connected, false);
  assert.deepEqual(events, []);
});

test('exchanges a subject credential for the storage audience, not the root', async () => {
  const { backend, calls, routes } = fixture(true);
  backend.setCredentialProvider(async context => {
    assert.equal(context.storage, storage);
    return { token: 'subject-credential', type: 'urn:ietf:params:oauth:token-type:id_token' };
  });
  await backend.connect();
  const exchange = calls.find(c => c.url === issuer + '/token');
  const body = new URLSearchParams(exchange.options.body);
  assert.equal(body.get('resource'), storage);
  assert.equal(body.get('subject_token'), 'subject-credential');
  assert.equal(exchange.options.redirect, 'error');
  for (const call of calls.slice(0, calls.indexOf(exchange) + 1)) assert.equal(new Headers(call.options.headers).has('Authorization'), false);
  routes.set(root + 'a.json', options => {
    assert.equal(options.headers.get('Authorization'), 'Bearer secret-access-token');
    return response({ hello: 'world' }, 200, { 'Content-Type': 'application/json', ETag: '"rev1"' });
  });
  const result = await backend.get('/a.json');
  assert.deepEqual(result.body, { hello: 'world' });
  assert.equal(result.revision, 'rev1');
});

test('conditional writes and deletes preserve preconditions and status codes', async () => {
  const { backend, routes } = fixture(); await backend.connect();
  routes.set(root + 'a', options => {
    if (options.method === 'HEAD') return response(null, 200, { ETag: '"old"' });
    assert.equal(options.headers.get('If-Match'), '"old"');
    return response(null, 412);
  });
  assert.equal((await backend.put('/a', 'new', 'text/plain', { ifMatch: 'old' })).statusCode, 412);
  assert.equal((await backend.delete('/a', { ifMatch: 'old' })).statusCode, 412);
  routes.set(root + 'new', () => response(null, 404));
  assert.equal((await backend.put('/new', 'new', 'text/plain', { ifMatch: 'old' })).statusCode, 412);
});

test('rs.js validators are independent of the browser HTTP cache', async () => {
  const { backend, routes, calls } = fixture(); await backend.connect();
  const start = calls.length;
  routes.set(root + 'a', options => {
    assert.equal(options.cache, 'no-store');
    if (options.method === 'HEAD') {
      assert.equal(options.headers.has('If-None-Match'), false);
      return response(null, 200, { ETag: '"old"' });
    }
    if (options.method) {
      assert.equal(options.headers.get('If-Match'), '"old"');
      return response(null, 204);
    }
    assert.equal(options.headers.get('If-None-Match'), '"old"');
    return response(null, 304, { ETag: '"old"' });
  });
  assert.equal((await backend.get('/a', { ifNoneMatch: 'old' })).statusCode, 304);
  assert.equal((await backend.put('/a', 'new', 'text/plain', { ifMatch: 'old' })).statusCode, 204);
  assert.equal((await backend.delete('/a', { ifMatch: 'old' })).statusCode, 204);
  assert.ok(calls.length > start);
  for (const call of calls.slice(start)) assert.equal(call.options.cache, 'no-store');
});

test('lists paginated containers using real member ETags', async () => {
  const { backend, routes } = fixture(); await backend.connect();
  routes.set(root, () => response({ id: root, type: 'Container', items: [{ id: root + 'a', type: 'DataResource', format: 'text/plain' }] }, 200, { Link: '<' + root + '?page=2>; rel="next"' }));
  routes.set(root + '?page=2', () => response({ id: root, type: 'Container', items: [{ id: root + 'b/', type: 'Container' }] }));
  routes.set(root + 'a', () => response(null, 200, { ETag: '"a1"' }));
  routes.set(root + 'b/', () => response(null, 200, { ETag: '"b1"' }));
  const result = await backend.get('/');
  assert.deepEqual(Object.keys(result.body), ['a', 'b/']);
  assert.equal(result.body.a.ETag, 'a1');
  assert.equal(result.body['b/'].ETag, 'b1');
  assert.equal(result.revision, undefined);
});

test('refuses traversal and off-origin pagination before sending credentials', async () => {
  const { backend, routes, calls } = fixture(); await backend.connect();
  for (const path of ['/../secret', '/%2e%2e/secret', '/%2fsecret', '/a?x=1', '/a\\b']) assert.throws(() => backend.getFileURL(path), /path/);
  routes.set(root, () => response({ id: root, items: [] }, 200, { Link: '<https://evil.example/next>; rel="next"' }));
  await assert.rejects(backend.get('/'), /another origin|Invalid resource URL/);
  assert.equal(calls.some(c => c.url.startsWith('https://evil.example')), false);
});

test('issuer mismatch prevents credential acquisition and token exchange', async () => {
  const { backend, routes, calls } = fixture(true);
  routes.set(issuer + '/.well-known/lws-configuration', () => response({ issuer: 'https://evil.example' }));
  backend.setCredentialProvider(() => { throw new Error('must not be called'); });
  await assert.rejects(backend.connect(), /issuer mismatch/);
  assert.equal(calls.some(c => c.url.endsWith('/token')), false);
});

test('disconnect cancels an in-flight credential acquisition', async () => {
  const { backend } = fixture(true);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  backend.setCredentialProvider(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { token: 'secret', type: 'jwt' }; });
  const connecting = backend.connect();
  await waiting;
  backend.configure({ userAddress: null }); release();
  await assert.rejects(connecting, /cancelled/);
  assert.equal(backend.connected, false);
});
