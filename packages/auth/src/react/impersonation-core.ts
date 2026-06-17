"use client";

export const HERCULES_IMPERSONATION_SESSION_ID_PARAM =
  "hercules_impersonation_session_id";
export const HERCULES_IMPERSONATION_TOKEN_PARAM =
  "hercules_impersonation_token";

export type StoredHerculesImpersonation = {
  sessionId: string;
  startedAt: string;
};

export function getHerculesImpersonationStorageKey(
  authority: string,
  clientId: string,
) {
  return `hercules.impersonation.${authority}.${clientId}`;
}

export function rememberHerculesImpersonationSession(
  storageKey: string,
  sessionId: string,
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    storageKey,
    JSON.stringify({ sessionId, startedAt: new Date().toISOString() }),
  );
}

export function clearHerculesImpersonationParamsFromUrl(url: URL) {
  url.searchParams.delete(HERCULES_IMPERSONATION_SESSION_ID_PARAM);
  url.searchParams.delete(HERCULES_IMPERSONATION_TOKEN_PARAM);
  return url;
}
