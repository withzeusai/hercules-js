import type { EmbeddedAuthClient } from "@usehercules/auth-core";
import {
  DeleteAccount as CoreDeleteAccount,
  ResetPassword as CoreResetPassword,
  SignIn as CoreSignIn,
  UserProfile as CoreUserProfile,
  UserSecurity as CoreUserSecurity,
  UserSessions as CoreUserSessions,
  useProvidedClient,
} from "@usehercules/auth-core/react";
import { type ComponentProps, type ComponentType, useMemo } from "react";

import { createEmbeddedSignInClient } from "./embedded";

/**
 * The embedded sign-in widgets, bound to this app: without a `client` prop or
 * an `AuthWidgetsProvider`, they use this app's own embedded sign-in client,
 * so `<SignIn />` drops in with no setup.
 */
function bound<P extends { client?: EmbeddedAuthClient }>(Widget: ComponentType<P>) {
  function BoundWidget(props: P) {
    const provided = useProvidedClient();
    const own = useMemo(() => createEmbeddedSignInClient(), []);
    return <Widget {...props} client={props.client ?? provided ?? own} />;
  }
  BoundWidget.displayName = `Hercules(${Widget.displayName ?? Widget.name})`;
  return BoundWidget;
}

/** Sign-in and sign-up for every enabled method. Render on the app's sign-in page. */
export const SignIn = bound(CoreSignIn);
/** Set a new password from a reset link. Render on the reset page. */
export const ResetPassword = bound(CoreResetPassword);
/** The signed-in user's name. */
export const UserProfile = bound(CoreUserProfile);
/** Password, passkeys, and linked sign-in methods. */
export const UserSecurity = bound(CoreUserSecurity);
/** Signed-in devices. */
export const UserSessions = bound(CoreUserSessions);
/** Account deletion with confirmation. */
export const DeleteAccount = bound(CoreDeleteAccount);

export type SignInProps = ComponentProps<typeof CoreSignIn>;
export {
  AuthWidgetsProvider,
  type WidgetClassNames,
  type WidgetSlot,
} from "@usehercules/auth-core/react";
