import ng, { worker_ready } from './api-web/main.ts';
import { initNg, DiscreteOrmSubscription } from '@ng-org/orm';

// A disposable fixture credential; never a production account or imported user secret.
const password = 'disposable-native-engine-acceptance';
const fixtureKey = 'rs-native-engine-fixture';
let state = JSON.parse(localStorage.getItem(fixtureKey) || '{}');
let session;
let subscription;
let document;
let failedOutboxWrites = 0;
let relayInstalled = false;
let savedSelection;
let queryGate;
let releaseQuery;
const rpcCounts = {};
const originalSetItem = Storage.prototype.setItem;

function remember() {
  localStorage.setItem(fixtureKey, JSON.stringify(state));
}

function summarizeStorage(storage) {
  const groups = {};
  for (const key of Object.keys(storage).filter(key => key.startsWith('ng_'))) {
    // Do not expose wallet identifiers, sequence identifiers, or encrypted bytes.
    const kind = key.split('@')[0];
    groups[kind] ||= { entries: 0, bytes: 0 };
    groups[kind].entries++;
    groups[kind].bytes += storage.getItem(key).length;
  }
  return groups;
}

async function snapshot() {
  const outbox = Object.keys(sessionStorage).filter(key => key.startsWith('ng_outboxes@'));
  const bytes = outbox.sort().map(key => key + '\0' + sessionStorage.getItem(key)).join('\0');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
  return {
    local: summarizeStorage(localStorage),
    session: summarizeStorage(sessionStorage),
    outboxEntries: outbox.length,
    outboxDigest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
    document: document ? JSON.parse(JSON.stringify(document)) : undefined,
    failedOutboxWrites,
  };
}

async function useWallet(walletName, user) {
  session = await ng.session_start(walletName, user);
  initNg(ng, session);
  return { opened: true, sessionType: typeof session.session_id };
}

async function create() {
  await worker_ready;
  const created = await ng.wallet_create({
    security_img: null, security_txt: 'Local acceptance wallet', pin: null,
    pazzle_length: 0, password, mnemonic: false, send_bootstrap: false,
    send_wallet: false, result_with_wallet_file: true, local_save: true,
    core_bootstrap: { servers: [{ server_type: { Localhost: Number(location.port) }, can_verify: false,
      can_forward: true, peer_id: { Ed25519PubKey: Array(32).fill(0) } }] },
    core_registration: null, additional_bootstrap: null, pdf: false,
    device_name: 'native-engine-acceptance',
  });
  state.walletName = created.wallet_name;
  remember();
  return useWallet(created.wallet_name, created.user);
}

async function reopen() {
  await worker_ready;
  const wallets = await ng.get_wallets();
  const wallet = wallets[state.walletName]?.wallet;
  if (!wallet) { throw new Error('Fixture wallet was not persisted'); }
  const opened = await ng.wallet_open_with_password(wallet, password);
  await ng.wallet_was_opened(opened);
  return useWallet(state.walletName, opened.V0.personal_site);
}

async function openDocument(createNew = false) {
  if (createNew) {
    state.documentId = await ng.doc_create(session.session_id, 'Automerge', 'data:json', 'store', undefined);
    remember();
  }
  subscription = DiscreteOrmSubscription.getOrCreate(state.documentId);
  document = await Promise.race([
    subscription.readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Native ORM document did not reopen offline')), 4000)),
  ]);
  return JSON.parse(JSON.stringify(document));
}

async function edit(value) {
  subscription.beginTransaction();
  document.record = value;
  await subscription.commitTransaction();
  return snapshot();
}

async function readEngineDocument() {
  let receive;
  const initial = new Promise(resolve => { receive = resolve; });
  const cancel = await ng.orm_start_discrete(state.documentId, session.session_id, event => {
    if (event.V0?.DiscreteOrmInitial) { receive(event.V0.DiscreteOrmInitial[0]); }
  });
  try { return await initial; }
  finally { cancel(); }
}

async function exportWallet() {
  return Array.from(await ng.wallet_get_file(state.walletName));
}

