/**
 * Everything Unifeye needs from UniFi Protect, and nothing else. The contract is read-only:
 * there is no method that changes camera settings, recordings, retention, events or Protect users.
 * `mock.ts` and `unifi.ts` both implement it, so the application never knows which one it has.
 */
export type EventType = "motion" | "person" | "vehicle" | "package" | "animal" | "ring" | "licensePlate" | "audio" | "other";
export const EVENT_TYPES: EventType[] = ["motion", "person", "vehicle", "package", "animal", "ring", "licensePlate", "audio", "other"];

export interface ProtectCamera {
  protectId: string;
  name: string;
  online: boolean;
  model?: string;
  /** Detection types this camera can report. Used to tell "unsupported" apart from "no results". */
  eventTypes: EventType[];
  /** Streams that are already enabled on the camera. Unifeye never enables one itself. */
  streams: { quality: "high" | "medium" | "low"; width: number; height: number; codec?: string }[];
  /** Outer bounds of what the recorder holds for this camera, when known. */
  recordingStartMs?: number;
  recordingEndMs?: number;
}
export interface ProtectEvent {
  id: string;
  protectCameraId: string;
  type: EventType;
  startMs: number;
  endMs: number | null;
  hasThumbnail: boolean;
}
export type LiveSource =
  /**
   * An RTSP(S) URL that MediaMTX pulls on demand. Contains upstream credentials or secrets: server-side only.
   * `retimeAudio`: the stream may carry sound whose timestamps browsers cannot play (Protect stamps
   * its audio packets in milliseconds against a 16 or 48 kHz clock), so the relay re-encodes the
   * sound with timestamps rebuilt from the sample count. Video is passed through untouched.
   */
  | { kind: "rtsp"; url: string; tlsFingerprint?: string; retimeAudio?: boolean }
  /** A command MediaMTX runs on demand to publish into the path (used by the mock adapter). */
  | { kind: "command"; command: string };
export interface RecordingRanges {
  ranges: [startMs: number, endMs: number][];
  /** `exact`: gaps are known. `bounds`: only the outer limits are known; gaps surface when a seek fails. */
  precision: "exact" | "bounds";
}
export interface AdapterHealth {
  mode: "mock" | "real";
  state: "connected" | "connecting" | "down";
  lastOkAt: number | null;
  lastError: string | null;
  protectVersion: string | null;
}
export interface EventQuery {
  protectCameraIds: string[];
  fromMs: number;
  toMs: number;
  types?: EventType[];
  limit: number;
}
export class ProtectUnavailableError extends Error {}
export class NoRecordingError extends Error { override name = "NoRecordingError"; }
/**
 * The recorder answered an export with a server error, a timeout or "too many requests" (`status`).
 * Unlike NoRecordingError, this says nothing about what was recorded, so it is worth trying again.
 */
export class RecorderBusyError extends ProtectUnavailableError {
  override name = "RecorderBusyError";
  constructor(readonly status: number) { super(`recorder answered ${status}`); }
}
// Matched by name as well, because the server bundles these modules more than once.
export const isNoRecording = (e: unknown) => e instanceof NoRecordingError || (e as Error)?.name === "NoRecordingError";
export const isRecorderBusy = (e: unknown) => e instanceof RecorderBusyError || (e as Error)?.name === "RecorderBusyError";

export interface ProtectAdapter {
  readonly mode: "mock" | "real";
  readonly nvrId: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  health(): AdapterHealth;
  listCameras(): Promise<ProtectCamera[]>;
  /** Protect ids of cameras writing video to the recorder at this moment (continuous, motion or schedule). */
  recordingNow(): Promise<string[]>;
  /** JPEG. `atMs` requests a still from the recording near that time, where supported. */
  snapshot(protectCameraId: string, opts?: { width?: number; atMs?: number; signal?: AbortSignal }): Promise<Buffer>;
  liveSource(protectCameraId: string, quality: "wall" | "focus"): Promise<LiveSource | null>;
  recordingRanges(protectCameraId: string, fromMs: number, toMs: number): Promise<RecordingRanges>;
  /** Writes an MP4 covering [startMs, endMs) to `destPath`. Throws NoRecordingError when nothing was recorded. */
  exportClip(protectCameraId: string, startMs: number, endMs: number, destPath: string, opts?: { quality?: "wall" | "focus"; signal?: AbortSignal }): Promise<void>;
  /** Newest first. The caller has already reduced `protectCameraIds` to authorized cameras. */
  listEvents(q: EventQuery): Promise<ProtectEvent[]>;
  getEvent(id: string): Promise<ProtectEvent | null>;
  eventThumbnail(id: string, signal?: AbortSignal): Promise<Buffer | null>;
  /** Live events. Returns an unsubscribe function. Must resynchronize after reconnects without duplicating ids. */
  subscribeEvents(cb: (e: ProtectEvent) => void): () => void;
}
