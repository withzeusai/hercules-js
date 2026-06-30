export type IamAdmissionStatus =
  | "pending_approval"
  | "blocked"
  | "suspended"
  | "removed"
  | "missing";

const IAM_ACCESS_PROBLEM_CODES = [
  "access_denied",
  "user_authority_required",
  "service_authority_required",
  "owner_authority_required",
] as const;

const IAM_OPERATION_PROBLEM_CODES = [
  "invalid_request",
  "resource_not_found",
  "state_conflict",
  "invalid_resource_role",
  "invalid_resource_permission",
  "invalid_lifecycle_transition",
  "last_owner_required",
  "grant_conflict",
] as const;

const IAM_SYNCHRONIZATION_PROBLEM_CODE = "source_version_conflict";

const IAM_PROBLEM_CODES = [
  ...IAM_ACCESS_PROBLEM_CODES,
  ...IAM_OPERATION_PROBLEM_CODES,
  IAM_SYNCHRONIZATION_PROBLEM_CODE,
] as const;

type IamAccessProblemCode = (typeof IAM_ACCESS_PROBLEM_CODES)[number];
type IamOperationProblemCode = (typeof IAM_OPERATION_PROBLEM_CODES)[number];
type IamSynchronizationProblemCode = typeof IAM_SYNCHRONIZATION_PROBLEM_CODE;
type IamProblemCode = (typeof IAM_PROBLEM_CODES)[number];
type IamProblemDetails = Record<string, unknown>;

const IAM_PROBLEM_CODE_SET: ReadonlySet<string> = new Set(IAM_PROBLEM_CODES);

const IAM_PROBLEM_KIND_BY_CODE: Readonly<
  Record<IamProblemCode, "access" | "operation" | "synchronization">
> = {
  access_denied: "access",
  user_authority_required: "access",
  service_authority_required: "access",
  owner_authority_required: "access",
  invalid_request: "operation",
  resource_not_found: "operation",
  state_conflict: "operation",
  invalid_resource_role: "operation",
  invalid_resource_permission: "operation",
  invalid_lifecycle_transition: "operation",
  last_owner_required: "operation",
  grant_conflict: "operation",
  source_version_conflict: "synchronization",
};

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
    }
  | {
      kind: "access";
      code: IamAccessProblemCode;
      status?: number;
      details?: IamProblemDetails;
    }
  | {
      kind: "synchronization";
      code: IamSynchronizationProblemCode;
      status?: number;
      details?: IamProblemDetails;
    }
  | {
      kind: "operation";
      code: IamOperationProblemCode;
      status?: number;
      details?: IamProblemDetails;
    };

const ADMISSION_STATUS_BY_REASON: Readonly<Record<string, IamAdmissionStatus>> = {
  membership_pending_approval: "pending_approval",
  membership_blocked: "blocked",
  membership_suspended: "suspended",
  membership_removed: "removed",
  membership_missing: "missing",
};

/**
 * Classifies runtime IAM denials that applications can recover from or present
 * to users. Configuration and unknown failures return `null`.
 */
export function classifyIamError(error: unknown): IamErrorClassification | null {
  const problem = getIamProblem(error);
  if (problem) {
    return classifyIamProblem(problem);
  }

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

type IamProblemCandidate = {
  problem: Record<string, unknown>;
  containerStatus?: number;
};

function classifyIamProblem({
  problem,
  containerStatus,
}: IamProblemCandidate): IamErrorClassification {
  const code = problem.code as IamProblemCode;
  const status = getStatus(problem.status) ?? containerStatus;
  const details = isPlainRecord(problem.details) ? problem.details : undefined;

  const base = {
    code,
    ...(status === undefined ? {} : { status }),
    ...(details === undefined ? {} : { details }),
  };

  const kind = IAM_PROBLEM_KIND_BY_CODE[code];
  if (kind === "access") {
    return {
      kind,
      ...base,
      code: code as IamAccessProblemCode,
    };
  }

  if (kind === "synchronization") {
    return {
      kind,
      ...base,
      code: code as IamSynchronizationProblemCode,
    };
  }

  return {
    kind,
    ...base,
    code: code as IamOperationProblemCode,
  };
}

function getIamProblem(error: unknown): IamProblemCandidate | null {
  if (!isObjectRecord(error)) {
    return null;
  }

  if (isIamProblemCode(error.code)) {
    return {
      problem: error,
      containerStatus: getStatus(error.status),
    };
  }

  const nestedProblems = (["error", "data"] as const)
    .map((key) => error[key])
    .filter(
      (value): value is Record<string, unknown> =>
        isObjectRecord(value) && isIamProblemCode(value.code),
    );

  const [problem] = nestedProblems;
  if (nestedProblems.length !== 1 || problem === undefined) {
    return null;
  }

  return {
    problem,
    containerStatus: getStatus(error.status),
  };
}

function isIamProblemCode(code: unknown): code is IamProblemCode {
  return typeof code === "string" && IAM_PROBLEM_CODE_SET.has(code);
}

function getStatus(status: unknown): number | undefined {
  return typeof status === "number" && Number.isFinite(status) && Number.isInteger(status)
    ? status
    : undefined;
}

function getErrorData(error: unknown): Record<string, unknown> | null {
  if (!isObjectRecord(error) || !("data" in error)) {
    return null;
  }

  const { data } = error;
  return isObjectRecord(data) ? data : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
