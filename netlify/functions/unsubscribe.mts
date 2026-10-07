import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { SEND_JOBS_STORE, SUPPRESSION_STORE, checkSignature, suppressionKey } from "../lib/email.mts";

// Public unsubscribe page linked from every marketing email (no login).
//   GET  shows a confirmation button. It doesn't unsubscribe by itself, because
//        mail security scanners open links in emails automatically.
//   POST unsubscribes. Mail apps' one-click "Unsubscribe" (RFC 8058) posts here
//        directly via the List-Unsubscribe headers send-email-background adds.
// The link carries the send job, the recipient's position in it, and a
// signature, so the email address itself never appears in the URL and links
// can't be forged for other addresses.

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function mask(email: string) {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
}

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5b6170;--line:#e1e4ea;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--ink:#eceef2;--muted:#a3a9b6;--line:#2c313b;--accent:#2dd4bf}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:440px;width:100%}
h1{font-size:20px;margin:0 0 10px}p{color:var(--muted);margin:0 0 16px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
@media (prefers-color-scheme:dark){button{color:#04302a}}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const invalid = () => page("Link not valid", `<h1>This unsubscribe link isn't valid</h1><p>It may have been copied incompletely. Reply to the email you received and ask to be removed, and the sender will take you off their list.</p>`, 400);

export default async (req: Request, context: Context) => {
  if (req.method !== "GET" && req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const jobId = url.searchParams.get("j") || "";
  const index = Number(url.searchParams.get("r"));
  const sig = url.searchParams.get("s") || "";
  if (!jobId || !Number.isInteger(index) || index < 0) return invalid();

  const job = await getStore(SEND_JOBS_STORE).get(jobId, { type: "json" });
  if (!job || !job.secret || index >= job.recipients.length || !checkSignature(job.secret, jobId, index, sig)) return invalid();

  const email: string = job.recipients[index];
  const sender = job.senderName ? esc(job.senderName) : "this sender";
  const key = suppressionKey(job.tenantId, email);
  const store = getStore({ name: SUPPRESSION_STORE, consistency: "strong" });

  if (req.method === "GET") {
    if (await store.getMetadata(key)) {
      return page("Unsubscribed", `<h1>You're already unsubscribed</h1><p>${esc(mask(email))} won't receive marketing emails from ${sender}.</p>`);
    }
    return page("Unsubscribe", `<h1>Unsubscribe from ${sender}?</h1><p>${esc(mask(email))} will stop receiving marketing emails from ${sender}.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`);
  }

  // Keep the first unsubscribe date if they click more than once.
  if (!(await store.getMetadata(key))) {
    await store.setJSON(key, { email, at: new Date().toISOString(), via: "email link", jobId });
  }
  return page("Unsubscribed", `<h1>You've been unsubscribed</h1><p>${esc(mask(email))} won't receive any more marketing emails from ${sender}.</p>`);
};

export const config: Config = {
  path: "/api/unsubscribe",
};
