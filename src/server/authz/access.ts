import type { Sessions } from "../auth/session";
import { log } from "../util";
import { subjectOf, type Actor } from "./actor";
import type { Policy } from "./policy";
import type { Previews } from "./preview";

/**
 * A record of access that was handed out and outlives the request that asked for it: a relay
 * reader, a WHEP resource, a clip download, an event feed. It holds ids only, so it can sit in
 * memory or in a table row (`export_jobs`) and be re-checked at any later time.
 * `cameraId` is absent for access that is not tied to one camera (the event feed).
 */
export interface Grant { sessionId: string; subjectId: string; previewId?: string; cameraId?: string; /** A permission beyond seeing the camera that must still hold. */ needs?: "clipExport" }
export type CameraGrant = Grant & { cameraId: string };

/**
 * Standing access: the one place that answers "is this access still good?" and the one signal
 * that says "ask again".
 *
 * A grant holds while all of these are true:
 *  - its session is live (not revoked, inside its idle and absolute limits, its user active,
 *    re-validated with the identity provider recently enough);
 *  - if it was made during "See as staff", that preview is live (not ended or timed out, the
 *    administrator is still one, the subject is still active staff);
 *  - if it names a camera, the subject can still see it according to Policy;
 *  - if it needs a permission (`needs`), the subject still has it according to Policy.
 * Anything that cannot be resolved denies.
 *
 * `onChange` listeners run after every event that can make a grant stop holding: a policy cache
 * invalidation (grants, groups, users, cameras), a session ending and a preview ending. Limits that
 * merely pass with time produce no event of their own; `expireDue()` turns them into one and is
 * called on the revocation timer. Holders re-check with `holds`; the signal carries no detail.
 */
export class Access {
  private listeners = new Set<() => void>();

  constructor(private policy: Policy, private sessions: Sessions, private previews: Previews) {
    const changed = () => this.changed();
    policy.onChange(changed);
    sessions.onEnd(changed);
    previews.onEnd(changed);
  }

  /** The grant for what this actor is being given now. The caller has already authorized it. */
  grant(a: Actor, cameraId: string): CameraGrant;
  grant(a: Actor): Grant;
  grant(a: Actor, cameraId?: string): Grant {
    return { sessionId: a.sessionId, subjectId: subjectOf(a), previewId: a.preview?.id, cameraId };
  }

  /** Whether the grant is still good right now. Read-only and safe to call from a listener. */
  holds(g: Grant): boolean {
    try {
      return this.sessions.isLive(g.sessionId) && (!g.previewId || this.previews.isLive(g.previewId)) && (g.cameraId === undefined || this.policy.canAccessCamera(g.subjectId, g.cameraId)) && (g.needs !== "clipExport" || this.policy.canExportClips(g.subjectId));
    } catch { return false; }
  }
  /** `holds`, and the grant was made for this actor's session and subject. Use when a client presents an id. */
  heldBy(g: Grant, a: Actor): boolean {
    return g.sessionId === a.sessionId && g.subjectId === subjectOf(a) && this.holds(g);
  }

  /** Subscribes to "access may have changed". Returns the unsubscribe function. */
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  /** Ends sessions and previews whose time limit has passed, which fires the signal if any did. */
  expireDue() {
    this.sessions.expireDue();
    this.previews.expireDue();
  }

  private changed() {
    // One failing holder must never keep the others from hearing about a revocation.
    for (const fn of [...this.listeners]) try { fn(); } catch (e) { log("error", "access listener failed", { error: e }); }
  }
}
