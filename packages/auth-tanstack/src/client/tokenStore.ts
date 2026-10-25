import { getSessionTokensAction, refreshSessionTokensAction } from "../server/actions";
import type { SessionTokens } from "../server/types";
import { decodeJwt } from "./jwt";

interface TokenState {
  token: string | undefined;
  loading: boolean;
  error: Error | null;
}

const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const SHORT_TOKEN_LIFETIME_SECONDS = 300;
const SHORT_TOKEN_EXPIRY_BUFFER_SECONDS = 30;
const MIN_REFRESH_DELAY_SECONDS = 15;
const MAX_REFRESH_DELAY_SECONDS = 24 * 60 * 60;
const RETRY_DELAY_SECONDS = 300;
/**
 * How far the wall clock may drift from monotonic time since the last
 * measurement before the clock offset is re-measured. Well below the expiry
 * buffers, well above timer jitter.
 */
const CLOCK_JUMP_TOLERANCE_MS = 5_000;

function getExpiryBuffer(totalTokenLifetime: number): number {
  return totalTokenLifetime <= SHORT_TOKEN_LIFETIME_SECONDS
    ? SHORT_TOKEN_EXPIRY_BUFFER_SECONDS
    : TOKEN_EXPIRY_BUFFER_SECONDS;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

interface ParsedToken {
  expiresAt: number;
  isExpiring: boolean;
  timeUntilExpiry: number;
  totalTokenLifetime: number;
}

/**
 * Reads and refreshes the session's tokens on behalf of every
 * {@link TokenStore}, and keeps the clock they judge expiry by.
 *
 * One refresh grant returns both the access and the ID token, so the stores
 * share it: a request from any store joins the one already in flight, and every
 * result is handed to all of them. Refreshing separately, the two stores would
 * spend the same refresh token twice at once, since their tokens usually expire
 * together — and a provider that rotates refresh tokens with reuse detection
 * revokes the session for that.
 *
 * Expiry is judged on the server's clock. Every response carries the server's
 * time, from which this measures the browser clock's offset; a browser clock
 * that is minutes or hours off would otherwise make every token look expired
 * (refreshing on every read) or never expire (handing out dead tokens).
 */
export class TokenSource {
  private readonly stores = new Set<TokenStore>();
  private fetchPromise: Promise<SessionTokens> | null = null;
  private refreshPromise: Promise<SessionTokens> | null = null;
  /** Browser clock minus server clock, in ms. */
  private clockOffsetMs = 0;
  /** Wall and monotonic time when the offset was last measured. */
  private measuredAt: { wall: number; monotonic: number } | undefined;

  /**
   * @param fetchTokens  Cheap read of the current tokens (no refresh grant).
   * @param refreshTokens  Refresh the session and return the new tokens.
   * @param monotonic  Monotonic clock (ms), used to detect wall-clock jumps.
   */
  constructor(
    private readonly fetchTokens: () => Promise<SessionTokens> = getSessionTokensAction,
    private readonly refreshTokens: () => Promise<SessionTokens> = refreshSessionTokensAction,
    private readonly monotonic: () => number = monotonicNow,
  ) {}

  /** Hand every future result to `store`. */
  register(store: TokenStore): void {
    this.stores.add(store);
  }

  /** The current time on the server's clock, in epoch seconds. */
  nowSeconds(): number {
    return Math.floor((Date.now() - this.clockOffsetMs) / 1000);
  }

  /**
   * False when the wall clock has moved apart from real time since the offset
   * was measured (the OS corrected it, or the user changed it), so the offset
   * no longer holds. System sleep can trip this too, which only costs a read.
   */
  isClockTrusted(): boolean {
    if (!this.measuredAt) return true;
    const wallElapsed = Date.now() - this.measuredAt.wall;
    const realElapsed = this.monotonic() - this.measuredAt.monotonic;
    return Math.abs(wallElapsed - realElapsed) <= CLOCK_JUMP_TOLERANCE_MS;
  }

  /** Read the current tokens. Joins a refresh in flight, whose tokens are fresher. */
  fetch(): Promise<SessionTokens> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.fetchPromise) {
      const promise = this.request(this.fetchTokens).finally(() => {
        if (this.fetchPromise === promise) this.fetchPromise = null;
      });
      this.fetchPromise = promise;
    }
    return this.fetchPromise;
  }

  /** Refresh the session, joining a refresh already in flight. */
  refresh(): Promise<SessionTokens> {
    if (!this.refreshPromise) {
      const promise = this.request(this.refreshTokens).finally(() => {
        if (this.refreshPromise === promise) this.refreshPromise = null;
      });
      this.refreshPromise = promise;
    }
    return this.refreshPromise;
  }

  private async request(action: () => Promise<SessionTokens>): Promise<SessionTokens> {
    const sentAt = Date.now();
    const tokens = await action();
    const receivedAt = Date.now();
    if (typeof tokens.serverTime === "number" && Number.isFinite(tokens.serverTime)) {
      // The server read its clock somewhere between send and receive; the
      // midpoint bounds the error by half the round trip.
      this.clockOffsetMs = (sentAt + receivedAt) / 2 - tokens.serverTime;
      this.measuredAt = { wall: receivedAt, monotonic: this.monotonic() };
    }
    for (const store of this.stores) store.receive(tokens);
    return tokens;
  }

  /** Test/teardown helper: forget in-flight requests and the clock offset. */
  reset(): void {
    this.fetchPromise = null;
    this.refreshPromise = null;
    this.clockOffsetMs = 0;
    this.measuredAt = undefined;
  }
}

