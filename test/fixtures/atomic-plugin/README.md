# Actual Atomic plugin acceptance

This opt-in journey uses the actual AtomicServer plugin runtime, native install
review, native app consent, and HTTP storage routes. No storage or consent
responder is substituted. It needs disposable local checkouts/accounts; it is
not part of ordinary credential-free SDK CI.

The recorded run uses AtomicServer `eac358358d2e565867c5bc8a416e4a5840551e08`
(the conditional-write patch in upstream draft PR 2645, based on the plugin
feature branch), and atomic-plugins `7a81b11fb9d224adc4037fee6493dce62e020ab0`.
The host is built with `plugin-routes` and the genuine plugin runtime, with
`ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME=true`. It serves the genuine frontend and
browser WASM. The recorded browser WASM build uses the supported `--no-opt`
packaging option because downloading Binaryen was unavailable; no placeholder
runtime or asset is used. Source/binary reproducibility is not asserted.

The browser new-drive path at that pinned host produced an empty-property
genesis update and failed before consent. The passing existing-account path
instead uses `bootstrap.rs`, compiled against the same native `atomic_lib`, to
create a signed disposable agent, drive, plugin ontology/draft and folder. It
writes its account JSON with mode 0600. The server must be stopped while that
helper opens its database. Installation review, route-write approval, app
consent and storage behavior still run through the unchanged native UI/runtime.
This does not certify new-account browser onboarding.

With the prepared host at localhost:9887 and routes at routes.localhost:9887:

```sh
ATOMIC_SERVER_CHECKOUT=/path/to/atomic-server \
ATOMIC_PLUGINS_CHECKOUT=/path/to/atomic-plugins \
ATOMIC_NATIVE_BOOTSTRAP=/private/path/native-bootstrap.json \
ATOMIC_RS_BUNDLE=/path/to/verified/remotestorage-all.js \
ATOMIC_WIDGET_BUNDLE=/path/to/verified/widget.js \
SERVER_URL=http://localhost:9887 FRONTEND_URL=http://localhost:9887 \
PLUGIN_ROUTES_LEVEL=read-write PLUGIN_ROUTES_ORIGIN=http://routes.localhost:9887 \
node /path/to/atomic-server/browser/e2e/node_modules/@playwright/test/cli.js \
  test --config playwright.atomic.config.cjs
```

Use `CHROMIUM_PATH` for an existing Chromium installation. Omitting
`ATOMIC_NATIVE_BOOTSTRAP` exercises the upstream browser new-drive setup instead.
Account JSON, host database, logs containing setup credentials and browser traces
stay outside this repository; none belong in published acceptance evidence.

The journey requires exact JSON text/MIME and binary bytes, anonymous and
unclaimed-scope denial, an interrupted provider connection with retained local
edits, reload, fresh-browser readback, and a real conditional-write race. The
race first creates a live HTTP baseline and obtains its ETag; concurrent writes
using that same validator must yield one success and one 412. It checks the
server commit boundary independently of the SDK cache.

`acceptance.json` records the successful run's source/artifact bindings and
asserted outcomes. It does not certify an AtomicServer deployment or other
server versions.
