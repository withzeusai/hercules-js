import { describe, it, expect } from "vitest";
import { parseCookies, parseCookieNames, serializeCookie } from "./cookie-utils";

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("a=1")).toEqual({ a: "1" });
  });

  it("parses multiple cookies", () => {
    expect(parseCookies("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("preserves = characters within cookie values", () => {
    expect(parseCookies("token=base64==padding==")).toEqual({ token: "base64==padding==" });
  });

  it("returns an empty object for an empty header", () => {
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("   ")).toEqual({});
  });

  it("trims whitespace around each pair", () => {
    expect(parseCookies("a=1 ;   b=2")).toEqual({ a: "1", b: "2" });
  });
});

describe("parseCookieNames", () => {
  it("returns names only, ignoring values", () => {
    expect(parseCookieNames("a=1; b=2; c=3")).toEqual(["a", "b", "c"]);
  });

  it("handles values containing = signs", () => {
    expect(parseCookieNames("token=base64==padding==")).toEqual(["token"]);
  });

  it("trims whitespace around each name", () => {
    expect(parseCookieNames("a=1 ;   b=2")).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty header", () => {
    expect(parseCookieNames("")).toEqual([]);
    expect(parseCookieNames("   ")).toEqual([]);
  });

  it("tolerates a valueless cookie segment", () => {
    expect(parseCookieNames("a=1; flag; b=2")).toEqual(["a", "flag", "b"]);
  });
});

describe("serializeCookie", () => {
  it("serializes a bare name/value pair", () => {
    expect(serializeCookie("a", "1")).toBe("a=1");
  });

  it("includes Path and Max-Age when provided", () => {
    expect(serializeCookie("a", "1", { path: "/", maxAge: 3600 })).toBe(
      "a=1; Path=/; Max-Age=3600",
    );
  });

  it("appends HttpOnly, Secure, and SameSite flags", () => {
    expect(
      serializeCookie("session", "tok", {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
      }),
    ).toBe("session=tok; Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  it("floors a fractional Max-Age to whole seconds", () => {
    expect(serializeCookie("a", "1", { maxAge: 59.9 })).toBe("a=1; Max-Age=59");
  });

  it("emits Max-Age=0 to expire a cookie", () => {
    expect(serializeCookie("a", "", { path: "/", maxAge: 0 })).toBe("a=; Path=/; Max-Age=0");
  });

  it("omits falsy flags", () => {
    expect(serializeCookie("a", "1", { httpOnly: false, secure: false })).toBe("a=1");
  });
});
