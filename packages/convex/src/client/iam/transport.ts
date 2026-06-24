import { Hercules } from "@usehercules/sdk";
import { ConvexError } from "convex/values";
import {
  DEFAULT_API_VERSION,
  type ApiRecord,
  type IamApiCaller,
  type IamApiOptions,
  type IamSdkClient,
} from "./types.js";

const DEFAULT_IAM_API_KEY_ENV_VAR = "HERCULES_API_KEY";
const IAM_ACTOR_HEADER = "x-hercules-iam-actor";
const IAM_USER_ID_TOKEN_HEADER = "x-hercules-user-id-token";
const jwtShapePattern = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export function makeIamApiCaller(options: IamApiOptions): IamApiCaller {
  let client = options.client;

  return async (method, path, headers, body) => {
    client ??= createSdkClient(options);
    const request = { headers, ...(body === undefined ? {} : { body }) };
    return await client[method]<ApiRecord>(path, request);
  };
}

function createSdkClient(options: IamApiOptions): IamSdkClient {
  const envVarName = options.apiKeyEnvVar ?? DEFAULT_IAM_API_KEY_ENV_VAR;
  const apiKey = options.apiKey ?? process.env[envVarName];
  if (!apiKey) {
    throw new Error(`${envVarName} is required for Hercules IAM API calls.`);
  }
  return new Hercules({
    apiKey,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
  }) as unknown as IamSdkClient;
}

export function serviceActorHeaders() {
  return { [IAM_ACTOR_HEADER]: "service" };
}

export function userActorHeaders(idToken: string) {
  return {
    [IAM_ACTOR_HEADER]: "user",
    [IAM_USER_ID_TOKEN_HEADER]: normalizeIdToken(idToken),
  };
}

export function tenantPath(tenantId: string, ...parts: string[]) {
  return `/v1/iam/tenants/${[tenantId, ...parts].map(encodeURIComponent).join("/")}`;
}

export function resourceGrantPath(tenantId: string, resourceType: string, resourceId: string) {
  return tenantPath(tenantId, "resources", resourceType, resourceId, "grants");
}

export function queryPath(
  path: string,
  values: Record<string, string | number | boolean | undefined>,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function normalizeIdToken(idToken: string) {
  const normalized = idToken.trim();
  if (!normalized) {
    throw new ConvexError({
      code: "INVALID_ID_TOKEN",
      message: "idToken is required",
    });
  }
  if (!jwtShapePattern.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ID_TOKEN",
      message: "idToken must be the signed-in user's OIDC ID token, not a user or subject id.",
    });
  }
  return normalized;
}

export function parseTokenIdentifierSubject(tokenIdentifier: string | null | undefined) {
  const value = requireTokenIdentifier(tokenIdentifier);
  return value.slice(value.lastIndexOf("|") + 1);
}

export function requireTokenIdentifier(tokenIdentifier: string | null | undefined) {
  if (!tokenIdentifier) throwUnauthenticated();
  const separatorIndex = tokenIdentifier.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === tokenIdentifier.length - 1) {
    throwUnauthenticated();
  }
  return tokenIdentifier;
}

export function throwUnauthenticated(): never {
  throw new ConvexError({
    code: "UNAUTHENTICATED",
    message: "Authentication required",
  });
}

export function throwIamDenied(): never {
  throw new ConvexError({
    code: "ACCESS_DENIED",
    message: "Access denied",
  });
}

export function requireAtLeastOne(operation: string, values: Record<string, unknown>) {
  if (Object.values(values).every((value) => value === undefined)) {
    throw new Error(`${operation} requires at least one update.`);
  }
}

export function requiredArgumentString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is required.`);
  }
  return value;
}
