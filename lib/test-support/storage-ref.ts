import { MemoryStorage } from "@/lib/storage";

// Shared across route test files: `getStorage()` in lib/storage.ts returns a
// brand-new MemoryStorage() on every call, which is correct for production
// (BlobStorage is stateless per-call) but means route tests that mock
// `@/lib/storage` need a single instance handed back every time so that a
// POST followed by a GET in the same test observes the same data.
export const storageRef: { current: MemoryStorage } = { current: new MemoryStorage() };

export function resetStorage(): MemoryStorage {
  storageRef.current = new MemoryStorage();
  return storageRef.current;
}
