import { readFile } from "fs/promises";
import path from "path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import type { Plugin, ViteDevServer } from "vite";

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

export interface ComponentTaggerStats {
  totalFiles: number;
  processedFiles: number;
  totalElements: number;
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
): boolean {
  if (threeFiberElems.has(elementName)) {
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
const isSandbox = process.env.HERCULES_DEV_SERVER === "true";

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

export class ComponentTagger {
  private stats: ComponentTaggerStats = {
    totalFiles: 0,
    processedFiles: 0,
    totalElements: 0,
  };
  private cwd = process.cwd();
  private dataAttribute: string;

  constructor(private options: ComponentTaggerOptions = {}) {
    this.dataAttribute = options.dataAttribute || "data-component-id";
  }

  async transformCode(code: string, id: string): Promise<{ code: string; map: any } | null> {
    const filePath = taggableFilePath(id);
    if (!filePath) {
      return null;
    }

    this.stats.totalFiles++;
    const relativePath = path.relative(this.cwd, filePath) || filePath;

    try {
      const parserOptions = {
        sourceType: "module" as const,
        plugins: ["jsx", "typescript"] as any,
      };

      const ast = parse(code, parserOptions);
      const magicString = new MagicString(code);
      let changedElementsCount = 0;
      let importsReactThree = false;
      const fiberImports = new Set<string>();

      // Dynamic import estree-walker
      const { walk } = await import("estree-walker");

      // First pass: find @react-three/* imports
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
            let elementName: string;

            if (jsxNode.name.type === "JSXIdentifier") {
              elementName = jsxNode.name.name;
            } else if (jsxNode.name.type === "JSXMemberExpression") {
              const memberExpr = jsxNode.name;
              elementName = `${memberExpr.object.name}.${memberExpr.property.name}`;
            } else {
              return;
            }

            // Skip fragments
            if (elementName === "Fragment" || elementName === "React.Fragment") {
              return;
            }

            const line = jsxNode.loc?.start?.line ?? 0;
            const col = jsxNode.loc?.start?.column ?? 0;
            const dataComponentId = `${relativePath}:${line}:${col}`;

            const shouldTag = shouldTagElement(elementName, importsReactThree, fiberImports);

            if (shouldTag) {
              // Only add the new data attributes (no legacy)
              const endPosition = jsxNode.name.end ?? 0;

              // Build the attributes string
              let attributesString = ` ${dataAttribute}="${dataComponentId}" data-hercules-name="${elementName}"`;

              magicString.appendLeft(endPosition, attributesString);
              changedElementsCount++;
            }
          }
        },
      });

      this.stats.processedFiles++;
      this.stats.totalElements += changedElementsCount;

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
      this.stats.processedFiles++;
      return null;
    }
  }

  getStats(): ComponentTaggerStats {
    return { ...this.stats };
  }

  // Tailwind v4 configuration handling
  // Note: Tailwind v4 uses CSS-based configuration instead of JS config files
  // This method is a placeholder for future Tailwind v4 integration
  async handleTailwindConfig(_server?: ViteDevServer): Promise<void> {
    if (!isSandbox) return;

    // TODO: Implement Tailwind v4 CSS-based config handling
    // Tailwind v4 doesn't use tailwind.config.js, so this needs different approach
    if (this.options.debug) {
      console.log("[Component Tagger] Tailwind v4 config handling not yet implemented");
    }
  }
}

// Export Vite plugin for component tagging
export function componentTaggerPlugin(options: ComponentTaggerOptions = {}): Plugin {
  const tagger = new ComponentTagger(options);
  const stats = tagger.getStats.bind(tagger);

  return {
    name: "vite-plugin-hercules-component-tagger",
    enforce: "pre",
    // Dev-server only: tagging is editor tooling, and published sites must
    // ship no Hercules identifiers in their markup
    apply: "serve",

    async buildStart() {
      await tagger.handleTailwindConfig();
    },

    async configureServer(server) {
      await tagger.handleTailwindConfig(server);

      // Expose stats endpoint
      server.middlewares.use("/hercules-component-tagger-stats", (req, res, next) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(stats()));
        } else {
          next();
        }
      });
    },

    // TanStack route split modules are tagged when they load, from the route
    // file on disk. In `transform` they may already be regenerated by the
    // router plugin (when it is listed before this one), and line and column
    // taken from that code would point at the wrong element of the route file.
    async load(id) {
      const filePath = taggableFilePath(id);
      if (!filePath || filePath === id) {
        return null;
      }
      return tagger.transformCode(await readFile(filePath, "utf8"), id);
    },

    async transform(code, id) {
      if (taggableFilePath(id) !== id) {
        return null;
      }
      const result = await tagger.transformCode(code, id);
      return result;
    },
  };
}
