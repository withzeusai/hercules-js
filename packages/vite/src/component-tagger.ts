import { readFile } from "fs/promises";
import path from "path";
import { parse as babelParse } from "@babel/parser";
// Named, not default: magic-string is ESM-only, and the CJS build's interop
// hands require()'s whole namespace back as `default`.
import { MagicString } from "magic-string";
import type { Plugin, Rolldown } from "vite";

// Types
export interface ComponentTaggerOptions {
  enabled?: boolean;
  debug?: boolean;
  /**
   * The data attribute to use for element identification
   * @default "data-component-id"
   */
  dataAttribute?: string;
}

// Keep: Three.js Fiber elements that should not be tagged
const threeFiberElems = new Set([
  "object3D",
  "audioListener",
  "positionalAudio",
  "mesh",
  "batchedMesh",
  "instancedMesh",
  "scene",
  "sprite",
  "lOD",
  "skinnedMesh",
  "skeleton",
  "bone",
  "lineSegments",
  "lineLoop",
  "points",
  "group",
  "camera",
  "perspectiveCamera",
  "orthographicCamera",
  "cubeCamera",
  "arrayCamera",
  "instancedBufferGeometry",
  "bufferGeometry",
  "boxBufferGeometry",
  "circleBufferGeometry",
  "coneBufferGeometry",
  "cylinderBufferGeometry",
  "dodecahedronBufferGeometry",
  "extrudeBufferGeometry",
  "icosahedronBufferGeometry",
  "latheBufferGeometry",
  "octahedronBufferGeometry",
  "planeBufferGeometry",
  "polyhedronBufferGeometry",
  "ringBufferGeometry",
  "shapeBufferGeometry",
  "sphereBufferGeometry",
  "tetrahedronBufferGeometry",
  "torusBufferGeometry",
  "torusKnotBufferGeometry",
  "tubeBufferGeometry",
  "wireframeGeometry",
  "tetrahedronGeometry",
  "octahedronGeometry",
  "icosahedronGeometry",
  "dodecahedronGeometry",
  "polyhedronGeometry",
  "tubeGeometry",
  "torusKnotGeometry",
  "torusGeometry",
  "sphereGeometry",
  "ringGeometry",
  "planeGeometry",
  "latheGeometry",
  "shapeGeometry",
  "extrudeGeometry",
  "edgesGeometry",
  "coneGeometry",
  "cylinderGeometry",
  "circleGeometry",
  "boxGeometry",
  "capsuleGeometry",
  "material",
  "shadowMaterial",
  "spriteMaterial",
  "rawShaderMaterial",
  "shaderMaterial",
  "pointsMaterial",
  "meshPhysicalMaterial",
  "meshStandardMaterial",
  "meshPhongMaterial",
  "meshToonMaterial",
  "meshNormalMaterial",
  "meshLambertMaterial",
  "meshDepthMaterial",
  "meshDistanceMaterial",
  "meshBasicMaterial",
  "meshMatcapMaterial",
  "lineDashedMaterial",
  "lineBasicMaterial",
  "primitive",
  "light",
  "spotLightShadow",
  "spotLight",
  "pointLight",
  "rectAreaLight",
  "hemisphereLight",
  "directionalLightShadow",
  "directionalLight",
  "ambientLight",
  "lightShadow",
  "ambientLightProbe",
  "hemisphereLightProbe",
  "lightProbe",
  "spotLightHelper",
  "skeletonHelper",
  "pointLightHelper",
  "hemisphereLightHelper",
  "gridHelper",
  "polarGridHelper",
  "directionalLightHelper",
  "cameraHelper",
  "boxHelper",
  "box3Helper",
  "planeHelper",
  "arrowHelper",
  "axesHelper",
  "texture",
  "videoTexture",
  "dataTexture",
  "dataTexture3D",
  "compressedTexture",
  "cubeTexture",
  "canvasTexture",
  "depthTexture",
  "raycaster",
  "vector2",
  "vector3",
  "vector4",
  "euler",
  "matrix3",
  "matrix4",
  "quaternion",
  "bufferAttribute",
  "float16BufferAttribute",
  "float32BufferAttribute",
  "float64BufferAttribute",
  "int8BufferAttribute",
  "int16BufferAttribute",
  "int32BufferAttribute",
  "uint8BufferAttribute",
  "uint16BufferAttribute",
  "uint32BufferAttribute",
  "instancedBufferAttribute",
  "color",
  "fog",
  "fogExp2",
  "shape",
  "colorShiftMaterial",
]);

