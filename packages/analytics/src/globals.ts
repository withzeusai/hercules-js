// Safe references to browser globals so every module can run (as a no-op)
// during SSR, following posthog-js utils/globals.ts.

export const win: (Window & typeof globalThis) | undefined =
  typeof window !== "undefined" ? window : undefined;

export const doc: Document | undefined = typeof document !== "undefined" ? document : undefined;

export const nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined;
