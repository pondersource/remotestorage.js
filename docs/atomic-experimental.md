# Atomic app-key storage (experimental)

The all-backend distribution can connect a browser app directly to Atomic
through an app key. It generates a separate Ed25519 signing key in the browser
and opens Atomic's native consent page for the drive the user selected. Atomic
records the grant on the drive. The app later signs its own requests without
receiving the user's secret, session cookies, or a remoteStorage plugin token.

## Enable the provider

Bundle a pinned Atomic SDK with the app. The build helper expects a checkout
of [Atomic Server](https://github.com/ontola/atomic-server), with browser pnpm
dependencies installed and `@tomic/utils` built. It has the same SDK boundary
as the Ponder Source launcher's native connection.

```sh
node scripts/build-atomic-sdk.mjs /path/to/atomic-server public/dependencies/atomic-sdk
```

Serve the generated module, WebAssembly and license together, from the app's
own origin. In the app's ES module bootstrap, configure the optional loader
before constructing RemoteStorage and attaching the Ponder Source widget.

```js
RemoteStorage.Atomic.loadSDK = () => import('./dependencies/atomic-sdk/index.mjs');
const rs = new RemoteStorage();
```

The widget asks for an Atomic server and drive DID or link. The default,
`https://atomic.place`, opens the hosted approval UI and uses
`https://node1.atomicserver.eu` for data. Use the node's HTTPS origin for a
drive hosted elsewhere. The user must give the key direct **Read and edit**
access to the selected drive. A dedicated private drive limits the scope of
the grant. Atomic's Connected apps settings can revoke it. Disconnecting
locally removes the saved browser key.

## Storage behavior

Private documents are stored as immutable revisions in the selected drive,
grouped by app origin's host. Existing plugin-backed data stays in its old
format. The provider does not automatically migrate that data. Export before
switching providers and import through the app where available.

An acknowledged save means Atomic persisted a revision. Two independent
clients can still append competing revisions. The provider reports conflict
instead of silently replacing either version. History is retained and reads
can become expensive for large libraries. This experimental provider does not
yet support public links.
