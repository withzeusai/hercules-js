/*!
 * State/navigation behavior adapted from react-oidc-context 3.3.1 (MIT).
 * Copyright (c) 2021 pamapa
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { User, UserManager } from "oidc-client-ts";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  hasAuthParams,
  type AuthContextProps,
  type AuthProviderBaseProps,
  type AuthState,
  type ErrorContext,
} from "react-oidc-context";

type Navigator = NonNullable<AuthState["activeNavigator"]>;
type Action =
  | { type: "INITIALISED" | "USER_LOADED"; user: User | null | undefined }
  | { type: "USER_UNLOADED" | "USER_SIGNED_OUT" | "NAVIGATOR_CLOSE" }
  | { type: "NAVIGATOR_INIT"; method: Navigator }
  | { type: "ERROR" | "REPORT_ERROR"; error: ErrorContext };

function reducer(state: AuthState, action: Action): AuthState {
  switch (action.type) {
    case "INITIALISED":
    case "USER_LOADED":
      return {
        ...state,
        user: action.user,
        isLoading: false,
        isAuthenticated: action.user ? !action.user.expired : false,
        error: undefined,
      };
    case "USER_UNLOADED":
    case "USER_SIGNED_OUT":
      return { ...state, user: undefined, isAuthenticated: false };
    case "NAVIGATOR_INIT":
      return { ...state, isLoading: true, activeNavigator: action.method };
    case "NAVIGATOR_CLOSE":
      return { ...state, isLoading: false, activeNavigator: undefined };
    case "ERROR":
    case "REPORT_ERROR": {
      const error = action.error;
      error.toString = () => `${error.name}: ${error.message}`;
      // An adapter's failed request must not close another active navigator.
      return action.type === "REPORT_ERROR"
        ? { ...state, error }
        : { ...state, isLoading: false, error };
    }
  }
}

function normalizeError(error: unknown, fallbackMessage: string) {
  const fields = error !== null && typeof error === "object" ? error : {};
  return {
    name: "name" in fields && typeof fields.name === "string" ? fields.name : "Error",
    message:
      "message" in fields && typeof fields.message === "string" ? fields.message : fallbackMessage,
    stack: "stack" in fields && typeof fields.stack === "string" ? fields.stack : new Error().stack,
    innerError: error,
  };
}

/**
 * Keep adapter reports and OIDC transitions in one queue, including batched failures.
 * REPORT_ERROR is the only added transition. Review upstream parity on dependency upgrades.
 */
export function useOidcAuthState(
  userManager: UserManager,
  {
    onSigninCallback,
    skipSigninCallback,
    matchSignoutCallback,
    onSignoutCallback,
    onRemoveUser,
  }: Omit<AuthProviderBaseProps, "children">,
) {
  const [state, dispatch] = useReducer(reducer, { isLoading: true, isAuthenticated: false });
  const methods = useMemo(() => {
    function navigator<Args, Result>(method: Navigator, execute: (args: Args) => Promise<Result>) {
      // Upstream navigators return null on failure even where their declarations
      // expose only User or void. Keep that assertion at the callable boundary.
      return (async (args: Args) => {
        dispatch({ type: "NAVIGATOR_INIT", method });
        try {
          return await execute(args);
        } catch (error) {
          dispatch({
            type: "ERROR",
            // Each method below binds its matching UserManager argument signature.
            error: {
              ...normalizeError(error, `Unknown error while executing ${method}(...).`),
              source: method,
              args,
            } as ErrorContext,
          });
          return null;
        } finally {
          dispatch({ type: "NAVIGATOR_CLOSE" });
        }
      }) as typeof execute;
    }

    return {
      settings: userManager.settings,
      events: userManager.events,
      clearStaleState: userManager.clearStaleState.bind(userManager),
      querySessionStatus: userManager.querySessionStatus.bind(userManager),
      revokeTokens: userManager.revokeTokens.bind(userManager),
      startSilentRenew: userManager.startSilentRenew.bind(userManager),
      stopSilentRenew: userManager.stopSilentRenew.bind(userManager),
      signinPopup: navigator("signinPopup", userManager.signinPopup.bind(userManager)),
      signinSilent: navigator("signinSilent", userManager.signinSilent.bind(userManager)),
      signinRedirect: navigator("signinRedirect", userManager.signinRedirect.bind(userManager)),
      signinResourceOwnerCredentials: navigator(
        "signinResourceOwnerCredentials",
        userManager.signinResourceOwnerCredentials.bind(userManager),
      ),
      signoutPopup: navigator("signoutPopup", userManager.signoutPopup.bind(userManager)),
      signoutRedirect: navigator("signoutRedirect", userManager.signoutRedirect.bind(userManager)),
      signoutSilent: navigator("signoutSilent", userManager.signoutSilent.bind(userManager)),
    } satisfies Omit<AuthContextProps, keyof AuthState | "removeUser">;
  }, [userManager]);

  const didInitialize = useRef(false);
  useEffect(() => {
    if (didInitialize.current) return;
    didInitialize.current = true;

    void (async () => {
      try {
        let user: User | null | undefined = null;
        if (hasAuthParams() && !skipSigninCallback) {
          user = await userManager.signinCallback();
          if (onSigninCallback) await onSigninCallback(user);
        }
        user = user || (await userManager.getUser());
        dispatch({ type: "INITIALISED", user });
      } catch (error) {
        dispatch({
          type: "ERROR",
          error: { ...normalizeError(error, "Sign-in failed"), source: "signinCallback" },
        });
      }

      try {
        if (matchSignoutCallback?.(userManager.settings)) {
          const response = await userManager.signoutCallback();
          if (onSignoutCallback) await onSignoutCallback(response);
        }
      } catch (error) {
        dispatch({
          type: "ERROR",
          error: { ...normalizeError(error, "Sign-out failed"), source: "signoutCallback" },
        });
      }
    })();
  }, [userManager, skipSigninCallback, onSigninCallback, matchSignoutCallback, onSignoutCallback]);

  useEffect(() => {
    const loaded = (user: User) => dispatch({ type: "USER_LOADED", user });
    const unloaded = () => dispatch({ type: "USER_UNLOADED" });
    const signedOut = () => dispatch({ type: "USER_SIGNED_OUT" });
    const renewFailed = (error: Error) => {
      dispatch({
        type: "ERROR",
        error: { ...normalizeError(error, "Renew silent failed"), source: "renewSilent" },
      });
    };
    userManager.events.addUserLoaded(loaded);
    userManager.events.addUserUnloaded(unloaded);
    userManager.events.addUserSignedOut(signedOut);
    userManager.events.addSilentRenewError(renewFailed);
    return () => {
      userManager.events.removeUserLoaded(loaded);
      userManager.events.removeUserUnloaded(unloaded);
      userManager.events.removeUserSignedOut(signedOut);
      userManager.events.removeSilentRenewError(renewFailed);
    };
  }, [userManager]);

  const removeUser = useCallback(async () => {
    await userManager.removeUser();
    if (onRemoveUser) await onRemoveUser();
  }, [userManager, onRemoveUser]);
  const reportSigninSilentError = useCallback((error: unknown) => {
    dispatch({
      type: "REPORT_ERROR",
      error: {
        ...normalizeError(error, "Unknown error while executing signinSilent(...)."),
        source: "signinSilent",
        args: undefined,
      },
    });
  }, []);
  const auth = useMemo(() => ({ ...state, ...methods, removeUser }), [state, methods, removeUser]);
  return { auth, reportSigninSilentError };
}
