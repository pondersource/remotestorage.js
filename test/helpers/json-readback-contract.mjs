import { expect } from 'chai';
import InMemoryStorage from '../../build/inmemorystorage.js';
import { Sync } from '../../build/sync.js';

/** Exercise the actual cache merge using an adapter's downloaded JSON bytes.
 * This is a transport contract check, not evidence about a provider's live API.
 */
export async function jsonReadbackContract(response, acknowledged, pending, contentType = 'application/json') {
  const path = '/notes/record.json';
  const local = new InMemoryStorage();
  const changes = [];
  local.emitChange = change => changes.push(change);
  const rs = { local, caching: { onActivate() {} } };
  rs.sync = new Sync(rs);
  await local.setNodes({ [path]: { path,
    common: { body: acknowledged, contentType },
    local: { body: pending, contentType }
  } });
  const { toBeSaved } = await rs.sync.completeFetch(path, response.body, response.contentType, response.revision);
  await local.setNodes(toBeSaved);
  const node = (await local.getNodes([path]))[path];
  expect(node.local?.body, 'readback must retain the pending edit').to.equal(pending);
  expect(node.common.body).to.equal(acknowledged);
  expect(node.common.revision).to.equal(response.revision);
  // Conflict events are deliberately deferred by Sync.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(changes.filter(change => change.origin === 'conflict')).to.deep.equal([]);
}
