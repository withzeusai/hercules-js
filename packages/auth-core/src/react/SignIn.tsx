import { type FormEvent, useEffect, useState } from "react";
import type { AuthResult, EmbeddedAuthClient, SignInConfig, SocialProvider } from "../client";
import type { AuthError } from "../errors";
import { slot, useWidgetClient, type WidgetClassNames } from "./context";
import { Button, Field, fieldError, FormError, formLevel, Notice } from "./parts";

const SOCIAL_LABELS: Record<SocialProvider, string> = {
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

type View =
  | "email-code"
  | "email-code-verify"
  | "password"
  | "sign-up"
  | "username"
  | "username-sign-up"
  | "username-created"
  | "phone"
  | "phone-verify"
  | "verify-email"
  | "forgot-password"
  | "reset-sent"
  | "access-requested";

export interface SignInProps {
  client?: EmbeddedAuthClient;
  /** Open on sign-up instead of sign-in. Defaults to what the sign-in link asked for. */
  initialView?: "sign-in" | "sign-up";
  /** App path to land on once signed in, when this page started the sign-in. */
  returnTo?: string;
  /** The app's reset page, which renders `<ResetPassword />`. Defaults to `/reset-password`. */
  passwordResetPath?: string;
  /** Replaces the heading ("Sign in to {appName}"). */
  title?: string;
  classNames?: WidgetClassNames;
}

/**
 * A complete sign-in and sign-up form: every method the app owner enabled
 * (social, email code, email and password, username, phone, passkeys),
 * verification codes, forgot password, and request access. Built on the
 * embedded sign-in client; render it on the app's sign-in page.
 */
export function SignIn(props: SignInProps) {
  const auth = useWidgetClient(props.client);
  const cn = props.classNames;
  const [config, setConfig] = useState<SignInConfig | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<AuthError | null>(() => auth.pageError());
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [assigned, setAssigned] = useState<Extract<AuthResult, { ok: true }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void auth.getConfig().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfig(result.data);
      const methods = result.data.enabledProviders;
      const wantsSignUp =
        props.initialView === "sign-up" || (!props.initialView && auth.isSignUpRequest());
      setView(
        wantsSignUp && methods.email_password
          ? "sign-up"
          : methods.email_otp
            ? "email-code"
            : methods.email_password
              ? "password"
              : methods.username_password
                ? "username"
                : methods.phone_otp
                  ? "phone"
                  : null,
      );
      if (
        methods.email_otp ||
        methods.email_password ||
        methods.username_password ||
        methods.phone_otp
      ) {
        void auth.prepareCaptcha();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [auth, props.initialView]);

  // Offer saved passkeys in the email field.
  useEffect(() => {
    if (!config || !auth.isPasskeyAvailable()) return;
    const abort = new AbortController();
    void auth
      .authenticateWithPasskey({ autofill: true, signal: abort.signal, ...start() })
      .then((result) => {
        // Autofill is opportunistic: only a chosen passkey changes the page.
        if (result.ok) finish(result);
      });
    return () => abort.abort();
  }, [config]);

  function start() {
    return props.returnTo ? { returnTo: props.returnTo } : {};
  }

  function go(next: View) {
    setError(null);
    setCode("");
    setView(next);
  }

  function finish(result: AuthResult) {
    setBusy(false);
    if (result.ok) {
      if (result.username) {
        setAssigned(result);
        setView("username-created");
      } else {
        auth.navigate(result);
      }
      return;
    }
    if (
      result.error.code === "email_verification_required" &&
      result.error.pendingAuthenticationToken
    ) {
      setPending(result.error.pendingAuthenticationToken);
      go("verify-email");
      return;
    }
    setError(result.error);
  }

  async function run(action: () => Promise<AuthResult>) {
    setBusy(true);
    setError(null);
    finish(await action());
  }

  async function runStep(
    action: () => Promise<{ ok: true } | { ok: false; error: AuthError }>,
    next: View,
  ) {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) go(next);
    else setError(result.error);
  }

  function onSubmit(handler: () => void) {
    return (event: FormEvent) => {
      event.preventDefault();
      if (!busy) handler();
    };
  }

  if (!config) {
    return (
      <div {...slot(cn, "root")} aria-busy={error ? undefined : true}>
        <FormError classNames={cn} error={error} />
      </div>
    );
  }

  const methods = config.enabledProviders;
  const socials = (Object.keys(SOCIAL_LABELS) as SocialProvider[]).filter((p) => methods[p]);
  const isSignUp = view === "sign-up" || view === "username-sign-up";
  const heading =
    props.title ??
    (isSignUp ? `Create your ${config.appName} account` : `Sign in to ${config.appName}`);
  const alternates: { view: View; label: string }[] = [
    ...(methods.email_otp && view !== "email-code"
      ? [{ view: "email-code" as View, label: "Email me a code" }]
      : []),
    ...(methods.email_password && view !== "password" && view !== "sign-up"
      ? [{ view: "password" as View, label: "Use email and password" }]
      : []),
    ...(methods.username_password && view !== "username" && view !== "username-sign-up"
      ? [{ view: "username" as View, label: "Use a username" }]
      : []),
    ...(methods.phone_otp && view !== "phone"
      ? [{ view: "phone" as View, label: "Use a phone number" }]
      : []),
  ];
  const showsEntry =
    view === null || ["email-code", "password", "sign-up", "username", "phone"].includes(view);
  const notAllowed = error?.code === "sign_in_not_allowed" && config.accessRequestsEnabled;

  return (
    <div {...slot(cn, "root")}>
      <div {...slot(cn, "header")}>
        {config.logoUrl ? (
          <img {...slot(cn, "logo")} src={config.logoUrl} alt={config.appName} />
        ) : null}
        <h1 {...slot(cn, "title")}>{heading}</h1>
      </div>
      {config.callout && showsEntry ? <p {...slot(cn, "callout")}>{config.callout.text}</p> : null}

      {showsEntry && socials.length > 0 ? (
        <div {...slot(cn, "form")}>
          {socials.map((provider) => (
            <Button
              key={provider}
              classNames={cn}
              variant="social"
              disabled={busy}
              onClick={() => run(() => auth.getAuthorizationUrl({ provider, ...start() }))}
            >
              Continue with {SOCIAL_LABELS[provider]}
            </Button>
          ))}
        </div>
      ) : null}
      {showsEntry && socials.length > 0 && view ? (
        <div {...slot(cn, "divider")} role="separator">
          or
        </div>
      ) : null}

      {view === "email-code" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () => void runStep(() => auth.sendMagicAuthCode({ email }), "email-code-verify"),
          )}
        >
          <Field
            classNames={cn}
            label="Email"
            type="email"
            name="email"
            autoComplete="username webauthn"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError(error, "email")}
          />
          <FormError classNames={cn} error={formLevel(error, ["email"])} />
          <Button classNames={cn} type="submit" disabled={busy}>
            Email me a code
          </Button>
        </form>
      ) : null}

      {view === "email-code-verify" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () => void run(() => auth.authenticateWithMagicAuth({ email, code, ...start() })),
          )}
        >
          <Notice classNames={cn}>We sent a code to {email}.</Notice>
          <Field
            classNames={cn}
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={fieldError(error, "code")}
          />
          <FormError classNames={cn} error={formLevel(error, ["code"])} />
          <Button classNames={cn} type="submit" disabled={busy}>
            Continue
          </Button>
          <Button classNames={cn} variant="link" onClick={() => go("email-code")}>
            Use a different email
          </Button>
        </form>
      ) : null}

      {view === "password" || view === "sign-up" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () =>
              void run(() =>
                view === "sign-up"
                  ? auth.createUser({ email, password, name, ...start() })
                  : auth.authenticateWithPassword({ email, password, ...start() }),
              ),
          )}
        >
          {view === "sign-up" ? (
            <Field
              classNames={cn}
              label="Name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : null}
          <Field
            classNames={cn}
            label="Email"
            type="email"
            autoComplete="username webauthn"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError(error, "email")}
          />
          <Field
            classNames={cn}
            label="Password"
            type="password"
            autoComplete={view === "sign-up" ? "new-password" : "current-password"}
            minLength={view === "sign-up" ? 8 : undefined}
            maxLength={128}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldError(error, "password") ?? fieldError(error, "newPassword")}
          />
          <FormError
            classNames={cn}
            error={formLevel(error, ["email", "password", "newPassword"])}
          />
          <Button classNames={cn} type="submit" disabled={busy}>
            {view === "sign-up" ? "Create account" : "Sign in"}
          </Button>
          {view === "password" ? (
            <>
              <Button classNames={cn} variant="link" onClick={() => go("forgot-password")}>
                Forgot password?
              </Button>
              <Button classNames={cn} variant="link" onClick={() => go("sign-up")}>
                Create an account
              </Button>
            </>
          ) : (
            <Button classNames={cn} variant="link" onClick={() => go("password")}>
              I already have an account
            </Button>
          )}
        </form>
      ) : null}

      {view === "username" || view === "username-sign-up" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () =>
              void run(() =>
                view === "username-sign-up"
                  ? auth.createUser({
                      password,
                      ...(config.usernameSignUp?.mode === "user_chosen" ? { username } : {}),
                      ...start(),
                    })
                  : auth.authenticateWithPassword({ username, password, ...start() }),
              ),
          )}
        >
          {view === "username" || config.usernameSignUp?.mode === "user_chosen" ? (
            <Field
              classNames={cn}
              label="Username"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              error={fieldError(error, "username")}
            />
          ) : null}
          <Field
            classNames={cn}
            label="Password"
            type="password"
            autoComplete={view === "username" ? "current-password" : "new-password"}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldError(error, "password") ?? fieldError(error, "newPassword")}
          />
          <FormError
            classNames={cn}
            error={formLevel(error, ["username", "password", "newPassword"])}
          />
          <Button classNames={cn} type="submit" disabled={busy}>
            {view === "username-sign-up" ? "Create account" : "Sign in"}
          </Button>
          {config.usernameSignUp ? (
            <Button
              classNames={cn}
              variant="link"
              onClick={() => go(view === "username" ? "username-sign-up" : "username")}
            >
              {view === "username" ? "Create an account" : "I already have an account"}
            </Button>
          ) : null}
        </form>
      ) : null}

      {view === "username-created" && assigned ? (
        <div {...slot(cn, "form")}>
          <Notice classNames={cn}>
            Your username is <strong>{assigned.username}</strong>. Save it: you will need it to sign
            in.
          </Notice>
          <Button classNames={cn} onClick={() => auth.navigate(assigned)}>
            Continue
          </Button>
        </div>
      ) : null}

      {view === "phone" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () => void runStep(() => auth.sendSmsCode({ phoneNumber }), "phone-verify"),
          )}
        >
          <Field
            classNames={cn}
            label="Phone number"
            type="tel"
            autoComplete="tel"
            placeholder="+14155550123"
            required
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            error={fieldError(error, "phoneNumber")}
          />
          <FormError classNames={cn} error={formLevel(error, ["phoneNumber"])} />
          <Button classNames={cn} type="submit" disabled={busy}>
            Text me a code
          </Button>
        </form>
      ) : null}

      {view === "phone-verify" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () => void run(() => auth.authenticateWithSmsCode({ phoneNumber, code, ...start() })),
          )}
        >
          <Notice classNames={cn}>We texted a code to {phoneNumber}.</Notice>
          <Field
            classNames={cn}
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={fieldError(error, "code")}
          />
          <FormError classNames={cn} error={formLevel(error, ["code"])} />
          <Button classNames={cn} type="submit" disabled={busy}>
            Continue
          </Button>
        </form>
      ) : null}

      {view === "verify-email" && pending ? (
        config.emailVerificationMethod === "code" ? (
          <form
            {...slot(cn, "form")}
            onSubmit={onSubmit(
              () =>
                void run(() =>
                  auth.authenticateWithEmailVerification({
                    code,
                    pendingAuthenticationToken: pending,
                    ...start(),
                  }),
                ),
            )}
          >
            <Notice classNames={cn}>Enter the code we sent to verify your email.</Notice>
            <Field
              classNames={cn}
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={fieldError(error, "code")}
            />
            <FormError classNames={cn} error={formLevel(error, ["code"])} />
            <Button classNames={cn} type="submit" disabled={busy}>
              Verify
            </Button>
            <Button
              classNames={cn}
              variant="link"
              disabled={busy}
              onClick={() =>
                void runStep(
                  () => auth.sendVerificationCode({ pendingAuthenticationToken: pending }),
                  "verify-email",
                )
              }
            >
              Send a new code
            </Button>
          </form>
        ) : (
          <Notice classNames={cn}>
            Check your email for a link to verify your address, then sign in.
          </Notice>
        )
      ) : null}

      {view === "forgot-password" ? (
        <form
          {...slot(cn, "form")}
          onSubmit={onSubmit(
            () =>
              void runStep(
                () =>
                  auth.sendPasswordResetEmail({
                    email,
                    passwordResetUrl: props.passwordResetPath ?? "/reset-password",
                  }),
                "reset-sent",
              ),
          )}
        >
          <Field
            classNames={cn}
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldError(error, "email")}
          />
          <FormError classNames={cn} error={formLevel(error, ["email"])} />
          <Button classNames={cn} type="submit" disabled={busy}>
            Send reset link
          </Button>
          <Button classNames={cn} variant="link" onClick={() => go("password")}>
            Back to sign in
          </Button>
        </form>
      ) : null}

      {view === "reset-sent" ? (
        <Notice classNames={cn}>If an account uses {email}, a reset link is on its way.</Notice>
      ) : null}

      {view === "access-requested" ? (
        <Notice classNames={cn}>Thanks. The app owner will review your request.</Notice>
      ) : null}

      {notAllowed ? (
        <Button
          classNames={cn}
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void runStep(
              () => auth.requestAccess({ email: error?.rejectedEmail ?? error?.email ?? email }),
              "access-requested",
            )
          }
        >
          Request access
        </Button>
      ) : null}

      {view === null ? <FormError classNames={cn} error={error} /> : null}

      {showsEntry && alternates.length > 0 ? (
        <div {...slot(cn, "footer")}>
          {alternates.map((alternate) => (
            <Button
              key={alternate.view}
              classNames={cn}
              variant="link"
              onClick={() => go(alternate.view)}
            >
              {alternate.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div id="hercules-captcha" data-hercules-auth="captcha" />

      {config.terms && showsEntry ? (
        <p {...slot(cn, "footer")}>
          By continuing you agree to the{" "}
          {config.terms.tosUrl ? (
            <a {...slot(cn, "link")} href={config.terms.tosUrl}>
              Terms of Service
            </a>
          ) : null}
          {config.terms.tosUrl && config.terms.privacyUrl ? " and " : null}
          {config.terms.privacyUrl ? (
            <a {...slot(cn, "link")} href={config.terms.privacyUrl}>
              Privacy Policy
            </a>
          ) : null}
          .
        </p>
      ) : null}
    </div>
  );
}
