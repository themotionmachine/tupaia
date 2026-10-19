/** Hidden layer records parse on first use; writes can replace them without parsing obsolete data. */
export function assignMapRecords<T extends object, K extends keyof T>(
  target: T,
  key: K,
  source: string,
  fallback: T[K],
  deferred: boolean
): void {
  const read = (): T[K] => (source ? (JSON.parse(source) as T[K]) : fallback);
  const store = (value: T[K]) =>
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true
    });
  if (!deferred) {
    store(read());
    return;
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      const value = read();
      store(value);
      return value;
    },
    set(value: T[K]) {
      store(value);
    }
  });
}
