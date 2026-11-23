# Experimental Nextgraph document backend

Build `npm run build:all` and use the updated remoteStorage widget. The default
and Solid-only bundles do not load this backend. Versions of `@ng-org/web`,
`@ng-org/orm` and `@ng-org/shex-orm` are pinned together in package-lock.json.

Call `rs.nextgraph.connect()` from a user gesture. The native web SDK redirects
the standalone app into its wallet environment. It uses its own authenticated
MessageChannel; the app never receives a wallet secret. A remembered selection
resumes only inside that environment. Disconnect closes the app subscription;
it does not log the user out of their wallet globally. A wallet that does not
return consent stops the UI attempt after two minutes with reload guidance.
A late successful native session is retained; the SDK is initialized only once.

A private-store RDF marker discovers one native Automerge JSON document across
sessions. A second visible collection is an error requiring reconciliation.
The JSON document stores immutable revisions in separate UUID map keys. Each
revision contains the remoteStorage path, parent revisions, deletion state and
a versioned envelope with MIME type and base64url bytes. No fields inside an
opaque source document are semantically merged. Concurrent heads, including
edit/delete heads, return 409; both candidates remain durable. The widget lets
the user download each version and choose one; resolution creates another
revision referencing all reviewed heads. Tombstones and history are retained.

An append-only IndexedDB journal owns durable local recovery. A successful write
waits for its actual transaction completion; quota errors and transaction aborts
reject before acknowledgement. The journal is keyed by the native private store
and collection, retains every revision and tombstone, and rejects mismatched
content for an immutable revision ID. Preconditions and appending a revision run
in the same short transaction, including across tabs. First collection selection
uses a separate Web Lock. Cross-device creation is not atomic; concurrent remote
heads still need explicit resolution.

The native SDK owns encrypted replication. Neither journal completion nor an
awaited ORM transaction proves broker delivery. The widget says **Saved on this
device** or **Needs attention**. Actual engine tests show that the pinned SDK can
resolve a commit after failing to save its encrypted outbox, and session-scoped
outbox entries can disappear when a tab closes. A wallet export does not include
the missing documents. The journal preserves local recovery independently of
those failures; it is not a replacement broker queue.

An unavailable native graph never means that archived documents were deleted.
A known collection can reopen from its journal. When the graph returns, only
missing revisions are replayed through the SDK with their original IDs. No SDK
outbox or peer sequence metadata is changed. An explicitly failed native view
requires a reload because the ORM pools its failed signal objects. Local journal
readback and recovery export remain available. Only one adapter may own a mutable
native transaction in the page.

## First guest transfer

Cross-site storage partitioning can hide the standalone app's guest cache.
Before connecting, choose **Export guest data for Nextgraph**. The export reads
only cached documents in scopes this app requested; it makes no remote reads.
In the wallet-hosted app, choose **Import guest data** and select that file.
Keep the source export. Import validates every record and permission before
writing, refuses existing documents, and reports partial completion. Retrying
keeps the records already imported. Maximums are 10000 documents and 50 MiB
for the widget's JSON file. This first version uses inline bytes, not native
large-file blobs. An export is not an atomic snapshot if another tab edits its
cache concurrently: stop editing while transferring and retain the source.

Snapshot shape:

```json
{"format":"pondersource-rs-documents","version":1,"records":[
  {"path":"/notes/a.txt","file":{"version":1,"contentType":"text/plain","data":"aGVsbG8"}}
]}
```

The API also offers `exportSnapshot()`, `importSnapshot(snapshot)`,
`listConflicts()`, `getConflicts(path)` and
`resolveConflict(path, chosenRevision, reviewedRevisionIds)`. The last argument
prevents a UI from resolving a changed set of heads without another review.
Client-side scope checks constrain this adapter. The collection is private to
the user's store, not a separate wallet capability per remoteStorage scope.

`exportRecovery()` exports all accessible archived versions and tombstones;
`importRecovery(snapshot)` requires the same selected account and collection and
does not replace existing history. Before connecting, `exportCacheRecovery()`
preserves every accessible older cache candidate (common, local, push, remote,
and interrupted-write base/observed versions). Existing cache data with no proven
native collection blocks silent assignment or empty collection creation. It is
kept intact for explicit recovery; no account is guessed from cache contents.

## Validation status

Unit tests cover the journal and adapter separately. A pinned actual WASM/ORM
fixture also exercises native storage failure, journal aborts, exact revision
history through reload/tab close/cold browser restart, old-cache recovery,
account mismatch, and concurrent local-tab selection and preconditions. It uses
the SDK's supported local web build and a transparent relay, not the native
wallet consent UI. The engine characterization and deliberately failing strict
engine durability gate remain separate from the passing journal adapter gate;
see `test/fixtures/nextgraph-native-engine/README.md` for commands and provenance.

Live acceptance still requires native wallet consent, successful real broker
replication and acknowledgement, two-device offline edits and a fresh device.
Public links, large native blobs, history compaction and semantic graph mapping
remain open. Browser storage clearing can erase the local journal: keep explicit
exports until remote recovery is verified.

## Content Security Policy

The all-backend bundle does not require `unsafe-eval`. The pinned web SDK embeds
an empty `Function` subclass as an async-proxy target; constructing it would
otherwise violate a strict app CSP during bundle evaluation. A build-only loader
replaces that target constructor with an ordinary function. It checks the exact
SDK file SHA-256 and expected single match, failing the build if the dependency
changes. The package in `node_modules` is not modified, licensing is retained,
and the bundle remains a single file. The real SDK browser protocol test runs
both the app and simulated wallet under CSP without `unsafe-eval`. Native
wallet/broker acceptance remains separate.

The web/ORM SDK modules are evaluated only when connecting to Nextgraph (or
resuming its explicitly requested wallet flow), while their code remains in the
single bundle. Guest mode, snapshot export, and other providers do not inherit
the native SDK's newer runtime requirements. In particular, the pinned ORM uses
`Set.union`; browsers without it receive a Nextgraph connection error with
upgrade/other-provider guidance. No global Set polyfill is installed. SDK startup
errors are confined to the connection attempt.
