import { expect } from 'chai';

/** Strict conditional-mutation contract for an adapter fixture or live harness.
 * Each factory supplies two independent clients in the same test account.
 * CRDT retention backends have a different contract: both offline writes may
 * succeed, then appear as retained concurrent candidates after replication.
 */
export function conditionalWriteContract(makeFixture) {
  describe('conditional write contract', () => {
    it('permits only one of two updates based on the same revision', async () => {
      const { clients, path } = await makeFixture('base');
      const before = await Promise.all(clients.map(client => client.get(path)));
      expect(before[0].revision).to.equal(before[1].revision);
      const bodies = ['first candidate', 'second candidate'];
      const results = await Promise.all(clients.map((client, i) =>
        client.put(path, bodies[i], 'text/plain', { ifMatch: before[i].revision })));
      const winner = results.findIndex(result => [200, 201].includes(result.statusCode));
      expect(winner).to.be.at.least(0);
      expect(results[1 - winner].statusCode).to.equal(412);
      const after = await clients[0].get(path);
      expect(after.body).to.equal(bodies[winner]);
      expect(after.revision).to.equal(results[winner].revision);
    });

    it('permits only one creator of an absent logical path', async () => {
      const { clients, path } = await makeFixture(undefined);
      const bodies = ['first creator', 'second creator'];
      const results = await Promise.all(clients.map((client, i) =>
        client.put(path, bodies[i], 'text/plain', { ifNoneMatch: '*' })));
      const winner = results.findIndex(result => [200, 201].includes(result.statusCode));
      expect(winner).to.be.at.least(0);
      expect(results[1 - winner].statusCode).to.equal(412);
      const after = await clients[0].get(path);
      expect(after.body).to.equal(bodies[winner]);
      expect(after.revision).to.equal(results[winner].revision);
    });
  });
}
