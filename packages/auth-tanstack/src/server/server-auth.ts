import { createServerFn } from "@tanstack/react-start";

import type { ServerAuthResult, ServerStepResult } from "./server-api-bodies";

// Server-side authentication, named after WorkOS's Authentication API. Each is
// a TanStack Start server function: call it from a form handler or another
// server function. The credentials go from the app's server to Hercules with
// the app's API key (no captcha, no redirect), and a successful sign-in sets
// the app's session cookie directly; follow it with `router.invalidate()` or a
// navigation so `useAuth()` picks the user up.
//
// Bodies load lazily so nothing server-only reaches the client bundle.

export type { ServerAuthResult, ServerAuthUser, ServerStepResult } from "./server-api-bodies";

/** Sign in with an email address or username, and a password. */
export const authenticateWithPassword = createServerFn({ method: "POST" })
  .validator(
    (data: { email: string; password: string } | { username: string; password: string }) => data,
  )
  .handler(async ({ data }): Promise<ServerAuthResult> => {
    const { authenticateWithPasswordBody } = await import("./server-api-bodies");
    return authenticateWithPasswordBody(data);
  });

/**
 * Create an account and sign in: a password account with `email`, or a
 * username account. Fails with `email_verification_required` (carrying a
 * `pendingAuthenticationToken`) when the app requires verification.
 */
export const createUser = createServerFn({ method: "POST" })
  .validator((data: { email?: string; username?: string; password: string; name?: string }) => data)
  .handler(async ({ data }): Promise<ServerAuthResult> => {
    const { createUserBody } = await import("./server-api-bodies");
    return createUserBody(data);
  });

/** Email a one-time sign-in code. */
export const sendMagicAuthCode = createServerFn({ method: "POST" })
  .validator((data: { email: string }) => data)
  .handler(async ({ data }): Promise<ServerStepResult> => {
    const { sendMagicAuthCodeBody } = await import("./server-api-bodies");
    return sendMagicAuthCodeBody(data);
  });

/** Sign in (or sign up) with the emailed code. */
export const authenticateWithMagicAuth = createServerFn({ method: "POST" })
  .validator((data: { email: string; code: string }) => data)
  .handler(async ({ data }): Promise<ServerAuthResult> => {
    const { authenticateWithMagicAuthBody } = await import("./server-api-bodies");
    return authenticateWithMagicAuthBody(data);
  });

/** Finish an `email_verification_required` sign-in with the emailed code. */
export const authenticateWithEmailVerification = createServerFn({ method: "POST" })
  .validator((data: { code: string; pendingAuthenticationToken: string }) => data)
  .handler(async ({ data }): Promise<ServerAuthResult> => {
    const { authenticateWithEmailVerificationBody } = await import("./server-api-bodies");
    return authenticateWithEmailVerificationBody(data);
  });

/** Send a new verification code for an `email_verification_required` error. */
export const sendVerificationCode = createServerFn({ method: "POST" })
  .validator((data: { pendingAuthenticationToken: string }) => data)
  .handler(async ({ data }): Promise<ServerStepResult> => {
    const { sendVerificationCodeBody } = await import("./server-api-bodies");
    return sendVerificationCodeBody(data);
  });

/** Text a one-time code to a phone number (E.164). */
export const sendSmsCode = createServerFn({ method: "POST" })
  .validator((data: { phoneNumber: string }) => data)
  .handler(async ({ data }): Promise<ServerStepResult> => {
    const { sendSmsCodeBody } = await import("./server-api-bodies");
    return sendSmsCodeBody(data);
  });

/** Sign in (or sign up) with the texted code. */
export const authenticateWithSmsCode = createServerFn({ method: "POST" })
  .validator((data: { phoneNumber: string; code: string }) => data)
  .handler(async ({ data }): Promise<ServerAuthResult> => {
    const { authenticateWithSmsCodeBody } = await import("./server-api-bodies");
    return authenticateWithSmsCodeBody(data);
  });

/** Email a password reset link to `passwordResetUrl?token=...` on this app. */
export const sendPasswordResetEmail = createServerFn({ method: "POST" })
  .validator((data: { email: string; passwordResetUrl: string }) => data)
  .handler(async ({ data }): Promise<ServerStepResult> => {
    const { sendPasswordResetEmailBody } = await import("./server-api-bodies");
    return sendPasswordResetEmailBody(data);
  });

/** Set a new password with the reset link's token. */
export const resetPassword = createServerFn({ method: "POST" })
  .validator((data: { token: string; newPassword: string }) => data)
  .handler(async ({ data }): Promise<ServerStepResult> => {
    const { resetPasswordBody } = await import("./server-api-bodies");
    return resetPasswordBody(data);
  });
