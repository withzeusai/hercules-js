import type { ReactNode } from "react";
import type { AuthError } from "../errors";
import { slot, type WidgetClassNames } from "./context";

export function Field({
  classNames,
  label,
  error,
  ...input
}: {
  classNames: WidgetClassNames | undefined;
  label: string;
  error?: string | undefined;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label {...slot(classNames, "field")}>
      <span {...slot(classNames, "label")}>{label}</span>
      <input {...slot(classNames, "input")} aria-invalid={error ? true : undefined} {...input} />
      {error ? (
        <span {...slot(classNames, "error")} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Button({
  classNames,
  variant = "primary",
  children,
  ...button
}: {
  classNames: WidgetClassNames | undefined;
  variant?: "primary" | "secondary" | "social" | "link";
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const name =
    variant === "primary"
      ? "primaryButton"
      : variant === "secondary"
        ? "secondaryButton"
        : variant === "social"
          ? "socialButton"
          : "link";
  return (
    <button type="button" {...slot(classNames, name)} {...button}>
      {children}
    </button>
  );
}

/** The form-level error: shown here unless a field shows it. */
export function FormError({
  classNames,
  error,
}: {
  classNames: WidgetClassNames | undefined;
  error: AuthError | null;
}) {
  if (!error) return null;
  return (
    <p {...slot(classNames, "error")} role="alert">
      {error.message}
    </p>
  );
}

export function Notice({
  classNames,
  children,
}: {
  classNames: WidgetClassNames | undefined;
  children: ReactNode;
}) {
  return (
    <p {...slot(classNames, "notice")} role="status">
      {children}
    </p>
  );
}

/** The field an error belongs to, or undefined when it belongs to the form. */
export function fieldError(error: AuthError | null, field: AuthError["field"]): string | undefined {
  return error && error.field === field ? error.message : undefined;
}

/** The error to show at the form level: any error no visible field shows. */
export function formLevel(
  error: AuthError | null,
  visibleFields: AuthError["field"][],
): AuthError | null {
  return error && (!error.field || !visibleFields.includes(error.field)) ? error : null;
}
