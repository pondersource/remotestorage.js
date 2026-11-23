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

Server visibility is not a client acknowledgement. If the first creation's
response is lost after the index commit, a later create-only retry receives
412. Sync fetches the unknown remote version and emits the normal conflict
event with both candidate bodies and an unknown last-common value. The default
cache view adopts the remote candidate; an application can retain the local
candidate from that event and explicitly write it back against the reviewed
remote validator. The adapter does not silently overwrite an unknown file or
loop through create attempts without fetching it.

Only the original storage address persists in localStorage. The single-use
OpenID state/verifier live in sessionStorage across the redirect and expire
after ten minutes. ID Tokens and LWS access tokens remain in memory.

Discovery and authenticated requests omit browser cookies, reject redirects and
use timeouts. Cross-origin roots, metadata and token endpoints are rejected by
this initial implementation. CORS must expose Link, WWW-Authenticate and ETag.
Do not put credentials or tokens in localStorage, logs or widget form fields.
Storage requests bypass the browser HTTP cache, so only rs.js supplies the
conditional validators; a cached GET cannot add a hidden condition to a HEAD
probe before a write.

References: https://www.w3.org/TR/lws10-core/ and
https://w3c.github.io/lws-protocol/lws10-oauth/ (drafts checked 2026-11-19).

Source tests (Node 24+):

```sh
LWS_IN_MEMORY=1 LWS_TEST_MODULE=../src/lws.ts node --import ./test/lws-source-loader.mjs --test test/lws.test.mjs test/lws-path-map.test.mjs
```

CI runs compiled transport tests over real loopback HTTP and OpenID tests with
signed test tokens. `node --test test/lws*.test.mjs` requires the TypeScript build.

## Independent server interoperability

The required independent-server job builds **ebremer/lws-server** at
`97e8ace5f7b0da890b4f8cd96eadec505e1fb16e` with JDK 25 and its transactional
TDB2 backend. It runs in open test mode on loopback with temporary data and
allows CORS only for the test app origin. Run the same harness with
`LWS_SERVER_KIND=ebremer` and a built checkout at `.lws-server/`.

The LWS workflow also starts **linkedwebstorage/lwsd**, pinned at
`421aaf1b52dd4478eb386b950d3c3da81b658e9b`, with JSS `0.0.222`. This is an
independent LWS implementation, separate from our deterministic test fixture.
Its anonymous-write test mode binds only to `127.0.0.1` and uses a disposable
data directory. Nothing is deployed publicly.

LWSD is a diagnostic target, not a supported concurrent-write target: the first
real run passed CRUD and conditional writes but returned an empty index body
during simultaneous updates (`Unexpected end of JSON input`, workflow run
`44554868871`). Its source uses in-place file writes, exposing a window to
readers and conditional writers. The unpatched target and regression stay
visible as a non-blocking diagnostic step; they are not counted as passing
interoperability. The transactional Java target is a required check.

A local run on 2026-11-23 also exposed an independent race in that pinned Java
server: the concurrent-writer test received HTTP 500 with `NoSuchFileException`
when an index reader tried to open a blob retired by another write. Its metadata
transaction does not by itself protect the old blob's lifetime. Both browser
recovery cases passed against it, but the host race must be fixed before this
pin is treated as a safe writable target. The required check remains blocking;
the adapter does not conceal the failure with unconditional writes or retries.

The runner waits for discovery to respond, runs CRUD/conditional-write and
concurrent-writer checks, and then runs the actual rs.js browser cache journey
against that server (create, offline edit, reconnect, a fresh browser's pull,
reload, delete). The offline journey waits for the initial cached write to be
acknowledged before disconnecting. A separate browser case deliberately loses
the first index-commit response, verifies both conflict candidates and an
explicit keep-local decision, and checks that create attempts remain bounded.
Failure diagnostics include cache state, errors and bounded sync/request traces.
The runner stops the server and removes its temporary data afterwards.

To reproduce after building rs.js and installing Playwright Chromium:

