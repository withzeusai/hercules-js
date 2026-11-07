import { devtools } from "@tanstack/devtools-vite";
import { describe, expect, it } from "vitest";
import { skipReactThreeSourceInjection } from "./skip-react-three-source";

async function injectSource(code: string): Promise<string | undefined> {
  const plugin = skipReactThreeSourceInjection(devtools()).find(
    (p) => p.name === "@tanstack/devtools:inject-source",
  );
  const transform = plugin?.transform;
  if (!transform || typeof transform === "function") {
    throw new Error("devtools inject-source transform not found");
  }
  const result = await transform.handler.call({} as never, code, "/app/src/scene.tsx");
  return result ? String(typeof result === "object" ? result.code : result) : undefined;
}

describe("skipReactThreeSourceInjection", () => {
  it("leaves files that import @react-three/* untouched", async () => {
    const code = `import { Canvas } from "@react-three/fiber";
export function Scene() {
  return <Canvas><mesh><boxGeometry /><meshStandardMaterial /></mesh></Canvas>;
}`;
    expect(await injectSource(code)).toBeUndefined();
  });

  it("still injects the source into other files", async () => {
    const code = `export function Card() {
  return <div><p>Hi</p></div>;
}`;
    expect(await injectSource(code)).toContain("data-tsd-source=");
  });
});
