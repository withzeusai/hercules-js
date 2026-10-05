import { createContext, type ReactNode, useContext } from "react";
import type { EmbeddedAuthClient } from "../client";

/**
 * Class name slots every widget accepts through `classNames`. Each element
 * also carries `data-hercules-auth="<slot>"`, which the optional stylesheet
 * (`@usehercules/auth-core/styles.css`) and app CSS can target.
 */
export type WidgetSlot =
  | "root"
  | "header"
  | "logo"
  | "title"
  | "callout"
  | "form"
  | "field"
  | "label"
  | "input"
  | "primaryButton"
  | "secondaryButton"
  | "socialButton"
  | "link"
  | "divider"
  | "error"
  | "notice"
  | "list"
  | "listItem"
  | "footer";

export type WidgetClassNames = Partial<Record<WidgetSlot, string>>;

const ClientContext = createContext<EmbeddedAuthClient | null>(null);

/** Provides the embedded sign-in client to the widgets below it. */
export function AuthWidgetsProvider({
  client,
  children,
}: {
  client: EmbeddedAuthClient;
  children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The client from the nearest `AuthWidgetsProvider`, or null. */
export function useProvidedClient(): EmbeddedAuthClient | null {
  return useContext(ClientContext);
}

/** The client a widget uses: its `client` prop, else the nearest provider. */
export function useWidgetClient(client?: EmbeddedAuthClient): EmbeddedAuthClient {
  const fromContext = useContext(ClientContext);
  const resolved = client ?? fromContext;
  if (!resolved) {
    throw new Error(
      "Hercules auth widgets need a client: pass `client` or wrap them in <AuthWidgetsProvider>.",
    );
  }
  return resolved;
}

/** Props for one slot: its class name and its data attribute. */
export function slot(classNames: WidgetClassNames | undefined, name: WidgetSlot) {
  return { className: classNames?.[name], "data-hercules-auth": name };
}
