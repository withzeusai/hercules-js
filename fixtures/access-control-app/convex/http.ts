import { httpRouter } from "convex/server";
import { registerAccessControlRoutes } from "@usehercules/convex/http";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

registerAccessControlRoutes(http, {
  httpAction,
  components,
});

export default http;
