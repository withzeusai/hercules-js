import type { IncomingMessage } from "http";
import { Readable } from "stream";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readJsonBody } from "./request-body";

function bodyStream(...chunks: string[]): IncomingMessage {
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as unknown as
    IncomingMessage;
  stream.destroy = (() => stream) as IncomingMessage["destroy"];
  return stream;
}

describe("readJsonBody", () => {
  it("parses a JSON body", async () => {
    const result = await readJsonBody(bodyStream('{"componentId":"src/App.tsx:1:0"}'));

    expect(result).toEqual({ ok: true, value: { componentId: "src/App.tsx:1:0" } });
  });

  it("reassembles a body split across chunks", async () => {
    const result = await readJsonBody(bodyStream('{"a"', ":1", "}"));

    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("handles multi-byte characters split across chunk boundaries", async () => {
    const encoded = Buffer.from('{"t":"né"}');
    const stream = Readable.from([
      encoded.subarray(0, 8),
      encoded.subarray(8),
    ]) as unknown as IncomingMessage;
    stream.destroy = (() => stream) as IncomingMessage["destroy"];

    expect(await readJsonBody(stream)).toEqual({ ok: true, value: { t: "né" } });
  });

  it("rejects invalid JSON", async () => {
    const result = await readJsonBody(bodyStream("not json"));

    expect(result).toEqual({
      ok: false,
      rejection: { status: 400, message: "Invalid JSON body" },
    });
  });

  it("rejects a body over the size cap", async () => {
    const result = await readJsonBody(bodyStream("x".repeat(MAX_BODY_BYTES + 1)));

    expect(result).toEqual({
      ok: false,
      rejection: { status: 413, message: "Request body too large" },
    });
  });
});
