This is a disposable **actual NextGraph engine** acceptance fixture. It uses the official pinned WASM package, the unchanged API worker and storage bridge copied from the listed source commit, and the repository's pinned ORM package. Every engine operation runs in the real WASM runtime. No MessageChannel engine responder or in-memory engine replacement is used.

Run from the repository root:

```
NEXTGRAPH_NATIVE_REPORT=/tmp/nextgraph-native-report.json node --test test/nextgraph-native-engine.test.cjs
```

`NEXTGRAPH_WASM_ARCHIVE` optionally identifies an existing official archive. If unavailable, the runner fetches the pinned registry URL. Both the archive and WASM bytes must match `provenance.json`. Extraction and generated bundles remain in a temporary directory. Upstream bridge files, their copyright notices, and both licenses are preserved. The published WASM does not identify its source `gitHead`; matching package versions are not a claim of reproducible source-to-binary identity.

The runner compiles the actual API bridge with esbuild, replacing Vite's `?worker&inline` packaging with separate module workers and linking the unchanged official WASM imports. This changes packaging only. These fixtures use the direct native API; the production web SDK redirect and native consent screens are separate acceptance gates. No production web SDK bundle is replaced.

The tests create disposable password wallets pointing at a nil peer on the fixture's own ephemeral localhost port. That HTTP server rejects WebSocket upgrades; it does not emulate a broker or contact another local service. Wallet generation, Automerge documents, ORM commits, wallet export/import, browser storage, and failed WebSocket connection use the actual SDK. An independent native subscription checks engine data after each initial commit. Wallet bytes and credentials are never included in reports. Reports contain only synthetic document candidates, storage byte counts, outbox digests and categorical outcomes.

These are boundary characterization tests: passing them does **not** establish durable-save acceptance. They explicitly expose lost offline availability after same-tab reload, and loss of session-scoped pending events after closing a tab. Native wallet export contains the wallet, while explicit document export/import separately preserves application data. A single injected `sessionStorage.setItem` quota failure tests the real bridge's error path.

The pinned WASM also resolves an ORM commit after a genuine outbox storage error: the visible candidate changes while no corresponding encrypted event is saved. Source explains why: `engine/verifier/src/request_processor.rs` converts the failure into `AppResponse::Error`, and `sdk/js/lib-wasm/src/lib.rs` `discrete_orm_update` ignores that response and returns success. The characterization asserts the measured failure explicitly, rather than treating it as acceptance.

The separate durable-save contract is deliberately **red** on this pinned engine:

```
NEXTGRAPH_REQUIRE_DURABLE=1 NEXTGRAPH_NATIVE_REPORT=/tmp/nextgraph-native-durability.json node --test test/nextgraph-native-engine.test.cjs
```

That gate requires successful native ORM commits to survive all tested lifecycle boundaries and requires storage failure to reject. Do not use the passing characterization run as evidence that this contract passed. A consumer adapter needs its own durable recovery journal or a verified engine fix before acknowledging documents as durably saved.

No broker runs. A rejected connection can prove that pre-handshake failure preserves pending events; it cannot prove broker acknowledgement, successful replication, interrupted post-handshake outbox delivery or remote recovery. Those require a real `ngd` and an independent client. Retain all application recovery candidates until those contracts are verified.

## Adapter recovery acceptance

```
NEXTGRAPH_ADAPTER_REPORT=/tmp/nextgraph-native-adapter-report.json node --test test/nextgraph-native-adapter.test.cjs
```

This separate positive gate runs the actual remoteStorage adapter against the
same WASM/ORM engine. The native web SDK source is pinned in `web.ts` and built
with its supported `NG_DEV_LOCAL_BROKER` flag. A transparent relay forwards
requests to the actual engine; it does not implement storage or consent. No
native wallet UI or successful broker delivery is claimed.

The gate requires exact immutable revision history and tombstones to survive
reload, tab close and cold browser restart independently of the SDK outbox. It
also requires rejected journal persistence, rollback on partial transaction
failure, account fencing, preservation of old remoteStorage cache candidates,
and concurrent tabs selecting one collection and enforcing local preconditions.
Do not confuse its passing result with the intentionally red engine-only
durability contract above.
