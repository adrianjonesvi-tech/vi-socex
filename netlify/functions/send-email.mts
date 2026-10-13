import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomBytes, randomUUID } from "node:crypto";
import { SEND_JOBS_STORE, MAX_RECIPIENTS, isValidEmail, normEmail, senderStatus, suppressedEmails } from "../lib/email.mts";

// Queues a marketing email send via Resend (https://resend.com). Needs a
// RESEND_KEY environment variable set in the Netlify site — without it, this
// endpoint tells the caller clearly rather than pretending to have sent anything.
//
// The actual sending happens in send-email-background.mts (up to 15 minutes),
// because sending one by one inside this request timed out after a few dozen
// recipients. This request checks the recipients, drops anyone who has
// unsubscribed or is suppressed, saves the job, and starts the background
// sender. The browser then polls send-status.mts for progress.
//
// Setup, once you're ready:
//   1. Create a free Resend account and verify a sending domain (or use
//      their sandbox address for testing — see note below).
//   2. Create an API key in Resend's dashboard.
//   3. Add it as an environment variable named RESEND_KEY on this
//      Netlify site (Site configuration -> Environment variables).
//   4. Optionally set RESEND_FROM_EMAIL once your own domain is verified
//      (e.g. "surveys@yourcompany.com"). Until then this falls back to
//      Resend's shared sandbox address, which Resend only allows sending
//      to the email address on the Resend account itself — fine for
//      testing, not for real recipients.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Only signed-in users can send — otherwise anyone could use this endpoint
  // to send arbitrary email from our verified sending address.
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  if (!Netlify.env.get("RESEND_KEY")) {
    return json({ error: "Email sending isn't configured yet — add a RESEND_KEY environment variable to this Netlify site to enable it.", needsSetup: true }, 501);
  }

  let body: { recipients?: string[]; subject?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const { recipients, subject, message } = body;
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) return json({ error: "No recipients provided" }, 400);
  if (!subject || !message) return json({ error: "Subject and message are required" }, 400);

  const skipped: string[] = [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    if (typeof r !== "string" || !isValidEmail(r)) { skipped.push(String(r)); continue; }
    const e = normEmail(r);
    if (!seen.has(e)) { seen.add(e); unique.push(e); }
  }

  if (unique.length === 0) {
    return json({ queued: 0, skipped, suppressed: [], error: "None of the recipients look like valid email addresses — a name alone isn't enough, an actual email is needed." }, 200);
  }
  if (unique.length > MAX_RECIPIENTS) {
    return json({ error: `That's ${unique.length} addresses — the limit is ${MAX_RECIPIENTS} per send. Split it into smaller groups.` }, 400);
  }

  // Every workspace sends under its own name, from its own address, on a domain
  // that belongs to it and is verified with Resend (Company Info → Email sender).
  const sender = await senderStatus(getStore, Netlify.env.get("RESEND_KEY")!, session.tenantId);
  if (!sender.ready) {
    return json({ error: sender.problem.message, senderProblem: sender.problem.code }, 400);
  }
  const { name: senderName, address: senderAddress } = sender.sender;

  const blocked = await suppressedEmails(getStore, session.tenantId);
  const suppressed = unique.filter(e => blocked.has(e));
  const toSend = unique.filter(e => !blocked.has(e));
  if (toSend.length === 0) {
    return json({ queued: 0, skipped, suppressed, error: "Everyone on this list has unsubscribed, is suppressed, or has no recorded consent basis — nothing was sent." }, 200);
  }

  const jobId = randomUUID();
  const jobs = getStore(SEND_JOBS_STORE);
  await jobs.setJSON(jobId, {
    id: jobId,
    tenantId: session.tenantId,
    createdBy: session.email || "",
    createdAt: Date.now(),
    senderName,
    senderAddress,
    // Unsubscribe links point back at whichever site sent the email.
    baseUrl: new URL(req.url).origin,
    subject,
    message,
    recipients: toSend,
    // Signs this job's unsubscribe links. Never returned to the browser.
    secret: randomBytes(32).toString("hex"),
    status: "queued",
    next: 0,
    sent: 0,
    failed: [],
  });

  // Background functions answer 202 straight away and carry on running.
  try {
    const kick = await fetch(new URL("/api/send-email-background", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Token": token },
      body: JSON.stringify({ jobId }),
    });
    if (kick.status !== 202 && !kick.ok) throw new Error(`background sender returned ${kick.status}`);
  } catch (err: any) {
    await jobs.setJSON(jobId, { ...(await jobs.get(jobId, { type: "json" })), status: "error", error: "Couldn't start sending — try again." });
    return json({ error: "Couldn't start sending — try again." }, 502);
  }

  return json({ jobId, queued: toSend.length, skipped, suppressed });
};

export const config: Config = {
  path: "/api/send-email",
};
