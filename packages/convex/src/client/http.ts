import type { FunctionReference, HttpActionBuilder, HttpRouter } from "convex/server";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import {
  ACCESS_CONTROL_SYNC_PATH,
  accessProjectionSyncPayloadSchema,
  type AccessProjectionSyncPayload,
  type SyncResponse,
} from "../shared/sync";

type ApplySyncReference = FunctionReference<
  "mutation",
  "public",
  AccessProjectionSyncPayload,
  SyncResponse
>;

export type AccessControlSyncComponent = { sync: { applySync: ApplySyncReference } };

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
  const envVarName = options.envVarName ?? "HERCULES_SYNC_SECRET";

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

      const parsedPayload = accessProjectionSyncPayloadSchema.safeParse(verifiedPayload.payload);
      if (!parsedPayload.success) {
        return jsonResponse({ ok: false, status: "invalid_payload" }, 400);
      }

      const result = await ctx.runMutation(component.sync.applySync, parsedPayload.data);
      const response = result.ok
        ? { ...result, capabilities: { resourcePermissionRules: true } }
        : result;
      return jsonResponse(response satisfies SyncResponse, syncResponseStatus(result));
    }),
  });
}

// Map mutation-level outcomes to HTTP statuses so generic webhook tooling
// (queues, retries, monitoring) does not treat rejected syncs as delivered.
// 200 -> applied / duplicate; 409 -> version_gap (retry after sync); 400 ->
// payload-shape problems; 401 -> signature already returned earlier.
function syncResponseStatus(result: SyncResponse): number {
  if (result.ok) return 200;
  if (result.status === "version_gap") return 409;
  if (result.status === "issuer_mismatch") return 409;
  return 400;
}

function resolveSyncComponent(
  options: RegisterAccessControlRoutesOptions,
): AccessControlSyncComponent {
  if (options.component) {
    return options.component;
  }

  const componentName = options.componentName ?? "hercules";
  const namedComponent = options.components?.[componentName];
  const defaultComponent =
    options.components?.hercules ?? options.components?.accessControl ?? options.components?.hercules_access_control;
  const component = namedComponent ?? defaultComponent;

  if (!component) {
    throw new Error(
      "Missing Hercules Access Control component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component as AccessControlSyncComponent;
}

function verifyWebhookPayload(secret: string, rawBody: string, headers: Headers) {
  const webhookHeaders: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    webhookHeaders[key] = value;
  }

  try {
    return { ok: true as const, payload: new Webhook(secret).verify(rawBody, webhookHeaders) };
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
    headers: { "content-type": "application/json" },
  });
}
