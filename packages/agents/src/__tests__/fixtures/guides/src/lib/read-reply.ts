// src/lib/read-reply.ts
import { followRun } from "@usehercules/agents";

// `live` is the thread's `activeRun.live`: the run's URL and its read-only token.
export async function readReply(live: { url: string; token: string }) {
  let text = "";
  for await (const event of followRun({ url: live.url, token: live.token })) {
    if (event.type === "message.delta") text += event.data.text;
    if (event.type === "message.completed") {
      // The whole reply: it replaces the text the deltas built.
      text = event.data.message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    }
  }
  return text;
}