async function importWallet(bytes, documentId) {
  await worker_ready;
  const wallet = await ng.wallet_read_file(new Uint8Array(bytes));
  const opened = await ng.wallet_open_with_password(wallet, password);
  await ng.wallet_import(wallet, opened, false);
  state.walletName = Object.keys(await ng.get_wallets())[0];
  state.documentId = documentId;
  remember();
  return useWallet(state.walletName, opened.V0.personal_site);
}

window.native = {
  create, reopen, openDocument, edit, snapshot, exportWallet, importWallet, readEngineDocument,
  documentId: () => state.documentId,
  exportDocument: () => JSON.parse(JSON.stringify(document)),
  async importDocument(value) {
    await openDocument(true);
    subscription.beginTransaction();
    for (const [key, item] of Object.entries(value)) { document[key] = item; }
    await subscription.commitTransaction();
    return snapshot();
  },
  failOutboxWrites(enabled) {
    Storage.prototype.setItem = enabled ? function (key, value) {
      if (key.startsWith('ng_outboxes@')) {
        failedOutboxWrites++;
        throw new DOMException('Injected outbox storage failure', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    } : originalSetItem;
  },
  async connectUnavailableBroker() {
    const info = await ng.client_info();
    return ng.user_connect(info, session.user, location.href);
  },
  async prepareAdapterCollection() {
    state.documentId = await ng.doc_create(session.session_id, 'Automerge', 'data:json', 'store', undefined);
    await ng.sparql_update(session.session_id,
      `INSERT DATA { GRAPH <${state.documentId}> { <${state.documentId}> a <https://pondersource.com/ns/remotestorage/DocumentLedgerV1> } }`, state.documentId);
    remember();
  },
  saveSelection() { savedSelection = { state: { ...state }, session }; },
  restoreSelection() { state = savedSelection.state; session = savedSelection.session; remember(); },
  rpcCounts: () => ({ ...rpcCounts }),
  pauseDiscovery() { window.nativeQueryPaused = false; queryGate = new Promise(resolve => { releaseQuery = resolve; }); },
  releaseDiscovery() { releaseQuery(); queryGate = undefined; },
  attachAdapter(mode) {
    // Transparent test relay to the actual native API, following broker-auth's
    // MessageChannel protocol. It provides no consent UI or broker simulation.
    const appOrigin = `http://127.0.0.1:${location.port}`;
    if (!relayInstalled) {
      relayInstalled = true;
      window.addEventListener('message', async event => {
        if (event.origin !== appOrigin || event.source !== window.document.querySelector('iframe')?.contentWindow) { return; }
        const { method, args = [], streamed, port } = event.data;
        if (method === 'init') { port.postMessage({ ok: true, ret: session }); port.close(); return; }
        const allowed = ['sparql_query', 'sparql_update', 'doc_create', 'orm_start_discrete', 'discrete_orm_update', 'user_connect', 'client_info'];
        if (!allowed.includes(method)) { port.postMessage({ ok: false, ret: 'Method not allowed by disposable fixture' }); port.close(); return; }
        rpcCounts[method] = (rpcCounts[method] || 0) + 1;
        try {
          if (method === 'sparql_query' && queryGate) { window.nativeQueryPaused = true; await queryGate; }
          if (streamed) {
            args.push(value => port.postMessage({ stream: true, ret: value }));
            let cancel = () => {};
            port.onmessage = message => { if (message.data.close) { cancel(); port.close(); } };
            cancel = await ng[method](...args);
            port.postMessage({ stream: true });
          } else {
            port.postMessage({ ok: true, ret: await ng[method](...args) }); port.close();
          }
        } catch (error) { port.postMessage({ ok: false, ret: String(error) }); port.close(); }
      });
    }
    window.document.querySelector('iframe')?.remove();
    const frame = window.document.createElement('iframe');
    frame.src = appOrigin + '/adapter.html' + (mode === 'upgrade' ? '?upgrade=1' : ''); window.document.body.append(frame);
  },
};
window.fixtureReady = true;
