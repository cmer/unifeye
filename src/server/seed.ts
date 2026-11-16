import { eq } from "drizzle-orm";
import { schema, type Db } from "./db";
import { MOCK_CAMERAS } from "./protect/mock-data";
import { newId } from "./util";

/**
 * Demo organization for mock mode and tests: tags, groups, grants and curated views.
 * Runs only when explicitly requested (VANTAGE_MODE=mock with SEED_DEMO=1, or from tests),
 * never in real mode, and only once. It creates no users: people always arrive through SSO.
 * `ownerId` is the administrator who will own the curated views.
 */
export function seedDemo(db: Db, ownerId: string) {
  if (db.select().from(schema.settings).where(eq(schema.settings.key, "demo_seeded")).get()) return false;
  const t = Date.now();
  db.transaction((tx) => {
    const cam = new Map(tx.select().from(schema.cameras).all().map((c) => [c.protectId, c.id]));
    const tag = new Map<string, string>();
    for (const m of MOCK_CAMERAS) for (const n of m.tags) {
      if (!tag.has(n)) { const id = newId(); tag.set(n, id); tx.insert(schema.tags).values({ id, name: n, createdAt: t }).run(); }
      const cameraId = cam.get(m.protectId);
      if (cameraId) tx.insert(schema.cameraTags).values({ cameraId, tagId: tag.get(n)! }).run();
    }
    const group = (name: string, defaultPriority: number, isAllStaff = false) => { const id = newId(); tx.insert(schema.groups).values({ id, name, defaultPriority, isAllStaff, createdAt: t }).run(); return id; };
    const all = group("All Staff", 10, true), front = group("Front Desk Team", 20), upper = group("Upper Level Team", 30), sec = group("Security", 40);
    const grant = (groupId: string, nums: number[]) => nums.forEach((n) => tx.insert(schema.groupCameraGrants).values({ groupId, cameraId: cam.get(`mock-${String(n).padStart(2, "0")}`)!, createdAt: t }).run());
    grant(upper, [4, 5, 6, 7, 8]); grant(front, [1, 2, 3]); grant(sec, [7, 9, 10, 11, 12]);
    const view = (name: string, type: "dynamic" | "static", columns: number, o: { tags?: string[]; cams?: number[]; all?: boolean; groups?: string[] }) => {
      const id = newId();
      tx.insert(schema.views).values({ id, name, ownerId, visibility: "curated", type, columns, sharedWithAll: !!o.all, createdAt: t, updatedAt: t }).run();
      o.tags?.forEach((n) => tx.insert(schema.viewPredicateTags).values({ viewId: id, tagId: tag.get(n)! }).run());
      o.cams?.forEach((n, position) => tx.insert(schema.viewCameras).values({ viewId: id, cameraId: cam.get(`mock-${String(n).padStart(2, "0")}`)!, position }).run());
      o.groups?.forEach((groupId) => tx.insert(schema.viewGroupShares).values({ viewId: id, groupId, createdAt: t }).run());
      return id;
    };
    const vUpper = view("Upper Level Indoors", "dynamic", 2, { tags: ["indoors", "upper_level"], groups: [upper, sec] });
    const vFront = view("Front Desk", "static", 2, { cams: [2, 3, 1, 11], groups: [front] });
    const vPerim = view("Perimeter", "dynamic", 2, { tags: ["outdoors", "perimeter"], groups: [sec] });
    const vAll = view("Building Overview", "static", 3, { cams: [1, 2, 4, 6, 9, 11, 13, 12], all: true });
    view("Restricted Rooms", "dynamic", 2, { tags: ["restricted"] });
    const def = (scope: "org" | "group", viewId: string, groupId?: string) => tx.insert(schema.defaultViews).values({ id: newId(), scope, groupId: groupId ?? null, viewId, createdBy: ownerId, createdAt: t }).run();
    def("org", vAll); def("group", vUpper, upper); def("group", vFront, front); def("group", vPerim, sec);
    void all;
    tx.insert(schema.settings).values({ key: "demo_seeded", value: true, updatedAt: t }).run();
  });
  return true;
}
