/**
 * Who is making a request. `userId` is always the authenticated person (from the server-side
 * session, never from client input). During "See as staff", `preview.subjectId` names the staff
 * member whose permissions are being previewed; the administrator remains the actor.
 */
export interface Actor {
  userId: string;
  role: "admin" | "staff";
  sessionId: string;
  preview?: { id: string; subjectId: string };
  requestId?: string;
  ip?: string;
}
/** The user whose permissions decide what is visible. Use this for every read. */
export const subjectOf = (a: Actor) => a.preview?.subjectId ?? a.userId;
