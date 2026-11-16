import { beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "@/server/testing/fixture";
import { schema } from "@/server/db";
import { syncCameras } from "@/server/cameras";

let f: Fixture;
beforeEach(() => { f = makeFixture(); });
const resolveNames = (view: string, userId: string) => f.views.resolve(f.views.get(f.viewByName()[view])!, userId).cameras.map((c) => c.name);
const opens = (userId: string) => f.views.accessible(userId).map((v) => v.name);

describe("camera grants", () => {
  it("denies by default: a signed-in user with no grants sees nothing", () => {
    expect(f.names(f.u.nobody)).toEqual([]);
    expect(f.policy.canAccessCamera(f.u.nobody, f.cam["Front Entrance"])).toBe(false);
  });
  it("unions individual and group grants across overlapping groups", () => {
    expect(f.names(f.u.front)).toEqual(["Front Entrance", "Loading Dock", "Lobby Front Desk", "Reception Waiting"]);
    // Security is in both Security and Front Desk Team
    expect(f.names(f.u.sec)).toEqual(["Front Entrance", "Loading Dock", "Lobby Front Desk", "Parking Lot North", "Parking Lot South", "Rear Exit", "Reception Waiting", "Upper Stairwell"]);
  });
  it("gives administrators every camera through the explicit admin policy", () => {
    expect(f.names(f.u.admin)).toHaveLength(14);
  });
  it("hides a forbidden camera exactly like a missing one", () => {
    expect(() => f.policy.camera(f.u.front, f.cam["Server Closet"])).toThrowError(/no longer available/);
    expect(() => f.policy.camera(f.u.front, "does-not-exist")).toThrowError(/no longer available/);
  });
  it("revoking a grant and removing a group membership take effect immediately", () => {
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], false);
    expect(f.names(f.u.front)).not.toContain("Loading Dock");
    f.admin.setMember(f.actor(f.u.admin), f.g["Front Desk Team"], f.u.front, false);
    expect(f.names(f.u.front)).toEqual([]);
  });
  it("a disabled user loses everything and their sessions are revoked", () => {
    const { token } = f.sessions.create(f.u.upper, {});
    expect(f.sessions.load(token)).toBeTruthy();
    f.admin.updateUser(f.actor(f.u.admin), f.u.upper, { status: "disabled" });
    expect(f.names(f.u.upper)).toEqual([]);
    expect(f.views.accessible(f.u.upper)).toEqual([]);
    expect(f.sessions.load(token)).toBeUndefined();
  });
  it("invalidates the permission cache and notifies listeners on every change", () => {
    let hits = 0;
    f.policy.onChange(() => hits++);
    expect(f.policy.canAccessCamera(f.u.upper, f.cam["Stock Room"])).toBe(false); // cached
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.upper }, f.cam["Stock Room"], true);
    expect(hits).toBeGreaterThan(0);
    expect(f.policy.canAccessCamera(f.u.upper, f.cam["Stock Room"])).toBe(true);
  });
  it("a newly discovered camera is granted to no staff member", () => {
    syncCameras(f.db, f.policy, "default", [{ protectId: "mock-99", name: "New Camera", online: true, eventTypes: [], streams: [] }, ...f.policy.allCamerasUnchecked().map((c) => ({ protectId: c.protectId, name: c.name, online: true, eventTypes: [], streams: [] }))]);
    for (const id of [f.u.upper, f.u.front, f.u.sec, f.u.nobody]) expect(f.names(id)).not.toContain("New Camera");
    expect(f.names(f.u.admin)).toContain("New Camera");
  });
  it("keeps tags, grants and view slots when a camera is renamed or goes missing", () => {
    const rest = f.policy.allCamerasUnchecked().filter((c) => c.name !== "Upper Lounge");
    const lounge = f.policy.allCamerasUnchecked().find((c) => c.name === "Upper Lounge")!;
    const as = (c: { protectId: string; name: string }) => ({ protectId: c.protectId, name: c.name, online: true, eventTypes: [], streams: [] });
    syncCameras(f.db, f.policy, "default", [...rest.map(as), as({ protectId: lounge.protectId, name: "Lounge (renamed)" })]);
    expect(f.names(f.u.upper)).toContain("Lounge (renamed)");
    expect(f.policy.camera(f.u.upper, lounge.id).tags).toContain("upper_level");
    syncCameras(f.db, f.policy, "default", rest.map(as));
    const c = f.policy.camera(f.u.upper, lounge.id);
    expect(c.missing).toBe(true);
    expect(c.tags).toContain("indoors");
  });
});

