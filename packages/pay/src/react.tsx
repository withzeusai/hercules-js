"use client";

import type { CustomerData } from "autumn-js";
import {
  AutumnProvider,
  CheckoutDialog,
  PaywallDialog,
  PricingTable,
  type PricingTableProduct,
  type ProductDetails,
  useAnalytics,
  useCustomer,
  useEntity,
  usePaywall,
  usePricingTable,
} from "autumn-js/react";
import { useConvex } from "convex/react";

export {
  AutumnProvider,
  CheckoutDialog,
  PaywallDialog,
  PricingTable,
  type PricingTableProduct,
  type ProductDetails,
  useAnalytics,
  useCustomer,
  useEntity,
  usePaywall,
  usePricingTable,
};

export function HerculesPayProvider({
  children,
  ...rest
}: {
  children: React.ReactNode;
  getBearerToken?: () => Promise<string | null>;
  backendUrl?: string;
  customerData?: CustomerData;
  includeCredentials?: boolean;
  betterAuthUrl?: string;
  headers?: Record<string, string>;
  convexApi?: any;
  pathPrefix?: string;
}) {
  const convex = useConvex();
  return (
    <AutumnProvider convex={convex} {...rest}>
      {children}
    </AutumnProvider>
  );
}