// Keep: Check if element should be tagged
function shouldTagElement(
  elementName: string,
  importsReactThree: boolean,
  fiberImports: Set<string>,
  googleMapsImports: Set<string>,
): boolean {
  if (threeFiberElems.has(elementName)) {
    return false;
  }
  // @vis.gl/react-google-maps components never put these attributes in the
  // DOM, and <Pin> passes every prop to the PinElement constructor, which
  // throws "Unknown property 'data-hercules-id'" and blanks the page.
  if (googleMapsImports.has(elementName.split(".")[0]!)) {
    return false;
  }
  // In a file that imports @react-three/*, any component (a name that is not a
  // lowercase intrinsic, such as drei or a wrapper spreading props into <mesh>)
  // may render into the R3F reconciler, which throws on data-* props. Only
  // fiber's own Canvas renders DOM.
  if (importsReactThree && !/^[a-z][^.]*$/.test(elementName)) {
    return fiberImports.has(elementName.split(".")[0]!);
  }
  return true;
}

// Constants
const validExtensions = new Set([".jsx", ".tsx"]);

// TanStack Router's code splitter loads each route component from a virtual
// module, `routes/index.tsx?tsr-split=component`, and the module-level bindings
// the pieces share from `routes/index.tsx?tsr-shared=1`. Both carry the route
// file's own source, so they are tagged as that file.
const routeSplitParams = new Set(["tsr-split", "tsr-shared"]);

/**
 * The source file a module id is tagged as, or null when the id is not a JSX
 * source file. Ids with any other query (`?raw`, `?url`) are left alone.
 */
export function taggableFilePath(id: string): string | null {
  const queryStart = id.indexOf("?");
  const filePath = queryStart === -1 ? id : id.slice(0, queryStart);
  if (queryStart !== -1) {
    const params = [...new URLSearchParams(id.slice(queryStart + 1)).keys()];
    if (params.length === 0 || !params.every((param) => routeSplitParams.has(param))) {
      return null;
    }
  }
  if (!validExtensions.has(path.extname(filePath)) || filePath.includes("node_modules")) {
    return null;
  }
  return filePath;
}

/**
 * Parses a `.jsx` or `.tsx` module into an ESTree-shaped tree whose nodes carry
 * `start` and `end` as UTF-16 offsets into the code, the indices MagicString
 * and JavaScript strings use. Both parsers below accept TypeScript in either
 * extension, so the two kinds of file are tagged alike.
 */
export type ParseModule = (code: string) => unknown;

export const parseWithBabel: ParseModule = (code) =>
  babelParse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

/**
 * The parser Vite already runs. Rolldown (Vite 8) parses TSX with Oxc and
 * reports the same offsets as Babel; Rollup's parser (Vite 7) has no
 * TypeScript support, so Vite 7 keeps Babel.
 */
function parserOf(context: Rolldown.PluginContext): ParseModule {
  if (!context.meta.rolldownVersion) {
    return parseWithBabel;
  }
  return (code) => context.parse(code, { lang: "tsx", sourceType: "module" });
}

/**
 * Turns UTF-16 offsets into 1-based lines and 0-based columns, counting line
 * breaks as JavaScript does (`\n`, `\r\n`, `\r`, U+2028, U+2029), like Babel's
 * `loc`.
 */
function lineLocator(code: string): (offset: number) => { line: number; col: number } {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) {
    const char = code.charCodeAt(i);
    if (char === 0x0d && code.charCodeAt(i + 1) === 0x0a) {
      i++;
      lineStarts.push(i + 1);
    } else if (char === 0x0a || char === 0x0d || char === 0x2028 || char === 0x2029) {
      lineStarts.push(i + 1);
    }
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { line: low + 1, col: offset - lineStarts[low]! };
  };
}

function openingElementName(node: any): string | null {
  if (node.name.type === "JSXIdentifier") {
    return node.name.name;
  }
  if (node.name.type === "JSXMemberExpression") {
    return `${node.name.object.name}.${node.name.property.name}`;
  }
  return null;
}

interface ElementPosition {
  name: string | null;
  line: number;
  col: number;
}

/**
 * The name and start of every JSX opening element in `code`, in walk order.
 */
async function openingElementPositions(
  code: string,
  parse: ParseModule,
): Promise<ElementPosition[]> {
  const ast = parse(code);
  const locate = lineLocator(code);
  const { walk } = await import("estree-walker");
  const positions: ElementPosition[] = [];
  walk(ast as any, {
    enter(node: any) {
      if (node.type === "JSXOpeningElement") {
        positions.push({ name: openingElementName(node), ...locate(node.start) });
      }
    },
  });
  return positions;
}

/**
 * Element positions taken from the source file when `code` has the same JSX
 * elements in the same order, or null when it does not. A plugin that runs
 * before this one can insert text into the file's code: TanStack devtools adds
 * a `data-tsd-source` attribute to every opening tag, which moves each later
 * element on the same line to the right. The editor looks elements up in the
 * file on disk, so their ids must carry the file's columns.
 */
async function sourcePositions(
  code: string,
  source: string,
  parse: ParseModule,
): Promise<ElementPosition[] | null> {
  const [fromCode, fromSource] = await Promise.all([
    openingElementPositions(code, parse),
    openingElementPositions(source, parse),
  ]);
  if (fromCode.length !== fromSource.length) {
    return null;
  }
  for (let i = 0; i < fromCode.length; i++) {
    if (fromCode[i]!.name !== fromSource[i]!.name) {
      return null;
    }
  }
  return fromSource;
}

