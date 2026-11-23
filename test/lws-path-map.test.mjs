import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './lws-server.cjs';
const { default: LWS } = await import(process.env.LWS_TEST_MODULE || '../build/lws.js');
const media = 'application/vnd.remotestorage.lws-index+json';
async function client(server) {
  const rs = { remote: { connected: false }, local: {}, setBackend() {}, _fireReady() {}, _emit() {} };
  const lws = new LWS(rs); if (server.fetch) lws.request = server.fetch; lws.setStorageURL(server.base + '/storage'); await lws.connect(); return lws;
}
test('create, reload, list, update and delete work with opaque server-assigned URLs', async t => {
  const server = await createServer(); t.after(server.close);
  let lws = await client(server);
  assert.equal((await lws.put('/notes/drafts/a.json', '{"title":"first"}', 'application/json', { ifNoneMatch: '*' })).statusCode, 201);
  const url = lws.getFileURL('/notes/drafts/a.json');
  assert.match(url, /\/objects\/\d+$/);
  assert.equal((await lws.get('/')).body['notes/'].ETag.length, 64);
  assert.ok((await lws.get('/notes/')).body['drafts/']);
  assert.ok((await lws.get('/notes/drafts/')).body['a.json']);
  lws = await client(server);
  const loaded = await lws.get('/notes/drafts/a.json');
  assert.deepEqual(JSON.parse(loaded.body), { title: 'first' });
  assert.equal(lws.getFileURL('/notes/drafts/a.json'), url);
  assert.equal((await lws.put('/notes/drafts/a.json', '{"title":"second"}', 'application/json', { ifMatch: loaded.revision })).statusCode, 204);
  assert.equal((await lws.delete('/notes/drafts/a.json', { ifMatch: loaded.revision })).statusCode, 412);
  const updated = await lws.get('/notes/drafts/a.json');
  assert.equal((await lws.delete('/notes/drafts/a.json', { ifMatch: updated.revision })).statusCode, 204);
  assert.equal((await lws.get('/notes/drafts/a.json')).statusCode, 404);
  assert.deepEqual(Object.keys((await lws.get('/')).body), []);
  assert.equal([...server.resources.values()].filter(r => r.type !== media).length, 0);
});
test('two clients creating the same rs.js path do not overwrite the winning file', async t => {
  const server = await createServer(); t.after(server.close);
  const first = await client(server);
  await first.put('/seed', 'seed', 'text/plain', { ifNoneMatch: '*' });
  const second = await client(server);
  const results = await Promise.all([first.put('/race', 'first', 'text/plain', { ifNoneMatch: '*' }), second.put('/race', 'second', 'text/plain', { ifNoneMatch: '*' })]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 412]);
  const winner = await first.get('/race');
  assert.ok(['first', 'second'].includes(winner.body));
  assert.equal([...server.resources.values()].filter(r => r.type !== media).length, 2);
});
test('concurrent different paths are merged through index compare-and-swap', async t => {
  const server = await createServer(); t.after(server.close);
  const a = await client(server); await a.put('/seed', 'seed', 'text/plain');
  const b = await client(server);
  await Promise.all([a.put('/a', 'a', 'text/plain'), b.put('/b', 'b', 'text/plain')]);
  assert.equal((await a.get('/a')).body, 'a');
  assert.equal((await b.get('/b')).body, 'b');
  assert.ok(server.requests.some(r => r.method === 'PUT' && r.headers['if-match']));
});
test('ambiguous indexes and unsafe index targets fail before file mutations', async t => {
  const server = await createServer(); t.after(server.close);
  const a = await client(server); await a.put('/seed', 'seed', 'text/plain');
  const index = [...server.resources].find(([, r]) => r.type === media);
  server.resources.set(server.base + '/duplicate', { ...index[1] });
  await assert.rejects(a.put('/unsafe', 'x', 'text/plain'), /Multiple/);
  server.resources.delete(server.base + '/duplicate');
  index[1].body = JSON.stringify({ version: 1, storage: server.base + '/storage', entries: { '/seed': 'https://evil.example/secret' } });
  await assert.rejects(a.get('/seed'), /Invalid resource URL/);
  assert.equal(server.requests.some(r => r.body === 'x'), false);
});
test('an indeterminate index commit keeps the already-created data recoverable', async t => {
  const server = await createServer(); t.after(server.close);
  const a = await client(server); await a.put('/seed', 'seed', 'text/plain');
  const send = a.request;
  a.request = async (url, init) => {
    const response = await send(url, init);
    if (init.method === 'PUT' && init.headers.get('Content-Type') === media) throw new Error('response lost');
    return response;
  };
  await assert.rejects(a.put('/recover', 'safe', 'text/plain'), /response lost/);
  const b = await client(server);
  assert.equal((await b.get('/recover')).body, 'safe');
  assert.equal((await b.put('/recover', 'retry', 'text/plain', { ifNoneMatch: '*' })).statusCode, 412);
});

