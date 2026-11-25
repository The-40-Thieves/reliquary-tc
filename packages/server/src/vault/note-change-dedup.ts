// One publish per distinct state of a note. A server-side write is seen twice: by the write hook,
// and again by the filesystem watcher when the file lands. Both carry the same content, so the
// second is the same change, not a new one. State is the content's digest, or "deleted".
//
// Bounded: only the most recently changed notes are remembered. A forgotten note publishes again on
// its next event, which is the behaviour without this filter.

import { createHash } from "node:crypto";

const DELETED = "";
const DEFAULT_MAX_NOTES = 4096;

export interface NoteChangeDedup {
  /** True when this state of the note differs from the last one seen; `null` content is a delete. */
  isNewState(vaultId: string, relPath: string, content: string | null): boolean;
}

export function createNoteChangeDedup(maxNotes: number = DEFAULT_MAX_NOTES): NoteChangeDedup {
  const lastState = new Map<string, string>();
  return {
    isNewState(vaultId, relPath, content) {
      const key = `${vaultId}\u0000${relPath}`;
      const state =
        content === null ? DELETED : createHash("sha256").update(content).digest("base64");
      if (lastState.get(key) === state) return false;
      // Re-insert so the map's order is recency, then drop the oldest past the bound.
      lastState.delete(key);
      lastState.set(key, state);
      if (lastState.size > maxNotes) {
        const oldest = lastState.keys().next().value;
        if (oldest !== undefined) lastState.delete(oldest);
      }
      return true;
    },
  };
}
