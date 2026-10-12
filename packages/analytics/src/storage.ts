// Slim take on posthog-js storage.ts: a common store interface over
// localStorage / sessionStorage with an in-memory fallback, feature-detected
// the same way (write + read back a probe key).

export interface PersistentStore {
  isSupported: () => boolean;
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

function webStore(getStorage: () => Storage | undefined): PersistentStore {
  let supported: boolean | undefined;

  return {
    isSupported() {
      if (supported === undefined) {
        try {
          const storage = getStorage();
          if (!storage) {
            supported = false;
          } else {
            const key = "__hrc_probe__";
            storage.setItem(key, "1");
            supported = storage.getItem(key) === "1";
            storage.removeItem(key);
          }
        } catch {
          supported = false;
        }
      }
      return supported;
    },
    get(key) {
      try {
        return getStorage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        getStorage()?.setItem(key, value);
      } catch {
        // Quota exceeded / private mode — data lives only in memory this page
      }
    },
    remove(key) {
      try {
        getStorage()?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

export const localStore: PersistentStore = webStore(() =>
  typeof localStorage === "undefined" ? undefined : localStorage,
);

export const sessionStore: PersistentStore = webStore(() =>
  typeof sessionStorage === "undefined" ? undefined : sessionStorage,
);

export function createMemoryStore(): PersistentStore {
  const data = new Map<string, string>();
  return {
    isSupported: () => true,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
  };
}

/**
 * Preferred store for session state: localStorage so sessions span tabs
 * (posthog-js behavior), falling back to memory when unavailable.
 */
export function pickSessionStore(): PersistentStore {
  return localStore.isSupported() ? localStore : createMemoryStore();
}
