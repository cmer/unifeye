/** Runs once when the server starts: migrations, recorder connection and background jobs. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startRuntime } = await import("./server/services");
  await startRuntime();
}
