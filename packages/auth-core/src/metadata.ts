/**
 * The discovery-document field a Hercules tenant adds when its app renders its
 * own sign-in UI. The SDKs read it so the dashboard setting takes effect
 * without an app rebuild.
 */
export const EMBEDDED_SIGN_IN_METADATA = "hercules_embedded_sign_in";

export interface EmbeddedSignInMetadata {
  /** Better Auth base path on the app's own origin, e.g. `/_hercules/auth`. */
  authBasePath: string;
  /** The app page a signed-out visitor is sent to. */
  signInPath: string;
  /** The app page `prompt=create` lands on. */
  signUpPath: string;
}

function isAppPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

/** The embedded sign-in settings in a discovery document, or null when hosted. */
export function readEmbeddedSignInMetadata(
  metadata: Record<string, unknown>,
): EmbeddedSignInMetadata | null {
  const value = metadata[EMBEDDED_SIGN_IN_METADATA];
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { auth_base_path, sign_in_path, sign_up_path } = record;
  if (!isAppPath(auth_base_path) || !isAppPath(sign_in_path)) return null;
  return {
    authBasePath: auth_base_path,
    signInPath: sign_in_path,
    signUpPath: isAppPath(sign_up_path) ? sign_up_path : sign_in_path,
  };
}

/**
 * Move a browser-facing endpoint (authorize, end-session) from the tenant's
 * auth host to the app's own origin, keeping its query. The issuer, token, and
 * JWKS endpoints stay where discovery put them.
 */
export function toEmbeddedEndpoint(
  endpoint: URL,
  appOrigin: string,
  metadata: Pick<EmbeddedSignInMetadata, "authBasePath">,
): URL {
  // Endpoints live under Better Auth's base path (`/api/auth/oauth2/...`);
  // keep the part after it.
  const marker = endpoint.pathname.indexOf("/oauth2/");
  const suffix = marker === -1 ? endpoint.pathname : endpoint.pathname.slice(marker);
  const moved = new URL(`${metadata.authBasePath}${suffix}`, appOrigin);
  moved.search = endpoint.search;
  return moved;
}
