/** `convex/_generated/dataModel.ts` as Convex writes it for an app with a schema. */
import type { DataModelFromSchemaDefinition } from "convex/server";
import type schema from "../schema";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
