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
  assert.deepEqual(loaded.body, { title: 'first' });
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
