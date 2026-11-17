import { eq } from "drizzle-orm";
import { config } from "../config";
import { schema, type Db } from "../db";
import type { CameraLogin, DirectCheck } from "../protect/types";
import { decrypt, log } from "../util";

/** How long a camera that failed to send video directly is read through the recorder instead. */
export const DIRECT_RETRY_MS = 2 * 60_000;

/** What an administrator sees when a camera can't be read directly. */
export const DIRECT_PROBLEM: Record<Exclude<DirectCheck, { ok: true }>["reason"] | "no_login", string> = {
  unsupported: "This camera can only stream through the recorder.",
  unreachable: "Can't reach the camera. Check that it's on and connected.",
  login: "The camera didn't accept the username or password.",
  no_stream: "The camera didn't send any video.",
  video_format: "The camera sends video in a format browsers can't play. Set it to H.264 in the camera's settings.",
  no_login: "Enter the camera's username and password.",
};

/**
 * Which cameras are read directly, and with which login. Settings are written by `Admin`; this only
 * reads them, and remembers cameras that recently failed so viewers fall back to the recorder.
 */
export class DirectVideo {
  private down = new Map<string, number>();
  constructor(private db: Db) {}

  private row(cameraId: string) {
    return this.db.select().from(schema.cameraDirect).where(eq(schema.cameraDirect.cameraId, cameraId)).get();
  }

  /** The login to use for a camera from stored settings plus a pending change, or null when there is none. */
  resolve(stored: { username: string | null; passwordEnc: string | null } | undefined, patch: { username?: string | null; password?: string | null } = {}): CameraLogin | null {
    const c = config();
    const username = (patch.username !== undefined ? patch.username : stored?.username) || c.DEFAULT_CAMERA_USERNAME;
    let password: string | undefined;
    if (patch.password) password = patch.password;
    else if (patch.password === undefined && stored?.passwordEnc) {
      try { password = decrypt(stored.passwordEnc, c.TOKEN_ENC_KEY ?? ""); } catch { log("warn", "camera password could not be read; check TOKEN_ENC_KEY"); return null; }
    } else password = c.DEFAULT_CAMERA_PASSWORD;
    return username ? { username, password: password ?? "" } : null;
  }

  /** The login for a camera switched to direct video, or null to use the recorder's stream. */
  login(cameraId: string): CameraLogin | null {
    const r = this.row(cameraId);
    if (!r?.enabled) return null;
    const until = this.down.get(cameraId);
    if (until && Date.now() < until) return null;
    this.down.delete(cameraId);
    return this.resolve(r);
  }

  /** Whether the camera is set to stream directly, even if it is falling back to the recorder right now. */
  enabled(cameraId: string) { return !!this.row(cameraId)?.enabled; }

  /** What the admin page needs, without passwords. */
  settings() {
    return this.db.select().from(schema.cameraDirect).all().map((r) => ({ cameraId: r.cameraId, enabled: r.enabled, username: r.username, ownPassword: !!r.passwordEnc }));
  }
  stored(cameraId: string) { return this.row(cameraId); }

  /** The camera didn't send video directly: use the recorder for a while. */
  failed(cameraId: string) {
    if (!this.down.has(cameraId)) log("warn", "direct camera video failed; using the recorder for now", { cameraId });
    this.down.set(cameraId, Date.now() + DIRECT_RETRY_MS);
  }
  /** Settings changed: try the camera again on the next view. */
  reset(cameraId: string) { this.down.delete(cameraId); }
}