/**
 * Client-side store for a single bearer token (access or ID), with proactive
 * scheduled refresh ahead of expiry. Requests go through a shared
 * {@link TokenSource}, so the access- and ID-token stores
 * ({@link tokenStore}, {@link idTokenStore}) refresh together, and the token
 * here is always the latest one the source returned.
 */
export class TokenStore {
  private state: TokenState = { token: undefined, loading: false, error: null };
  private readonly serverSnapshot: TokenState = { token: undefined, loading: false, error: null };

  private listeners = new Set<() => void>();
  private refreshPromise: Promise<string | undefined> | null = null;
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param source  Shared reader/refresher of the session's tokens.
   * @param select  Picks this store's token out of a result.
   */
  constructor(
    private readonly source: TokenSource,
    private readonly select: (tokens: SessionTokens) => string | undefined,
  ) {
    source.register(this);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.cancelRefresh();
    };
  };

  getSnapshot = (): TokenState => this.state;
  getServerSnapshot = (): TokenState => this.serverSnapshot;

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private setState(updates: Partial<TokenState>): void {
    this.state = { ...this.state, ...updates };
    this.notify();
  }

  /**
   * Adopt this store's token from a result fetched by any store. An unchanged
   * token publishes nothing, so subscribers don't re-render on a revalidation.
   */
  receive(tokens: SessionTokens): void {
    const token = this.select(tokens);
    if (token !== this.state.token) this.setState({ token, error: null });

    const tokenData = this.parseToken(token);
    if (tokenData) this.scheduleRefresh(tokenData);
    // Opaque token: no local expiry to schedule against, so revalidate on the
    // retry cadence rather than treating it as permanently fresh.
    else if (token) this.scheduleRefresh();
    else this.cancelRefresh();
  }

  parseToken(token: string | undefined): ParsedToken | null {
    if (!token) return null;
    try {
      const { payload } = decodeJwt(token);
      if (typeof payload.exp !== "number") return null;

      const now = this.source.nowSeconds();
      const totalTokenLifetime = payload.exp - (payload.iat ?? now);
      const bufferSeconds = getExpiryBuffer(totalTokenLifetime);

      return {
        expiresAt: payload.exp,
        isExpiring: payload.exp <= now + bufferSeconds,
        timeUntilExpiry: payload.exp - now,
        totalTokenLifetime,
      };
    } catch {
      return null;
    }
  }

  private getRefreshDelay({ timeUntilExpiry, totalTokenLifetime }: ParsedToken): number {
    const bufferSeconds = getExpiryBuffer(totalTokenLifetime);
    const idealDelay = (timeUntilExpiry - bufferSeconds) * 1000;
    // Floor the proactive delay at MIN_REFRESH_DELAY. A token whose lifetime is
    // at or below the buffer (e.g. 30s test tokens) would otherwise schedule a
    // 0 ms refresh, which fires immediately, sees the token still expiring, and
    // refreshes again in a tight loop. On-demand reads still refresh a genuinely
    // expiring token immediately; this only paces the background timer.
    return Math.min(
      Math.max(idealDelay, MIN_REFRESH_DELAY_SECONDS * 1000),
      MAX_REFRESH_DELAY_SECONDS * 1000,
    );
  }

  private scheduleRefresh(tokenData?: ParsedToken): void {
    this.cancelRefresh();
    // The timer serves mounted hooks only. A store nobody listens to is brought
    // up to date by the hook that next mounts it.
    if (this.listeners.size === 0) return;
    const delay =
      tokenData === undefined ? RETRY_DELAY_SECONDS * 1000 : this.getRefreshDelay(tokenData);
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = undefined;
      void this.getTokenSilently().catch(() => {});
    }, delay);
  }

  private cancelRefresh(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
  }

  clearToken(): void {
    this.setState({ token: undefined, error: null, loading: false });
    this.cancelRefresh();
  }

  /**
   * Parse the current token, first re-reading the tokens (which re-measures
   * the clock offset) when the wall clock has jumped since the last
   * measurement. A failed read leaves the old offset in place.
   */
  private async currentTokenData(): Promise<ParsedToken | null> {
    if (this.state.token && !this.source.isClockTrusted()) {
      await this.source.fetch().catch(() => {});
    }
    return this.parseToken(this.state.token);
  }

  /** Get a guaranteed-fresh token, refreshing when expiring. */
  async getToken(): Promise<string | undefined> {
    const tokenData = await this.currentTokenData();
    if (tokenData && !tokenData.isExpiring) return this.state.token;
    // Otherwise — expiring, absent, or opaque (unparseable, so freshness can't
    // be checked locally) — revalidate against the server rather than trusting a
    // cached copy. The server validates against the session's stored expiry.
    return this.refreshTokenSilently();
  }

  /** Like {@link getToken} but also keeps the next refresh scheduled. */
  async getTokenSilently(): Promise<string | undefined> {
    const tokenData = await this.currentTokenData();
    if (tokenData && !tokenData.isExpiring) {
      // A remount after every listener left (which cancels the timer) finds a
      // fresh token and nothing scheduled; queue the refresh again.
      if (!this.refreshTimeout) this.scheduleRefresh(tokenData);
      return this.state.token;
    }
    return this.refreshTokenSilently();
  }

  /** Force a refresh (user-initiated), surfacing loading state. */
  async refreshToken(): Promise<string | undefined> {
    return this._refreshToken(false);
  }

  private async refreshTokenSilently(): Promise<string | undefined> {
    return this._refreshToken(true);
  }

  private async _refreshToken(silent: boolean): Promise<string | undefined> {
    if (this.refreshPromise) return this.refreshPromise;

    const previousToken = this.state.token;
    if (!silent) this.setState({ loading: true, error: null });
    else if (this.state.error) this.setState({ error: null });

    this.refreshPromise = (async () => {
      try {
        let tokens: SessionTokens;

        // Try the cheap read before a full refresh when we have no token, or an
        // opaque one we can't validate locally. The server returns the current
        // tokens only if the session is present and unexpired (per its stored
        // expiry), so a token it returns is already validated.
        const needsServerCheck = !previousToken || this.parseToken(previousToken) === null;
        if (silent && needsServerCheck) {
          tokens = await this.source.fetch();
          const token = this.select(tokens);
          // Refresh only if the server has nothing, or returned a parseable
          // token that's already expiring. A server-returned opaque token is
          // session-validated, so accept it as-is.
          if (!token || this.parseToken(token)?.isExpiring) {
            tokens = await this.source.refresh();
          }
        } else {
          tokens = await this.source.refresh();
        }

        // The source already handed the result to receive(); only the loading
        // flag this call raised is left to settle.
        if (!silent) this.setState({ loading: false });
        return this.select(tokens);
      } catch (error) {
        this.setState({
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.scheduleRefresh();
        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /** Test/teardown helper: reset all state and listeners. */
  reset(): void {
    this.state = { token: undefined, loading: false, error: null };
    this.refreshPromise = null;
    this.cancelRefresh();
    this.listeners.clear();
  }
}

/** Shared reader/refresher behind both token stores. */
export const tokenSource = new TokenSource();
/** Shared singleton for the access token. */
export const tokenStore = new TokenStore(tokenSource, (tokens) => tokens.accessToken);
/** Shared singleton for the ID token. */
export const idTokenStore = new TokenStore(tokenSource, (tokens) => tokens.idToken);
