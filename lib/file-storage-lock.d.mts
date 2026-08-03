import type { NewRunEvent, RunEvent } from "./types";

export function safeStoragePart(value: string): string;
export function isProcessAlive(pid: number): boolean;
export function assertSafeStoragePath(root: string, path: string): Promise<string>;
export function assertNoSymlinksInTree(root: string): Promise<void>;
export function atomicWriteFile(path: string, value: string | Buffer, mode?: number, confinementRoot?: string): Promise<void>;
export function atomicCreateFile(path: string, value: string | Buffer, mode?: number, confinementRoot?: string, options?: { beforePublish?: () => void | Promise<void> }): Promise<void>;
export function acquireDirectoryLock(lockPath: string, options?: {
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  confinementRoot?: string;
  beforePublish?: () => void | Promise<void>;
  afterOrderAllocated?: () => void | Promise<void>;
  afterClaimPublished?: () => void | Promise<void>;
  afterFencePrepared?: () => void | Promise<void>;
  afterFencePublished?: () => void | Promise<void>;
  afterDeadFencePinned?: () => void | Promise<void>;
  beforeDeadFenceRemoved?: () => void | Promise<void>;
  afterDeadFenceRemoved?: () => void | Promise<void>;
}): Promise<() => Promise<void>>;
export function appendRunEventsFile(root: string, runId: string, values: NewRunEvent[]): Promise<RunEvent[]>;
