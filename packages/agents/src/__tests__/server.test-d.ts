/** The caller a tool handler is given, as an app's code reads it. */
import { describe, expectTypeOf, it } from "vitest";
import type { ConvexTool, ToolsDefinition } from "../convex";
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

describe("ConvexTool", () => {
  it("is opaque: nothing to read, nothing to write, and no way to make one but tool()", () => {
    // No member an app can name.
    expectTypeOf<Extract<keyof ConvexTool, string>>().toEqualTypeOf<never>();
    const byHand: ConvexTool = {
      // @ts-expect-error A tool written by hand is not a tool.
      description: "Returns its arguments.",
      inputSchema: { type: "object" },
      parseArgs: (raw: unknown) => raw,
      handler: () => "ok",
    };
    // @ts-expect-error Nor is an empty object.
    const empty: ConvexTool = {};
    const read = (made: ConvexTool) => {
      // @ts-expect-error Its principals cannot be read, or widened after the fact.
      made.principals = ["user", "agent"];
      // @ts-expect-error Nor its handler called.
      return made.handler;
    };
    expectTypeOf(byHand).toEqualTypeOf<ConvexTool>();
    expectTypeOf(empty).toEqualTypeOf<ConvexTool>();
    expectTypeOf(read).toBeFunction();
    expectTypeOf<ToolsDefinition["tools"]>().toEqualTypeOf<Readonly<Record<string, ConvexTool>>>();
  });
});
