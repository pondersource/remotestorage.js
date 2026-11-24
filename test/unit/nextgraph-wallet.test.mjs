import { expect } from 'chai';
import { normalizeWalletURL, rememberWalletURL, requestedWalletURL, forgetWalletHandoff } from '../../build/nextgraph-wallet.js';

describe('Nextgraph wallet destination', function() {
  it('accepts HTTPS origins and local development servers', function() {
    expect(normalizeWalletURL('https://NEXTGRAPH.net/')).to.equal('https://nextgraph.net');
    expect(normalizeWalletURL('https://wallet.example:8443')).to.equal('https://wallet.example:8443');
    expect(normalizeWalletURL('http://localhost:1421/')).to.equal('http://localhost:1421');
    expect(normalizeWalletURL('http://[::1]:1421')).to.equal('http://[::1]:1421');
  });
  it('rejects insecure remote wallets, credentials and non-origin URLs', function() {
    for (const value of ['nextgraph.net', 'http://example.test', 'javascript:alert(1)', 'https://alice:secret@example.test',
      'https://example.test/wallet/', 'https://example.test/?key=secret', 'https://example.test/#wallet', 'https://localhost.attacker.test/?http=localhost']) {
      expect(() => normalizeWalletURL(value), value).to.throw();
    }
  });
  it('carries the selected origin in the app URL without losing app routing or history state', function() {
    const previous = globalThis.window;
    const state = { page: 12 };
    try {
      globalThis.window = { location: { href: 'https://app.example/calendar?view=week#event-42' }, history: {
        state, replaceState(next, _title, url) { expect(next).to.equal(state); globalThis.window.location.href = url; }
      } };
      rememberWalletURL('https://my-wallet.example');
      expect(requestedWalletURL()).to.equal('https://my-wallet.example');
      const url = new URL(window.location.href);
      expect(url.searchParams.get('view')).to.equal('week'); expect(url.hash).to.equal('#event-42');
      rememberWalletURL('https://nextgraph.net');
      expect(url.pathname).to.equal('/calendar');
      expect(requestedWalletURL()).to.equal('https://nextgraph.net');
      forgetWalletHandoff();
      expect(window.location.href).to.equal('https://app.example/calendar?view=week#event-42');
    } finally { if (previous === undefined) { delete globalThis.window; } else { globalThis.window = previous; } }
  });
});
