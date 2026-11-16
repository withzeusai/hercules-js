/** The caller a tool handler is given, as an app's code reads it. */
import { describe, expectTypeOf, it } from "vitest";
import type { ToolCaller } from "../index";

describe("ToolCaller", () => {
  it("is an end user, or an agent with nothing but its id", () => {
    expectTypeOf<Extract<ToolCaller, { principal: "user" }>>().toEqualTypeOf<{
      principal: "user";
      tokenIdentifier: string;
      issuer: string;
      subject: string;
      agentId: string | null;
    }>();
    expectTypeOf<Extract<ToolCaller, { principal: "agent" }>>().toEqualTypeOf<{
      principal: "agent";
      agentId: string;
    }>();
  });
});
