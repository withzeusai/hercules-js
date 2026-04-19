import * as z from "zod/mini";

export const DeviceTypeEnum = z.enum(["mobile", "tablet", "desktop", "unknown"]);
export type DeviceType = z.infer<typeof DeviceTypeEnum>;

export const SessionReplayChunkMetaSchema = z.object({
  user_agent: z.nullish(z.string()),
  viewport_width: z.nullish(z.number()),
  viewport_height: z.nullish(z.number()),
  url: z.nullish(z.string()),
  domain: z.nullish(z.string()),
  device_type: z.nullish(DeviceTypeEnum),
  user_id: z.nullish(z.string()),
});
export type SessionReplayChunkMeta = z.infer<typeof SessionReplayChunkMetaSchema>;

export const SessionReplayChunkSchema = z.object({
  session_id: z.string(),
  chunk_index: z.number(),
  started_at: z.number(),
  ended_at: z.number(),
  events: z.array(z.unknown()),
  meta: SessionReplayChunkMetaSchema,
});
export type SessionReplayChunk = z.infer<typeof SessionReplayChunkSchema>;
