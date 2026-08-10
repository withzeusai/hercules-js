import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { parse } from "@babel/parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteComponent, updateComponentElement } from "./ast-transformer";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hercules-editor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a single-line component; column === string index on line 1. */
async function writeComponent(source: string): Promise<string> {
  await writeFile(path.join(root, "App.tsx"), source, "utf-8");
  return source;
}

function idAt(source: string, marker: string): string {
  const column = source.indexOf(marker);
  expect(column).toBeGreaterThanOrEqual(0);
  return `App.tsx:1:${column}`;
}

async function readBack(): Promise<string> {
  return readFile(path.join(root, "App.tsx"), "utf-8");
}

function expectParses(code: string) {
  expect(() => parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] })).not.toThrow();
}

describe("updateComponentElement", () => {
  // JSX text cannot contain these raw; emitting them unescaped writes a file
  // that no longer parses, breaking the dev server on the next edit.
  it.each([
    ["a < b", "less-than"],
    ["100% {done}", "braces"],
    ["</div>", "a closing tag"],
    ['say "hi"', "quotes"],
    ["price > 5 && x", "greater-than"],
  ])("keeps the file parseable when text contains %s (%s)", async (textContent) => {
    const source = await writeComponent(`export const A = () => <div>old</div>;\n`);

    const result = await updateComponentElement(idAt(source, "<div"), { textContent }, root);

    expect(result.success).toBe(true);
    const updated = await readBack();
    expectParses(updated);
    // Written as `{"..."}`, so the text survives in its JS-escaped form
    expect(updated).toContain(JSON.stringify(textContent));
  });

  it("keeps the file parseable when className contains quotes", async () => {
    const source = await writeComponent(`export const A = () => <div>old</div>;\n`);

    const result = await updateComponentElement(
      idAt(source, "<div"),
      { className: 'w-[calc(100%-2px)] before:content-["x"]' },
      root,
    );

    expect(result.success).toBe(true);
    expectParses(await readBack());
  });

  it("writes plain text without an expression wrapper when it is safe", async () => {
    const source = await writeComponent(`export const A = () => <div>old</div>;\n`);

    await updateComponentElement(idAt(source, "<div"), { textContent: "new" }, root);

    expect(await readBack()).toContain("<div>new</div>");
  });

  // A ±5 column window matched the enclosing element, so editing the inner
  // element rewrote the outer one instead.
  it("updates the exact element when two start within five columns", async () => {
    const source = await writeComponent(`export const A = () => <div><span>old</span></div>;\n`);

    const result = await updateComponentElement(
      idAt(source, "<span"),
      { textContent: "new" },
      root,
    );

    expect(result.success).toBe(true);
    const updated = await readBack();
    expect(updated).toContain("<span>new</span>");
    expect(updated).toContain("<div>");
  });

  it("does not match an element at a nearby column", async () => {
    const source = await writeComponent(`export const A = () => <div><span>old</span></div>;\n`);
    const nearby = `App.tsx:1:${source.indexOf("<span") + 2}`;

    const result = await updateComponentElement(nearby, { textContent: "new" }, root);

    expect(result.success).toBe(false);
    expect(await readBack()).toBe(source);
  });

  it("refuses a component ID that escapes the project root", async () => {
    const outside = path.join(root, "outside.tsx");
    await writeFile(outside, `export const B = () => <div>keep</div>;\n`, "utf-8");
    const nested = path.join(root, "nested");
    await mkdtemp(nested);

    const result = await updateComponentElement(
      "../outside.tsx:1:23",
      { textContent: "pwned" },
      path.join(root, "nested"),
    );

    expect(result).toEqual({
      success: false,
      error: "Component ID resolves outside the project root",
    });
    expect(await readFile(outside, "utf-8")).toContain("keep");
  });
});

describe("deleteComponent", () => {
  it("deletes the exact element when two start within five columns", async () => {
    const source = await writeComponent(`export const A = () => <div><span>gone</span></div>;\n`);

    const result = await deleteComponent(idAt(source, "<span"), root);

    expect(result.success).toBe(true);
    const updated = await readBack();
    expectParses(updated);
    expect(updated).not.toContain("<span");
    expect(updated).toContain("<div>");
  });

  it("refuses a component ID that escapes the project root", async () => {
    const result = await deleteComponent("../../../etc/hosts:1:0", root);

    expect(result.success).toBe(false);
  });
});
