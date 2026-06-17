export const REFRESH_LOCK_KEY = "__herculesAuthRefresh";

type Queue = {
  running: Promise<void> | null;
  waiting: Array<() => Promise<void>>;
};

const mutexes = new Map<string, Queue>();

async function manualMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const wrapped = () =>
      callback()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          const mutex = mutexes.get(key)!;
          const next = mutex.waiting.shift();
          if (next) {
            mutex.running = next();
          } else {
            mutex.running = null;
          }
        });

    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = { running: null, waiting: [] };
      mutexes.set(key, mutex);
    }

    if (mutex.running === null) {
      mutex.running = wrapped();
    } else {
      mutex.waiting.push(wrapped);
    }
  });
}

export async function withRefreshLock<T>(
  callback: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(REFRESH_LOCK_KEY, callback);
  }
  return manualMutex(REFRESH_LOCK_KEY, callback);
}
