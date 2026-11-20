// src/components/support-chat.tsx
import { useState } from "react";
import { AgentError, RunStreamError, useAgentThread } from "@usehercules/agents/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

type Props = { openOrder: (orderId: string) => void };

// What an order's id looks like in this app.
const ORDER_ID = /^[\w-]{1,64}$/;

// The chat is for signed-in users: mount it once Convex knows who is asking.
export function SupportChat(props: Props) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <p>Sign in to chat.</p>;
  return <SignedInSupportChat {...props} />;
}

function errorText(error: AgentError | RunStreamError | Error | null) {
  // A RunStreamError is the live view failing, not the run: the reply still arrives.
  if (error === null || error instanceof RunStreamError) return null;
  if (
    error instanceof AgentError &&
    [
      "agent_not_found",
      "agent_unavailable",
      "hercules_auth_required",
      "client_upgrade_required",
    ].includes(error.code)
  ) {
    // The app's setup. A new chat will not help.
    return "The assistant is not available right now.";
  }
  return "Something went wrong. Send your message again.";
}

function SignedInSupportChat({ openOrder }: Props) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const chat = useAgentThread({
    threadId,
    // "skip" until there is a thread to read.
    thread: useQuery(api.agent.thread, threadId === null ? "skip" : { threadId }),
    send: useMutation(api.agent.send),
    cancel: useMutation(api.agent.cancel),
    claimPageAction: useMutation(api.agent.claimPageAction),
    pageActions: {
      // The agent writes the arguments: check the id before acting on it.
      open_order: ({ orderId }) => {
        if (typeof orderId === "string" && ORDER_ID.test(orderId)) openOrder(orderId);
      },
    },
  });

  async function submit(text: string) {
    const started = await chat.send(text, { context: { page: window.location.pathname } });
    // Keep the id the first send returns, so the next message continues the thread.
    if (started !== null) setThreadId(started.threadId);
  }

  const problem = errorText(chat.error);
  return (
    <div>
      {chat.messages.map((message) => (
        <p key={message.id} data-role={message.role}>
          {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </p>
      ))}
      {problem && <p role="alert">{problem}</p>}
      {/* Only "ready" takes a new message. Any other status means something is going. */}
      {chat.status !== "ready" && chat.status !== "loading" && (
        <button type="button" onClick={() => void chat.cancel()}>
          Stop
        </button>
      )}
      <button
        type="button"
        disabled={chat.status !== "ready"}
        onClick={() => void submit("Where is my order?")}
      >
        Ask about my order
      </button>
    </div>
  );
}
