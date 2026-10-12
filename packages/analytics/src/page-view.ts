// Adapted from posthog-js page-view.ts, producing our flat wire-format field
// names instead of $prev_pageview_* properties.
//
// State lives in memory, so on classic multi-page sites it is lost on reload —
// which is why a pageleave event is sent on pagehide: it carries the ending
// page's duration and scroll depth. For SPA navigations the previous page's
// numbers arrive on the *next* pageview event instead. To find the dwell time
// of a given pageview, look for the pageview/pageleave event whose
// prev_pageview_id matches its pageview_id.

import { doc } from "./globals";
import type { ScrollManager } from "./scroll-manager";

export interface PageViewProperties {
  pageview_id?: string;
  prev_pageview_id?: string;
  prev_pageview_pathname?: string;
  prev_pageview_duration?: number; // seconds
  prev_pageview_max_scroll_percentage?: number; // 0-1
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class PageViewManager {
  private currentPageview: { timestamp: number; pageviewId: string; pathname: string } | undefined;

  constructor(private readonly scrollManager: ScrollManager) {}

  doPageView(timestamp: number, pageviewId: string): PageViewProperties {
    const properties = this.previousPageViewProperties(timestamp, pageviewId);

    this.currentPageview = {
      pathname: doc?.location?.pathname ?? "",
      pageviewId,
      timestamp,
    };
    this.scrollManager.resetContext();

    return properties;
  }

  doPageLeave(timestamp: number): PageViewProperties {
    return this.previousPageViewProperties(timestamp, this.currentPageview?.pageviewId);
  }

  doEvent(): PageViewProperties {
    return this.currentPageview ? { pageview_id: this.currentPageview.pageviewId } : {};
  }

  /** Called on session rotation so a new session doesn't link to old pageviews */
  reset(): void {
    this.currentPageview = undefined;
    this.scrollManager.resetContext();
  }

  private previousPageViewProperties(
    timestamp: number,
    pageviewId: string | undefined,
  ): PageViewProperties {
    const previous = this.currentPageview;
    const properties: PageViewProperties = {};
    if (pageviewId) {
      properties.pageview_id = pageviewId;
    }

    if (!previous) {
      return properties;
    }

    properties.prev_pageview_id = previous.pageviewId;
    if (previous.pathname) {
      properties.prev_pageview_pathname = previous.pathname;
    }
    // Seconds, consistent with posthog's duration properties
    properties.prev_pageview_duration = (timestamp - previous.timestamp) / 1000;

    const scrollContext = this.scrollManager.getContext();
    if (
      scrollContext &&
      scrollContext.maxScrollHeight !== undefined &&
      scrollContext.maxScrollY !== undefined
    ) {
      // Ceil so scrolling 999.5px of a 1000px page counts as 100%; a page too
      // short to scroll counts as fully scrolled (both posthog-js decisions).
      const maxScrollHeight = Math.ceil(scrollContext.maxScrollHeight);
      const maxScrollY = Math.ceil(scrollContext.maxScrollY);
      properties.prev_pageview_max_scroll_percentage =
        maxScrollHeight <= 1 ? 1 : clamp01(maxScrollY / maxScrollHeight);
    }

    return properties;
  }
}
