export const VISITOR_ID_COOKIE = "_hrc_vid";
export const VISITOR_ID_COOKIE_DAYS = 365 * 2;

/** localStorage key holding the identified user id (posthog persists distinct_id the same way) */
export const USER_ID_STORAGE_KEY = "_hrc_uid";

/** localStorage key holding [sessionId, lastActivityTimestamp, sessionStartTimestamp] */
export const SESSION_STORAGE_KEY = "_hrc_ses";
/** sessionStorage keys used by @usehercules/analytics < 2.0, read once for migration */
export const LEGACY_SESSION_ID_KEY = "_hrc_sid";
export const LEGACY_LAST_ACTIVITY_KEY = "_hrc_last_activity";

// Session semantics follow posthog-js sessionid.ts
export const DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES = 30;
export const SESSION_LENGTH_LIMIT_MS = 24 * 60 * 60 * 1000;

// Request pipeline defaults (posthog-js request-queue.ts / retry-queue.ts)
export const DEFAULT_FLUSH_INTERVAL_MS = 3000;
export const DEFAULT_BUFFER_SIZE = 10;
export const RETRY_BASE_DELAY_MS = 6000;
export const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
export const MAX_RETRIES = 10;

/** Flush web vitals this long after the first metric arrives (posthog-js web-vitals) */
export const WEB_VITALS_FLUSH_MS = 5000;
/**
 * Ignore web-vitals values at or above this (15 min), matching posthog-js
 * `_maxAllowedValue`. bfcache restores and clock skew can produce absurd LCP/INP
 * readings that would otherwise wreck p75s.
 */
export const WEB_VITALS_MAX_VALUE_MS = 15 * 60 * 1000;
