"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth as useOidcAuth } from "react-oidc-context";
import { useHerculesAuthProvider } from "./HerculesAuthProvider";
import {
  rememberHerculesImpersonationSession,
  type StoredHerculesImpersonation,
} from "./impersonation-core";
export {
  getHerculesImpersonationStorageKey,
  HERCULES_IMPERSONATION_SESSION_ID_PARAM,
  HERCULES_IMPERSONATION_TOKEN_PARAM,
  rememberHerculesImpersonationSession,
} from "./impersonation-core";

export type HerculesImpersonationState = {
  isImpersonating: boolean;
  sessionId: string | null;
  actorSub: string | null;
  stopImpersonating: () => Promise<void>;
};

export function useHerculesImpersonation(): HerculesImpersonationState {
  const { userManager, impersonationStorageKey } = useHerculesAuthProvider();
  const auth = useOidcAuth();
  const [storedSessionId, setStoredSessionId] = useState<string | null>(() =>
    readStoredImpersonationSessionId(impersonationStorageKey),
  );

  const profile = (auth.user?.profile ?? {}) as Record<string, unknown>;
  const profileSessionId =
    typeof profile.hercules_impersonation_session_id === "string"
      ? profile.hercules_impersonation_session_id
      : null;
  const actorSub =
    typeof profile.hercules_actor_sub === "string"
      ? profile.hercules_actor_sub
      : null;
  const sessionId = profileSessionId ?? storedSessionId;

  useEffect(() => {
    if (!auth.isAuthenticated) return;

    if (profileSessionId) {
      rememberHerculesImpersonationSession(
        impersonationStorageKey,
        profileSessionId,
      );
      setStoredSessionId(profileSessionId);
    }
  }, [auth.isAuthenticated, impersonationStorageKey, profileSessionId]);

  const stopImpersonating = useCallback(async () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(impersonationStorageKey);
    }
    setStoredSessionId(null);

    const endpoint = await userManager.metadataService.getEndSessionEndpoint();
    if (endpoint != null) {
      await auth.signoutRedirect();
    } else {
      await auth.removeUser();
    }
  }, [auth, impersonationStorageKey, userManager]);

  return useMemo(
    () => ({
      isImpersonating: auth.isAuthenticated && sessionId != null,
      sessionId,
      actorSub,
      stopImpersonating,
    }),
    [actorSub, auth.isAuthenticated, sessionId, stopImpersonating],
  );
}

function readStoredImpersonationSessionId(storageKey: string) {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<StoredHerculesImpersonation>;
    return typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  } catch {
    return null;
  }
}