```sh
git clone https://github.com/linkedwebstorage/lwsd.git .lwsd
git -C .lwsd checkout 421aaf1b52dd4478eb386b950d3c3da81b658e9b
npm install --prefix .lwsd --ignore-scripts --no-save javascript-solid-server@0.0.222
npm run test:lws:interop
```

This open-mode target exercises storage and browser/CORS interoperability. It
does not establish real-provider OpenID interoperability; the signed-token and
PKCE tests cover that flow separately with controlled identity responses.
For the Java target, the runner explicitly disables the otherwise enabled
embedded authorization server and any trusted issuers, and checks that protected
resource metadata returns 404. Anonymous test access is an intentional server
configuration on disposable loopback, rather than a client authentication bypass.

## Public roots and projected member types

A public storage root does not imply anonymous access to the app's private
resources. If neither the supplied resource nor its root sends a metadata
challenge, discovery also queries the RFC 9728 protected-resource metadata URL
for that exact resource path and query. The metadata must identify that exact
resource and advertise valid authorization servers. Only a missing metadata
endpoint (404 or 410) permits open-mode fallback; denied, malformed or failed
metadata requests do not silently downgrade authentication. This lookup also
keeps the storage/issuer binding reproducible after the OpenID redirect.
For an origin-root resource, the metadata URL omits the root-only slash, as
RFC 9728 section 3.1 requires; a query is preserved.

Some container listings project a custom member media type as
`application/octet-stream`. Index discovery uses at most four concurrent HEAD
requests for members with missing/generic types, checks their actual media type,
and then validates the index document's media type, version, storage and entries.
It does not inspect arbitrary binary/JSON bodies to guess which file is an
index, and still stops if multiple indexes are present. A failed metadata HEAD
cannot be treated as an absent index and cause another index to be created.

The `css-public-discovery` CI job builds CSS-LWS at
`ef6d664f1253662cbfcb0f1786fe45d32849e067` and reproduces these two real server
behaviors on a disposable loopback Pod. Its index API test uses an explicitly
public writable test namespace; it does not certify private access or complete
OpenID login. Run it against an installed/built checkout with:

```sh
LWS_CSS_SERVER_DIR=/path/to/CommunitySolidServer node --test test/lws-css-auth.test.mjs
```

An OpenID client registration and the configured `idTokenSigningAlg` must agree
with the chosen identity provider. For example, the pinned CSS-LWS fixture uses
an explicitly registered ES256 client and `idTokenSigningAlg: 'ES256'`; the
adapter's default is RS256. Scopes and token claims remain verified by the
normal OpenID/token-exchange path.

## JSON readback after a write

Some servers acknowledge a successful write without an ETag. Before the next
conditional mutation, Sync fetches the acknowledged content and adopts its
validator only if the bytes and media type still match. LWS returns JSON as
serialized text, matching the cached `storeObject` body and WireClient's
transport contract; `BaseClient.getObject` performs the JSON parsing. Parsing
inside the backend would turn unchanged text into an object, falsely report a
conflict, and discard the pending edit through normal conflict handling.

HTTP containers can legally normalize the spelling of Content-Type. Sync
compares media type and parameter names without case, and charset values
without case, honoring optional whitespace, quoted values and parameter order.
Unknown values, profiles and multipart boundaries remain significant and
case-sensitive. For `application/json` only, an explicit UTF-8 charset is also
equivalent to its omission: RFC 8259 defines no charset parameter and requires
UTF-8 for interoperable exchange. Other encodings/types receive no such default.
Malformed or duplicate parameters cannot be
treated as equivalent by this normalization. The acknowledged bytes and all
existing revision guards still have to match before adopting a validator.

The browser regression covers JSON creation, a subsequent edit, and retrieval
in a fresh browser after suppressing write-response ETags. The separate lost
acknowledgement case still retains genuinely different conflict candidates.
The OneDrive/Nextgraph shared record decoder follows the same text contract;
their adapter-boundary tests exercise actual Sync cache revalidation, without
claiming live Microsoft or wallet/broker acceptance.
