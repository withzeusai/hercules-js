// ============================================================================
// Auto-initialization for ES module script embedding
// ============================================================================

import { initSessionReplay, type SessionReplayInstance } from "./index";
import { shouldRecord } from "./utils";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace hercules {
    let sessionReplay: SessionReplayInstance | undefined;
  }
}

function parseUrlConfig() {
  try {
    const params = new URL(import.meta.url).searchParams;
    const sampleRateParam = params.get("sampleRate");
    const sampleRate = sampleRateParam != null ? Number(sampleRateParam) : undefined;
    return {
      apiEndpoint: params.get("apiEndpoint") ?? undefined,
      debug: params.has("debug") ? params.get("debug") === "true" : undefined,
      userId: params.get("userId") ?? undefined,
      sampleRate: Number.isFinite(sampleRate) ? sampleRate : undefined,
      recordInIframes: params.has("recordInIframes")
        ? params.get("recordInIframes") === "true"
        : undefined,
      recordInHeadless: params.has("recordInHeadless")
        ? params.get("recordInHeadless") === "true"
        : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Auto-initialize from URL params.
 *
 * Usage:
 * <script
 *   type="module"
 *   src="/_hercules/r.js?websiteId=xxx&organizationId=yyy&sampleRate=100">
 * </script>
 */
(function autoInit() {
  const g = globalThis as typeof globalThis & {
    hercules?: { sessionReplay?: SessionReplayInstance };
  };

  if (typeof window === "undefined") {
    console.warn("[@usehercules/session-replay] window is not defined");
    return;
  }

  const config = parseUrlConfig();

  if (!shouldRecord(config.sampleRate)) {
    if (config.debug) {
      console.log("[hercules/session-replay] skipped due to sample rate", config.sampleRate);
    }
    return;
  }

  const instance = initSessionReplay({
    apiEndpoint: config.apiEndpoint ?? "/_hercules/r",
    debug: config.debug ?? false,
    sampleRate: config.sampleRate ?? 100,
    userId: config.userId,
    recordInIframes: config.recordInIframes ?? false,
    recordInHeadless: config.recordInHeadless ?? false,
  });

  g.hercules = g.hercules ?? {};
  g.hercules.sessionReplay = instance;
})();
