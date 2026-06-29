/**
 * Base64url helpers used for sealed-session and PKCE-state cookie values.
 *
 * Implemented on top of the universally-available `btoa`/`atob` globals (Node
 * 16+, edge runtimes) rather than `Buffer`, so the package stays runtime-
 * agnostic. The output alphabet (`-`/`_`, no `=` padding) is cookie-safe: it
 * contains no `;`, `,`, `=`, or whitespace.
 */

/** Encode raw bytes as an unpadded base64url string. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode an unpadded base64url string back into raw bytes. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
