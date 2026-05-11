import type { FunctionReference, HttpActionBuilder, HttpRouter } from "convex/server";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import {
  ACCESS_CONTROL_SYNC_PATH,
  accessProjectionSnapshotSchema,
  type AccessProjectionSnapshot,
  type SyncResponse,
} from "../shared/sync";

type ApplySnapshotReference = FunctionReference<
  "mutation",
  "public",
  AccessProjectionSnapshot,
  { ok: true; status: "applied" | "duplicate"; acknowledgedVersion: number }
>;

export type AccessControlSyncComponent = {
  sync: {
    applySnapshot: ApplySnapshotReference;
  };
};

export type RegisterAccessControlRoutesOptions = {
  httpAction: HttpActionBuilder;
  components?: Record<string, unknown>;
  component?: AccessControlSyncComponent;
  componentName?: string;
  path?: string;
  envVarName?: string;
};

export function registerAccessControlRoutes(
  http: HttpRouter,
  options: RegisterAccessControlRoutesOptions,
) {
  const component = resolveSyncComponent(options);
  const path = options.path ?? ACCESS_CONTROL_SYNC_PATH;
  const envVarName = options.envVarName ?? "HERCULES_ACCESS_SYNC_SECRET";

  http.route({
    path,
    method: "POST",
    handler: options.httpAction(async (ctx, request) => {
      const secret = process.env[envVarName];
      if (!secret) {
        return jsonResponse({ ok: false, status: "invalid_signature" }, 500);
      }

      const rawBody = await request.text();
      const verifiedPayload = verifyWebhookPayload(secret, rawBody, request.headers);
      if (!verifiedPayload.ok) {
        return jsonResponse({ ok: false, status: "invalid_signature" }, 401);
      }

      const parsedPayload = accessProjectionSnapshotSchema.safeParse(verifiedPayload.payload);
      if (!parsedPayload.success) {
        return jsonResponse({ ok: false, status: "invalid_payload" }, 400);
      }

      const result = await ctx.runMutation(component.sync.applySnapshot, parsedPayload.data);
      return jsonResponse(result satisfies SyncResponse, 200);
    }),
  });
}

function resolveSyncComponent(
  options: RegisterAccessControlRoutesOptions,
): AccessControlSyncComponent {
  if (options.component) {
    return options.component;
  }

  const componentName = options.componentName ?? "accessControl";
  const namedComponent = options.components?.[componentName];
  const defaultComponent = options.components?.hercules_access_control;
  const component = namedComponent ?? defaultComponent;

  if (!isSyncComponent(component)) {
    throw new Error(
      "Missing Hercules Access Control component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component;
}

function isSyncComponent(component: unknown): component is AccessControlSyncComponent {
  return (
    typeof component === "object" &&
    component !== null &&
    "sync" in component &&
    typeof component.sync === "object" &&
    component.sync !== null &&
    "applySnapshot" in component.sync
  );
}

function verifyWebhookPayload(secret: string, rawBody: string, headers: Headers) {
  const webhookHeaders: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    webhookHeaders[key] = value;
  }

  try {
    return {
      ok: true as const,
      payload: new Webhook(secret).verify(rawBody, webhookHeaders),
    };
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return { ok: false as const };
    }
    throw error;
  }
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
