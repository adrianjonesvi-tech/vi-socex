import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { SnapshotRefused, listSnapshots, takeSnapshot } from "../lib/snapshot.mts";

// On-demand snapshot of the signed-in user's workspace (see lib/snapshot.mts).
//   POST { reason? } → takes one now and returns its manifest (500 if any copy
//                      failed — callers such as the import must stop then)
//   GET              → this workspace's snapshots, newest first
// Only ever reads and copies the caller's own workspace.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const snapshots = await listSnapshots(getStore, session.tenantId);
    return json({ snapshots: snapshots.map(({ sections, ...m }: any) => ({ ...m, sectionCount: sections.length })) });
  }

  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { /* reason is optional */ }
    try {
      const manifest = await takeSnapshot(getStore, session.tenantId, { createdBy: session.email || "", reason: body && body.reason });
      console.log(`snapshot: ${session.email} took ${manifest.id} of ${session.tenantId} (${manifest.sections.length} sections, ${manifest.totalBytes} bytes)${manifest.reason ? ` — ${manifest.reason}` : ""}`);
      return json({ ok: true, snapshot: manifest });
    } catch (err: any) {
      if (err instanceof SnapshotRefused) return json({ ok: false, error: err.message }, 429);
      console.log(`snapshot: FAILED for ${session.tenantId}: ${err && err.message}`);
      return json({ ok: false, error: "Couldn't take a snapshot of your data, so nothing else was changed. Try again in a moment." }, 500);
    }
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/snapshot",
};
