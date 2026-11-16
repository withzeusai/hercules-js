/**
 * `convex/agent.ts` as the README writes it. `onRunFinished` names an
 * internal function through `internal`, whose type is built from every
 * module's exports, this one's included. So `support` has its annotation:
 * without it TypeScript has to infer `support` from an initializer that
 * depends on `support`, and an app's type-check fails with TS7022.
 *
 * TypeScript 6 and earlier, which apps use, report that error. TypeScript 7,
 * which checks this package, does not, so this fixture cannot show the
 * unannotated form failing: it holds the annotated form to compiling.
 */
import { HerculesAgents } from "../../../convex";
import { components, internal } from "./_generated/api";

export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  onRunFinished: internal.orders.onAgentRunFinished,
  limits: { runsPerUserPerHour: 20 },
});

export const { send, thread, cancel, claimPageAction, deleteThread } = support.api();
