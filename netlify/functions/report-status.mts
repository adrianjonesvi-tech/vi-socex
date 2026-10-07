import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Polled by the frontend while market-report-background.mts runs. Returns
// whatever's currently stored for the job — pending (nothing written yet),
// done (with the report), or error. Only the workspace that started a job
// can read it.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return json({ error: "jobId is required" }, 400);

  const jobsStore = getStore("visocex-report-jobs");
  const job = await jobsStore.get(jobId, { type: "json" });
  if (!job) return json({ status: "pending" });
  if (job.tenantId !== session.tenantId) return json({ error: "not found" }, 404);
  return json(job);
};

export const config: Config = {
  path: "/api/report-status",
};
