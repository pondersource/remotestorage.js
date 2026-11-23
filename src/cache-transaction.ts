/** Serialize local cache read/modify/write operations across app writes and sync. */
const queues = new WeakMap<object, Promise<void>>();

/**
 * Hold the cache mutation queue only while updating local state. Network
 * requests must remain outside it so that offline edits never wait for HTTP.
 *
 * @internal
 */
export function withCacheTransaction<T> (cache: object, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(cache) || Promise.resolve();
  const current = previous.then(() => {
    const identity = (cache as { sharedCacheId?: string }).sharedCacheId;
    const locks = typeof navigator !== 'undefined' && navigator.locks;
    if (identity && locks?.request) {
      // This lock is distinct from the network write lease. Persistent adapter
      // setNodes promises must include the actual storage commit before release.
      return locks.request('remotestorage:cache:' + identity, work);
    }
    return work();
  });
  queues.set(cache, current.then(() => undefined, () => undefined));
  return current;
}
