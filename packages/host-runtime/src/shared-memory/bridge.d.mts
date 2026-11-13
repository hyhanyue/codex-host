interface MemoryThread {
  id: string;
  cwd: string;
  harnessId?: string;
  record?: { title?: string | null };
  activeTurnId?: string | null;
}
export function prepareSharedMemoryInput(
  thread: MemoryThread,
  text: string,
  turnId: string,
): string;
export function recordSharedMemoryOutput(thread: MemoryThread, event: unknown): void;
export function closeSharedMemory(): void;
