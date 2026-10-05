/**
 * @usehercules/auth-core/react
 *
 * Drop-in widgets for embedded sign-in, in the spirit of WorkOS Widgets. They
 * are unstyled: style them with `classNames` slots, the `data-hercules-auth`
 * attributes, or the optional `@usehercules/auth-core/styles.css`.
 */
export {
  AuthWidgetsProvider,
  useProvidedClient,
  useWidgetClient,
  type WidgetClassNames,
  type WidgetSlot,
} from "./context";
export { SignIn, type SignInProps } from "./SignIn";
export {
  DeleteAccount,
  ResetPassword,
  UserProfile,
  UserSecurity,
  UserSessions,
  type WidgetProps,
} from "./Account";
