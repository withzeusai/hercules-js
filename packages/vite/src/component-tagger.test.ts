import path from "node:path";
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

interface Fixture {
  /** Module id, relative to the working directory. */
  file: string;
  code: string;
  /** The file on disk, when an earlier plugin changed `code`. */
  source?: string;
}

// `data-hercules-id` is a contract with herculesd, which looks elements up by
// it. The snapshots hold the tagger's output from before it moved off Babel,
// and every case must keep matching them byte for byte.
const fixtures: Record<string, Fixture> = {
  page: {
    file: "src/pages/Dashboard.tsx",
    code: `import { useState } from "react";
import { Card } from "@/components/ui/card";
import * as React from "react";

type Item = { id: string; title: string; done: boolean };

export default function Dashboard({ items }: { items: Item[] }) {
  const [filter, setFilter] = useState<"all" | "done">("all");
  const visible = items.filter((item) => filter === "all" || item.done);
  return (
    <main className="flex flex-col gap-4 p-6">
      <header className={\`title \${filter}\`}>
        <h1>Dashboard</h1>
        <button type="button" onClick={() => setFilter(filter === "all" ? "done" : "all")}>
          Show {filter === "all" ? "done" : "all"}
        </button>
      </header>
      {visible.length === 0 ? (
        <p className="text-muted">Nothing here yet.</p>
      ) : (
        <ul>
          {visible.map((item) => (
            <li key={item.id} {...{ "data-done": item.done }}>
              <Card.Header>{item.title}</Card.Header>
              <React.Fragment>
                <input type="checkbox" checked={item.done} readOnly />
              </React.Fragment>
            </li>
          ))}
        </ul>
      )}
      <>
        <footer />
      </>
    </main>
  );
}
`,
  },
  typescript: {
    file: "src/components/Select.tsx",
    code: `enum Size { Small, Large }
interface Option { value: string; label: string }
const identity = <T,>(value: T) => <span>{String(value)}</span>;
function Select<T extends Option>({ options }: { options: T[] }) {
  return <select>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export const A = () => <Select<Option> options={[] satisfies Option[]} />;
export const B = () => <Select<Option>>{identity(Size.Large)}</Select>;
`,
  },
  unicode: {
    file: "src/components/Greeting.tsx",
    code: `const wave = "👋🏽 你好";
export const Greeting = () => <p title="😀">😀 <b>{wave}</b> 𝒳𝒴 <i>ok</i></p>;
// 🚀 a comment with an emoji before the next element
export const Rocket = () => <div>{/* ✨ */}<span>🚀</span><em /></div>;
`,
  },
  crlf: {
    file: "src/components/Windows.tsx",
    code: [
      'import { Button } from "@/components/ui/button";',
      "export const Windows = () => (",
      "  <section>",
      '    <Button variant="ghost">Save</Button>',
      "    <span />",
      "  </section>",
      ");",
      "",
    ].join("\r\n"),
  },
  reactThree: {
    file: "src/scene/Scene.tsx",
    code: `import { Canvas } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
function Label(props: { text: string }) {
  return <Html><div className="label">{props.text}</div></Html>;
}
export const Scene = () => (
  <div className="h-full">
    <Canvas>
      <mesh>
        <boxGeometry />
        <meshStandardMaterial color="orange" />
      </mesh>
      <Label text="box" />
      <OrbitControls />
    </Canvas>
  </div>
);
`,
  },
  names: {
    file: "src/components/Names.tsx",
    code: `import { motion } from "motion/react";
export const Names = () => (
  <svg>
    <svg:rect width={1} />
    <a.b.c />
    <motion.div animate={{ opacity: 1 }} />
    <Fragment><g /></Fragment>
  </svg>
);
`,
  },
  javascript: {
    file: "src/legacy/Widget.jsx",
    code: `export function Widget({ label }) {
  return <label htmlFor="w">{label}<input id="w" /></label>;
}
`,
  },
  routeSplit: {
    file: "src/routes/index.tsx?tsr-split=component",
    code: `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/")({ component: Home });
function Home() {
  return <div><h1>Home</h1></div>;
}
`,
  },
  devtoolsAttributes: {
    file: "src/routes/about.tsx",
    source: `export const About = () => <div><p>One</p><p>Two</p></div>;
`,
    code: `export const About = () => <div data-tsd-source="/src/routes/about.tsx:1:25"><p data-tsd-source="/src/routes/about.tsx:1:30">One</p><p data-tsd-source="/src/routes/about.tsx:1:40">Two</p></div>;
`,
  },
};

describe("ComponentTagger output", () => {
  it.each(Object.entries(fixtures))("tags %s", async (_name, fixture) => {
    const tagger = new ComponentTagger({ dataAttribute: "data-hercules-id" });
    const id = path.join(process.cwd(), fixture.file);
    const result = await tagger.transformCode(fixture.code, id, fixture.source);
    expect(result?.code).toMatchSnapshot();
  });
});
