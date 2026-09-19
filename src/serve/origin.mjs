/**
 * Cross-site WebSocket hijacking guard.
 *
 * The terminal has no authentication of its own — it sits behind the cluster's
 * oauth2-proxy. But a WebSocket handshake is not subject to the same-origin
 * policy: an attacker's page can open wss://<agent-host>/ws, the browser
 * attaches the proxy's session cookie, the proxy authorises the request, and
 * that page has a live bidirectional terminal, reading output and injecting
 * keystrokes as the signed-in user. Cookies alone cannot defend this endpoint;
 * the Origin header is what separates "the agent's own page" from "some other
 * site the user happened to visit".
 *
 * Requests with no Origin at all are allowed through: browsers always send one
 * on a WebSocket handshake, so their absence means a non-browser client (curl,
 * a probe, something in-cluster) which is not exposed to this attack. Blocking
 * those would break tooling without closing anything.
 *
 * This lives in the base because it is precisely the kind of fix that does not
 * propagate by hand: it landed in claude-code-adapter as commit fb22e8d and
 * never reached opencode-adapter, whose server.mjs is otherwise byte-identical.
 */

/** Drop a port that is implied by the scheme, so `https://x` and `x:443` compare equal. */
function normalizeHost(host, scheme) {
  const lower = String(host ?? '').toLowerCase();
  if (scheme === 'https:' && lower.endsWith(':443')) return lower.slice(0, -4);
  if (scheme === 'http:' && lower.endsWith(':80')) return lower.slice(0, -3);
  return lower;
}

/**
 * @param {object} req
 * @param {string} [req.origin]           The Origin header, if any.
 * @param {string} [req.host]             The Host header.
 * @param {string[]} [req.allowedOrigins] Exact origins to accept, from ALLOWED_ORIGINS.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkOrigin({ origin, host, allowedOrigins = [] } = {}) {
  if (!origin) return { allowed: true, reason: 'no Origin header (not a browser request)' };

  if (allowedOrigins.length > 0) {
    // An explicit allowlist replaces the Host comparison outright — that is the
    // escape hatch for a proxy that rewrites Host, or a console embedding the
    // terminal from a different origin.
    const allowed = allowedOrigins.includes(origin);
    return { allowed, reason: allowed ? 'origin is allowlisted' : `origin ${origin} is not in ALLOWED_ORIGINS` };
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    // Only a hand-rolled client sends an unparseable Origin.
    return { allowed: false, reason: `origin ${JSON.stringify(origin)} is not a valid URL` };
  }

  const originHost = normalizeHost(parsed.host, parsed.protocol);
  const requestHost = normalizeHost(host, parsed.protocol);
  const allowed = originHost !== '' && originHost === requestHost;
  return {
    allowed,
    reason: allowed ? 'origin matches host' : `origin host ${originHost || '(empty)'} does not match request host ${requestHost || '(empty)'}`,
  };
}

/** Parse the ALLOWED_ORIGINS env var into exact origins. */
export function parseAllowedOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