describe("tags and views", () => {
  it("filters with AND: indoors + upper_level matches exactly four cameras", () => {
    const hit = f.policy.cameras(f.u.admin).filter((c) => ["indoors", "upper_level"].every((t) => c.tags.includes(t))).map((c) => c.name);
    expect(hit).toEqual(["Upper Hallway East", "Upper Hallway West", "Upper Lounge", "Upper Stairwell"]);
  });
  it("sharing a view never grants cameras: results are the intersection with the viewer's grants", () => {
    expect(resolveNames("Upper Level Indoors", f.u.upper)).toEqual(["Upper Hallway East", "Upper Hallway West", "Upper Lounge", "Upper Stairwell"]);
    expect(resolveNames("Upper Level Indoors", f.u.sec)).toEqual(["Upper Stairwell"]); // shared with Security, but only one camera granted
    // Building Overview mixes permitted and forbidden cameras and is shared with everyone
    expect(resolveNames("Building Overview", f.u.front)).toEqual(["Front Entrance", "Lobby Front Desk", "Loading Dock"]);
    expect(resolveNames("Building Overview", f.u.nobody)).toEqual([]);
    expect(f.names(f.u.nobody)).toEqual([]);
  });
  it("sanitizes: nothing about forbidden cameras leaks through a resolved view", () => {
    const json = JSON.stringify(f.views.resolve(f.views.get(f.viewByName()["Building Overview"])!, f.u.front));
    for (const forbidden of ["Stock Room", "Upper Lounge", "Parking Lot North", f.cam["Stock Room"], f.cam["Upper Lounge"]]) expect(json).not.toContain(forbidden);
  });
  it("dynamic views follow tag edits; a newly tagged but unauthorized camera does not appear", () => {
    const admin = f.actor(f.u.admin), tags = f.tagByName();
    f.admin.setCameraTag(admin, f.cam["Stock Room"], tags.upper_level, true); // indoors already
    expect(resolveNames("Upper Level Indoors", f.u.admin)).toContain("Stock Room");
    expect(resolveNames("Upper Level Indoors", f.u.upper)).not.toContain("Stock Room"); // matches the rule, not granted
    f.admin.setGrant(admin, { groupId: f.g["Upper Level Team"] }, f.cam["Stock Room"], true);
    expect(resolveNames("Upper Level Indoors", f.u.upper)).toContain("Stock Room");
    f.admin.setCameraTag(admin, f.cam["Upper Lounge"], tags.indoors, false);
    expect(resolveNames("Upper Level Indoors", f.u.upper)).not.toContain("Upper Lounge");
  });
  it("static views keep their order and ignore tag changes", () => {
    const before = resolveNames("Front Desk", f.u.front);
    expect(before).toEqual(["Lobby Front Desk", "Reception Waiting", "Front Entrance", "Loading Dock"]);
    f.admin.setCameraTag(f.actor(f.u.admin), f.cam["Lobby Front Desk"], f.tagByName().front_desk, false);
    expect(resolveNames("Front Desk", f.u.front)).toEqual(before);
  });
  it("lists a view once when it is shared both individually and through groups", () => {
    const id = f.viewByName()["Front Desk"];
    f.admin.setSharing(f.actor(f.u.admin), id, { all: false, userIds: [f.u.sec], groupIds: [f.g["Front Desk Team"], f.g["Security"]] });
    expect(opens(f.u.sec).filter((n) => n === "Front Desk")).toHaveLength(1);
  });
  it("revoking one share keeps access only while another valid share remains", () => {
    const id = f.viewByName()["Front Desk"], admin = f.actor(f.u.admin);
    f.admin.setSharing(admin, id, { all: false, userIds: [f.u.front], groupIds: [f.g["Front Desk Team"]] });
    f.admin.setSharing(admin, id, { all: false, userIds: [f.u.front], groupIds: [] });
    expect(opens(f.u.front)).toContain("Front Desk"); // individual share remains
    expect(opens(f.u.sec)).not.toContain("Front Desk"); // group share was the only one
    f.admin.setSharing(admin, id, { all: false, userIds: [], groupIds: [] });
    expect(opens(f.u.front)).not.toContain("Front Desk");
  });
  it("staff cannot share, edit curated views, or create views unless allowed", () => {
    const id = f.viewByName()["Front Desk"];
    expect(() => f.admin.setSharing(f.actor(f.u.front), id, { all: true, userIds: [], groupIds: [] })).toThrow();
    expect(() => f.admin.updateView(f.actor(f.u.front), id, { name: "x", type: "static", cameraIds: [] }, 1)).toThrow();
    expect(() => f.admin.createView(f.actor(f.u.upper), { name: "mine", type: "dynamic" }, "private")).toThrow(); // private views not enabled
    expect(() => f.admin.createView(f.actor(f.u.front), { name: "curated", type: "dynamic" }, "curated")).toThrow();
  });
  it("a private view can reference only cameras its owner may see", () => {
    const a = f.actor(f.u.front);
    expect(() => f.admin.createView(a, { name: "sneaky", type: "static", cameraIds: [f.cam["Server Closet"]] }, "private")).toThrowError(/no longer available/);
    const v = f.admin.createView(a, { name: "Deliveries", type: "static", cameraIds: [f.cam["Loading Dock"]] }, "private");
    expect(opens(f.u.front)).toContain("Deliveries");
    expect(opens(f.u.sec)).not.toContain("Deliveries");
    expect(f.views.resolve(v, f.u.front).cameras.map((c) => c.name)).toEqual(["Loading Dock"]);
  });
  it("rejects a concurrent edit instead of losing an update", () => {
    const id = f.viewByName()["Perimeter"], a = f.actor(f.u.admin), tags = f.tagByName();
    f.admin.updateView(a, id, { name: "Perimeter", type: "dynamic", tagIds: [tags.outdoors] }, 1);
    expect(() => f.admin.updateView(a, id, { name: "Stale", type: "dynamic", tagIds: [] }, 1)).toThrowError(/Someone else changed/);
  });
  it("refuses to delete a tag that a dynamic view depends on", () => {
    expect(() => f.admin.deleteTag(f.actor(f.u.admin), f.tagByName().restricted)).toThrowError(/Restricted Rooms/);
  });
});

