import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeElement } from "./ast-analyzer";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hercules-analyzer-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function analyze(source: string, marker: string) {
  await writeFile(path.join(root, "App.tsx"), source, "utf-8");
  const column = source.indexOf(marker);
  expect(column).toBeGreaterThanOrEqual(0);
  return analyzeElement(`App.tsx:1:${column}`, root);
}

describe("analyzeElement", () => {
  it("reports a static className and text content", async () => {
    const result = await analyze(`export const A = () => <div className="p-4">hi</div>;\n`, "<div");

    expect(result.success).toBe(true);
    expect(result.className).toEqual({ type: "static", value: "p-4" });
    expect(result.textContent).toEqual({ type: "static", value: "hi" });
  });

  it("reports a dynamic className", async () => {
    const result = await analyze(`export const A = () => <div className={cx(a)}>hi</div>;\n`, "<div");

    expect(result.className).toEqual({ type: "dynamic" });
  });

  // The safety walk used node.parent, which Babel does not set, so it stopped
  // after one hop and called everything safe to delete.
  it("detects an element nested inside .map()", async () => {
    const result = await analyze(
      `export const A = ({ items }) => <ul>{items.map((i) => <li>{i}</li>)}</ul>;\n`,
      "<li",
    );

    expect(result.success).toBe(true);
    expect(result.elementType).toEqual({ type: "dynamic", reason: "map-expression" });
  });

  it("detects an element inside a ternary", async () => {
    const result = await analyze(
      `export const A = ({ on }) => <div>{on ? <b>y</b> : null}</div>;\n`,
      "<b",
    );

    expect(result.elementType).toEqual({ type: "dynamic", reason: "conditional-expression" });
  });

  it("detects an element behind a logical guard", async () => {
    const result = await analyze(`export const A = ({ on }) => <div>{on && <b>y</b>}</div>;\n`, "<b");

    expect(result.elementType).toEqual({ type: "dynamic", reason: "complex-parent" });
  });

  it("treats a plainly nested element as safe to delete", async () => {
    const result = await analyze(`export const A = () => <div><b>y</b></div>;\n`, "<b");

    expect(result.elementType).toEqual({ type: "static" });
  });

  it("selects the exact element when two start within five columns", async () => {
    const result = await analyze(
      `export const A = () => <div className="outer"><b className="inner">y</b></div>;\n`,
      "<b",
    );

    expect(result.className).toEqual({ type: "static", value: "inner" });
  });

  it("refuses a component ID that escapes the project root", async () => {
    const result = await analyzeElement("../../../etc/hosts:1:0", root);

    expect(result).toEqual({
      success: false,
      componentId: "../../../etc/hosts:1:0",
      error: "Component ID resolves outside the project root",
    });
  });
});
