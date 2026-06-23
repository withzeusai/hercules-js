export type IamAdmissionStatus =
  | "pending_approval"
  | "blocked"
  | "suspended"
  | "removed"
  | "missing";

export type IamErrorClassification =
  | {
      kind: "admission";
      reasonCode: string;
      status: IamAdmissionStatus;
      sourceVersion?: number;
    }
  | {
      kind: "permission";
      reasonCode: "permission_denied";
      sourceVersion?: number;
    }
  | {
      kind: "temporary";
      reasonCode: "mirror_not_ready";
      sourceVersion?: number;
    };

const ADMISSION_STATUS_BY_REASON: Readonly<Record<string, IamAdmissionStatus>> = {
  principal_pending_approval: "pending_approval",
  app_principal_pending_approval: "pending_approval",
  principal_blocked: "blocked",
  app_principal_blocked: "blocked",
  principal_suspended: "suspended",
  app_principal_suspended: "suspended",
  principal_removed: "removed",
  app_principal_removed: "removed",
  principal_missing: "missing",
  app_principal_missing: "missing",
};

/**
 * Classifies runtime IAM denials that applications can recover from or present
 * to users. Configuration and unknown failures return `null`.
 */
export function classifyIamError(error: unknown): IamErrorClassification | null {
  const data = getErrorData(error);
  if (data?.code !== "ACCESS_DENIED" || typeof data.reasonCode !== "string") {
    return null;
  }

  const sourceVersion =
    typeof data.sourceVersion === "number" && Number.isFinite(data.sourceVersion)
      ? data.sourceVersion
      : undefined;
  const status = ADMISSION_STATUS_BY_REASON[data.reasonCode];
  if (status) {
    return {
      kind: "admission",
      reasonCode: data.reasonCode,
      status,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    };
  }

  if (data.reasonCode === "permission_denied") {
    return {
      kind: "permission",
      reasonCode: data.reasonCode,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    };
  }

  if (data.reasonCode === "mirror_not_ready") {
    return {
      kind: "temporary",
      reasonCode: data.reasonCode,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    };
  }

  return null;
}

function getErrorData(error: unknown): Record<string, unknown> | null {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return null;
  }

  const { data } = error;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}
