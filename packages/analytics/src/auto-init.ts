// ============================================================================
// Auto-initialization for ES module script embedding
// ============================================================================

import { initAnalytics } from ".";

declare global {
  interface Window {
    hercules?: {
      analytics?: ReturnType<typeof initAnalytics>;
    };
  }
}

/**
 * Parse config from URL query parameters via import.meta.url.
 */
function parseUrlConfig() {
  try {
    const params = new URL(import.meta.url).searchParams;
    return {
      websiteId: params.get("websiteId") ?? undefined,
      organizationId: params.get("organizationId") ?? undefined,
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
  if (typeof window === "undefined") {
    console.warn("[@usehercules/analytics] Window is not defined");
  }

  const config = parseUrlConfig();

  // Only auto-init if required fields are present
  if (!config.websiteId || !config.organizationId) {
    console.warn(
      "[@usehercules/analytics] Website ID and organization ID are required",
    );
    return;
  }

  const instance = initAnalytics({
    websiteId: config.websiteId,
    organizationId: config.organizationId,
    apiEndpoint: config.apiEndpoint ?? "/_hercules/i",
    debug: config.debug ?? false,
    trackClicks: config.trackClicks ?? false,
    trackPerformance: config.trackPerformance ?? true,
  });

  // Expose instance globally for manual usage
  window.hercules = window.hercules ?? {};
  window.hercules.analytics = instance;
})();
