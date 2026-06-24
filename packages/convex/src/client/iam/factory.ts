import type { ActionBuilder, GenericDataModel } from "convex/server";
import { v } from "convex/values";
import { createAdmissionRuleActions } from "./admission-rules.js";
import { createAuditEventActions } from "./audit-events.js";
import { createGrantActions } from "./grants.js";
import { createGroupActions } from "./groups.js";
import { createInvitationActions } from "./invitations.js";
import { createResourceActions } from "./resources.js";
import { createRoleActions } from "./roles.js";
import {
  userActorHeaders,
  type IamApiOptions,
  makeIamApiCaller,
  requiredArgumentString,
  serviceActorHeaders,
} from "./shared.js";
import {
  createArchiveTenantAction,
  createEvaluateTenantEntryAction,
  createTenantActions,
} from "./tenants.js";
import { createUserActions } from "./users.js";

export type CreateIamServiceActionsOptions<DataModel extends GenericDataModel> = IamApiOptions & {
  internalAction: ActionBuilder<DataModel, "internal">;
};

export type CreateIamManagementActionsOptions<DataModel extends GenericDataModel> =
  IamApiOptions & {
    authenticatedAction: ActionBuilder<DataModel, "public">;
  };

export function createIamServiceActions<DataModel extends GenericDataModel>(
  options: CreateIamServiceActionsOptions<DataModel>,
) {
  const context = {
    builder: options.internalAction,
    actorValidators: {},
    headersFor: () => serviceActorHeaders(),
    call: makeIamApiCaller(options),
  };

  return {
    ...createTenantActions(context),
    ...createUserActions(context),
    ...createGrantActions(context),
    ...createGroupActions(context),
    ...createRoleActions(context),
    ...createAdmissionRuleActions(context),
    ...createAuditEventActions(context),
    ...createInvitationActions(context),
    ...createResourceActions(context),
    archiveTenant: createArchiveTenantAction(options.internalAction, options),
  };
}

export function createIamManagementActions<DataModel extends GenericDataModel>(
  options: CreateIamManagementActionsOptions<DataModel>,
) {
  const context = {
    builder: options.authenticatedAction,
    actorValidators: { idToken: v.string() },
    headersFor: (args: object) =>
      userActorHeaders(requiredArgumentString(args as Record<string, unknown>, "idToken")),
    call: makeIamApiCaller(options),
  };

  return {
    ...createTenantActions(context),
    ...createUserActions(context),
    ...createGrantActions(context),
    ...createGroupActions(context),
    ...createRoleActions(context),
    ...createAdmissionRuleActions(context),
    ...createAuditEventActions(context),
    ...createInvitationActions(context),
    ...createResourceActions(context),
    evaluateTenantEntry: createEvaluateTenantEntryAction(options.authenticatedAction, options),
  };
}
