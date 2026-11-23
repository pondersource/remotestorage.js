import NextGraph from '../../../src/nextgraph.ts';
import { Access } from '../../../src/access.ts';
import IndexedDB from '../../../src/indexeddb.ts';

const access = new Access();
access.claim('notes', 'rw');
window.adapterErrors = [];
let local = {};
if (new URLSearchParams(location.search).has('upgrade')) {
  window.upgradeStage = 'opening';
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('rs-nextgraph-preview6-cache', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('nodes', { keyPath: 'path' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  local = new IndexedDB(database);
  window.actualCache = local;
  window.upgradeStage = 'putting';
  await local.put('/notes/preview6.json', '{ "unknown": true, "saved": "native acknowledged" }\n', 'application/json');
  window.upgradeStage = 'reading';
  const nodes = await local.getNodes(['/notes/preview6.json', '/notes/', '/']);
  for (const node of Object.values(nodes)) {
    node.common = { ...node.local, revision: 'preview6-native-ack' };
    delete node.local;
  }
  await local.setNodes(nodes);
  window.upgradeStage = 'seeded';
}
window.actualCache = local;
const rs = { access, local, remote: { connected: false },
  setBackend(name) { this.backend = name; }, _fireReady() {},
  _emit(name, error) { if (name === 'error') { adapterErrors.push(error.message); } },
};
window.adapter = new NextGraph(rs);
window.adapter.connect().then(() => { window.adapterReady = true; }, error => { window.adapterError = error.message; });
