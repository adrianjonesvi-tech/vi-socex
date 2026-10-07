import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { SEND_JOBS_STORE } from "../lib/email.mts";

// Polled by the frontend while send-email-background.mts runs. Only the
// workspace that started a send can read it, and the job's signing secret and
// full recipient list are never returned.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return json({ error: "jobId is required" }, 400);

  const job = await getStore(SEND_JOBS_STORE).get(jobId, { type: "json" });
  if (!job || job.tenantId !== session.tenantId) return json({ error: "not found" }, 404);
  return json({
    status: job.status,
    total: job.recipients.length,
    processed: job.next,
    sent: job.sent,
    failed: job.failed,
    suppressedLate: job.suppressedLate || [],
    error: job.error || null,
  });
};

export const config: Config = {
  path: "/api/send-status",
};
