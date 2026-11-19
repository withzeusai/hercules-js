/**
 * Page actions in the browser: an agent's command to the page, such as
 * opening a record. They are one-way: one open tab claims each through the
 * app's `claimPageAction` mutation and runs it, and nothing goes back to the
 * run. No React or Convex imports.
 *
 * A page action is taken from the thread's `pageActions`, the ones Hercules
 * delivered to the app and no tab has claimed: the claim is on the delivered
 * call, so only a tool call the run really made can be run. It is run only
 * while its event is less than two minutes old. The claim decides that, on
 * the server's clock, never the browser's: one that came too late is listed
 * on the thread as `expired`, for the page to tell the user.
 */

/**
 * Runs a page action. What it returns goes nowhere: page actions are one-way.
 *
 * A model writes the arguments, and it may have been steered by text it read,
 * so they are untrusted input. A handler navigates within the app or adjusts
 * what the page shows. It never submits, purchases, deletes or changes a
 * setting. It validates an id and builds the URL from a fixed route plus the
 * encoded id, never navigates to a URL taken from an argument, and never
 * renders an argument as HTML.
 */
export type PageActionHandler = (
  // Untrusted: check the type and the shape of each before acting on it.
  args: any,
  info: { toolCallId: string; runId: string },
) => void | Promise<void>;

export type PageActionHandlers = Readonly<Record<string, PageActionHandler>>;

export interface ClaimPageActionArgs {
  threadId: string;
  runId: string;
  toolCallId: string;
}

/** A page action waiting for a tab, as the thread query lists it. */
export interface PendingPageActionCall {
  toolCallId: string;
  runId: string;
  name: string;
  /** The arguments as JSON text. */
  argumentsJson: string;
  /** When the agent called it. */
  createdAt: string;
  /** `expired` when it came more than two minutes after the agent called it: it is not run. */
  status: "pending" | "expired";
}

export interface PageActionRunnerOptions {
  /** The app's `claimPageAction` mutation, read when an action arrives. Without it none runs. */
  claim: () => ((args: ClaimPageActionArgs) => Promise<boolean>) | undefined;
  /** The page's handlers, read when an action arrives. */
  handlers: () => PageActionHandlers | undefined;
  /** Where a page with handlers but no `claim` is told it needs one. */
  name: string;
}

function parseArguments(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

/**
 * The page's handler for a page action, by the name the agent called it
 * under. Only a function the page set under that name itself: a name such as
 * `constructor` or `toString` finds nothing, as an object's inherited
 * properties are not handlers, and neither is a value that is not a function.
 */
function handlerFor(
  handlers: PageActionHandlers | undefined,
  name: string,
): PageActionHandler | undefined {
  if (handlers === undefined || !Object.hasOwn(handlers, name)) return undefined;
  const handler: unknown = handlers[name];
  return typeof handler === "function" ? (handler as PageActionHandler) : undefined;
}

/**
 * Runs each pending page action at most once in this page: only one the page
 * has a handler for, and only after this tab won the claim. The claim is
 * refused for one that is too old, which the thread then lists as `expired`.
 * A failing handler is logged; it fails nothing else.
 */
export function createPageActionRunner(options: PageActionRunnerOptions) {
  const taken = new Set<string>();
  let warned = false;

  async function run(threadId: string, action: PendingPageActionCall): Promise<void> {
    const handler = handlerFor(options.handlers(), action.name);
    const key = `${action.runId}:${action.toolCallId}`;
    if (action.status !== "pending" || handler === undefined || taken.has(key)) return;
    const claim = options.claim();
    if (claim === undefined) {
      if (!warned) {
        warned = true;
        console.warn(
          `${options.name}: the app's claimPageAction mutation is needed to run page actions`,
        );
      }
      return;
    }
    taken.add(key);
    let claimed: boolean;
    try {
      claimed = await claim({
        threadId,
        runId: action.runId,
        toolCallId: action.toolCallId,
      });
    } catch (failure) {
      // Not known to be taken: the next read of the thread may try again.
      taken.delete(key);
      console.error(`Page action ${action.name} could not be claimed`, failure);
      return;
    }
    if (!claimed) return;
    try {
      await handler(parseArguments(action.argumentsJson), {
        toolCallId: action.toolCallId,
        runId: action.runId,
      });
    } catch (failure) {
      console.error(`Page action ${action.name} failed`, failure);
    }
  }

  /** Takes and runs the thread's pending page actions. Call it with each read of the thread. */
  return function runPending(
    thread: { id: string; pageActions: readonly PendingPageActionCall[] } | null | undefined,
  ): void {
    if (thread === null || thread === undefined) return;
    for (const action of thread.pageActions) void run(thread.id, action);
  };
}
