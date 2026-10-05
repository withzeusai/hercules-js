// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAuthClient, SignInConfig } from "../client";
import { authError } from "../errors";
import { UserSecurity } from "./Account";
import { SignIn } from "./SignIn";

const CONFIG: SignInConfig = {
  issuer: "https://tenant.hercules-auth.com",
  appName: "Recipe Pro",
  logoUrl: null,
  language: "en",
  theme: "light",
  terms: { tosUrl: "https://recipepro.com/terms", privacyUrl: null },
  callout: null,
  enabledProviders: {
    google: true,
    apple: false,
    microsoft: false,
    facebook: false,
    linkedin: false,
    email_otp: true,
    email_password: true,
    phone_otp: false,
    username_password: false,
  },
  usernameSignUp: null,
  requireEmailVerification: true,
  emailVerificationMethod: "code",
  accessRequestsEnabled: true,
  embedded: { signInPath: "/sign-in", signUpPath: "/sign-in" },
};

function fakeClient(overrides: Partial<EmbeddedAuthClient> = {}): EmbeddedAuthClient {
  return {
    getConfig: vi.fn(async () => ({ ok: true as const, data: CONFIG })),
    prepareCaptcha: vi.fn(async () => ({ ok: true as const })),
    pageError: vi.fn(() => null),
    isSignUpRequest: vi.fn(() => false),
    isPasskeyAvailable: vi.fn(() => false),
    navigate: vi.fn(),
    ...overrides,
  } as unknown as EmbeddedAuthClient;
}

afterEach(() => {
  cleanup();
});

describe("<SignIn />", () => {
  it("renders the enabled methods and legal links", async () => {
    render(<SignIn client={fakeClient()} />);

    expect(await screen.findByText("Sign in to Recipe Pro")).toBeTruthy();
    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.queryByText("Continue with Apple")).toBeNull();
    expect(screen.getByText("Email me a code")).toBeTruthy();
    expect(screen.getByText("Use email and password")).toBeTruthy();
    expect(screen.getByText("Terms of Service")).toBeTruthy();
    expect(document.getElementById("hercules-captcha")).not.toBeNull();
  });

  it("signs in with an emailed code", async () => {
    const client = fakeClient({
      sendMagicAuthCode: vi.fn(async () => ({ ok: true as const })),
      authenticateWithMagicAuth: vi.fn(async () => ({ ok: true as const, redirectTo: "/cb" })),
    });
    render(<SignIn client={client} />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(client.navigate).toHaveBeenCalledWith({ ok: true, redirectTo: "/cb" }),
    );
    expect(client.authenticateWithMagicAuth).toHaveBeenCalledWith({
      email: "a@example.com",
      code: "123456",
    });
  });

  it("continues an unverified password sign-up with the emailed code", async () => {
    const client = fakeClient({
      createUser: vi.fn(async () => ({
        ok: false as const,
        error: authError("email_verification_required", "Verify your email", 200, {
          email: "a@example.com",
          pendingAuthenticationToken: "pending",
        }),
      })),
      authenticateWithEmailVerification: vi.fn(async () => ({
        ok: true as const,
        redirectTo: "/cb",
      })),
    });
    render(<SignIn client={client} initialView="sign-up" />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(client.authenticateWithEmailVerification).toHaveBeenCalledWith({
        code: "654321",
        pendingAuthenticationToken: "pending",
      }),
    );
    expect(client.navigate).toHaveBeenCalled();
  });

  it("offers to request access when the allowlist turns the user away", async () => {
    const client = fakeClient({
      sendMagicAuthCode: vi.fn(async () => ({
        ok: false as const,
        error: authError("SIGN_IN_NOT_ALLOWLISTED", "Not on the list", 403),
      })),
      requestAccess: vi.fn(async () => ({ ok: true as const })),
    });
    render(<SignIn client={client} />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Request access" }));

    await waitFor(() =>
      expect(client.requestAccess).toHaveBeenCalledWith({ email: "a@example.com" }),
    );
    expect(await screen.findByText("Thanks. The app owner will review your request.")).toBeTruthy();
  });
});

describe("<UserSecurity />", () => {
  it("keeps the last sign-in method linked when email codes are off", async () => {
    const client = fakeClient({
      getConfig: vi.fn(async () => ({
        ok: true as const,
        data: { ...CONFIG, enabledProviders: { ...CONFIG.enabledProviders, email_otp: false } },
      })),
      listIdentities: vi.fn(async () => ({
        ok: true as const,
        data: [{ id: "i1", provider: "google", providerUserId: "g1", createdAt: "" }],
      })),
      listPasskeys: vi.fn(async () => ({ ok: true as const, data: [] })),
    });
    render(<UserSecurity client={client} />);

    const unlink = await screen.findByRole("button", { name: "Unlink" });
    expect((unlink as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Password")).toBeNull();
  });
});
