import type { FunctionReference, HttpActionBuilder, HttpRouter } from "convex/server";
import { IAM_SYNC_PATH, type SyncResponse } from "../shared/sync.js";

// The component's public sync entry point is an ACTION: it receives the raw
// request body plus the three standardwebhooks headers, verifies the signature
// against the component-bound secret, and only then applies the (internal)
// mirror mutation. The parent route below just transports the delivery to it.
type ApplySyncReference = FunctionReference<
  "action",
  "public",
  { payload: string; webhookId: string; webhookTimestamp: string; webhookSignature: string },
  SyncResponse
>;

export type IamSyncComponent = {
  sync: { applySync: ApplySyncReference };
};

export type RegisterIamRoutesOptions = {
  httpAction: HttpActionBuilder;
  components?: Record<string, unknown>;
  component?: IamSyncComponent;
  componentName?: string;
  path?: string;
};

export function registerIamRoutes(http: HttpRouter, options: RegisterIamRoutesOptions) {
  const component = resolveSyncComponent(options);
  const path = options.path ?? IAM_SYNC_PATH;

  http.route({
    path,
    method: "POST",
    handler: options.httpAction(async (ctx, request) => {
      // This route owns NO trust. The signing secret lives in the component and
      // signature verification happens there, welded to the mirror write. We
      // only forward the raw body (verbatim — the signature is over these exact
      // bytes) and the standardwebhooks headers into the component action.
      const rawBody = await request.text();
      let result: SyncResponse;
      try {
        result = await ctx.runAction(component.sync.applySync, {
          payload: rawBody,
          webhookId: request.headers.get("webhook-id") ?? "",
          webhookTimestamp: request.headers.get("webhook-timestamp") ?? "",
          webhookSignature: request.headers.get("webhook-signature") ?? "",
        });
      } catch {
        // Server misconfiguration (e.g. the signing secret is not bound to the
        // component) or an unexpected component error. Fail closed.
        return jsonResponse({ ok: false, status: "invalid_signature" }, 500);
      }
      return jsonResponse(result satisfies SyncResponse, syncResponseStatus(result));
    }),
  });
}

// Map mutation-level outcomes to HTTP statuses so generic webhook tooling
// (queues, retries, monitoring) does not treat rejected syncs as delivered.
// 200 -> applied / duplicate; 401 -> bad signature; 409 -> recoverable
// projection-state conflicts; 400 -> payload-shape problems.
function syncResponseStatus(result: SyncResponse): number {
  if (result.ok) return 200;
  if (result.status === "invalid_signature") return 401;
  if (
    result.status === "version_gap" ||
    result.status === "issuer_mismatch" ||
    result.status === "not_ready" ||
    result.status === "reset_required"
  ) {
    return 409;
  }
  return 400;
}

function resolveSyncComponent(options: RegisterIamRoutesOptions): IamSyncComponent {
  if (options.component) {
    return options.component;
  }

  const componentName = options.componentName ?? "hercules";
  const component = options.components?.[componentName];

  if (!component) {
    throw new Error(
      "Missing Hercules IAM component. Install @usehercules/convex in convex/convex.config.ts.",
    );
  }

  return component as IamSyncComponent;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
