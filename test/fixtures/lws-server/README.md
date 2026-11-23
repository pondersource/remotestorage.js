# Patched independent LWS server fixture

This is a source patch for [ebremer/lws-server](https://github.com/ebremer/lws-server)
at the immutable upstream commit
`97e8ace5f7b0da890b4f8cd96eadec505e1fb16e`. CI applies it before building and
testing the real Java server. Results apply to this patched fixture and the
exercised contracts. Other deployed hosts require their own conformance checks.

The patch pins an HTTP response's immutable blob key while taking its fresh
metadata snapshot. Concurrent replacement/deletion can retire that blob, but
unlinking waits for its last reader to close. Blob opening, streaming and
deletion stay outside the metadata transaction and retirement guard. It also
retains the full Content-Type of non-RDF resources instead of dropping media
parameters. Write preconditions and RDF negotiation are unchanged.

Provenance:

- Original local fix commit: `524a931743f677af7436522df4c401ce1dbc8e62`.
- Patch SHA-256: `8226b592d34442be9239fa698ce263da946ad03473c15552ad8b8bff01c85f7e`.
- Nine new deterministic regressions accompany the modified Java sources.
- The source patch is published here because the connected GitHub integration
  could not create an independent Ponder Source server fork (HTTP 403).

The upstream Apache-2.0 LICENSE and NOTICE are retained beside the patch.
These modified provider sources are separate from the SDK's own MIT license;
this directory does not redistribute a compiled server or its dependencies.

To reproduce, check out the pinned upstream revision, then run with JDK 25:

```sh
git apply /path/to/remotestorage.js/test/fixtures/lws-server/read-lifetimes.patch
mvn -B -q verify
```

After building the SDK and installing Playwright Chromium, run its actual
storage/browser contract against that checkout:

```sh
LWS_SERVER_KIND=ebremer LWS_SERVER_CHECKOUT=/path/to/lws-server node scripts/run-lwsd-interop.mjs
```

The runner intentionally configures an anonymous server only on disposable
loopback storage. Native authenticated/private CSS-LWS acceptance is separate.
