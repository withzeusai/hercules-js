import {
  getAccessTokenAction,
  getIdTokenAction,
  refreshAccessTokenAction,
  refreshIdTokenAction,
} from "../server/actions";
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

function getExpiryBuffer(totalTokenLifetime: number): number {
  return totalTokenLifetime <= SHORT_TOKEN_LIFETIME_SECONDS
    ? SHORT_TOKEN_EXPIRY_BUFFER_SECONDS
    : TOKEN_EXPIRY_BUFFER_SECONDS;
}

interface ParsedToken {
  expiresAt: number;
  isExpiring: boolean;
  timeUntilExpiry: number;
  totalTokenLifetime: number;
}

/**
 * Client-side store for a single bearer token (access or ID), with single-flight
 * refresh and proactive scheduled refresh ahead of expiry. The cheap GET and the
 * refresh are injected so one implementation backs both token kinds; the access-
 * token actions are the defaults. Each kind is a module singleton shared by all
 * hooks ({@link tokenStore}, {@link idTokenStore}).
 */
export class TokenStore {
  private state: TokenState = { token: undefined, loading: false, error: null };
  private readonly serverSnapshot: TokenState = { token: undefined, loading: false, error: null };

  private listeners = new Set<() => void>();
  private refreshPromise: Promise<string | undefined> | null = null;
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param fetchToken  Cheap GET of the current token (no refresh round-trip).
   * @param refreshTokenAction  Refresh the session and return the new token.
   */
  constructor(
    private readonly fetchToken: () => Promise<string | undefined> = getAccessTokenAction,
    private readonly refreshTokenAction: () => Promise<
      string | undefined
    > = refreshAccessTokenAction,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.refreshTimeout) {
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = undefined;
      }
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

  parseToken(token: string | undefined): ParsedToken | null {
    if (!token) return null;
    try {
      const { payload } = decodeJwt(token);
      if (typeof payload.exp !== "number") return null;

      const now = Math.floor(Date.now() / 1000);
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
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
    const delay =
      tokenData === undefined ? RETRY_DELAY_SECONDS * 1000 : this.getRefreshDelay(tokenData);
    this.refreshTimeout = setTimeout(() => {
      void this.getTokenSilently().catch(() => {});
    }, delay);
  }

  clearToken(): void {
    this.setState({ token: undefined, error: null, loading: false });
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
  }

  /** Get a guaranteed-fresh token, refreshing when expiring. */
  async getToken(): Promise<string | undefined> {
    const tokenData = this.parseToken(this.state.token);
    if (tokenData && !tokenData.isExpiring) return this.state.token;
    // Otherwise — expiring, absent, or opaque (unparseable, so freshness can't
    // be checked locally) — revalidate against the server rather than trusting a
    // cached copy. The server validates against the session's stored expiry.
    return this.refreshTokenSilently();
  }

  /** Like {@link getToken} but also (re)schedules the next refresh. */
  async getTokenSilently(): Promise<string | undefined> {
    const tokenData = this.parseToken(this.state.token);
    if (tokenData && !tokenData.isExpiring) return this.state.token;
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
    this.setState(silent ? { error: null } : { loading: true, error: null });

    this.refreshPromise = (async () => {
      try {
        let token: string | undefined;

        // Try the cheap GET before a full refresh when we have no token, or an
        // opaque one we can't validate locally. The server returns the current
        // token only if the session is present and unexpired (per its stored
        // expiry), so a token it returns is already validated.
        const needsServerCheck = !previousToken || this.parseToken(previousToken) === null;
        if (silent && needsServerCheck) {
          token = await this.fetchToken();
          const tokenData = this.parseToken(token);
          // Refresh only if the server has nothing, or returned a parseable
          // token that's already expiring. A server-returned opaque token is
          // session-validated, so accept it as-is.
          if (!token || (tokenData && tokenData.isExpiring)) {
            token = (await this.refreshTokenAction()) ?? token;
          }
        } else {
          token = await this.refreshTokenAction();
        }

        this.setState({ token, loading: false, error: null });

        const tokenData = this.parseToken(token);
        if (tokenData) this.scheduleRefresh(tokenData);
        // Opaque token: no local expiry to schedule against, so revalidate on
        // the retry cadence rather than treating it as permanently fresh.
        else if (token) this.scheduleRefresh();

        return token;
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
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
    this.listeners.clear();
  }
}

/** Shared singleton for the access token. */
export const tokenStore = new TokenStore();
/** Shared singleton for the ID token. */
export const idTokenStore = new TokenStore(getIdTokenAction, refreshIdTokenAction);
