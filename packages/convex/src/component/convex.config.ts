import { defineComponent } from "convex/server";
import { v } from "convex/values";

// The component verifies the signed projection-sync webhook inside its OWN
// runtime (see component/sync.ts `applySync`), so the signing secret must be
// bound to the component. Convex isolates component environment variables from
// the app, so the installing app declares the secret and binds it explicitly:
//
//   const app = defineApp({ env: { HERCULES_SYNC_SECRET: v.string() } });
//   app.use(hercules, {
//     name: "hercules",
//     env: { HERCULES_SYNC_SECRET: app.env.HERCULES_SYNC_SECRET },
//   });
//
// Declaring it here as required makes a missing binding fail loudly at deploy
// time rather than silently rejecting every sync at runtime.
export default defineComponent("hercules", {
  env: {
    HERCULES_SYNC_SECRET: v.string(),
  },
});
