export * from "./auth-callback-hook";
export * from "./HerculesAuthProvider";
export * from "./use-user";
export * from "./use-auth";
export {
  classifyAuthError,
  getOrCreateAuthAttemptId,
  reportAuthDiagnostic,
  startAuthAttempt,
  type AuthDiagnosticEvent,
  type AuthDiagnosticErrorClass,
  type AuthDiagnosticPhase,
  type DiagnosticsConfig,
} from "./diagnostics";

// rexports of react-oidc-context
export { hasAuthParams } from "react-oidc-context";
