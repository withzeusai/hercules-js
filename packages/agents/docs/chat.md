# The chat

How to put an agent's chat in a page of a Convex app: with TanStack AI and
`herculesConnection` from `@usehercules/agents/tanstack`, or with
`useAgentThread` from `@usehercules/agents/react` and no TanStack.

The [README](../README.md) is the reference: every export, option, default
and limit, and what the package promises under "Versioning". This guide
shows how to use them and adds no promise of its own. Where it describes
what Hercules does, that is for context, and is Hercules's to define.

The other guides: [The Convex side](./convex.md), [App tools](./tools.md) and
[Events, limits and errors](./events-and-errors.md).

## Before you start

- Set up the backend first, with the functions `support.api()` exports from
  `convex/agent.ts`: see [The Convex side](./convex.md).
- For the TanStack path, the app installs TanStack AI itself:

  ```sh
  npm install @usehercules/agents @tanstack/ai @tanstack/ai-client @tanstack/ai-react
  ```

  The versions the package takes are under "In the page, with TanStack AI" in
  the README.

- The chat is for signed-in users. Mount it once Convex knows who is asking.
  Without a signed-in user every message fails with `sign_in_required`.
- No key reaches the browser. The page calls the app's Convex functions, and
  streams the reply from Hercules with a token that reads that one run and
  nothing else.

## A complete chat

The chat in the README is the smallest one that works. This one is what a
finished chat needs on top of it: a Stop that also works for a run another
tab started, the user's text put back when a message is not sent, a note
under a reply that was stopped, a note for a page action that came too late,
a line for each tool call, and words for each error code.

<!-- sample: src/components/agent-chat.tsx -->

```tsx
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
```

What the README does not say of it:

- **`running` comes from the thread as well as from `chat.isLoading`.** A
  stopped run takes a moment to end, and `thread.activeRun.stopping` is
  `true` until it has. It is also how a tab shows a run another tab started.
  A run can stay unfinished for a long time, so the chat never times one
  out: while `thread.activeRun` is set the run is going, and the chat keeps
  Stop.
- **Stop and Send are two buttons**, and Send stays disabled while a run goes
  on. One button that turns from Stop into Send submits the typed text when
  the run ends during a click.
- **`stop` cancels a run this page is not streaming** with the app's `cancel`
  mutation. `chat.stop()` alone stops only a run this page streams.
- **`onError` puts the user's text back** in the box when a message is
  refused or its run fails.
- **"Stopped." and "Stopped before it finished." are two cases.** A stopped
  run's reply is kept as far as it was written, and the thread holds it as
  `completed`: the chat shows that text with "Stopped." under it, live and
  after a reload. When the thread got less of a reply than the page
  streamed, the page's text stays, with `metadata.hercules.messageStatus` set
  to `"incomplete"`.
- **`thread.latestRun` outlives a reload**, and `chat.error` does not. So
  after a reload the chat still shows "Stopped.", or why a message got no
  reply. The thread keeps that for its latest run only.
- **Keep the chat mounted while the user is signed in.** In a launcher, hide
  the closed panel with the `hidden` attribute instead of unmounting it: the
  connection holds the reply's stream, and runs page actions, only while the
  chat is mounted.
- **Build the connection inside the component**, from `useConvex()`: that is
  the client the app's Convex provider signs in.

"Context, errors and progress" in the README has the rest: what
`chat.error` holds, how a run another tab started shows, and why there is no
regenerate.

## The thread behind the chat

- With `persistence: true` the chat reads the thread from Convex when it
  mounts, and rejoins a reply that is still being written.
- `useThreadSync(chat, api.agent.thread, { threadId, limit? })` keeps the chat
  in step with the thread, and returns it, as the app's `thread` query does.
  Pass `"skip"` in place of the arguments to read nothing.
- It reads the thread's newest messages: as many as `limit` says, up to the
  most one read returns. See "Defaults and limits" in the README. There is
  no way to page to older messages yet.
- `herculesConnection` returns a TanStack AI connection. `useChat` calls its
  `connect`, `hydrate`, `joinRun` and `cancelRun`, and the page calls its
  `setPageActions`.

## Which thread the chat opens

The one `AgentChat` is given. Use a new `crypto.randomUUID()` for a new chat:
the first message opens the thread under that id. Keep the id where the page
finds it again, so that a reload opens the same chat:

- On a chat page, keep it in the route (`/chat/$threadId`) or a search
  parameter.
- In a chat launcher, keep it in state: `useState(() => crypto.randomUUID())`.
- For a "New chat" button, make a new `crypto.randomUUID()`.

A new thread's id has to be made at random: see "Methods" in the README for
the forms `send` takes. A thread answers only to the user who opened it. For
anyone else `thread` reads `null`, and a message to it fails with
`not_found`. A deleted thread's id is retired: a message to it fails with
`thread_deleted`, so start the next chat under a new id.