test('a stale mapping can be replaced after its resource was removed outside rs.js', async t => {
  const server = await createServer(); t.after(server.close);
  const a = await client(server); await a.put('/note', 'first', 'text/plain');
  const original = a.getFileURL('/note'); server.resources.delete(original);
  assert.equal((await a.put('/note', 'second', 'text/plain', { ifNoneMatch: '*' })).statusCode, 201);
  assert.notEqual(a.getFileURL('/note'), original);
  assert.equal((await a.get('/note')).body, 'second');
});

test('existing native files and foreign opaque resources survive rs.js writes', async t => {
  const server = await createServer({ rootPath: '/root/' }); t.after(server.close);
  server.resources.set(server.base + '/root/existing.txt', { body: 'existing native file', type: 'text/plain', revision: 100 });
  server.resources.set(server.base + '/foreign', { body: 'another app', type: 'text/plain', revision: 101 });
  const a = await client(server);
  assert.equal((await a.get('/existing.txt')).body, 'existing native file');
  assert.equal((await a.put('/existing.txt', 'do not overwrite', 'text/plain', { ifNoneMatch: '*' })).statusCode, 412);
  await a.put('/notes/new.txt', 'new', 'text/plain', { ifNoneMatch: '*' });
  assert.deepEqual(Object.keys((await a.get('/')).body).sort(), ['existing.txt', 'notes/']);
  assert.equal(server.resources.get(server.base + '/foreign').body, 'another app');
  assert.equal(server.resources.get(server.base + '/root/existing.txt').body, 'existing native file');
});


function unknownFormats(server, headStatus) {
  const send = server.fetch || globalThis.fetch;
  return { ...server, fetch: async (url, init = {}) => {
    if (init.method === 'HEAD' && headStatus) { return new Response(null, { status: headStatus }); }
    const response = await send(url, init);
    if ((!init.method || init.method === 'GET') && response.headers.get('content-type') === 'application/lws+json') {
      const data = await response.json();
      data.items = data.items.map(item => ({ ...item, format: 'application/octet-stream' }));
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    }
    return response;
  } };
}

test('unknown listing formats are resolved by HEAD without replacing native resources or duplicating the index', async t => {
  const server = await createServer(); t.after(server.close);
  server.resources.set(server.base + '/native', { type: 'application/octet-stream', body: 'native bytes', revision: 100 });
  const projected = unknownFormats(server);
  const a = await client(projected);
  await a.put('/note', 'first', 'text/plain', { ifNoneMatch: '*' });
  const b = await client(projected);
  const before = await b.get('/note');
  assert.equal(before.body, 'first');
  await b.put('/note', 'second', 'text/plain', { ifMatch: before.revision });
  assert.equal((await a.get('/note')).body, 'second');
  assert.equal([...server.resources.values()].filter(record => record.type === media).length, 1);
  assert.equal(server.resources.get(server.base + '/native').body, 'native bytes');
  assert.equal(server.requests.some(request => request.path === '/native' && request.method === 'GET'), false);
  assert.ok(server.requests.some(request => request.path === '/native' && request.method === 'HEAD'));
});

test('unknown listing formats still refuse multiple valid indexes', async t => {
  const server = await createServer(); t.after(server.close);
  const a = await client(server); await a.put('/seed', 'seed', 'text/plain');
  const index = [...server.resources.values()].find(record => record.type === media);
  server.resources.set(server.base + '/duplicate', { ...index });
  await assert.rejects(client(unknownFormats(server)), /Multiple/);
});

for (const status of [401, 500]) test('failed HEAD discovery (' + status + ') cannot create a new index', async t => {
  const server = await createServer(); t.after(server.close);
  server.resources.set(server.base + '/unknown', { type: 'application/octet-stream', body: 'unreadable', revision: 100 });
  await assert.rejects(client(unknownFormats(server, status)), /Cannot discover.*HTTP /);
  assert.equal(server.requests.some(request => request.method === 'POST'), false);
});

test('unknown member media discovery is bounded to four HEAD requests at once', async t => {
  const server = await createServer(); t.after(server.close);
  for (let i = 0; i < 9; i++) server.resources.set(server.base + '/binary-' + i, { type: 'application/octet-stream', body: 'bytes', revision: 100 + i });
  const projected = unknownFormats(server), send = projected.fetch;
  let active = 0, maximum = 0;
  projected.fetch = async (url, init = {}) => {
    if (init.method !== 'HEAD') return send(url, init);
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await send(url, init); }
    finally { active--; }
  };
  await client(projected);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});
