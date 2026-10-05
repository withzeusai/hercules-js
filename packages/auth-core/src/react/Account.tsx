import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  EmbeddedAuthClient,
  Identity,
  Passkey,
  Session,
  SignInConfig,
  SocialProvider,
  StepResult,
  User,
} from "../client";
import type { AuthError } from "../errors";
import { slot, useWidgetClient, type WidgetClassNames } from "./context";
import { Button, Field, fieldError, FormError, formLevel, Notice } from "./parts";

export interface WidgetProps {
  client?: EmbeddedAuthClient;
  classNames?: WidgetClassNames;
}

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  password: "Password",
};

/** Run a step with busy and error state. */
function useStep() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);
  const run = useCallback(async (action: () => Promise<StepResult>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.error);
    return result.ok;
  }, []);
  return { busy, error, setError, run };
}

/** Set a new password from a reset link (`?token=`). Render on the reset path. */
export function ResetPassword({
  client,
  classNames: cn,
  signInPath = "/sign-in",
}: WidgetProps & { signInPath?: string }) {
  const auth = useWidgetClient(client);
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useStep();

  if (!token || params.get("error")) {
    return (
      <div {...slot(cn, "root")}>
        <FormError
          classNames={cn}
          error={{
            code: "invalid_token",
            message: "This reset link is invalid or has expired.",
            status: 0,
          }}
        />
        <a {...slot(cn, "link")} href={signInPath}>
          Back to sign in
        </a>
      </div>
    );
  }
  if (done) {
    return (
      <div {...slot(cn, "root")}>
        <Notice classNames={cn}>Your password was changed.</Notice>
        <a {...slot(cn, "link")} href={signInPath}>
          Sign in
        </a>
      </div>
    );
  }
  return (
    <form
      {...slot(cn, "root")}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void run(() => auth.resetPassword({ token, newPassword: password })).then((ok) =>
          setDone(ok),
        );
      }}
    >
      <h1 {...slot(cn, "title")}>Choose a new password</h1>
      <Field
        classNames={cn}
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fieldError(error, "newPassword")}
      />
      <FormError classNames={cn} error={formLevel(error, ["newPassword"])} />
      <Button classNames={cn} type="submit" disabled={busy}>
        Change password
      </Button>
    </form>
  );
}

/** The signed-in user's name. */
export function UserProfile({ client, classNames: cn }: WidgetProps) {
  const auth = useWidgetClient(client);
  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useStep();

  useEffect(() => {
    void auth.getUser().then((result) => {
      if (!result.ok) setError(result.error);
      else if (result.data) {
        setUser(result.data);
        setName(result.data.name);
      }
    });
  }, [auth, setError]);

  if (!user)
    return (
      <div {...slot(cn, "root")} aria-busy>
        <FormError classNames={cn} error={error} />
      </div>
    );
  return (
    <form
      {...slot(cn, "root")}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setSaved(false);
        void run(() => auth.updateUser({ name })).then((ok) => setSaved(ok));
      }}
    >
      <Field
        classNames={cn}
        label="Name"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Field
        classNames={cn}
        label={user.username ? "Username" : "Email"}
        value={user.username ?? user.email}
        readOnly
        disabled
      />
      <FormError classNames={cn} error={error} />
      {saved ? <Notice classNames={cn}>Saved.</Notice> : null}
      <Button classNames={cn} type="submit" disabled={busy || name === user.name}>
        Save
      </Button>
    </form>
  );
}

