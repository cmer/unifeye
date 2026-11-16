import { handleApi } from "@/server/api";

// Database, Protect and media access all need the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleApi;
export const POST = handleApi;
export const PUT = handleApi;
export const PATCH = handleApi;
export const DELETE = handleApi;
