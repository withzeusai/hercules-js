import path from "path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import MagicString from "magic-string";
import type { Plugin, ViteDevServer } from "vite";

// @babel/traverse ships a CJS default-export, so unwrap it for ESM consumers.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

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

// Keep: Three.js objects whose lowercased R3F intrinsic names also exist as
// real DOM/SVG element names (<line>, <path>, <audio>, <source>). We only skip
// tagging on these when the file imports from @react-three/* so non-R3F files
// can still tag their SVG/HTML usage.
const threeFiberDomConflictElems = new Set([
  "line",
  "path",
  "audio",
  "source",
  "clippingGroup",
]);

// Keep: Check if element should be tagged
function shouldTagElement(
  elementName: string,
  threeDreiImportedElements: Set<string>,
  threeDreiNamespaces: Set<string>,
  insideCanvasSubtree: boolean,
): boolean {
  if (threeFiberElems.has(elementName)) {
    return false;
  }
  if (insideCanvasSubtree && threeFiberDomConflictElems.has(elementName)) {
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

  async transformCode(code: string, id: string): Promise<{ code: string; map: any } | null> {
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

      // First pass: collect @react-three/* companion-package imports (drei,
      // postprocessing, cannon, rapier, xr). Their named exports render into
      // the R3F reconciler, which trips on injected data-hercules-name. Also
      // walk @react-three/fiber's import specifiers so the second pass can
      // resolve a JSX <Canvas> reference back to the import via
      // path.scope.getBinding (binding-aware, not just by name).
      walk(ast as any, {
        enter(node) {
          if (node.type === "ImportDeclaration") {
            const source = node.source?.value;
            if (
              typeof source === "string" &&
              source.startsWith("@react-three/") &&
              source !== "@react-three/fiber" &&
              (node as any).importKind !== "type"
            ) {
              const specifiers = node.specifiers ?? [];
              const hasValueSpec =
                specifiers.length === 0 ||
                specifiers.some((spec: any) => spec.importKind !== "type");
              if (!hasValueSpec) {
                return;
              }
              specifiers.forEach((spec: any) => {
                if (spec.importKind === "type") {
                  return;
                }
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

      // Binding-aware check: does this JSX opening name resolve to a named
      // export from a particular @react-three/* package in the CURRENT
      // lexical scope? path.scope.getBinding follows the usual JavaScript
      // scoping rules, so a function param or local var that shadows the
      // import returns the shadowing binding and we correctly conclude that
      // the subtree is not the imported component.
      const resolvesToImport = (
        name: any,
        scope: any,
        sourceModule: string,
        importedName: string,
      ): boolean => {
        if (!name) return false;
        if (name.type === "JSXIdentifier") {
          const binding = scope.getBinding(name.name);
          if (!binding) return false;
          const bindingNode = binding.path?.node;
          const bindingParent = binding.path?.parent;
          if (
            bindingNode?.type === "ImportSpecifier" &&
            bindingNode.importKind !== "type" &&
            bindingParent?.type === "ImportDeclaration" &&
            bindingParent.importKind !== "type" &&
            bindingParent.source?.value === sourceModule &&
            bindingNode.imported?.name === importedName
          ) {
            return true;
          }
          return false;
        }
        if (
          name.type === "JSXMemberExpression" &&
          name.object?.type === "JSXIdentifier" &&
          name.property?.type === "JSXIdentifier" &&
          name.property.name === importedName
        ) {
          const binding = scope.getBinding(name.object.name);
          if (!binding) return false;
          const bindingNode = binding.path?.node;
          const bindingParent = binding.path?.parent;
          if (
            bindingNode?.type === "ImportNamespaceSpecifier" &&
            bindingParent?.type === "ImportDeclaration" &&
            bindingParent.importKind !== "type" &&
            bindingParent.source?.value === sourceModule
          ) {
            return true;
          }
        }
        return false;
      };

      const isCanvasReference = (name: any, scope: any) =>
        resolvesToImport(name, scope, "@react-three/fiber", "Canvas");
      // drei's <Html> portals its children into the regular DOM (outside the
      // WebGL canvas), so DOM-conflict intrinsics inside it must keep their
      // tags. Track Html subtrees so we can suppress the canvas-subtree skip
      // while we are inside one.
      const isHtmlPortalReference = (name: any, scope: any) =>
        resolvesToImport(name, scope, "@react-three/drei", "Html");

      // Capture dataAttribute for use in the walker
      const dataAttribute = this.dataAttribute;

      // Second pass: tag elements. canvasDepth tracks whether the current
      // JSX node is nested inside an R3F <Canvas>; htmlPortalDepth tracks
      // nesting inside a drei <Html> (which portals back to the DOM, so
      // children there are real DOM elements again). DOM-conflict intrinsics
      // (<line>, <path>, <audio>, <source>, <clippingGroup>) are skipped
      // only when canvasDepth > 0 AND we are not currently inside an Html
      // portal, so the same file can render ordinary SVG/HTML versions
      // outside the canvas (or inside a portal back to DOM) and keep them
      // selectable in the visual editor. We use @babel/traverse here (not
      // estree-walker) for path.scope.getBinding, which lets us resolve
      // <Canvas>/<Html> by lexical binding rather than by raw name and so
      // respects shadowing scopes.
      let canvasDepth = 0;
      let htmlPortalDepth = 0;
      traverse(ast as any, {
        JSXElement: {
          enter(path: any) {
            if (isCanvasReference(path.node.openingElement?.name, path.scope)) {
              canvasDepth++;
            } else if (
              isHtmlPortalReference(path.node.openingElement?.name, path.scope)
            ) {
              htmlPortalDepth++;
            }
          },
          exit(path: any) {
            if (isCanvasReference(path.node.openingElement?.name, path.scope)) {
              canvasDepth--;
            } else if (
              isHtmlPortalReference(path.node.openingElement?.name, path.scope)
            ) {
              htmlPortalDepth--;
            }
          },
        },
        JSXOpeningElement: {
          enter(path: any) {
            const jsxNode = path.node;
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

            const shouldTag = shouldTagElement(
              elementName,
              threeDreiImportedElements,
              threeDreiNamespaces,
              canvasDepth > 0 && htmlPortalDepth === 0,
            );

            if (shouldTag) {
              // Only add the new data attributes (no legacy)
              const endPosition = jsxNode.name.end ?? 0;

              // Build the attributes string
              let attributesString = ` ${dataAttribute}="${dataComponentId}" data-hercules-name="${elementName}"`;

              magicString.appendLeft(endPosition, attributesString);
              changedElementsCount++;
            }
          },
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

    async transform(code, id) {
      const result = await tagger.transformCode(code, id);
      return result;
    },
  };
}
