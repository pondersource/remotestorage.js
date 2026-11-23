import assert from 'node:assert/strict';
import { test } from 'node:test';
const address = process.env.LWS_REAL_SERVER_URL;
const { default: LWS } = await import(process.env.LWS_TEST_MODULE || '../build/lws.js');
async function client() {
  const rs = { remote: { connected: false }, local: {}, setBackend() {}, _fireReady() {}, _emit() {} };
  const lws = new LWS(rs); lws.setStorageURL(address); await lws.connect(); return lws;
}
test('real LWS server: create, reload, conditional update, listing and delete', { skip: !address }, async () => {
  const path = '/interop/' + crypto.randomUUID() + '/note.json';
  const a = await client();
  assert.equal((await a.put(path, '{"title":"first"}', 'application/json', { ifNoneMatch: '*' })).statusCode, 201);
  const resource = a.getFileURL(path);
  const b = await client();
  const first = await b.get(path);
  assert.equal(first.statusCode, 200); assert.deepEqual(JSON.parse(first.body), { title: 'first' });
  assert.equal(b.getFileURL(path), resource);
  assert.equal((await b.put(path, '{"title":"do not overwrite"}', 'application/json', { ifNoneMatch: '*' })).statusCode, 412);
  assert.ok([200, 204].includes((await b.put(path, '{"title":"second"}', 'application/json', { ifMatch: first.revision })).statusCode));
  assert.equal((await a.delete(path, { ifMatch: first.revision })).statusCode, 412);
  const updated = await a.get(path);
  assert.equal(JSON.parse(updated.body).title, 'second');
  assert.ok((await a.get(path.slice(0, path.lastIndexOf('/') + 1))).body['note.json']);
  assert.ok([200, 204].includes((await a.delete(path, { ifMatch: updated.revision })).statusCode));
  assert.equal((await b.get(path)).statusCode, 404);
});
test('real LWS server: concurrent independent paths preserve both writes', { skip: !address }, async () => {
  const prefix = '/interop/' + crypto.randomUUID() + '/';
  const a = await client(), b = await client();
  const results = await Promise.all([a.put(prefix + 'a', 'A', 'text/plain', { ifNoneMatch: '*' }), b.put(prefix + 'b', 'B', 'text/plain', { ifNoneMatch: '*' })]);
  assert.deepEqual(results.map(r => r.statusCode), [201, 201]);
  for (const [name, value] of [['a', 'A'], ['b', 'B']]) {
    const file = await a.get(prefix + name); assert.equal(file.body, value);
    assert.ok([200, 204].includes((await a.delete(prefix + name, { ifMatch: file.revision })).statusCode));
  }
});