export interface TransformOptions {
  /** The file on disk. When given, ids carry its line and column instead of those of the code. */
  source?: string;
  /** @default parseWithBabel */
  parse?: ParseModule;
}

export class ComponentTagger {
  private cwd = process.cwd();
  private dataAttribute: string;

  constructor(private options: ComponentTaggerOptions = {}) {
    this.dataAttribute = options.dataAttribute || "data-component-id";
  }

  /**
   * Tags the JSX elements of `code` with `<dataAttribute>="<file>:<line>:<column>"`
   * and `data-hercules-name`.
   */
  async transformCode(
    code: string,
    id: string,
    { source, parse = parseWithBabel }: TransformOptions = {},
  ): Promise<{ code: string; map: any } | null> {
    const filePath = taggableFilePath(id);
    if (!filePath) {
      return null;
    }

    const relativePath = path.relative(this.cwd, filePath) || filePath;

    try {
      const ast = parse(code);
      const locate = lineLocator(code);
      const positions =
        source === undefined || source === code ? null : await sourcePositions(code, source, parse);
      let elementIndex = 0;
      const magicString = new MagicString(code);
      let changedElementsCount = 0;
      let importsReactThree = false;
      const fiberImports = new Set<string>();
      const googleMapsImports = new Set<string>();

      // Dynamic import estree-walker
      const { walk } = await import("estree-walker");

      // First pass: find @react-three/* and @vis.gl/react-google-maps imports
      walk(ast as any, {
        enter(node) {
          if (node.type === "ImportDeclaration") {
            const source = node.source?.value;
            if (typeof source === "string" && source.startsWith("@react-three/")) {
              importsReactThree = true;
              if (source === "@react-three/fiber") {
                node.specifiers.forEach((spec) => fiberImports.add(spec.local.name));
              }
            }
            if (source === "@vis.gl/react-google-maps") {
              node.specifiers.forEach((spec) => googleMapsImports.add(spec.local.name));
            }
          }
        },
      });

      // Capture dataAttribute for use in the walker
      const dataAttribute = this.dataAttribute;

      // Second pass: tag elements
      walk(ast as any, {
        enter(node: any) {
          if (node.type === "JSXOpeningElement") {
            const jsxNode = node;
            const position = positions?.[elementIndex];
            elementIndex++;
            const elementName = openingElementName(jsxNode);
            if (elementName === null) {
              return;
            }

            // Skip fragments
            if (elementName === "Fragment" || elementName === "React.Fragment") {
              return;
            }

            const { line, col } = position ?? locate(jsxNode.start);
            const dataComponentId = `${relativePath}:${line}:${col}`;

            const shouldTag = shouldTagElement(
              elementName,
              importsReactThree,
              fiberImports,
              googleMapsImports,
            );

            if (shouldTag) {
              // Insert after the tag name, or after its type arguments in
              // `<Foo<Bar>>`: an attribute between them is a syntax error
              const endPosition = (jsxNode.typeArguments ?? jsxNode.name).end ?? 0;

              // Build the attributes string
              let attributesString = ` ${dataAttribute}="${dataComponentId}" data-hercules-name="${elementName}"`;

              magicString.appendLeft(endPosition, attributesString);
              changedElementsCount++;
            }
          }
        },
      });

      if (this.options.debug) {
        console.log(
          `[Component Tagger] Processed ${relativePath}: ${changedElementsCount} elements`,
        );
      }

      return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true }),
      };
    } catch (error) {
      console.error(`Error processing file ${relativePath}:`, error);
      return null;
    }
  }
}

// Export Vite plugin for component tagging
export function componentTaggerPlugin(options: ComponentTaggerOptions = {}): Plugin {
  const tagger = new ComponentTagger(options);

  return {
    name: "vite-plugin-hercules-component-tagger",
    enforce: "pre",
    // Dev-server only: tagging is editor tooling, and published sites must
    // ship no Hercules identifiers in their markup
    apply: "serve",

    // TanStack route split modules are tagged when they load, from the route
    // file on disk. In `transform` they may already be regenerated by the
    // router plugin (when it is listed before this one), and line and column
    // taken from that code would point at the wrong element of the route file.
    async load(id) {
      const filePath = taggableFilePath(id);
      if (!filePath || filePath === id) {
        return null;
      }
      return tagger.transformCode(await readFile(filePath, "utf8"), id, { parse: parserOf(this) });
    },

    // Plugins listed earlier may have changed the code already (TanStack
    // devtools adds an attribute to every element), so ids take their line and
    // column from the file on disk.
    async transform(code, id) {
      if (taggableFilePath(id) !== id) {
        return null;
      }
      const source = await readFile(id, "utf8").catch(() => undefined);
      return tagger.transformCode(code, id, { source, parse: parserOf(this) });
    },
  };
}
