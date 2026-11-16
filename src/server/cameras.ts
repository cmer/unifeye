import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Policy } from "./authz/policy";
import { schema, type Db } from "./db";
import type { ProtectCamera } from "./protect/types";
import { log, newId } from "./util";

/**
 * Reconciles the recorder's inventory into Vantage's camera references.
 * Identity is (nvr id, Protect camera id): a rename keeps tags, grants and view slots.
 * A camera that discovery no longer reports is marked missing, not deleted.
 * A newly discovered camera gets no grants: nobody but administrators sees it until one is added.
 * Call only with a complete, successful discovery result; never during an outage.
 *
 * Runs every 30 seconds, so it tells Policy only what actually happened: a camera appearing,
 * going missing or coming back invalidates (and so reaches everything holding access); a change
 * to a name or to recorder metadata, which moves on every sync, only refreshes the descriptive
 * cache; an identical inventory touches nothing.
 */
export function syncCameras(db: Db, policy: Policy, nvrId: string, found: ProtectCamera[]) {
  const t = Date.now();
  let added = 0, inventory = false, described = false;
  db.transaction((tx) => {
    for (const c of found) {
      const meta = { online: c.online, model: c.model, eventTypes: c.eventTypes, streams: c.streams, recordingStartMs: c.recordingStartMs, recordingEndMs: c.recordingEndMs };
      const cur = tx.select().from(schema.cameras).where(and(eq(schema.cameras.nvrId, nvrId), eq(schema.cameras.protectId, c.protectId))).get();
      if (cur) {
        if (cur.missingSince != null) inventory = true;
        if (cur.name !== c.name || JSON.stringify(cur.meta) !== JSON.stringify(meta)) described = true;
        tx.update(schema.cameras).set({ name: c.name, meta, lastSeenAt: t, missingSince: null }).where(eq(schema.cameras.id, cur.id)).run();
      } else {
        tx.insert(schema.cameras).values({ id: newId(), nvrId, protectId: c.protectId, name: c.name, meta, firstSeenAt: t, lastSeenAt: t }).run();
        added++;
      }
    }
    const ids = found.map((c) => c.protectId);
    const gone = and(eq(schema.cameras.nvrId, nvrId), isNull(schema.cameras.missingSince), ids.length ? notInArray(schema.cameras.protectId, ids) : undefined);
    if (tx.update(schema.cameras).set({ missingSince: t }).where(gone).run().changes) inventory = true;
  }, { behavior: "immediate" });
  if (added || inventory) policy.invalidate();
  else if (described) policy.refreshCameraInfo();
  if (added) log("info", "new cameras discovered; no staff access granted", { added });
  return { added };
}
