import { createContext } from "react";
import type { UserManager } from "oidc-client-ts";

export interface HerculesAuthProviderContext {
  userManager: UserManager;
  impersonationStorageKey: string;
}

export const HerculesAuthProviderContext = createContext<HerculesAuthProviderContext | null>(null);
