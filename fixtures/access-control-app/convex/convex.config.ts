import { defineApp } from "convex/server";
import accessControl from "@usehercules/convex/convex.config.js";

const app = defineApp();
app.use(accessControl, { name: "accessControl" });

export default app;
