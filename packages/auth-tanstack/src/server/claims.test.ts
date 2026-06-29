import { describe, it, expect } from "vitest";
import { decodeJwtClaims, userInfoFromSession } from "./claims";
import type { SessionData } from "./session";

/** Build an unsigned JWT (`header.payload.`) carrying the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.`;
}

describe("decodeJwtClaims", () => {
  it("decodes a JWT payload", () => {
    expect(decodeJwtClaims(makeJwt({ sub: "u1", email: "a@b.com" }))).toEqual({
      sub: "u1",
      email: "a@b.com",
    });
  });

  it("returns null for an opaque (non-JWT) token", () => {
    expect(decodeJwtClaims("opaque-access-token")).toBeNull();
  });
});

describe("userInfoFromSession", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it("maps standard OIDC identity claims onto the user", () => {
    const session: SessionData = {
      accessToken: makeJwt({ sub: "u1" }),
      idToken: makeJwt({
        sub: "u1",
        sid: "sess_1",
        email: "jane@example.com",
        email_verified: true,
        given_name: "Jane",
        family_name: "Doe",
        picture: "https://img/jane.png",
      }),
      expiresAt: future,
    };

    const result = userInfoFromSession(session);
    expect(result).toMatchObject({
      user: {
        id: "u1",
        email: "jane@example.com",
        emailVerified: true,
        firstName: "Jane",
        lastName: "Doe",
        profilePictureUrl: "https://img/jane.png",
      },
      sessionId: "sess_1",
      accessToken: session.accessToken,
    });
  });

  it("pulls authorization claims from the access token and merges with the id token", () => {
    const session: SessionData = {
      accessToken: makeJwt({
        sub: "u1",
        org_id: "org_42",
        roles: ["admin", "editor"],
        permissions: ["posts:write"],
      }),
      idToken: makeJwt({ sub: "u1", email: "jane@example.com" }),
      expiresAt: future,
    };

    expect(userInfoFromSession(session)).toMatchObject({
      organizationId: "org_42",
      roles: ["admin", "editor"],
      permissions: ["posts:write"],
    });
  });

  it("falls back to cognito:groups for roles", () => {
    const session: SessionData = {
      accessToken: makeJwt({ sub: "u1", "cognito:groups": ["staff"] }),
      expiresAt: future,
    };
    expect(userInfoFromSession(session)).toMatchObject({ roles: ["staff"] });
  });

  it("returns no user when the access token has expired", () => {
    const session: SessionData = {
      accessToken: makeJwt({ sub: "u1" }),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    };
    expect(userInfoFromSession(session)).toEqual({ user: null });
  });

  it("returns no user when there is no usable subject", () => {
    const session: SessionData = { accessToken: "opaque", expiresAt: future };
    expect(userInfoFromSession(session)).toEqual({ user: null });
  });

  it("normalizes a stringified email_verified", () => {
    const session: SessionData = {
      accessToken: makeJwt({ sub: "u1", email_verified: "true" }),
      expiresAt: future,
    };
    expect(userInfoFromSession(session)).toMatchObject({ user: { emailVerified: true } });
  });
});
