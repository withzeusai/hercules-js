import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPageActionRunner,
  type PageActionHandlers,
  type PendingPageActionCall,
} from "../page-actions";

const THREAD = "9c2d7a10-55e1-4f0b-8d3c-2a1b0c9d8e7f";

function pending(name: string, args: unknown = {}): PendingPageActionCall {
  return {
    toolCallId: `call_${name}`,
    runId: "run_1",
    name,
    argumentsJson: JSON.stringify(args),
    created_at: "2026-11-15T12:00:00.000Z",
    status: "pending",
  };
}

/** A page with these handlers, and a claim that every tab wins. */
function page(handlers: PageActionHandlers | undefined) {
  const claim = vi.fn(async () => true);
  const runPending = createPageActionRunner({
    name: "test",
    handlers: () => handlers,
    claim: () => claim,
  });
  return {
    claim,
    async deliver(...actions: PendingPageActionCall[]) {
      runPending({ id: THREAD, pageActions: actions });
      // The claim and the handler run in promises of their own.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPageActionRunner", () => {
  it("claims a page action and runs the page's handler for it, with its arguments", async () => {
    const openOrder = vi.fn();
    const tab = page({ open_order: openOrder });
    await tab.deliver(pending("open_order", { orderId: "123" }));
    expect(tab.claim).toHaveBeenCalledExactlyOnceWith({
      threadId: THREAD,
      runId: "run_1",
      toolCallId: "call_open_order",
    });
    expect(openOrder).toHaveBeenCalledExactlyOnceWith(
      { orderId: "123" },
      { toolCallId: "call_open_order", runId: "run_1" },
    );
  });

  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "__proto__",
    "__defineGetter__",
  ])("has no handler for %s, a name every object answers to", async (name) => {
    const openOrder = vi.fn();
    const tab = page({ open_order: openOrder });
    await tab.deliver(pending(name, { orderId: "123" }));
    // Not claimed either: it is left for a page that does have a handler for it.
    expect(tab.claim).not.toHaveBeenCalled();
    expect(openOrder).not.toHaveBeenCalled();
  });

  it("runs only a handler the page set under the name itself, never an inherited one", async () => {
    const inherited = vi.fn();
    const own = vi.fn();
    const handlers = Object.assign(Object.create({ close_panel: inherited }), {
      open_order: own,
    }) as PageActionHandlers;
    const tab = page(handlers);
    await tab.deliver(pending("close_panel"), pending("open_order"));
    expect(inherited).not.toHaveBeenCalled();
    expect(own).toHaveBeenCalledOnce();
    expect(tab.claim).toHaveBeenCalledOnce();
  });

  it("ignores a value that is not a function", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlers = {
      open_order: "/orders",
      close_panel: null,
      show_invoice: { run: vi.fn() },
    } as unknown as PageActionHandlers;
    const tab = page(handlers);
    await tab.deliver(pending("open_order"), pending("close_panel"), pending("show_invoice"));
    expect(tab.claim).not.toHaveBeenCalled();
    // Nothing was called, so nothing failed.
    expect(errors).not.toHaveBeenCalled();
  });

  it("takes handlers kept in an object with no prototype", async () => {
    const openOrder = vi.fn();
    const handlers = Object.assign(Object.create(null), {
      open_order: openOrder,
    }) as PageActionHandlers;
    const tab = page(handlers);
    await tab.deliver(pending("open_order"), pending("toString"));
    expect(openOrder).toHaveBeenCalledOnce();
    expect(tab.claim).toHaveBeenCalledOnce();
  });
});