To show a user their past chats, save each thread's id with the user in the
backend: see "Keeping a list of a user's chats" in
[The Convex side](./convex.md#keeping-a-list-of-a-users-chats).

## Sending what is on the page

Send named JSON values about the page with a message, as `send` does above
with `{ body: { context } }`. The agent reads them with the user's text, and
they count toward the message's length limit.

Send the user's time zone, and tell the agent in its instructions to use it.
Tools return times in UTC and a page shows local time, so an agent that does
not know the zone can name a different day than the page does.

## Showing tool calls

Render tool calls in the `message` component, as `ChatMessage` does above.
The agent also calls tools the page does not know, such as Hercules's own,
and the kit's `toolsComponents` shows only the tools it names.

- A tool call's `part.output` is `undefined` while the tool runs. Once the
  call ends it is `{ kind, status, summary }`, a `HerculesToolOutput`, or
  `"sent to the page"` (`PAGE_ACTION_OUTPUT`) for a page action.
- Show one line for each call, as `toolLine` does: its name while it runs,
  and its `summary` when it is done. The thread keeps tool calls, so the
  lines are still there after a reload.
- By default the page does not learn which of Hercules's tools the agent
  used, and no tool call carries its result: see "What the page sees of
  tools" in the README.
- Do not pass `tools` to `useChat`, and do not write a TanStack client tool
  for the agent. The agent calls only the tools Hercules gives it: Hercules's
  own, the app's tools, and the page actions declared on the agent.

## Page actions

A page action lets the agent act on the page: open an order, fill in a form.
It is one-way. The agent's call completes at once, the run carries on, and
the page runs the action. Three places have to agree on its name:

1. **The agent declares it**, in Hercules: a name, a description, and a JSON
   Schema for its arguments. Hercules checks every call's arguments against
   that schema before it sends anything. A call that does not match fails:
   the agent reads what was wrong and can call again, and nothing reaches
   the page.
2. **The page has a handler for it.** "Page actions" in the README shows one,
   and says what a handler may do with its arguments. Arguments that passed
   the schema are still untrusted input: a model wrote them.
3. **The backend lists it**, in `pageActions` in `convex/agent.ts`, and
   exports `claimPageAction`.

In `convex/agent.ts`:

<!-- excerpt: convex/agent.ts -->

```ts
export const support: HerculesAgents = new HerculesAgents(components.herculesAgents, {
  agentId: "01JDX5ZQ8W3J2K6M9N4P7R1S0T",
  onRunFinished: internal.orders.onAgentRunFinished,
  // Only names the agent declares.
  pageActions: ["open_order"],
});
```

A name that `pageActions` lists and the agent does not declare makes every
run fail with `invalid_request`.

When one runs:

- A page action runs when Hercules has delivered it to the app, a moment
  after it shows in the chat. One open tab claims it and calls the handler.
- It can be claimed until it expires: the page-action expiry, under "Defaults
  and limits" in the README. One that arrives while no tab has the chat open
  runs if the user opens the chat in that time.
- One that came too late is never run. The thread lists it in `pageActions`
  with `status: "expired"` for a while, so the page can tell the user, as
  `SignedInChat` does above.
- The chat shows the call as a finished tool call. What the handler returns
  goes nowhere, and the agent never waits for the page. A change to the
  app's data belongs in an [app tool](./tools.md).

### Changing page actions in an app that is live

The pages, the backend and the agent change at different moments:

- A change to the agent, or to `pageActions` in the backend, is live as soon
  as it is saved or deployed. In an app Hercules hosts, the preview and the
  published app share one backend.
- A change to the pages, a handler among them, is live when the pages are
  published.

The agent can call a page action as soon as a run lists it. A page with no
handler for it does nothing, and no one sees an error. So change one in an
order that never leaves the published pages behind:

- **To add one**, declare it on the agent and write its handler, publish the
  pages, then list it in `pageActions`.
- **To rename one**, first publish a handler that answers to both names. Then
  add the new name beside the old one, on the agent and then in
  `pageActions`. Then change the agent's instructions to the new name.
  Remove the old name last.
- **To remove one**, take it out of `pageActions` and out of the pages,
  publish, then remove it from the agent.

## Without TanStack

`useAgentThread` from `@usehercules/agents/react` is a plain React hook. It
takes what Convex's own `useQuery` and `useMutation` return, and gives back
the thread's messages with the reply streamed in:

<!-- sample: src/components/support-chat.tsx -->

```tsx
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
```

It takes:

| Option            | What it is                                                                |
| ----------------- | ------------------------------------------------------------------------- |
| `threadId`        | The thread on the page, or `null` before its first message                |
| `thread`          | `useQuery(api.agent.thread, ...)`: `undefined` while it loads             |
| `send`            | `useMutation(api.agent.send)`                                             |
| `cancel`          | `useMutation(api.agent.cancel)`. Without it, `chat.cancel()` does nothing |
| `claimPageAction` | `useMutation(api.agent.claimPageAction)`. Without it, no page action runs |
| `pageActions`     | The page's handlers, by name                                              |
| `fetch`           | The `fetch` that reads a run's live stream                                |

It returns:

| Field      | What it is                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `messages` | The thread's messages, with the reply still being written streamed in until it is complete                             |
| `status`   | `loading`, `ready`, `submitted` or `streaming`. Enable sending on `ready` alone                                        |
| `send`     | `send(text, { context? })` sends the user's message. Resolves to `{ threadId, runId }`, or `null` when it was not sent |
| `cancel`   | `cancel()` stops the reply                                                                                             |
| `error`    | An `AgentError`, a `RunStreamError`, any other `Error`, or `null`: see "In React, without TanStack" in the README      |

- Pass `threadId`. Left out, the hook takes it from `thread`, so a message
  sent while the query is still loading opens a new thread.
- The hook takes page actions from `thread.pageActions` and runs the
  `pending` ones. Read the `expired` ones from the thread to tell the user.
- Use it for a small widget, or when the app would rather not add TanStack AI.

## Questions

**Does the browser talk to Hercules?** Only to stream a run's reply, with a
token that reads that one run. Starting a run, stopping it and reading the
thread all go through the app's Convex functions, which hold the app's key.

**Why does the next message fail with `thread_busy`?** See "Questions" in
[The Convex side](./convex.md#questions).

**Which words go with which error code?** `errorMessage` above has a line
for each. "Error codes" in
[Events, limits and errors](./events-and-errors.md#error-codes) says what
each means and what to do about it.
