import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { SEND_JOBS_STORE, suppressedEmails, unsubscribeUrl, withFooter } from "../lib/email.mts";

// Background function (answers 202 immediately, runs up to 15 minutes). Sends
// a job queued by send-email.mts through Resend's batch endpoint, 100 emails
// per call, each with its own unsubscribe link and one-click unsubscribe
// headers. Progress is saved after every batch so send-status.mts can report
// it, and so a re-run carries on from where it stopped instead of starting over.
// Idempotency keys make Resend ignore a batch it has already accepted.

const BATCH = 100;
const TIME_BUDGET_MS = 13 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function resend(apiKey: string, path: string, payload: unknown, idempotencyKey: string) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`https://api.resend.com${path}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    if (resp.status === 429 && attempt < 5) {
      const wait = Number(resp.headers.get("retry-after")) || 2 ** attempt;
      await sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    return resp;
  }
}

async function reason(resp: Response) {
  const body = await resp.json().catch(() => ({}));
  return (body as any).message || `Resend returned ${resp.status}`;
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return new Response("unauthorized", { status: 401 });
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return new Response("unauthorized", { status: 401 });

  let jobId: string;
  try {
    ({ jobId } = await req.json());
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  const jobs = getStore(SEND_JOBS_STORE);
  const job = jobId ? await jobs.get(jobId, { type: "json" }) : null;
  if (!job || job.tenantId !== session.tenantId) return new Response("not found", { status: 404 });
  if (job.status === "done") return new Response("ok");

  const apiKey = Netlify.env.get("RESEND_KEY");
  const fromAddress = (Netlify.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev").trim();
  const fromName = (Netlify.env.get("RESEND_FROM_NAME") || "").trim();
  const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
  const started = Date.now();
  const save = () => jobs.setJSON(jobId, job);

  try {
    if (!apiKey) throw new Error("Email sending isn't configured (no RESEND_KEY).");
    job.status = "sending";
    job.startedAt = job.startedAt || started;
    job.suppressedLate = job.suppressedLate || [];
    await save();

    // Someone may have unsubscribed between queueing and now.
    const blocked = await suppressedEmails(getStore, job.tenantId);

    while (job.next < job.recipients.length) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        job.status = "partial";
        job.error = `Stopped after ${job.next} of ${job.recipients.length} because sending took too long. The rest were not sent.`;
        break;
      }
      const start = job.next;
      const end = Math.min(start + BATCH, job.recipients.length);
      const emails: any[] = [];
      const indexes: number[] = [];
      for (let i = start; i < end; i++) {
        const to = job.recipients[i];
        if (blocked.has(to)) { job.suppressedLate.push(to); continue; }
        const link = unsubscribeUrl(job.baseUrl, jobId, i, job.secret);
        emails.push({
          from,
          to: [to],
          subject: job.subject,
          text: withFooter(job.message, job.senderName, link),
          headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        indexes.push(i);
      }

      if (emails.length) {
        const resp = await resend(apiKey, "/emails/batch", emails, `${jobId}-b${start}`);
        if (resp.ok) {
          job.sent += emails.length;
        } else {
          // A batch is accepted or rejected as a whole. Send this one's emails
          // individually so one bad address doesn't stop the other 99.
          const batchReason = await reason(resp);
          console.log(`send-email batch ${start} rejected (${resp.status}): ${batchReason}; sending individually`);
          for (let k = 0; k < emails.length; k++) {
            const one = await resend(apiKey, "/emails", emails[k], `${jobId}-${indexes[k]}`);
            if (one.ok) job.sent++;
            else job.failed.push({ email: emails[k].to[0], reason: await reason(one) });
          }
        }
      }
      job.next = end;
      await save();
    }
    if (job.status === "sending") job.status = "done";
  } catch (err: any) {
    job.status = "error";
    job.error = err?.message || "Sending failed";
  }
  job.completedAt = Date.now();
  await save();
  console.log(`send-email job ${jobId}: ${job.status}, sent ${job.sent}/${job.recipients.length}, failed ${job.failed.length}`);
  return new Response("ok");
};

export const config: Config = {
  path: "/api/send-email-background",
};
