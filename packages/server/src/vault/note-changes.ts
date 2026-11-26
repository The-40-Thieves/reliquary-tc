/** One vault-relative note that changed, with forward slashes (e.g. "notes/a.md"). */
export interface ResourceChangeEvent {
  vaultId: string;
  relPath: string;
}

/**
 * Every note change, from explicit writes and from the watcher alike, is published here. The watcher
 * publishes whether or not its process is the leader: each process serves its own subscription streams.
 */
export interface ResourceChangeBus {
  /** Best-effort. No open stream is the common case and must be silent. A listener's failure is
   *  caught so it cannot break delivery to any other. */
  publish(event: ResourceChangeEvent): void;
  onChange(listener: (event: ResourceChangeEvent) => void): () => void;
}

/** One process-local pub/sub, the same shape as advisories.ts's bus. */
export function createResourceChangeBus(): ResourceChangeBus {
  const listeners = new Set<(event: ResourceChangeEvent) => void>();
  return {
    publish(event) {
      if (listeners.size === 0) return;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          /* one subscriber's failure must not break delivery to another's stream */
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
