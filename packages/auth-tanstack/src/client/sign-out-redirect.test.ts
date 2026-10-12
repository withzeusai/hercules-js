import { describe, expect, it } from "vitest";
import { signOutFallback } from "./sign-out-redirect";

const origin = "https://app.example.com";

describe("signOutFallback", () => {
  it.each([
    undefined,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,test",
    "https://app.example.com@evil.example",
    "http://[",
  ])("falls back to the app home for %j", (returnTo) =>
    expect(signOutFallback(returnTo, origin)).toBe(`${origin}/`),
  );

  it.each([
    "/signed-out?reason=user#done",
    "signed-out?reason=user#done",
    `${origin}/signed-out?reason=user#done`,
  ])("preserves a same-origin return target %j", (returnTo) =>
    expect(signOutFallback(returnTo, origin)).toBe(`${origin}/signed-out?reason=user#done`),
  );
});
