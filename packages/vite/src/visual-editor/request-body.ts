import type { IncomingMessage } from "http";

export type RequestRejection = { status: number; message: string };

/** Cap on the JSON body, so a stray request cannot grow the heap unbounded. */
export const MAX_BODY_BYTES = 1024 * 1024;

export type JsonBodyResult =
  | { ok: true; value: any }
  | { ok: false; rejection: RequestRejection };

/**
 * Read a JSON request body with a size limit. Rejects with a `RequestRejection`
 * rather than throwing so callers can turn it straight into a response.
 */
export function readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    let chunks: Buffer[] = [];
    let overflowed = false;
    let settled = false;

    const settle = (result: JsonBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drop what we hold and keep draining rather than destroying the
        // request: tearing down the socket here kills the connection before
        // the caller can write the 413, leaving the client with a reset.
        overflowed = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () =>
      settle({ ok: false, rejection: { status: 400, message: "Failed to read request body" } }),
    );

    req.on("end", () => {
      if (overflowed) {
        settle({ ok: false, rejection: { status: 413, message: "Request body too large" } });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
      } catch {
        settle({ ok: false, rejection: { status: 400, message: "Invalid JSON body" } });
      }
    });
  });
}
