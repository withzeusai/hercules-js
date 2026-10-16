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
});
