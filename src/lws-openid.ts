// OIDC is one LWS authentication suite. The ID Token is exchanged for an LWS
// access token; it is never presented directly to a storage server.
type Options = { issuer: string; clientId: string; redirectUri: string; idTokenSigningAlg?: string };
type Context = { storage: string; storageURL: string; authorizationServer: string; interactive?: boolean };
const KEY = 'remotestorage:lws:openid-pending';
const TYPE = 'urn:ietf:params:oauth:token-type:id_token';

function webURL(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash) {
    throw new Error('LWS OpenID requires HTTPS URLs, or loopback HTTP for development.');
  }
  return url;
}

class LWSOpenID {
  private options: Options;
  private credential: { token: string; expires: number; context: Context };
  private epoch = 0;
  constructor(options: Options) {
    webURL(options.issuer); webURL(options.redirectUri);
    if (!options.clientId) throw new Error('An OpenID client ID registered for this app is required.');
    if (new URL(options.redirectUri).origin !== window.location.origin) throw new Error('The LWS OpenID callback must be on this app origin.');
    this.options = { ...options };
  }

  private async library() { return import('oauth4webapi'); }
  private async metadata(oauth: typeof import('oauth4webapi')) {
    const issuer = webURL(this.options.issuer);
    const insecure = issuer.protocol === 'http:';
    const transport = { [oauth.allowInsecureRequests]: insecure,
      [oauth.customFetch]: (url, init) => fetch(url, { ...init, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) }) };
    const response = await oauth.discoveryRequest(issuer, transport);
    const as = await oauth.processDiscoveryResponse(issuer, response);
    if (!as.authorization_endpoint || !as.token_endpoint || !as.jwks_uri) throw new Error('The OpenID provider did not advertise its required endpoints.');
    for (const value of [as.authorization_endpoint, as.token_endpoint, as.jwks_uri]) {
      const endpoint = webURL(value);
      if (endpoint.protocol !== issuer.protocol) throw new Error('OpenID endpoints must use the issuer transport security.');
    }
    if (!as.code_challenge_methods_supported?.includes('S256')) throw new Error('The OpenID provider must advertise PKCE S256.');
    return { as, transport };
  }

  async get(context: Context): Promise<{ token: string; type: string }> {
    if (this.credential && this.credential.expires > Date.now() + 5000 &&
      this.credential.context.storage === context.storage && this.credential.context.authorizationServer === context.authorizationServer) {
      return { token: this.credential.token, type: TYPE };
    }
    if (!context.interactive) throw new Error('LWS sign-in expired. Reconnect your storage to sign in again.');
    const oauth = await this.library(), { as } = await this.metadata(oauth);
    const verifier = oauth.generateRandomCodeVerifier(), nonce = oauth.generateRandomNonce(), state = oauth.generateRandomState();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    const url = new URL(as.authorization_endpoint);
    const parameters = { client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: 'code',
      scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256', nonce, state, resource: context.authorizationServer };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    // Only single-use PKCE state persists across the navigation. Tokens stay in memory.
    sessionStorage.setItem(KEY, JSON.stringify({ version: 1, created: Date.now(), issuer: this.options.issuer,
      clientId: this.options.clientId, redirectUri: this.options.redirectUri, verifier, nonce, state, context }));
    window.location.assign(url.href);
    const redirect = new Error('Redirecting to the identity provider.');
    Object.assign(redirect, { redirecting: true });
    throw redirect;
  }

  async handleIncomingRedirect(url = window.location.href): Promise<Context> {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const pending = JSON.parse(raw), current = new URL(url), redirect = new URL(this.options.redirectUri);
    if (current.origin !== redirect.origin || current.pathname !== redirect.pathname ||
      !current.searchParams.has('state') || current.searchParams.get('state') !== pending.state) return undefined;
    // Consume before any token request, including an error/cancel response.
    sessionStorage.removeItem(KEY);
    if (pending.version !== 1 || pending.issuer !== this.options.issuer || pending.clientId !== this.options.clientId ||
      pending.redirectUri !== this.options.redirectUri || !Number.isFinite(pending.created) ||
      Date.now() - pending.created > 10 * 60 * 1000 || pending.created > Date.now()) throw new Error('LWS sign-in state expired or changed.');
    const epoch = this.epoch;
    const oauth = await this.library(), { as, transport } = await this.metadata(oauth);
    const client = { client_id: this.options.clientId, id_token_signed_response_alg: this.options.idTokenSigningAlg || 'RS256' };
    const params = oauth.validateAuthResponse(as, client, current, pending.state);
    const response = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params,
      this.options.redirectUri, pending.verifier, { ...transport, additionalParameters: new URLSearchParams({ resource: pending.context.authorizationServer }) });
    const result = await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: pending.nonce, requireIdToken: true });
    await oauth.validateApplicationLevelSignature(as, response, transport);
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (claims.azp !== this.options.clientId) throw new Error('The OpenID credential must identify this LWS client with azp.');
    try { new URL(claims.sub); } catch { throw new Error('The OpenID credential must use a URI subject for LWS.'); }
    if (epoch !== this.epoch) throw new Error('LWS sign-in was cancelled.');
    this.credential = { token: result.id_token, expires: claims.exp * 1000, context: pending.context };
    // Keep application query parameters while removing OAuth response parameters.
    for (const key of ['code', 'state', 'iss', 'session_state', 'error', 'error_description']) current.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', current.href);
    return pending.context;
  }

  clear(): void { this.epoch++; this.credential = undefined; sessionStorage.removeItem(KEY); }
}

export = LWSOpenID;
