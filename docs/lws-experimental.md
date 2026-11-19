# Experimental LWS backend

This branch starts the LWS backend using the same feature registration and
`Remote` contract as Solid. It is not ready for production synchronization.

```js
remoteStorage.lws.setStorageURL('https://storage.example/alice/');
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

Still required before deploying to Litewrite or enabling real writable sync:

- Resource creation and a persistent mapping between rs.js paths and LWS's
  server-assigned identifiers. The current transport supports directory-style
  roots and direct-child URI names only. Create-only writes explicitly fail;
  they never pretend that an update PUT creates a resource. This is a scaffold,
  not a complete `Remote` implementation for new app data.
- A browser credential provider for the target server's supported authentication
  suite, redirect/session recovery, and explicit selection among multiple
  authorization servers. Token exchange alone is not an identity sign-in UI.
- End-to-end sync against a real LWS server, including create/reload/conflict,
  deletion, token expiration, and interrupted authentication.

Discovery and authenticated requests omit browser cookies, reject redirects and
use timeouts. Cross-origin roots, metadata and token endpoints are rejected by
this initial implementation. CORS must expose Link, WWW-Authenticate and ETag.
Do not put credentials or tokens in localStorage, logs or widget form fields.

References: https://www.w3.org/TR/lws10-core/ and
https://w3c.github.io/lws-protocol/lws10-oauth/ (drafts checked 2026-11-19).

Source tests (Node 24+):

```sh
LWS_TEST_MODULE=../src/lws.ts node --import ./test/lws-source-loader.mjs --test test/lws.test.mjs
```
