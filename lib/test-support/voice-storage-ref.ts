import { MemoryVoiceStorage } from "@/lib/voice-storage";

// Shared across route test files: `getVoiceStorage()` in lib/voice-storage.ts
// returns a brand-new MemoryVoiceStorage() on every call, which is correct
// for production (BlobVoiceStorage is stateless per-call) but means route
// tests that mock `@/lib/voice-storage` need a single instance handed back
// every time so that a POST followed by a GET in the same test observes the
// same data.
export const voiceStorageRef: { current: MemoryVoiceStorage } = { current: new MemoryVoiceStorage() };

export function resetVoiceStorage(): MemoryVoiceStorage {
  voiceStorageRef.current = new MemoryVoiceStorage();
  return voiceStorageRef.current;
}
