/** Public wallet origin, carried in the app URL across storage partitions. */
export const DEFAULT_WALLET_URL = 'https://nextgraph.net';
export const WALLET_PARAMETER = 'rs-nextgraph-wallet';
const WALLET_PREFERENCE = 'remotestorage:nextgraph-wallet';

export function normalizeWalletURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a complete Nextgraph wallet URL, such as https://nextgraph.net.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS wallet origin without a path, query, credentials or fragment. HTTP is allowed only on localhost.');
  }
  return url.origin;
}

export function requestedWalletURL(): string | undefined {
  return typeof window === 'undefined' ? undefined : new URL(window.location.href).searchParams.get(WALLET_PARAMETER) || undefined;
}

export function rememberedWalletURL(): string | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage?.getItem(WALLET_PREFERENCE) || undefined; }
  catch { return undefined; }
}

export function rememberWalletURL(origin: string): void {
  if (typeof window === 'undefined') { return; }
  const url = new URL(window.location.href);
  url.searchParams.set(WALLET_PARAMETER, origin);
  window.history.replaceState(window.history.state, '', url.href);
  try { window.localStorage?.setItem(WALLET_PREFERENCE, origin); } catch { /* URL handoff also works without localStorage. */ }
}

export function forgetWalletHandoff(): void {
  if (typeof window === 'undefined') { return; }
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WALLET_PARAMETER)) { return; }
  url.searchParams.delete(WALLET_PARAMETER);
  window.history.replaceState(window.history.state, '', url.href);
}
