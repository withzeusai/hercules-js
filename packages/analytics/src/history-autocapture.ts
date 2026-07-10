// Adapted from posthog-js extensions/history-autocapture.ts: capture a
// pageview when an SPA navigates via history.pushState / replaceState or the
// back/forward buttons. Only fires when the pathname actually changes, so
// query-param and hash updates don't inflate pageview counts.

import { win } from "./globals";

export class HistoryAutocapture {
  private lastPathname: string;
  private teardowns: (() => void)[] = [];

  constructor(private readonly onPageview: () => void) {
    this.lastPathname = win?.location?.pathname ?? "";
  }

  start(): void {
    if (!win?.history || this.teardowns.length > 0) {
      return;
    }
    this.patchHistoryMethod("pushState");
    this.patchHistoryMethod("replaceState");

    const listenerWin = win;
    const onPopstate = () => this.captureIfPathChanged();
    listenerWin.addEventListener("popstate", onPopstate);
    this.teardowns.push(() => listenerWin.removeEventListener("popstate", onPopstate));
  }

  private patchHistoryMethod(method: "pushState" | "replaceState"): void {
    const history = win?.history;
    if (!history) {
      return;
    }
    const original = history[method];
    const patched: History["pushState"] = (...args) => {
      original.apply(history, args);
      this.captureIfPathChanged();
    };
    history[method] = patched;
    this.teardowns.push(() => {
      // Only restore if nothing else has patched over us since
      if (history[method] === patched) {
        history[method] = original;
      }
    });
  }

  private captureIfPathChanged(): void {
    const pathname = win?.location?.pathname ?? "";
    if (pathname !== this.lastPathname) {
      this.lastPathname = pathname;
      this.onPageview();
    }
  }

  stop(): void {
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns = [];
  }
}
