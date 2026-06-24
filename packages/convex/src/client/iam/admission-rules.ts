import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  compactBody,
  type IamActionModuleContext,
  type IamTenantWriteResult,
  nullableString,
  normalizeTenantWriteResult,
  optionalString,
  queryPath,
  requiredBoolean,
  requiredRecord,
  requiredRecordArray,
  requiredString,
  tenantPath,
} from "./shared.js";

export type IamAdmissionRule = {
  ruleId: string;
  effect: "allow" | "deny";
  subject: { type: "email" | "domain"; value: string };
  reason: string | null;
  archived: boolean;
  archivedAt: string | null;
};

export type IamAdmissionRuleListResult = {
  tenantId: string;
  admissionRules: IamAdmissionRule[];
  nextCursor?: string;
};

export type IamAdmissionRuleWriteResult = IamTenantWriteResult & {
  ruleId: string;
};

export function createAdmissionRuleActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    listAdmissionRules: builder({
      args: {
        tenantId: v.string(),
        cursor: v.optional(v.string()),
        limit: v.optional(v.number()),
        effect: v.optional(v.union(v.literal("allow"), v.literal("deny"))),
        subjectType: v.optional(v.union(v.literal("email"), v.literal("domain"))),
        archived: v.optional(v.boolean()),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeAdmissionRuleListResult(
          await call(
            "get",
            queryPath(tenantPath(args.tenantId, "admission-rules"), {
              cursor: args.cursor,
              limit: args.limit,
              effect: args.effect,
              subject_type: args.subjectType,
              archived: args.archived,
            }),
            headersFor(args),
          ),
        ),
    }),

    createAdmissionRule: builder({
      args: {
        tenantId: v.string(),
        effect: v.union(v.literal("allow"), v.literal("deny")),
        subject: v.union(
          v.object({ type: v.literal("email"), value: v.string() }),
          v.object({ type: v.literal("domain"), value: v.string() }),
        ),
        reason: v.optional(v.union(v.string(), v.null())),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeAdmissionRuleResult(
          await call(
            "post",
            tenantPath(args.tenantId, "admission-rules"),
            headersFor(args),
            compactBody({
              effect: args.effect,
              subject: args.subject,
              reason: args.reason,
            }),
          ),
        ),
    }),

    updateAdmissionRule: builder({
      args: {
        tenantId: v.string(),
        ruleId: v.string(),
        reason: v.union(v.string(), v.null()),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeAdmissionRuleResult(
          await call(
            "patch",
            tenantPath(args.tenantId, "admission-rules", args.ruleId),
            headersFor(args),
            { reason: args.reason },
          ),
        ),
    }),

    archiveAdmissionRule: builder({
      args: {
        tenantId: v.string(),
        ruleId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeAdmissionRuleResult(
          await call(
            "delete",
            tenantPath(args.tenantId, "admission-rules", args.ruleId),
            headersFor(args),
          ),
        ),
    }),
  };
}

function normalizeAdmissionRuleListResult(
  result: import("./shared.js").ApiRecord,
): IamAdmissionRuleListResult {
  return {
    tenantId: requiredString(result, "tenant_id", "tenantId"),
    admissionRules: requiredRecordArray(result, "admission_rules", "admissionRules").map((rule) => {
      const effect = requiredString(rule, "effect", "admissionRules[].effect");
      if (effect !== "allow" && effect !== "deny") {
        throw new Error("IAM API response has invalid admissionRules[].effect.");
      }
      const subject = requiredRecord(rule, "subject", "admissionRules[].subject");
      const subjectType = requiredString(subject, "type", "admissionRules[].subject.type");
      if (subjectType !== "email" && subjectType !== "domain") {
        throw new Error("IAM API response has invalid admissionRules[].subject.type.");
      }
      return {
        ruleId: requiredString(rule, "rule_id", "admissionRules[].ruleId"),
        effect,
        subject: {
          type: subjectType,
          value: requiredString(subject, "value", "admissionRules[].subject.value"),
        },
        reason: nullableString(rule, "reason", "admissionRules[].reason"),
        archived: requiredBoolean(rule, "archived", "admissionRules[].archived"),
        archivedAt: nullableString(rule, "archived_at", "admissionRules[].archivedAt"),
      };
    }),
    ...optionalCursor(result),
  };
}

function normalizeAdmissionRuleResult(
  result: import("./shared.js").ApiRecord,
): IamAdmissionRuleWriteResult {
  return {
    ...normalizeTenantWriteResult(result),
    ruleId: requiredString(result, "rule_id", "ruleId"),
  };
}

function optionalCursor(result: import("./shared.js").ApiRecord) {
  const nextCursor = optionalString(result, "next_cursor", "nextCursor");
  return nextCursor ? { nextCursor } : {};
}
