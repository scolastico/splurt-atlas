// Extracts a map ZIP off the main thread. Each batch waits for the page to
// acknowledge it, so extraction never runs ahead of IndexedDB writes.
/// <reference lib="webworker" />
import { extractArchive, type ExtractedAsset } from '../data/archive-extract.ts';

export interface ArchiveWorkerRequest {
  blob: Blob;
  priorities: string[];
}

export type ArchiveWorkerMessage =
  | { batch: ExtractedAsset[]; complete: number; total: number }
  | { done: true }
  | { error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let acknowledge: (() => void) | undefined;

scope.onmessage = async (event: MessageEvent<ArchiveWorkerRequest | { ack: true }>) => {
  if ('ack' in event.data) {
    acknowledge?.();
    return;
  }
  const { blob, priorities } = event.data;
  try {
    await extractArchive(
      blob,
      (batch, complete, total) =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
          scope.postMessage({ batch, complete, total } satisfies ArchiveWorkerMessage);
        }),
      () => false,
      priorities,
    );
    scope.postMessage({ done: true } satisfies ArchiveWorkerMessage);
  } catch (error) {
    scope.postMessage({ error: (error as Error).message } satisfies ArchiveWorkerMessage);
  }
};
