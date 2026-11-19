# Experimental LWS backend

This branch implements an experimental LWS backend using the same feature
registration and `Remote` contract as Solid. Real-server interoperability still
needs to be verified before production rollout.

```js
remoteStorage.lws.setStorageURL('https://storage.example/alice/');
remoteStorage.lws.configureOpenID({
  issuer: 'https://identity.example',
  clientId: 'https://app.example/lws-client',
  redirectUri: 'https://app.example/callback'
});
// On application startup, after configuring OpenID and registering event handlers:
if (!(await remoteStorage.lws.handleIncomingRedirect())) {
  // The widget's Connect action calls connect() when the user requests it.
}
```

The identity provider must register this app as a public OIDC code-flow client,
support PKCE S256 and issue the URI subject and `azp` required by LWS. It must
issue credentials accepted by the storage authorization server. The storage URL
cannot tell us an arbitrary user's identity provider or register our app there.
Configuration is supplied by the application, not inferred from a WebID.

Alternatively, supply the same configuration as `lwsOpenID` in the existing
widget's options. The widget configures OpenID and finishes a pending callback
when attached; do not also configure/resume it separately in application code.

Applications with another authentication suite can provide their own credential:

```js
remoteStorage.lws.setCredentialProvider(async ({ authorizationServer, storage, metadata }) => {
  // Obtain a signed authentication credential using a supported LWS suite.
  // The credential must be intended for this authorization server.
  return { token: credential, type: 'urn:ietf:params:oauth:token-type:id_token' };
});
await remoteStorage.lws.connect();
```

The widget adds LWS only when `remoteStorage.lws` exists, retains its current
provider chooser and asks for a **Storage address**. It uses no new logo.
The existing fork's Solid screen asks for an identity provider; it is unchanged.

Implemented:

- Storage/resource URL discovery, StorageRoot and protected-resource metadata.
- Exact authorization-server issuer validation and OAuth token exchange for the
  canonical storage audience. Access tokens stay in memory and are renewed using
  the credential provider before expiration. There is no implicit login redirect.
- Public access, JSON and binary reads, paginated container listings with real
  member ETags, conditional update and delete requests, and disconnect cancellation.
- Backend feature registration, selection persistence, and existing widget integration.
- Browser OpenID redirects with single-use state, PKCE S256, nonce, issuer,
  audience, expiry, `azp` and ID Token signature validation through oauth4webapi.
  Expired credentials require explicit reconnection; background sync cannot redirect.
- POST creation using the returned Location, persisted path mapping, virtual
  folder listings, reload recovery, and CAS updates merging independent writes.

Still required before deploying to Litewrite or enabling real writable sync:

- Configure a real identity provider/client registration and callback for the
  target deployment; test its signed ID Token with the chosen LWS authorization
  server. Multiple authorization-server selection is still unsupported.
- End-to-end sync against a real LWS server, including create/reload/conflict,
  deletion, token expiration, and interrupted authentication.

## Path mapping convention

An index with media type `application/vnd.remotestorage.lws-index+json` is created
in the storage root on the first new file write. It contains version 1, the
canonical storage URI, and a map of rs.js paths to the server-assigned resource
URIs. File bytes remain separate LWS data resources, not inline blobs in the
index. This is a provisional rs.js convention, not a standardized LWS format.
Other clients need this convention to interpret virtual rs.js folders.

Index updates require a strong exposed ETag and If-Match support. Concurrent
different paths are merged; same-path create conflicts return 412. A duplicate
index from concurrent first-time setup stops sync for explicit resolution; the
backend never guesses which namespace to keep. An interrupted creation can
leave an unreferenced resource, which is retained for recovery instead of being
deleted when a commit response might have been lost. POST is never blindly
retried. Unknown opaque resources from other apps are preserved and omitted
from rs.js listings; existing hierarchical native files remain readable.

Only the original storage address persists in localStorage. The single-use
OpenID state/verifier live in sessionStorage across the redirect and expire
after ten minutes. ID Tokens and LWS access tokens remain in memory.

Discovery and authenticated requests omit browser cookies, reject redirects and
use timeouts. Cross-origin roots, metadata and token endpoints are rejected by
this initial implementation. CORS must expose Link, WWW-Authenticate and ETag.
Do not put credentials or tokens in localStorage, logs or widget form fields.

References: https://www.w3.org/TR/lws10-core/ and
https://w3c.github.io/lws-protocol/lws10-oauth/ (drafts checked 2026-11-19).

Source tests (Node 24+):

```sh
LWS_IN_MEMORY=1 LWS_TEST_MODULE=../src/lws.ts node --import ./test/lws-source-loader.mjs --test test/lws.test.mjs test/lws-path-map.test.mjs
```

CI runs compiled transport tests over real loopback HTTP and OpenID tests with
signed test tokens. `node --test test/lws*.test.mjs` requires the TypeScript build.
