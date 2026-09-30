import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Polled by the frontend while market-report-background.mts runs. Returns
// whatever's currently stored for the job — pending (nothing written yet),
// done (with the report), or error.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return json({ error: "jobId is required" }, 400);

  const jobsStore = getStore("visocex-report-jobs");
  const job = await jobsStore.get(jobId, { type: "json" });
  if (!job) return json({ status: "pending" });
  return json(job);
};

export const config: Config = {
  path: "/api/report-status",
};
