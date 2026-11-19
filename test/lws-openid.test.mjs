import assert from 'node:assert/strict';
import { test } from 'node:test';
const { default: OpenID } = await import(process.env.LWS_OPENID_TEST_MODULE || '../build/lws-openid.js');
const issuer = 'https://identity.example', clientId = 'https://app.example/lws-client', redirectUri = 'https://app.example/callback?app=notes';
const context = { storage: 'https://pods.example/storage', storageURL: 'https://pods.example/note', authorizationServer: 'https://as.example', interactive: true };
const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const b64 = value => Buffer.from(value).toString('base64url');
async function fixture(t, overrides = {}) {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map(), calls = [];
  let navigated, current = redirectUri;
  const store = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  Object.defineProperty(globalThis, 'sessionStorage', { value: store, configurable: true });
  globalThis.window = { location: { get href() { return current; }, origin: 'https://app.example', assign(url) { navigated = new URL(url); } }, history: { state: null, replaceState(_state, _title, url) { current = url; } } };
  t.after(() => { globalThis.fetch = oldFetch; globalThis.window = oldWindow; if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete globalThis.sessionStorage; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === issuer + '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'] });
    if (String(url) === issuer + '/jwks') return json({ keys: [jwk] });
    if (String(url) === issuer + '/token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('resource'), context.authorizationServer);
      assert.equal(body.get('redirect_uri'), redirectUri);
      const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier'))));
      assert.equal(challenge, navigated.searchParams.get('code_challenge'));
      const now = Math.floor(Date.now() / 1000);
      const header = b64(JSON.stringify({ alg: 'RS256', kid: 'test-key' }));
      const payload = b64(JSON.stringify({ iss: issuer, sub: 'https://identity.example/alice', aud: clientId, azp: clientId,
        nonce: navigated.searchParams.get('nonce'), iat: now, exp: now + 300, ...overrides.claims }));
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(header + '.' + payload));
      const token = header + '.' + payload + '.' + b64(overrides.badSignature ? new Uint8Array(signature.byteLength) : signature);
      return json({ access_token: 'oidc-access-token', token_type: 'Bearer', expires_in: 300, id_token: token });
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const openid = () => new OpenID({ issuer, clientId, redirectUri });
  return { values, calls, openid, callback(state = navigated.searchParams.get('state')) {
    current = redirectUri + '&code=code-123&state=' + state + '&iss=' + encodeURIComponent(issuer);
    return current;
  }, get navigation() { return navigated; }, get current() { return current; } };
}

test('PKCE redirect resumes after reload and exchanges a validated signed ID Token', async t => {
  const f = await fixture(t);
  await assert.rejects(f.openid().get(context), error => error.redirecting === true);
  assert.equal(f.navigation.searchParams.get('resource'), context.authorizationServer);
  assert.equal(f.navigation.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(f.navigation.searchParams.get('nonce'));
  assert.ok(![...f.values.values()].join('').includes('oidc-access-token'));
  const afterReload = f.openid();
  assert.deepEqual(await afterReload.handleIncomingRedirect(f.callback()), context);
  assert.equal(f.values.size, 0);
  const credential = await afterReload.get({ ...context, interactive: false });
  assert.equal(credential.type, 'urn:ietf:params:oauth:token-type:id_token');
  assert.equal(credential.token.split('.').length, 3);
  assert.equal(f.current, redirectUri);
  afterReload.clear();
  await assert.rejects(afterReload.get({ ...context, interactive: false }), /expired/);
});

test('unrelated OAuth responses are ignored without consuming pending state', async t => {
  const f = await fixture(t); await assert.rejects(f.openid().get(context));
  assert.equal(await f.openid().handleIncomingRedirect(f.callback('wrong-state')), undefined);
  assert.equal(f.values.size, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/token')).length, 0);
});

for (const [name, overrides] of Object.entries({
  nonce: { claims: { nonce: 'wrong' } }, issuer: { claims: { iss: 'https://evil.example' } },
  audience: { claims: { aud: 'another-client' } }, client: { claims: { azp: 'another-client' } },
  expiration: { claims: { exp: 1 } }, signature: { badSignature: true }
})) test('rejects an invalid OpenID ' + name, async t => {
  const f = await fixture(t, overrides); await assert.rejects(f.openid().get(context));
  await assert.rejects(f.openid().handleIncomingRedirect(f.callback()));
  assert.equal(f.values.size, 0);
});
