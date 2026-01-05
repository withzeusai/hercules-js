// ============================================================================
// Auto-initialization for ES module script embedding
// ============================================================================

import { initAnalytics, type Analytics } from "./index";

declare global {
  namespace hercules {
    let analytics: Analytics | undefined;
  }
}

/**
 * Parse config from URL query parameters via import.meta.url.
 */
function parseUrlConfig() {
  try {
    const params = new URL(import.meta.url).searchParams;
    return {
      apiEndpoint: params.get("apiEndpoint") ?? undefined,
      debug: params.has("debug") ? params.get("debug") === "true" : undefined,
      trackClicks: params.has("trackClicks")
        ? params.get("trackClicks") === "true"
        : undefined,
      trackPerformance: params.has("trackPerformance")
        ? params.get("trackPerformance") !== "false"
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
 *   src="https://cdn.com/analytics.mjs?websiteId=xxx&organizationId=yyy">
 * </script>
 *
 * Optional parameters:
 *   - apiEndpoint: Custom API endpoint
 *   - debug: Enable debug mode (default: false)
 *   - trackClicks: Track click events (default: false)
 *   - trackPerformance: Track web vitals (default: true)
 */
(function autoInit() {
  const g = globalThis ?? window;
  if (g == null) {
    console.warn("[@usehercules/analytics] Window is not defined");
  }

  const config = parseUrlConfig();
  const instance = initAnalytics({
    apiEndpoint: config.apiEndpoint ?? "/_hercules/i",
    debug: config.debug ?? false,
    trackClicks: config.trackClicks ?? false,
    trackPerformance: config.trackPerformance ?? true,
  });

  // Expose instance globally for manual usage
  g.hercules = g.hercules ?? {};
  g.hercules.analytics = instance;
})();
