import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/server/authz/actor";
import { syncCameras } from "@/server/cameras";
import { schema } from "@/server/db";
import { makeFixture, type Fixture } from "@/server/testing/fixture";
import { hashToken } from "@/server/util";

let f: Fixture;
beforeEach(() => {
  f = makeFixture(); // its media relay is in memory, so the sweeps the signal starts stay off the network
});

/** Front Desk signed in on their own session. */
function own(): Actor {
  return f.actor(f.u.front, { sessionId: f.sessions.create(f.u.front, {}).session.id });
}
/** The administrator previewing Front Desk ("See as staff"). */
function previewing(): Actor {
  const admin = f.actor(f.u.admin, { sessionId: f.sessions.create(f.u.admin, {}).session.id });
  const { token } = f.previews.start(admin, f.u.front);
  return { ...admin, preview: { id: hashToken(token), subjectId: f.u.front } };
}
const asAdmin = () => f.actor(f.u.admin);

interface Case {
  name: string;
  /** Who holds the access. */
  as: () => Actor;
  /** Front Desk sees this one through a personal grant ("Loading Dock") or a group ("Front Entrance"). */
  camera: string;
  /** The thing that happens in the world. */
  when: (a: Actor) => void;
  /** True when nothing but the clock moved, so the timer has to turn it into a signal. */
  timed?: boolean;
  /** Whether access that is not tied to a camera (the event feed) survives. */
  feedSurvives: boolean;
}
const past = () => Date.now() - 1;
const cases: Case[] = [
  { name: "session revoked", as: own, camera: "Loading Dock", when: (a) => f.sessions.revoke(a.sessionId, "logout"), feedSurvives: false },
  { name: "session replaced at sign-in", as: own, camera: "Loading Dock", when: (a) => f.sessions.create(a.userId, { replaces: a.sessionId }), feedSurvives: false },
  { name: "session idle-expired", as: own, camera: "Loading Dock", when: (a) => f.db.update(schema.sessions).set({ idleExpiresAt: past() }).where(eq(schema.sessions.id, a.sessionId)).run(), timed: true, feedSurvives: false },
  { name: "session past its absolute limit", as: own, camera: "Loading Dock", when: (a) => f.db.update(schema.sessions).set({ absoluteExpiresAt: past() }).where(eq(schema.sessions.id, a.sessionId)).run(), timed: true, feedSurvives: false },
  { name: "preview ended", as: previewing, camera: "Loading Dock", when: (a) => f.previews.end(a), feedSurvives: false },
  { name: "preview timed out", as: previewing, camera: "Loading Dock", when: (a) => f.db.update(schema.previewContexts).set({ expiresAt: past() }).where(eq(schema.previewContexts.id, a.preview!.id)).run(), timed: true, feedSurvives: false },
  { name: "administrator's session revoked during a preview", as: previewing, camera: "Loading Dock", when: (a) => f.sessions.revoke(a.sessionId, "logout"), feedSurvives: false },
  { name: "subject disabled", as: own, camera: "Loading Dock", when: () => f.admin.updateUser(asAdmin(), f.u.front, { status: "disabled" }), feedSurvives: false },
  { name: "previewed subject disabled", as: previewing, camera: "Loading Dock", when: () => f.admin.updateUser(asAdmin(), f.u.front, { status: "disabled" }), feedSurvives: false },
  { name: "grant removed", as: own, camera: "Loading Dock", when: () => f.admin.setGrant(asAdmin(), { userId: f.u.front }, f.cam["Loading Dock"], false), feedSurvives: true },
  { name: "grant removed from the previewed subject", as: previewing, camera: "Loading Dock", when: () => f.admin.setGrant(asAdmin(), { userId: f.u.front }, f.cam["Loading Dock"], false), feedSurvives: true },
  { name: "group membership removed", as: own, camera: "Front Entrance", when: () => f.admin.setMember(asAdmin(), f.g["Front Desk Team"], f.u.front, false), feedSurvives: true },
  { name: "camera gone", as: own, camera: "Loading Dock", when: () => { f.db.delete(schema.cameras).where(eq(schema.cameras.id, f.cam["Loading Dock"])).run(); f.policy.invalidate(); }, feedSurvives: true },
];

