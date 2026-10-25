---
"@usehercules/analytics": patch
---

Cap what `AnalyticsPayloadSchema` accepts, since the ingest endpoint takes writes from anyone who can load a Hercules app. A batch holds at most 50 events, and `bufferSize` is clamped to 50 so the client never sends a batch the server refuses. Every string field is cut to a fixed length (8,192 characters for URLs and paths, 128 to 512 for ids and labels), and `properties` and `properties_numeric` keep their first 50 keys. Values over a cap are cut, not rejected, so one long URL never fails a whole batch.
