/**
 * WebAuthn JSON helpers. Better Auth's passkey endpoints speak the WebAuthn
 * JSON shapes (base64url strings); the browser API speaks ArrayBuffers. These
 * convert both ways without a dependency, preferring the browser's own
 * `parse*OptionsFromJSON` / `toJSON` where it has them.
 */

type Json = Record<string, unknown>;

function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer | null | undefined): string | undefined {
  if (!buffer) return undefined;
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function withCredentialIds(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((item: Json) => ({
    ...(item as unknown as PublicKeyCredentialDescriptor),
    id: fromBase64Url(item.id as string),
  }));
}

interface PublicKeyCredentialStatics {
  parseRequestOptionsFromJSON?: (options: Json) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (options: Json) => PublicKeyCredentialCreationOptions;
}

function statics(): PublicKeyCredentialStatics {
  return (globalThis.PublicKeyCredential ?? {}) as unknown as PublicKeyCredentialStatics;
}

export function isWebAuthnAvailable(): boolean {
  return (
    typeof globalThis.PublicKeyCredential === "function" && !!globalThis.navigator?.credentials
  );
}

export function requestOptionsFromJSON(options: Json): PublicKeyCredentialRequestOptions {
  const native = statics().parseRequestOptionsFromJSON;
  if (native) return native(options);
  return {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64Url(options.challenge as string),
    allowCredentials: withCredentialIds(options.allowCredentials),
  };
}

export function creationOptionsFromJSON(options: Json): PublicKeyCredentialCreationOptions {
  const native = statics().parseCreationOptionsFromJSON;
  if (native) return native(options);
  const user = options.user as Json;
  return {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64Url(options.challenge as string),
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: fromBase64Url(user.id as string),
    },
    excludeCredentials: withCredentialIds(options.excludeCredentials),
  };
}

/** A credential the browser returned, as the JSON Better Auth verifies. */
export function credentialToJSON(credential: PublicKeyCredential): Json {
  const withToJSON = credential as unknown as { toJSON?: () => Json };
  if (typeof withToJSON.toJSON === "function") return withToJSON.toJSON();
  const response = credential.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const json: Json = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      ...("attestationObject" in response
        ? {
            attestationObject: toBase64Url(response.attestationObject),
            transports: response.getTransports?.() ?? [],
          }
        : {}),
      ...("authenticatorData" in response
        ? {
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            userHandle: toBase64Url(response.userHandle),
          }
        : {}),
    },
  };
  return json;
}
