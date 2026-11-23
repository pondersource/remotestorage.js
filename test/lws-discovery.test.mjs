import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverLWS } from '../build/lws-discovery.js';

const root = 'https://pods.example/alice/';
const issuer = 'https://login.example/';
const canonical = 'https://pods.example/.well-known/oauth-protected-resource/alice/';
const description = { id: root, type: 'Storage', service: [{ type: 'StorageRoot', serviceEndpoint: root }] };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function fixture(metadata = { resource: root, authorization_servers: [issuer] }) {
  const calls = [];
  return { calls, request: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    if (url === root) { return json(description, 200, { Link: '<' + root + '>; rel="https://www.w3.org/ns/lws#storage"' }); }
    assert.equal(url, canonical);
    return metadata instanceof Response ? metadata.clone() : json(metadata);
  } };
}

test('public storage root discovers authorization through RFC 9728 metadata without a 401', async () => {
  const f = fixture();
  const result = await discoverLWS(root, { fetch: f.request });
  assert.deepEqual(result, { storage: root, root, authorizationServers: [issuer] });
  assert.equal(f.calls.at(-1).url, canonical);
});

test('only missing public metadata permits open-mode connection', async () => {
  for (const status of [404, 410]) {
    const f = fixture(new Response(null, { status }));
    assert.deepEqual((await discoverLWS(root, { fetch: f.request })).authorizationServers, []);
  }
  for (const status of [401, 403, 500]) {
    const f = fixture(new Response(null, { status }));
    await assert.rejects(discoverLWS(root, { fetch: f.request }), /refused/);
  }
});

test('public metadata must identify the exact resource and valid authorization server', async () => {
  for (const document of [
    { resource: 'https://pods.example/bob/', authorization_servers: [issuer] },
    { resource: root, authorization_servers: [] },
    { resource: root, authorization_servers: ['http://evil.example/'] }
  ]) {
    const f = fixture(document);
    await assert.rejects(discoverLWS(root, { fetch: f.request }), /different resource|no authorization server|HTTPS/);
  }
});

test('canonical metadata preserves a resource path and query and does not fall back to origin metadata', async () => {
  const resource = root + '?view=files';
  const calls = [];
  const request = async url => {
    calls.push(url);
    if (url === resource) { return json({ ...description, id: resource, service: [{ type: 'StorageRoot', serviceEndpoint: resource }] }); }
    assert.equal(url, canonical + '?view=files');
    return json({ resource, authorization_servers: [issuer] });
  };
  assert.deepEqual((await discoverLWS(resource, { fetch: request })).authorizationServers, [issuer]);
  assert.ok(calls.every(url => url !== 'https://pods.example/.well-known/oauth-protected-resource'));
});

test('a metadata transport failure does not become an anonymous connection', async () => {
  const f = fixture();
  const request = async (url, options) => {
    if (url === canonical) { throw new TypeError('metadata CORS failed'); }
    return f.request(url, options);
  };
  await assert.rejects(discoverLWS(root, { fetch: request }), /metadata CORS failed/);
});

test('origin-root metadata removes the root-only slash and preserves the query', async () => {
  for (const query of ['', '?view=files']) {
    const resource = 'https://pods.example/' + query;
    const metadata = 'https://pods.example/.well-known/oauth-protected-resource' + query;
    const request = async url => {
      if (url === resource) return json({ ...description, id: resource, service: [{ type: 'StorageRoot', serviceEndpoint: resource }] });
      assert.equal(url, metadata);
      return json({ resource, authorization_servers: [issuer] });
    };
    assert.deepEqual((await discoverLWS(resource, { fetch: request })).authorizationServers, [issuer]);
  }
});
