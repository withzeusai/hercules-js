import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  type ApiRecord,
  type IamActionModuleContext,
  nullableString,
  optionalNullableString,
  optionalString,
  queryPath,
  requiredRecord,
  requiredRecordArray,
  requiredString,
  tenantPath,
} from "./shared.js";

export type IamAuditActor =
  | {
      type: "user";
      userId: string | null;
      name?: string | null;
      email?: string | null;
    }
  | {
      type: "platform_user";
      platformUserId: string | null;
      name?: string | null;
      email?: string | null;
    }
  | {
      type: "service";
      apiKeyId: string | null;
      name?: string | null;
      email?: string | null;
    }
  | { type: "system" }
  | { type: "agent" };

export type IamAuditEvent = {
  auditEventId: string;
  action: string;
  outcome: "success" | "denied" | "failure";
  actor: IamAuditActor;
  target: { type: string; id: string };
  reasonCode: string | null;
  sourceVersion: number | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type IamAuditEventListResult = {
  tenantId: string;
  auditEvents: IamAuditEvent[];
  nextCursor?: string;
};

export function createAuditEventActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    listAuditEvents: builder({
      args: {
        tenantId: v.string(),
        cursor: v.optional(v.string()),
        limit: v.optional(v.number()),
        action: v.optional(v.string()),
        actorType: v.optional(
          v.union(
            v.literal("system"),
            v.literal("platform_user"),
            v.literal("user"),
            v.literal("agent"),
            v.literal("service"),
          ),
        ),
        userId: v.optional(v.string()),
        apiKeyId: v.optional(v.string()),
        targetType: v.optional(v.string()),
        targetId: v.optional(v.string()),
        outcome: v.optional(
          v.union(v.literal("success"), v.literal("denied"), v.literal("failure")),
        ),
        since: v.optional(v.string()),
        until: v.optional(v.string()),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeAuditEventListResult(
          await call(
            "get",
            queryPath(tenantPath(args.tenantId, "audit-events"), {
              cursor: args.cursor,
              limit: args.limit,
              action: args.action,
              actor_type: args.actorType,
              user_id: args.userId,
              api_key_id: args.apiKeyId,
              target_type: args.targetType,
              target_id: args.targetId,
              outcome: args.outcome,
              since: args.since,
              until: args.until,
            }),
            headersFor(args),
          ),
        ),
    }),
  };
}

function normalizeAuditEventListResult(result: ApiRecord): IamAuditEventListResult {
  const nextCursor = optionalString(result, "next_cursor", "nextCursor");
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    auditEvents: requiredRecordArray(result, "audit_events", "auditEvents").map(
      normalizeAuditEvent,
    ),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function normalizeAuditEvent(event: ApiRecord): IamAuditEvent {
  const outcome = requiredString(event, "outcome", "auditEvents[].outcome");
  if (outcome !== "success" && outcome !== "denied" && outcome !== "failure") {
    throw new Error("IAM API response has invalid auditEvents[].outcome.");
  }
  const target = requiredRecord(event, "target", "auditEvents[].target");
  return {
    auditEventId: requiredString(event, "audit_event_id", "auditEvents[].auditEventId"),
    action: requiredString(event, "action", "auditEvents[].action"),
    outcome,
    actor: normalizeAuditActor(requiredRecord(event, "actor", "auditEvents[].actor")),
    target: {
      type: requiredString(target, "type", "auditEvents[].target.type"),
      id: requiredString(target, "id", "auditEvents[].target.id"),
    },
    reasonCode: nullableString(event, "reason_code", "auditEvents[].reasonCode"),
    sourceVersion: nullableNumber(event, "source_version", "auditEvents[].sourceVersion"),
    requestId: nullableString(event, "request_id", "auditEvents[].requestId"),
    metadata: nullableRecord(event, "metadata", "auditEvents[].metadata"),
    createdAt: requiredString(event, "created_at", "auditEvents[].createdAt"),
  };
}

function normalizeAuditActor(actor: ApiRecord): IamAuditActor {
  const type = requiredString(actor, "type", "auditEvents[].actor.type");
  const profile = {
    ...optionalProfileField(actor, "name"),
    ...optionalProfileField(actor, "email"),
  };
  switch (type) {
    case "user":
      return {
        type,
        userId: nullableString(actor, "user_id", "auditEvents[].actor.userId"),
        ...profile,
      };
    case "platform_user":
      return {
        type,
        platformUserId: nullableString(
          actor,
          "platform_user_id",
          "auditEvents[].actor.platformUserId",
        ),
        ...profile,
      };
    case "service":
      return {
        type,
        apiKeyId: nullableString(actor, "api_key_id", "auditEvents[].actor.apiKeyId"),
        ...profile,
      };
    case "system":
    case "agent":
      return { type };
    default:
      throw new Error("IAM API response has invalid auditEvents[].actor.type.");
  }
}

function optionalProfileField(actor: ApiRecord, key: "name" | "email") {
  const value = optionalNullableString(actor, key, `auditEvents[].actor.${key}`);
  return value === undefined ? {} : { [key]: value };
}

function nullableNumber(result: ApiRecord, key: string, resultName: string) {
  const value = result[key];
  if (value === null) return null;
  if (typeof value !== "number") {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value;
}

function nullableRecord(result: ApiRecord, key: string, resultName: string) {
  const value = result[key];
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`IAM API response has invalid ${resultName}.`);
  }
  return value as Record<string, unknown>;
}
