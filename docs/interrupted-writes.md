# Interrupted writes

An upload can finish at the server after its page disappears, or lose its
response before rs.js records the acknowledgement. A persisted `push` is an
uncertain outcome, not proof that either version won.

New pending writes retain an operation ID, their actual destination and an
immutable base snapshot. In browsers with Web Locks, one document holds the
per-path write lease through request completion and durable cache acknowledgement.
A live sibling waits; page death releases the lease. Separate short cache locks
serialize local edits and acknowledgements across documents without making
offline edits wait for HTTP. IndexedDB promises include actual transaction
completion, and completed write overlays no longer conceal another tab's rows.

After obtaining ownership, recovery reads the remote representation first:

- Exact pending bytes and an equivalent media type confirm an applied write.
- An unchanged captured base permits a new conditional mutation. Newer local
  edits remain the candidate; a response for an older operation cannot clear them.
- Different bytes, profiles, encodings or revisions remain a durable conflict.
  Empty text is a known value, a tombstone is `false`, and an unknown body is
  `undefined`. Empty JSON remains invalid JSON; it is never equated with a
  nonempty pending record.

Automatic recreation after a 404 additionally requires an atomic logical-name
create contract. Google Drive permits duplicate names, and Nextgraph uses
retained CRDT branches, so an ambiguous missing create stays parked there unless
the existing candidate is positively identified. No unconditional retry is used.
Explicit local resolution also cannot replay a still-missing ambiguous create
without that guarantee; recheck for the existing candidate or export it instead.

## Review, export and deliberate resolution

Interrupted conflicts differ from ordinary rs.js change conflicts: calling
`storeObject` alone can add a newer local edit, but does not discard a parked
operation or silently overwrite its remote alternative.

```js
const unfinished = await remoteStorage.sync.listInterruptedWrites();
```

This returns accessible raw cache snapshots, including active uploads. For a
parked conflict, `node.push.operation.state` is `conflict`, `base` is the captured
common version and `observed` is the reviewed remote version. `node.local` can
contain a newer edit than `node.push`. Preserve every candidate when exporting;
binary bodies are ArrayBuffers/views and must be exported as bytes, not passed
through plain `JSON.stringify`. Internal localStorage persistence uses a
versioned binary envelope and preserves legacy text-only rows.

After inspecting a current list, an application can recheck an operation:

```js
await remoteStorage.sync.retryInterruptedWrite(node.path, node.push.operation.id);
```

This performs fresh readback, not a blind replay. An applied candidate can be
confirmed, an unchanged base can be retried conditionally, and a differing
version remains parked and is exposed again through a `conflict` change event.

For a reviewed conflict, choose explicitly:

```js
await remoteStorage.sync.resolveInterruptedWrite(node.path, node.push.operation.id, 'local');
// Or choose 'remote' to discard the retained local candidate deliberately.
```

Resolution captures the current local/operation snapshot before waiting for its
lease, refreshes the remote version, and rechecks both before changing state.
A newer local edit or another remote version requires another review. Choosing
local writes only against that freshly reviewed validator (or an atomic
create-if-absent); choosing remote does not send a mutation. All retained
candidates survive until a valid deliberate choice succeeds.

Legacy/unowned markers, unavailable Web Locks and destination changes are not
evidence that another owner died. They stay readable/exportable and report
`error.code === 'interrupted-write'`, without automatic clearing or replay.
The resolution API accepts only owned, versioned operations. For an old cache,
export the complete local dataset and every pending candidate, close older
clients, then use the application's supported disconnect/reset and import flow.
This avoids modifying raw cache records or mistaking an older live tab for a
dead writer.

## Validation

Browser regressions use actual IndexedDB/localStorage, document reloads and live
sibling documents over the LWS HTTP fixture and the patched independent Java
provider. They cover readback before mutation, conditional retries, late
acknowledgements, newer edits during a held recovery decision, durable differing
and empty candidates, explicit resolution, binary bases and tombstones.
