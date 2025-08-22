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
  threeDreiImportedElements: Set<string>,
  threeDreiNamespaces: Set<string>,
): boolean {
  if (threeFiberElems.has(elementName)) {
    return false;
  }
  if (threeDreiImportedElements.has(elementName)) {
    return false;
  }
  if (elementName.includes(".")) {
    const namespace = elementName.split(".")[0];
    if (namespace && threeDreiNamespaces.has(namespace)) {
      return false;
    }
  }
  return true;
}

// Constants
const validExtensions = new Set([".jsx", ".tsx"]);
const isSandbox = process.env.HERCULES_DEV_SERVER === "true";

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

  async transformCode(
    code: string,
    id: string,
  ): Promise<{ code: string; map: any } | null> {
    if (!validExtensions.has(path.extname(id)) || id.includes("node_modules")) {
      return null;
    }

    this.stats.totalFiles++;
    const relativePath = path.relative(this.cwd, id) || id;

    try {
      const parserOptions = {
        sourceType: "module" as const,
        plugins: ["jsx", "typescript"] as any,
      };

      const ast = parse(code, parserOptions);
      const magicString = new MagicString(code);
      let changedElementsCount = 0;
      const threeDreiImportedElements = new Set<string>();
      const threeDreiNamespaces = new Set<string>();

      // Dynamic import estree-walker
      const { walk } = await import("estree-walker");

      // First pass: collect drei imports
      walk(ast as any, {
        enter(node) {
          if (node.type === "ImportDeclaration") {
            const source = node.source?.value;
            if (
              typeof source === "string" &&
              source.includes("@react-three/drei")
            ) {
              node.specifiers.forEach((spec: any) => {
                if (spec.type === "ImportSpecifier") {
                  threeDreiImportedElements.add(spec.local.name);
                } else if (spec.type === "ImportNamespaceSpecifier") {
                  threeDreiNamespaces.add(spec.local.name);
                }
              });
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
            if (
              elementName === "Fragment" ||
              elementName === "React.Fragment"
            ) {
              return;
            }

            const line = jsxNode.loc?.start?.line ?? 0;
            const col = jsxNode.loc?.start?.column ?? 0;
            const dataComponentId = `${relativePath}:${line}:${col}`;

            const shouldTag = shouldTagElement(
              elementName,
              threeDreiImportedElements,
              threeDreiNamespaces,
            );

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
      console.log(
        "[Component Tagger] Tailwind v4 config handling not yet implemented",
      );
    }
  }
}

// Export Vite plugin for component tagging
export function componentTaggerPlugin(
  options: ComponentTaggerOptions = {},
): Plugin {
  const tagger = new ComponentTagger(options);
  const stats = tagger.getStats.bind(tagger);

  return {
    name: "vite-plugin-hercules-component-tagger",
    enforce: "pre",

    async buildStart() {
      await tagger.handleTailwindConfig();
    },

    async configureServer(server) {
      await tagger.handleTailwindConfig(server);

      // Expose stats endpoint
      server.middlewares.use(
        "/hercules-component-tagger-stats",
        (req, res, next) => {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(stats()));
          } else {
            next();
          }
        },
      );
    },

    async transform(code, id) {
      const result = await tagger.transformCode(code, id);
      return result;
    },
  };
}
