import type { GenericDataModel } from "convex/server";
import type { PropertyValidators } from "convex/values";
import { v } from "convex/values";
import {
  type ApiRecord,
  type IamActionModuleContext,
  type IamGrant,
  type IamResourceGrant,
  type IamTenantWriteResult,
  normalizeGrant,
  normalizeResourceGrant,
  normalizeTenantWriteResult,
  requiredRecord,
  tenantPath,
} from "./shared.js";

export type IamGrantWriteResult = IamTenantWriteResult & {
  grant: IamGrant | IamResourceGrant;
};

export type IamGrantUpdateResult = IamGrantWriteResult;
export type IamGrantDeleteResult = IamGrantWriteResult;

export function createGrantActions<
  DataModel extends GenericDataModel,
  Visibility extends "public" | "internal",
  ActorValidators extends PropertyValidators,
>(context: IamActionModuleContext<DataModel, Visibility, ActorValidators>) {
  const { actorValidators, builder, call, headersFor } = context;

  return {
    updateGrant: builder({
      args: {
        tenantId: v.string(),
        grantId: v.string(),
        expiresAt: v.union(v.string(), v.null()),
        ...actorValidators,
      },
      handler: async (_ctx, args) => {
        const result = await call(
          "patch",
          tenantPath(args.tenantId, "grants", args.grantId),
          headersFor(args),
          { expires_at: args.expiresAt },
        );
        return {
          ...normalizeGrantWriteResult(result),
        } satisfies IamGrantUpdateResult;
      },
    }),

    deleteGrant: builder({
      args: {
        tenantId: v.string(),
        grantId: v.string(),
        ...actorValidators,
      },
      handler: async (_ctx, args) =>
        normalizeGrantWriteResult(
          await call("delete", tenantPath(args.tenantId, "grants", args.grantId), headersFor(args)),
        ) satisfies IamGrantDeleteResult,
    }),
  };
}

export function normalizeGrantWriteResult(result: ApiRecord): IamGrantWriteResult {
  const grant = requiredRecord(result, "grant", "grant");
  return {
    ...normalizeTenantWriteResult(result),
    grant: "applies_to" in grant ? normalizeResourceGrant(grant) : normalizeGrant(grant),
  };
}