describe("landing view precedence", () => {
  const land = (id: string) => { const l = f.views.landing(id); return [l.viewId ? f.views.get(l.viewId)!.name : null, l.reason]; };
  it("uses group defaults, then the organization default", () => {
    expect(land(f.u.upper)).toEqual(["Upper Level Indoors", "group"]);
    expect(land(f.u.nobody)).toEqual(["Building Overview", "org"]);
  });
  it("picks the competing group default with the highest priority, ties by group id", () => {
    expect(land(f.u.sec)).toEqual(["Perimeter", "group"]); // Security (40) beats Front Desk Team (20)
    const a = f.actor(f.u.admin);
    f.admin.updateGroup(a, f.g["Front Desk Team"], { defaultPriority: 40 });
    const first = [f.g["Front Desk Team"], f.g["Security"]].sort()[0];
    expect(f.views.landing(f.u.sec).groupId).toBe(first);
  });
  it("an administrator-assigned individual default wins over everything", () => {
    f.admin.setDefault(f.actor(f.u.admin), { scope: "user", userId: f.u.sec }, f.viewByName()["Building Overview"]);
    expect(land(f.u.sec)).toEqual(["Building Overview", "user"]);
  });
  it("a personal default applies only below administrator and group defaults", () => {
    const a = f.actor(f.u.front);
    const v = f.admin.createView(a, { name: "Deliveries", type: "static", cameraIds: [f.cam["Loading Dock"]] }, "private");
    f.admin.setDefault(a, { scope: "personal" }, v.id);
    expect(land(f.u.front)).toEqual(["Front Desk", "group"]);
    f.admin.setDefault(f.actor(f.u.admin), { scope: "group", groupId: f.g["Front Desk Team"] }, null);
    expect(land(f.u.front)).toEqual(["Deliveries", "personal"]);
  });
  it("validates assignments: a default must be openable by its target", () => {
    const a = f.actor(f.u.admin), v = f.viewByName();
    expect(() => f.admin.setDefault(a, { scope: "user", userId: f.u.upper }, v["Restricted Rooms"])).toThrowError(/Share this view with them first/);
    expect(() => f.admin.setDefault(a, { scope: "group", groupId: f.g["Upper Level Team"] }, v["Perimeter"])).toThrowError(/Share this view/);
    expect(() => f.admin.setDefault(a, { scope: "org" }, v["Perimeter"])).toThrowError(/with everyone first/);
    expect(() => f.admin.setDefault(f.actor(f.u.front), { scope: "user", userId: f.u.front }, v["Front Desk"])).toThrow(); // staff cannot set admin defaults
  });
  it("falls back safely when a default is unshared or deleted", () => {
    const a = f.actor(f.u.admin), v = f.viewByName();
    f.admin.setSharing(a, v["Upper Level Indoors"], { all: false, userIds: [], groupIds: [] });
    expect(land(f.u.upper)).toEqual(["Building Overview", "org"]);
    f.admin.deleteView(a, v["Building Overview"]);
    expect(land(f.u.upper)).toEqual([null, "wall"]);
    expect(land(f.u.nobody)).toEqual([null, "none"]);
    expect(f.db.select().from(schema.defaultViews).all().some((d) => d.viewId === v["Building Overview"])).toBe(false);
  });
  it("an accessible default that resolves to zero cameras stays empty rather than borrowing cameras", () => {
    const l = f.views.landing(f.u.nobody);
    expect(f.views.resolve(f.views.get(l.viewId!)!, f.u.nobody).cameras).toEqual([]);
  });
});
