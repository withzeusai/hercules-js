// src/components/agent-chat.tsx
import { useState, type ComponentType, type FormEvent } from "react";
import { useChat, type UIMessage } from "@tanstack/ai-react";
import { createChatUI, TextPart } from "@tanstack/ai-react/ui";
import {
  agentErrorCode,
  herculesConnection,
  PAGE_ACTION_OUTPUT,
  useThreadSync,
  type HerculesMessageMetadata,
} from "@usehercules/agents/tanstack";
import { useConvex, useConvexAuth } from "convex/react";
import { api } from "../../convex/_generated/api";

type Part = UIMessage["parts"][number];

const chatOptions = { persistence: true } as const;

// The message component renders every part itself, so a tool the page does not know still shows.
const { Chat } = createChatUI(chatOptions, {
  components: { layout: ChatLayout, message: ChatMessage },
  partsComponents: {},
});

// The chat is for signed-in users. Mount it only once Convex knows who is asking:
// it reads its thread when it mounts, and a thread read signed out comes back empty.
export function AgentChat({ threadId }: { threadId: string }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return <p>Sign in to chat.</p>;
  return <SignedInChat threadId={threadId} />;
}

function SignedInChat({ threadId }: { threadId: string }) {
  // The client the app's Convex provider signs in.
  const convex = useConvex();
  // Once per chat: useChat keeps the first connection it gets.
  const [connection] = useState(() => herculesConnection(convex, api.agent));
  const [text, setText] = useState("");
  // The message on its way, to give back if it is not sent.
  const [sent, setSent] = useState("");
  const chat = useChat({
    ...chatOptions,
    connection,
    threadId,
    // A message that is refused, or whose run fails, goes back into the box.
    onError: () => setText((typed) => typed || sent),
  });
  // Shows replies the user's other tabs and devices got, and returns the thread.
  const thread = useThreadSync(chat, api.agent.thread, { threadId });
  const activeRun = thread?.activeRun ?? null;
  const latestRun = thread?.latestRun ?? null;
  // A run goes on until the thread says it ended. After Stop that is a moment later than
  // chat.isLoading, and for a run another tab started it is the only sign.
  const running = chat.isLoading || activeRun !== null;
  const stopping = activeRun?.stopping === true;
  const last = chat.messages.at(-1);
  const replying = last?.role === "assistant" && last.parts.some(isVisibleText);
  // chat.error is lost on a reload. The thread keeps how its latest run ended.
  const error = chat.error
    ? errorMessage(agentErrorCode(chat.error))
    : latestRun?.status === "failed"
      ? errorMessage(latestRun.error?.code ?? null)
      : null;
  // Notes on the latest run. They go with the next message, so none stays under a newer one.
  const notes: string[] = [];
  // "Stopped." goes under what the thread kept of a stopped run: its reply as far as it was
  // written, or the user's message alone. A reply the thread holds only in part says so
  // itself. Ask the thread, not the chat's copy: its mark comes a render after the run ends.
  const whole =
    last?.role !== "assistant" ||
    thread?.messages.some((stored) => stored.id === last.id && stored.status === "completed");
  if (latestRun?.status === "cancelled" && whole) notes.push("Stopped.");
  // A page action that reached the app too late is not run. Say so.
  const late = thread?.pageActions.some(
    (action) => action.status === "expired" && action.runId === latestRun?.id,
  );
  if (late)
    notes.push("The assistant tried to do something on this page, but it arrived too late.");

  function send(event: FormEvent) {
    event.preventDefault();
    // The backend refuses a message while a run goes on, so none is sent.
    if (running || !text.trim()) return;
    setSent(text);
    setText("");
    const context = {
      page: window.location.pathname,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    void chat.sendMessage(text, { body: { context } }).finally(() => setSent(""));
  }

  function stop() {
    // chat.stop() ends this page's stream and cancels the run. A run with no stream here,
    // such as one another tab started, is stopped through the backend.
    if (chat.isLoading) chat.stop();
    else void convex.mutation(api.agent.cancel, { threadId });
  }

  return (
    <div>
      <div aria-live="polite">
        <Chat chat={chat} />
        {running && (stopping || !replying) && (
          <p>{stopping ? "Stopping..." : (activeRun?.progress ?? "Thinking...")}</p>
        )}
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      <form onSubmit={send}>
        {error && <p role="alert">{error}</p>}
        <textarea value={text} onChange={(event) => setText(event.target.value)} />
        {/* Stop and Send are two buttons, and Send keeps its place. One button that turns
            from Stop into Send submits the form when the run ends during a click. */}
        {running && (
          <button type="button" disabled={stopping} onClick={stop}>
            Stop
          </button>
        )}
        <button type="submit" disabled={running || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function ChatLayout({ Messages }: { Messages: ComponentType }) {
  return <Messages />;
}

function ChatMessage({ message }: { message: UIMessage }) {
  const parts = message.parts.filter((part) => isVisibleText(part) || part.type === "tool-call");
  const cutShort = isCutShort(message);
  if (parts.length === 0 && !cutShort) return null;
  return (
    <div data-role={message.role}>
      {parts.map((part, index) =>
        part.type === "text" ? (
          <TextPart key={index} content={part.content} />
        ) : part.type === "tool-call" ? (
          // One line per tool call, while it runs and after it ends.
          <p key={index}>{toolLine(part)}</p>
        ) : null,
      )}
      {cutShort && <p>Stopped before it finished.</p>}
    </div>
  );
}

function isVisibleText(part: Part) {
  return part.type === "text" && part.content.trim() !== "";
}

/** A reply the thread holds less of than was written. */
function isCutShort(message: UIMessage) {
  // What the connection records on a message: its run, and where the thread has the message.
  const hercules: Partial<HerculesMessageMetadata> = message.metadata?.hercules ?? {};
  return hercules.messageStatus === "incomplete";
}

/** One line for a tool call: its name while it runs, then the summary Hercules wrote. */
function toolLine(part: Extract<Part, { type: "tool-call" }>) {
  const name = part.name.replaceAll("_", " ");
  // Unless the backend sets exposeToolDetails, every Hercules tool is named "tool" here.
  if (part.output === undefined) return part.name === "tool" ? "Working..." : `Running ${name}...`;
  if (part.output === PAGE_ACTION_OUTPUT) return `Sent ${name} to the page`;
  return (
    part.output.summary ??
    (part.output.status === "failed" ? `Couldn't run ${name}` : `Ran ${name}`)
  );
}

function errorMessage(code: string | null) {
  switch (code) {
    case "sign_in_required":
      return "Sign in to chat.";
    case "message_too_long":
      return "That message is too long. Send a shorter one.";
    case "thread_busy":
      return "Wait for the reply to finish, then send your message again.";
    case "not_found":
    case "thread_deleted":
      return "This chat is not available. Start a new chat.";
    case "end_user_rate_limited":
    case "agent_daily_limit_reached":
    case "rate_limited":
      return "You have sent a lot of messages. Try again later.";
    case "out_of_credits":
    case "agent_not_found":
    case "agent_unavailable":
    case "hercules_auth_required":
    case "client_upgrade_required":
    case "invalid_request":
      // The app's setup, or its credits: not the user's to fix, and a new chat will not help.
      return "The assistant is not available right now.";
    default:
      // Hercules may add codes: keep a default.
      return "Something went wrong. Send your message again.";
  }
}