/** Password, passkeys, and linked sign-in methods. */
export function UserSecurity({ client, classNames: cn }: WidgetProps) {
  const auth = useWidgetClient(client);
  const [config, setConfig] = useState<SignInConfig | null>(null);
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run } = useStep();

  const reload = useCallback(async () => {
    const [configResult, identityResult, passkeyResult] = await Promise.all([
      auth.getConfig(),
      auth.listIdentities(),
      auth.listPasskeys(),
    ]);
    if (configResult.ok) setConfig(configResult.data);
    if (identityResult.ok) setIdentities(identityResult.data);
    else setError(identityResult.error);
    if (passkeyResult.ok) setPasskeys(passkeyResult.data);
  }, [auth, setError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!config || !identities)
    return (
      <div {...slot(cn, "root")} aria-busy>
        <FormError classNames={cn} error={error} />
      </div>
    );

  const hasPassword = identities.some((identity) => identity.provider === "password");
  const linkable = (
    ["google", "apple", "microsoft", "facebook", "linkedin"] as SocialProvider[]
  ).filter(
    (provider) =>
      config.enabledProviders[provider] && !identities.some((i) => i.provider === provider),
  );
  // Keep at least one way back in: the last method stays unless email codes work.
  const canUnlink = identities.length > 1 || config.enabledProviders.email_otp;

  return (
    <div {...slot(cn, "root")}>
      <FormError classNames={cn} error={formLevel(error, ["password", "newPassword"])} />
      {notice ? <Notice classNames={cn}>{notice}</Notice> : null}

      {hasPassword ? (
        <form
          {...slot(cn, "form")}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run(() => auth.updateUser({ password: newPassword, currentPassword })).then(
              (ok) => {
                if (!ok) return;
                setCurrentPassword("");
                setNewPassword("");
                setNotice("Password changed. Other devices were signed out.");
              },
            );
          }}
        >
          <h2 {...slot(cn, "title")}>Password</h2>
          <Field
            classNames={cn}
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            error={fieldError(error, "password")}
          />
          <Field
            classNames={cn}
            label="New password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={fieldError(error, "newPassword")}
          />
          <Button classNames={cn} type="submit" disabled={busy}>
            Change password
          </Button>
        </form>
      ) : null}

      {passkeys && auth.isPasskeyAvailable() ? (
        <div {...slot(cn, "form")}>
          <h2 {...slot(cn, "title")}>Passkeys</h2>
          <ul {...slot(cn, "list")}>
            {passkeys.map((passkey) => (
              <li key={passkey.id} {...slot(cn, "listItem")}>
                <span>{passkey.name ?? "Passkey"}</span>
                <Button
                  classNames={cn}
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => auth.deletePasskey({ passkeyId: passkey.id })).then(reload)
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <Button
            classNames={cn}
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => auth.createPasskey()).then(reload)}
          >
            Add a passkey
          </Button>
        </div>
      ) : null}

      <div {...slot(cn, "form")}>
        <h2 {...slot(cn, "title")}>Sign-in methods</h2>
        <ul {...slot(cn, "list")}>
          {identities.map((identity) => (
            <li key={identity.id} {...slot(cn, "listItem")}>
              <span>{PROVIDER_LABELS[identity.provider] ?? identity.provider}</span>
              {identity.provider !== "password" ? (
                <Button
                  classNames={cn}
                  variant="secondary"
                  disabled={busy || !canUnlink}
                  onClick={() =>
                    void run(() => auth.unlinkIdentity({ identityId: identity.id })).then(reload)
                  }
                >
                  Unlink
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {linkable.map((provider) => (
          <Button
            key={provider}
            classNames={cn}
            variant="social"
            disabled={busy}
            onClick={() =>
              void auth.linkIdentity({ provider }).then((result) => {
                if (result.ok) auth.navigate(result);
                else setError(result.error);
              })
            }
          >
            Link {PROVIDER_LABELS[provider]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function describeDevice(session: Session): string {
  const agent = session.userAgent ?? "";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Chrome\//.test(agent)
      ? "Chrome"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Mac OS X/.test(agent)
        ? "macOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

/** The user's signed-in devices, with sign-out per device and for all others. */
export function UserSessions({ client, classNames: cn }: WidgetProps) {
  const auth = useWidgetClient(client);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const { busy, error, setError, run } = useStep();

  const reload = useCallback(async () => {
    const result = await auth.listSessions();
    if (result.ok) setSessions(result.data);
    else setError(result.error);
  }, [auth, setError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!sessions)
    return (
      <div {...slot(cn, "root")} aria-busy>
        <FormError classNames={cn} error={error} />
      </div>
    );
  return (
    <div {...slot(cn, "root")}>
      <FormError classNames={cn} error={error} />
      <ul {...slot(cn, "list")}>
        {sessions.map((session) => (
          <li key={session.id} {...slot(cn, "listItem")}>
            <span>
              {describeDevice(session)} · {new Date(session.createdAt).toLocaleDateString()}
            </span>
            <Button
              classNames={cn}
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => auth.revokeSession({ sessionId: session.id })).then(reload)
              }
            >
              Sign out
            </Button>
          </li>
        ))}
      </ul>
      {sessions.length > 1 ? (
        <Button
          classNames={cn}
          variant="secondary"
          disabled={busy}
          onClick={() => void run(() => auth.revokeOtherSessions()).then(reload)}
        >
          Sign out of all other devices
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Delete the account after confirmation. `onDeleted` runs after Hercules Auth
 * deletes it: delete the app's own data about the user there, then sign out
 * with the app SDK.
 */
export function DeleteAccount({
  client,
  classNames: cn,
  onDeleted,
}: WidgetProps & { onDeleted: () => void | Promise<void> }) {
  const auth = useWidgetClient(client);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useStep();
  const needsPassword = error?.code === "reauthentication_required";

  if (!confirming) {
    return (
      <div {...slot(cn, "root")}>
        <Button classNames={cn} variant="secondary" onClick={() => setConfirming(true)}>
          Delete account
        </Button>
      </div>
    );
  }
  return (
    <form
      {...slot(cn, "root")}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void run(() => auth.deleteUser(password ? { password } : {})).then(async (ok) => {
          if (ok) await onDeleted();
        });
      }}
    >
      <Notice classNames={cn}>This permanently deletes your account. It cannot be undone.</Notice>
      {needsPassword ? (
        <Field
          classNames={cn}
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      ) : null}
      <FormError classNames={cn} error={error} />
      <Button classNames={cn} type="submit" disabled={busy}>
        Delete my account
      </Button>
      <Button classNames={cn} variant="link" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </form>
  );
}
