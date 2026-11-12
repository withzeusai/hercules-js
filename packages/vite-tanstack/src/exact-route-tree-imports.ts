import path from "node:path";
import type { Plugin } from "vite";
import { GENERATED_ROUTE_TREE } from "./skip-deleted-route-updates";

export function exactRouteTreeImports(): Plugin {
  return {
    name: "hercules:exact-route-tree-imports",
    apply: "serve",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith(".") || !GENERATED_ROUTE_TREE.test(importer)) return;
      const resolved = await this.resolve(source, importer, options);
      const file = path.posix.join(path.posix.dirname(importer), source);
      return resolved && path.posix.dirname(resolved.id) === file ? file : resolved;
    },
  };
}
