import { applyCommand, type Command, type Workspace } from "./study";

export type Snapshot = { state: Workspace; revision: number; serverNow: number; storage?: "local" | "cloud" };
export type Flight = { baseRevision: number; mutationId: string; commands: Command[] };
export type Cache = {
  version: 1; base: Snapshot; pending: Command[]; flight: Flight | null;
  closed?: boolean; savedAt?: number; lineage?: string; handledDiscards?: string[];
  rebasedFlights?: { mutationId: string; count: number }[];
};
export type DiscardNotice = {
  id: string; lineage: string; baseRevision: number; mutationId?: string; commands: Command[];
};

/** Retire only the identical prefix the user discarded, retaining a sibling tab's later edits. */
export function applyDiscardNotices(cache: Cache, notices: DiscardNotice[], resolvedSnapshot?: Snapshot | null): boolean {
  let changed = false;
  for (const notice of notices) {
    if (cache.handledDiscards?.includes(notice.id) || cache.base.revision !== notice.baseRevision) continue;
    // mutationId also recognizes recovered copies written by the original v1 implementation.
    if (cache.lineage !== notice.lineage && (!notice.mutationId || cache.flight?.mutationId !== notice.mutationId)) continue;
    let count = 0;
    while (count < notice.commands.length && count < cache.pending.length && JSON.stringify(cache.pending[count]) === JSON.stringify(notice.commands[count])) count++;
    if (!count) continue;
    // Keep the original local context for dependent later commands (e.g. a note on a new task).
    // Its OLD revision deliberately remains: later edits must still face the server conflict guard.
    if (count < cache.pending.length) {
      let state = cache.base.state;
      for (const command of cache.pending.slice(0, count)) state = applyCommand(state, command);
      cache.base = { ...cache.base, state };
    } else if (resolvedSnapshot && resolvedSnapshot.revision >= cache.base.revision) {
      cache.base = resolvedSnapshot;
    }
    cache.pending.splice(0, count);
    cache.flight = null;
    cache.handledDiscards = [...(cache.handledDiscards ?? []), notice.id];
    changed = true;
  }
  return changed;
}
