/** The caller a tool handler is given, as an app's code reads it. */
import { describe, expectTypeOf, it } from "vitest";
import type { AgentOrigin, ToolCaller } from "../index";

describe("ToolCaller", () => {
  it("is an end user, or an agent with its id and where its run was started", () => {
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
      origin: AgentOrigin | null;
    }>();
    // The origins Hercules signs today are offered by name, and any other string is taken.
    expectTypeOf<"app" | "schedule" | "an_origin_added_later">().toExtend<AgentOrigin>();
  });
});
