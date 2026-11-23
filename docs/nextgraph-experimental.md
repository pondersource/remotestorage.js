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

The engine owns persistence and encrypted replication. An awaited ORM
transaction means the SDK accepted the local write. It is **not** proof of
broker delivery. The widget says **Saved on this device** or **Needs attention**.
No verified broker acknowledgement API is wired up yet. SDK write failures
invalidate the current view and require a full app reload. The pinned ORM pools
subscriptions briefly; reusing its failed signal object would otherwise make an
unaccepted edit look saved. A failed collection cannot be reopened by another
rs.js instance in that page. Only one adapter may own its mutable SDK
transaction at a time. Reloading reopens the authoritative engine state.

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

## Validation status

Unit tests exercise the adapter at a mocked native SDK boundary, including
conflicts, deletion, exact imported bytes, permission fences, local transaction
failures and disconnect races. They do not establish wallet/broker operation.
Live acceptance still requires wallet consent, two-device offline edits,
restart before reconnect, a fresh device, duplicate first connections, revoked
access, interrupted import and loss/recovery of browser storage. Public links,
large native blobs, history compaction and semantic graph mapping remain open.

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
