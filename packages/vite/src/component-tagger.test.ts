import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { ComponentTagger } from "./component-tagger";

async function tag(code: string): Promise<string> {
  const result = await new ComponentTagger().transformCode(code, "/app/src/App.tsx");
  return result!.code;
}

describe("ComponentTagger", () => {
  it.each(["<Foo<Bar> a={1} />", "<Foo<Bar>>child</Foo>"])(
    "tags %s after its type arguments",
    async (element) => {
      const output = await tag(`const el = ${element};`);

      expect(output).toContain("<Foo<Bar> data-component-id=");
      expect(() =>
        parse(output, { sourceType: "module", plugins: ["jsx", "typescript"] }),
      ).not.toThrow();
    },
  );

  it("skips R3F intrinsics named like DOM elements in an R3F file", async () => {
    const output = await tag(`import { Canvas } from "@react-three/fiber";
const el = (
  <Canvas>
    <line />
    <path />
    <audio />
    <source />
  </Canvas>
);`);

    expect(output).toContain('data-hercules-name="Canvas"');
    expect(output).not.toMatch(/data-hercules-name="(line|path|audio|source)"/);
  });

  it("tags DOM elements with those names outside R3F files", async () => {
    const output = await tag(`const el = (
  <svg>
    <line />
    <path />
  </svg>
);`);

    expect(output).toContain('data-hercules-name="line"');
    expect(output).toContain('data-hercules-name="path"');
  });
});
