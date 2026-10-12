// Adapted from posthog-js scroll-manager.ts. Tracks how far down the page the
// visitor has scrolled; the wire format only carries a max-scroll percentage,
// so the content-height tracking and scroll_root_selector config are dropped.

import { doc, win } from "./globals";

export interface ScrollContext {
  lastScrollY?: number;
  maxScrollY?: number;
  maxScrollHeight?: number;
}

export class ScrollManager {
  private context: ScrollContext | undefined;
  private teardown: (() => void) | undefined;

  getContext(): ScrollContext | undefined {
    return this.context;
  }

  resetContext(): ScrollContext | undefined {
    const previous = this.context;
    this.context = undefined;
    // Seed the new page's context on the next tick, once the new document
    // height is in place (posthog-js does the same).
    setTimeout(this.updateScrollData, 0);
    return previous;
  }

  private updateScrollData = (): void => {
    if (!win || !doc) {
      return;
    }
    this.context ??= {};
    const el = doc.documentElement;
    const scrollY = win.scrollY || win.pageYOffset || el.scrollTop || 0;
    const scrollHeight = Math.max(0, el.scrollHeight - el.clientHeight);

    this.context.lastScrollY = Math.ceil(scrollY);
    this.context.maxScrollY = Math.max(scrollY, this.context.maxScrollY ?? 0);
    this.context.maxScrollHeight = Math.max(scrollHeight, this.context.maxScrollHeight ?? 0);
  };

  // `capture: true` also catches scroll events from nested scrollable elements
  startMeasuringScrollPosition(): void {
    if (!win || this.teardown) {
      return;
    }
    const listenerWin = win;
    const options = { capture: true, passive: true } as const;
    listenerWin.addEventListener("scroll", this.updateScrollData, options);
    listenerWin.addEventListener("scrollend", this.updateScrollData, options);
    listenerWin.addEventListener("resize", this.updateScrollData);
    this.teardown = () => {
      listenerWin.removeEventListener("scroll", this.updateScrollData, options);
      listenerWin.removeEventListener("scrollend", this.updateScrollData, options);
      listenerWin.removeEventListener("resize", this.updateScrollData);
    };
    this.updateScrollData();
  }

  stop(): void {
    this.teardown?.();
    this.teardown = undefined;
  }
}
