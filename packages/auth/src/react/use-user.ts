"use client";

import { useMemo } from "react";
import { useAuth } from "react-oidc-context";

/**
 * A hook that returns the current user if authenticated
 *
 * @public
 */
export function useUser() {
  const { user, isLoading, error, isAuthenticated } = useAuth();

  return useMemo(() => {
    const id = user?.profile.sub;
    const name = user?.profile.name;
    const email = user?.profile.email;
    const avatar = user?.profile.picture;
    return {
      ...(user ?? {}),
      id,
      name,
      email,
      avatar,
      isAuthenticated,
      isLoading,
      error,
    };
  }, [user, isAuthenticated, isLoading, error]);
}
