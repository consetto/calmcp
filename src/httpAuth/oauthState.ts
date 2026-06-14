// Stateless, signed OAuth `state` codec for the XSUAA callback proxy.
//
// Why this exists: XSUAA echoes a literal `+` (not `%2B`) for any `state` value containing `+`
// when it redirects back to the OAuth client. Standard base64 `state` values (which many MCP
// clients generate) contain `+` ~50% of the time, and the receiving client decodes `+` to a space
// under `application/x-www-form-urlencoded` semantics, so the round-tripped `state` no longer
// matches → "State does not match" → login fails.
//
// The fix is to put calmcp into the OAuth return path: we send XSUAA a `state` that calmcp controls
// and that is immune to the `+` bug (base64url uses `A-Za-z0-9-_` — no `+`, no `/`), carrying the
// client's ORIGINAL `state` + `redirect_uri` inside an HMAC-signed, URL-safe token. The callback
// route then re-emits the client's original `state` correctly. The token is self-validating, so any
// instance with the same signing key can verify it — no shared state, survives restarts/scale-out.

import crypto from 'node:crypto';

/** Domain-separation label for the HKDF-style key derivation. Bump the version suffix to invalidate
 *  every outstanding state token at once. */
const KDF_LABEL = 'calmcp-oauth-state/v1';

/** Truncated HMAC length in bytes. 16 bytes (128 bits) is ample for a short-lived, single-use
 *  CSRF state token. */
const SIG_BYTES = 16;

/** Default lifetime of a state token. The authorize→callback hop is interactive (the user logs in),
 *  so a few minutes covers it. */
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

/** Compact JSON shape embedded in the signed token. Keys are terse to keep the URL short. */
interface StatePayload {
  /** Schema version. */
  v: 1;
  /** The OAuth client's ORIGINAL `state` (may contain `+`; optional per RFC 6749). */
  s?: string;
  /** The OAuth client's ORIGINAL `redirect_uri` — where calmcp sends the user after XSUAA returns. */
  r: string;
  /** The DCR `client_id` that initiated the flow. Bound into the signed payload so the callback can
   *  verify the recovered `redirect_uri` is actually registered for THIS client (closes the
   *  authorization-code interception vector). */
  cid: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export type DecodeResult =
  | { kind: 'ok'; clientState?: string; clientRedirectUri: string; clientId: string }
  | { kind: 'error'; reason: 'malformed' | 'bad_signature' | 'invalid_payload' | 'expired' };

/**
 * Signs and verifies OAuth `state` tokens for the XSUAA callback proxy.
 */
export class OAuthStateCodec {
  private readonly hmacKey: Buffer;
  private readonly ttlSeconds: number;

  constructor(signingSecret: string, opts: { ttlSeconds?: number } = {}) {
    if (!signingSecret) {
      throw new Error('OAuthStateCodec requires a non-empty signingSecret');
    }
    // HKDF-style: derive a dedicated key from the shared secret + label. The label domain-separates
    // this key from the DCR client-id signing key.
    this.hmacKey = crypto.createHmac('sha256', signingSecret).update(KDF_LABEL).digest();
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /**
   * Encode a URL-safe, signed state token. Safe to put in a query string and round-trip through
   * XSUAA (no `+`, no `/`).
   *
   * @param input.now - Injectable clock (epoch ms) for deterministic tests.
   */
  encode(input: {
    clientState?: string;
    clientRedirectUri: string;
    clientId: string;
    now?: number;
  }): string {
    const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
    const payload: StatePayload = {
      v: 1,
      r: input.clientRedirectUri,
      cid: input.clientId,
      exp: nowSec + this.ttlSeconds,
    };
    if (input.clientState !== undefined) {
      payload.s = input.clientState;
    }
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${payloadB64}.${this.sign(payloadB64)}`;
  }

  /**
   * Decode and verify a state token. Never throws — returns a typed result.
   *
   * @param now - Injectable clock (epoch ms) for deterministic tests.
   */
  decode(token: string, now: number = Date.now()): DecodeResult {
    if (typeof token !== 'string' || token.length === 0) {
      return { kind: 'error', reason: 'malformed' };
    }
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot === token.length - 1) {
      return { kind: 'error', reason: 'malformed' };
    }
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    if (!this.verifySignature(payloadB64, sigB64)) {
      return { kind: 'error', reason: 'bad_signature' };
    }

    const payload = parsePayload(payloadB64);
    if (!payload) {
      return { kind: 'error', reason: 'invalid_payload' };
    }

    if (payload.exp * 1000 <= now) {
      return { kind: 'error', reason: 'expired' };
    }

    return {
      kind: 'ok',
      clientState: payload.s,
      clientRedirectUri: payload.r,
      clientId: payload.cid,
    };
  }

  private sign(payloadB64: string): string {
    const fullDigest = crypto.createHmac('sha256', this.hmacKey).update(payloadB64).digest();
    return fullDigest.subarray(0, SIG_BYTES).toString('base64url');
  }

  private verifySignature(payloadB64: string, sigB64: string): boolean {
    const expected = Buffer.from(this.sign(payloadB64), 'base64url');
    const actual = Buffer.from(sigB64, 'base64url');
    if (actual.length !== expected.length || actual.length !== SIG_BYTES) {
      return false;
    }
    return crypto.timingSafeEqual(actual, expected);
  }
}

/** Parse a base64url payload back into a typed `StatePayload`. Returns `undefined` on any failure. */
function parsePayload(payloadB64: string): StatePayload | undefined {
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (obj.v !== 1) return undefined;
    if (typeof obj.r !== 'string' || obj.r.length === 0) return undefined;
    if (typeof obj.cid !== 'string' || obj.cid.length === 0) return undefined;
    if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp)) return undefined;
    if (obj.s !== undefined && typeof obj.s !== 'string') return undefined;
    return { v: 1, s: obj.s as string | undefined, r: obj.r, cid: obj.cid, exp: obj.exp };
  } catch {
    return undefined;
  }
}
