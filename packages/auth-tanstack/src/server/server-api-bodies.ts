import { type AuthError, authError } from "@usehercules/auth-core";
import { getRequest } from "@tanstack/react-start/server";

import { ISSUER_URL_ENV_VARS, readEnv, requireEnv } from "./config";
import { writeSession } from "./session-store";

/**
 * Bodies for the server-side authentication functions in `server-auth.ts`.
 * They call the Hercules tenant auth server API with the app's API key, the
 * way WorkOS's Authentication API is called from an app server, and on success
 * seal the returned tokens into the app's session cookie, exactly as
 * `/auth/callback` does after a redirect sign-in.
 */

/** The app's server API key, provided by Hercules. */
export const API_KEY_ENV_VARS = ["HERCULES_AUTH_API_KEY", "AUTH_API_KEY"] as const;

export interface ServerAuthUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  username: string | null;
  phoneNumber: string | null;
}

/** A server-side sign-in: signed in (session cookie set), or a WorkOS-style error. */
export type ServerAuthResult =
  | { ok: true; user: ServerAuthUser; username?: string }
  | { ok: false; error: AuthError };

export type ServerStepResult = { ok: true } | { ok: false; error: AuthError };

const SERVER_API_PATH = "/api/server/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

/** The end user's IP address and user agent, for the server API's rate limits. */
function callerFields(): { ip_address?: string; user_agent?: string } {
  const request = getRequest();
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = request.headers.get("user-agent");
  return { ...(ip ? { ip_address: ip } : {}), ...(userAgent ? { user_agent: userAgent } : {}) };
}

async function callServerApi(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; error: AuthError }> {
  const apiKey = readEnv(API_KEY_ENV_VARS);
  if (!apiKey) {
    return {
      ok: false,
      error: authError(
        "invalid_request",
        "Server-side sign-in needs HERCULES_AUTH_API_KEY; republish the app to receive it.",
      ),
    };
  }
  const issuer = requireEnv(ISSUER_URL_ENV_VARS).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${issuer}${SERVER_API_PATH}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, ...callerFields() }),
    });
  } catch (error) {
    return {
      ok: false,
      error: authError("network_error", error instanceof Error ? error.message : "Network error"),
    };
  }
  const parsed: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  const record = isRecord(parsed) ? parsed : null;
  if (!response.ok) {
    const code = (record && text(record, "code")) ?? `HTTP_${response.status}`;
    const email = record ? text(record, "email") : null;
    const pending = record ? text(record, "pending_authentication_token") : null;
    return {
      ok: false,
      error: authError(
        code,
        (record && text(record, "message")) ?? response.statusText,
        response.status,
        {
          ...(email ? { email } : {}),
          ...(pending ? { pendingAuthenticationToken: pending } : {}),
        },
      ),
    };
  }
  return { ok: true, body: record };
}

/** Run a sign-in call and seal its tokens into the session cookie. */
async function signIn(path: string, body: Record<string, unknown>): Promise<ServerAuthResult> {
  const result = await callServerApi(path, body);
  if (!result.ok) return result;
  const response = result.body;
  const accessToken = response ? text(response, "access_token") : null;
  const user = response?.["user"];
  if (!response || !accessToken || !isRecord(user)) {
    return { ok: false, error: authError("unknown_error", "The sign-in returned no tokens.", 200) };
  }
  const expiresIn = typeof response["expires_in"] === "number" ? response["expires_in"] : null;
  await writeSession({
    accessToken,
    idToken: text(response, "id_token") ?? undefined,
    refreshToken: text(response, "refresh_token") ?? undefined,
    expiresAt: expiresIn == null ? undefined : Math.floor(Date.now() / 1000) + expiresIn,
  });
  const username = text(response, "username");
  return {
    ok: true,
    user: {
      id: text(user, "id") ?? "",
      email: text(user, "email"),
      emailVerified: user["email_verified"] === true,
      name: text(user, "name"),
      image: text(user, "image"),
      username: text(user, "username"),
      phoneNumber: text(user, "phone_number"),
    },
    ...(username ? { username } : {}),
  };
}

async function step(path: string, body: Record<string, unknown>): Promise<ServerStepResult> {
  const result = await callServerApi(path, body);
  return result.ok ? { ok: true } : result;
}

export function authenticateWithPasswordBody(
  data: { email: string; password: string } | { username: string; password: string },
): Promise<ServerAuthResult> {
  return signIn("/authenticate", { grant_type: "password", ...data });
}

export function createUserBody(data: {
  email?: string;
  username?: string;
  password: string;
  name?: string;
}): Promise<ServerAuthResult> {
  return signIn("/users", data);
}

export function sendMagicAuthCodeBody(data: { email: string }): Promise<ServerStepResult> {
  return step("/magic-auth/send", data);
}

export function authenticateWithMagicAuthBody(data: {
  email: string;
  code: string;
}): Promise<ServerAuthResult> {
  return signIn("/authenticate", { grant_type: "magic_auth", ...data });
}

export function authenticateWithEmailVerificationBody(data: {
  code: string;
  pendingAuthenticationToken: string;
}): Promise<ServerAuthResult> {
  return signIn("/authenticate", {
    grant_type: "email_verification",
    code: data.code,
    pending_authentication_token: data.pendingAuthenticationToken,
  });
}

export function sendVerificationCodeBody(data: {
  pendingAuthenticationToken: string;
}): Promise<ServerStepResult> {
  return step("/email-verification/send", {
    pending_authentication_token: data.pendingAuthenticationToken,
  });
}

export function sendSmsCodeBody(data: { phoneNumber: string }): Promise<ServerStepResult> {
  return step("/sms/send", { phone_number: data.phoneNumber });
}

export function authenticateWithSmsCodeBody(data: {
  phoneNumber: string;
  code: string;
}): Promise<ServerAuthResult> {
  return signIn("/authenticate", {
    grant_type: "sms_code",
    phone_number: data.phoneNumber,
    code: data.code,
  });
}

export function sendPasswordResetEmailBody(data: {
  email: string;
  passwordResetUrl: string;
}): Promise<ServerStepResult> {
  const url = new URL(data.passwordResetUrl, new URL(getRequest().url).origin).toString();
  return step("/password-reset/send", { email: data.email, password_reset_url: url });
}

export function resetPasswordBody(data: {
  token: string;
  newPassword: string;
}): Promise<ServerStepResult> {
  return step("/password-reset/confirm", { token: data.token, new_password: data.newPassword });
}
