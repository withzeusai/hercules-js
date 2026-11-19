// @vitest-environment jsdom
/**
 * The chat as the README writes it: TanStack's `createChatUI` and `useChat`,
 * with the connection made once per chat from `useConvex()` and the page's
 * actions set on it in an effect.
 */
import { useChat, type UIMessage } from "@tanstack/ai-react";
import { createChatUI } from "@tanstack/ai-react/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ConvexProviderWithAuth,
  useConvex,
  useConvexAuth,
  type ConvexReactClient,
} from "convex/react";
import { createElement, useEffect, useState, type ComponentType, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { herculesConnection, useThreadSync, type PageActionHandlers } from "../tanstack";
import {
  api,
  apiMessage,
  assistantMessage,
  createApp,
  frame,
  pendingPageAction,
  RUN,
  settledThread,
  THREAD,
  type App,
  userMessage,
} from "./tanstack-harness";

const chatOptions = { persistence: true } as const;

const { Chat, useChatContext } = createChatUI(chatOptions, {
  components: { layout: ChatLayout, message: ChatMessage },
  partsComponents: {},
});

// Typed returns: without JSX, `createElement` would infer them through `useChatContext`.
function ChatLayout({ Messages }: { Messages: ComponentType }): ReactElement {
  const chat = useChatContext();
  return createElement(
    "div",
    null,
    createElement(Messages),
    chat.isLoading ? createElement("p", null, "Thinking...") : null,
  );
}

function ChatMessage({ message }: { message: UIMessage }): ReactElement {
  const text = message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
  return createElement("p", { "data-role": message.role }, text);
}

interface ChatProps {
  threadId: string;
  fetch: typeof globalThis.fetch;
  pageActions: PageActionHandlers;
}

// The gate the README shows: the chat mounts once Convex knows who is asking.
function AgentChat(props: ChatProps) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return createElement("p", null, "Sign in to chat.");
  return createElement(SignedInChat, props);
}

function SignedInChat({ threadId, fetch, pageActions }: ChatProps) {
  const convex = useConvex();
  const [connection] = useState(() => herculesConnection(convex, api.agent, { fetch }));
  const chat = useChat({ ...chatOptions, connection, threadId });
  useThreadSync(chat, api.agent.thread, { threadId });
  useEffect(() => {
    connection.setPageActions(pageActions);
    return () => connection.setPageActions(undefined);
  }, [connection, pageActions]);
  return createElement(
    "div",
    null,
    createElement(Chat, { chat }),
    createElement(
      "button",
      { type: "button", onClick: () => void chat.sendMessage("Open my order") },
      "Send",
    ),
  );
}

/** How the app's auth provider reports the user to Convex. */
interface Session {
  isLoading: boolean;
  isAuthenticated: boolean;
}
const SIGNED_IN: Session = { isLoading: false, isAuthenticated: true };

/** The app's Convex client, as far as auth goes: it takes the token and says it is good. */
function withAuth(app: App): ConvexReactClient {
  return {
    ...app.client,
    setAuth(fetchToken: () => Promise<unknown>, onChange: (isAuthenticated: boolean) => void) {
      void fetchToken().then((token) => onChange(token !== null));
    },
    clearAuth() {},
  } as unknown as ConvexReactClient;
}

/** One open tab of the app. */
function renderTab(app: App, pageActions: PageActionHandlers, session: Session = SIGNED_IN) {
  const useAuth = () => ({
    ...session,
    fetchAccessToken: async () => (session.isAuthenticated ? "token" : null),
  });
  return render(
    createElement(
      ConvexProviderWithAuth,
      { client: withAuth(app), useAuth },
      createElement(AgentChat, { threadId: THREAD, fetch: app.fetch, pageActions }),
    ),
  );
}

const REPLY = assistantMessage("msg_1", [
  { type: "text", text: "Opening order 123." },
  {
    type: "tool_call",
    id: "call_open",
    name: "open_order",
    kind: "page",
    status: "sent",
    summary: null,
  },
]);

afterEach(cleanup);

describe("the README's chat", () => {
  it("does not mount the chat, or read the thread, until Convex has a signed-in user", async () => {
    const app = createApp(settledThread([userMessage("Open my order"), REPLY]));
    const signedOut = renderTab(app, {}, { isLoading: false, isAuthenticated: false });
    expect(await screen.findByText("Sign in to chat.")).toBeTruthy();
    signedOut.unmount();
    renderTab(app, {}, { isLoading: true, isAuthenticated: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A thread read now would be read as no one, and come back empty for good.
    expect(app.calls).toEqual([]);
    expect(screen.queryByText("Send")).toBeNull();
  });

  it("sends with the app's own client, shows the reply, and runs the page action", async () => {
    const app = createApp(null);
    const openOrder = vi.fn();
    renderTab(app, { open_order: openOrder });
    // Persistence read the thread once: there is none yet.
    await waitFor(() => expect(app.callsTo("agent:thread")).toHaveLength(1));

    app.push(
      frame(1, "run.started"),
      frame(2, "message.delta", { message_id: "msg_1", text: "Opening order 123." }),
      frame(3, "tool_call.started", {
        tool_call_id: "call_open",
        name: "open_order",
        kind: "page",
      }),
      frame(4, "page_action", {
        tool_call_id: "call_open",
        name: "open_order",
        arguments: { orderId: "123" },
      }),
      frame(5, "tool_call.completed", {
        tool_call_id: "call_open",
        name: "open_order",
        kind: "page",
        status: "sent",
        summary: null,
      }),
      frame(6, "message.completed", { message: apiMessage(REPLY) }),
      frame(7, "run.completed", { output: "Opening order 123.", usage: null }),
    );
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("Opening order 123.")).toBeTruthy();
    // The page action runs once Hercules has delivered it to the app.
    expect(openOrder).not.toHaveBeenCalled();
    act(() => app.deliverPageAction(pendingPageAction("call_open", { orderId: "123" })));
    await waitFor(() => expect(openOrder).toHaveBeenCalledTimes(1));
    expect(openOrder).toHaveBeenCalledWith(
      { orderId: "123" },
      { toolCallId: "call_open", runId: RUN },
    );

    act(() => app.setThread(settledThread([userMessage("Open my order"), REPLY])));
    await waitFor(() => expect(screen.queryByText("Thinking...")).toBeNull());
    expect(app.callsTo("agent:send").map((call) => call.args)).toEqual([
      { threadId: THREAD, text: "Open my order" },
    ]);
    expect(app.callsTo("agent:claimPageAction")).toHaveLength(1);
  });

  it("runs a page action left waiting in one tab only, with handlers set in an effect", async () => {
    const app = createApp({
      ...settledThread([userMessage("Open my order"), REPLY]),
      pageActions: [pendingPageAction("call_open", { orderId: "123" })],
    });
    const firstTab = vi.fn();
    const secondTab = vi.fn();
    renderTab(app, { open_order: firstTab });
    renderTab(app, { open_order: secondTab });

    await waitFor(() => expect(app.callsTo("agent:claimPageAction")).toHaveLength(2));
    await waitFor(() => expect(firstTab.mock.calls.length + secondTab.mock.calls.length).toBe(1));
    expect([...firstTab.mock.calls, ...secondTab.mock.calls]).toEqual([
      [{ orderId: "123" }, { toolCallId: "call_open", runId: RUN }],
    ]);
    expect(screen.getAllByText("Opening order 123.")).toHaveLength(2);
  });
});
