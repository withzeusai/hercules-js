import { getAccessTokenAction, refreshAccessTokenAction } from "../server/actions";
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
 * Client-side store for the access token, with single-flight refresh and
 * proactive scheduled refresh ahead of expiry. Backed by the `getAccessToken`/
 * `refreshAccessToken` server actions. A module singleton shared by all hooks.
 */
export class TokenStore {
  private state: TokenState = { token: undefined, loading: false, error: null };
  private readonly serverSnapshot: TokenState = { token: undefined, loading: false, error: null };

  private listeners = new Set<() => void>();
  private refreshPromise: Promise<string | undefined> | null = null;
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

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
    if (timeUntilExpiry <= bufferSeconds) return 0;
    const idealDelay = (timeUntilExpiry - bufferSeconds) * 1000;
    return Math.min(Math.max(idealDelay, MIN_REFRESH_DELAY_SECONDS * 1000), MAX_REFRESH_DELAY_SECONDS * 1000);
  }

  private scheduleRefresh(tokenData?: ParsedToken): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
    const delay = tokenData === undefined ? RETRY_DELAY_SECONDS * 1000 : this.getRefreshDelay(tokenData);
    this.refreshTimeout = setTimeout(() => {
      void this.getAccessTokenSilently().catch(() => {});
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
  async getAccessToken(): Promise<string | undefined> {
    const tokenData = this.parseToken(this.state.token);
    if (tokenData && !tokenData.isExpiring) return this.state.token;
    // An unparseable-but-present token (opaque) can't be checked — return it.
    if (this.state.token && !tokenData) return this.state.token;
    return this.refreshTokenSilently();
  }

  /** Like {@link getAccessToken} but also (re)schedules the next refresh. */
  async getAccessTokenSilently(): Promise<string | undefined> {
    const tokenData = this.parseToken(this.state.token);
    if (tokenData && !tokenData.isExpiring) return this.state.token;
    if (this.state.token && !tokenData) return this.state.token;
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

        if (silent && !previousToken) {
          // No token in hand yet — the session may already carry a valid access
          // token (e.g. right after SSR), so try the cheap GET before refreshing.
          token = await getAccessTokenAction();
          const tokenData = this.parseToken(token);
          if (!token || (tokenData && tokenData.isExpiring)) {
            token = (await refreshAccessTokenAction()) ?? token;
          }
        } else {
          token = await refreshAccessTokenAction();
        }

        this.setState({ token, loading: false, error: null });

        const tokenData = this.parseToken(token);
        if (tokenData) this.scheduleRefresh(tokenData);

        return token;
      } catch (error) {
        this.setState({ loading: false, error: error instanceof Error ? error : new Error(String(error)) });
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

export const tokenStore = new TokenStore();