describe("standing access", () => {
  it.each(cases)("$name: the grant stops holding and every holder is told", (c) => {
    const { access } = f.s, actor = c.as();
    const onCamera = access.grant(actor, f.cam[c.camera]), feed = access.grant(actor);
    expect(access.holds(onCamera)).toBe(true);
    expect(access.holds(feed)).toBe(true);
    expect(access.heldBy(onCamera, actor)).toBe(true);
    let signals = 0;
    const seenByHolder: boolean[] = [];
    access.onChange(() => { signals++; seenByHolder.push(access.holds(onCamera)); });

    c.when(actor);

    expect(access.holds(onCamera)).toBe(false); // the answer is right even before anyone is told
    expect(access.heldBy(onCamera, actor)).toBe(false);
    expect(access.holds(feed)).toBe(c.feedSurvives);
    if (c.timed) {
      expect(signals).toBe(0);
      access.expireDue(); // what the revocation timer does
    }
    expect(signals).toBeGreaterThan(0);
    expect(seenByHolder.at(-1)).toBe(false); // a holder that re-checks on the signal sees the loss
  });

  it("records what the access was given for: session, effective subject, preview and camera", () => {
    const a = own(), p = previewing(), cam = f.cam["Loading Dock"];
    expect(f.s.access.grant(a, cam)).toEqual({ sessionId: a.sessionId, subjectId: f.u.front, previewId: undefined, cameraId: cam });
    expect(f.s.access.grant(p, cam)).toEqual({ sessionId: p.sessionId, subjectId: f.u.front, previewId: p.preview!.id, cameraId: cam });
    expect(f.s.access.grant(p).cameraId).toBeUndefined();
  });

  it("denies by default: unknown sessions, previews, subjects and cameras never hold", () => {
    const { access } = f.s, a = own(), cam = f.cam["Loading Dock"], g = access.grant(a, cam);
    expect(access.holds({ ...g, sessionId: "no-such-session" })).toBe(false);
    expect(access.holds({ ...g, previewId: "no-such-preview" })).toBe(false);
    expect(access.holds({ ...g, subjectId: "no-such-user" })).toBe(false);
    expect(access.holds({ ...g, cameraId: "no-such-camera" })).toBe(false);
    expect(access.holds({ ...g, cameraId: f.cam["Server Closet"] })).toBe(false); // exists, not granted
    expect(access.holds({ ...g, subjectId: f.u.nobody })).toBe(false);
  });

  it("a grant belongs to the session and subject it was made for", () => {
    const { access } = f.s, a = own(), admin = previewing(), cam = f.cam["Loading Dock"];
    const g = access.grant(a, cam), pg = access.grant(admin, cam);
    expect(access.heldBy(g, own())).toBe(false); // same person, another session
    expect(access.heldBy(g, admin)).toBe(false); // same subject through a preview, another session
    expect(access.heldBy(pg, { ...admin, preview: undefined })).toBe(false); // the administrator outside the preview is another subject
    expect(access.heldBy(pg, admin)).toBe(true);
  });

  it("an unrelated change signals but leaves the grant holding", () => {
    const { access } = f.s, g = access.grant(own(), f.cam["Loading Dock"]);
    let signals = 0;
    access.onChange(() => signals++);
    f.admin.setGrant(asAdmin(), { userId: f.u.upper }, f.cam["Stock Room"], true);
    f.sessions.revokeUser(f.u.upper, "logout"); // no session to end: nothing happened
    expect(signals).toBe(1);
    expect(access.holds(g)).toBe(true);
  });

  it("a session suspended while the identity provider cannot be reached does not hold, and holds again once re-validated", () => {
    const { access } = f.s;
    const { session } = f.sessions.create(f.u.front, { refreshToken: "rt" });
    const g = access.grant(f.actor(f.u.front, { sessionId: session.id }), f.cam["Loading Dock"]);
    expect(access.holds(g)).toBe(true);
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 1_801_000 }).where(eq(schema.sessions.id, session.id)).run();
    expect(access.holds(g)).toBe(false);
    access.expireDue();
    expect(f.sessions.byId(session.id)!.revokedAt).toBeNull(); // suspended, not ended
    f.sessions.markValidated(session.id);
    expect(access.holds(g)).toBe(true);
  });

  it("unsubscribing stops the signal, and one failing listener does not silence the others", () => {
    const { access } = f.s, a = own();
    let kept = 0, dropped = 0;
    access.onChange(() => { throw new Error("broken holder"); });
    access.onChange(() => kept++);
    const off = access.onChange(() => dropped++);
    off();
    f.sessions.revoke(a.sessionId, "logout");
    expect(kept).toBe(1);
    expect(dropped).toBe(0);
  });
});

describe("camera sync and the access signal", () => {
  const inventory = () => f.policy.allCamerasUnchecked().filter((c) => !c.missing).map((c) => ({ protectId: c.protectId, name: c.name, online: true, eventTypes: [], streams: [] }));
  it("signals when a camera appears, goes missing or returns, and stays quiet otherwise", () => {
    let signals = 0;
    f.s.access.onChange(() => signals++);
    const all = inventory();
    syncCameras(f.db, f.policy, "default", all); // metadata differs from the fixture's: described, not signalled
    syncCameras(f.db, f.policy, "default", all); // identical
    expect(signals).toBe(0);

    syncCameras(f.db, f.policy, "default", all.map((c, i) => (i ? c : { ...c, name: "Renamed" })));
    expect(signals).toBe(0);
    expect(f.policy.allCamerasUnchecked().some((c) => c.name === "Renamed")).toBe(true); // the description is still fresh

    syncCameras(f.db, f.policy, "default", all.slice(1)); // one disappears from the recorder
    expect(signals).toBe(1);
    syncCameras(f.db, f.policy, "default", all.slice(1)); // still missing: nothing new
    expect(signals).toBe(1);
    syncCameras(f.db, f.policy, "default", all); // back
    expect(signals).toBe(2);
    syncCameras(f.db, f.policy, "default", [...all, { protectId: "mock-99", name: "New Camera", online: true, eventTypes: [], streams: [] }]);
    expect(signals).toBe(3);
    expect(f.names(f.u.admin)).toContain("New Camera"); // the administrator's cached camera set was dropped
  });
});
