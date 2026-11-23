import { globalContext } from './util';

export interface WriteLease { release(): void; }

/** A browser-owned lease ends automatically when its document dies.
 * Acquire outside the short cache transaction; offline edits never take it.
 */
export function acquireWriteLease(cacheId: string | undefined, destination: string | undefined, path: string): Promise<WriteLease | undefined> {
  const locks = globalContext.navigator?.locks;
  if (!cacheId || !destination || !locks?.request) { return Promise.resolve(undefined); }
  const name = 'remotestorage:write:' + JSON.stringify([cacheId, destination, path]);
  return new Promise((resolve, reject) => {
    locks.request(name, { mode: 'exclusive' }, () => new Promise<void>(release => {
      resolve({ release });
    })).catch(reject);
  });
}
