import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { runBackup, BACKUP_STORE } from "../lib/backup.mts";

// Scheduled daily (00:00 UTC). Copies all workspace data into the separate
// "visocex-backups" store, keeps 30 days, and records the outcome in
// status/last-run (plus status/last-success) and in the function log.
// Scheduled functions can't be called by URL in production; run it on demand
// from Netlify → Logs → Functions → backup-daily → "Run now".
//
// Optional: set BACKUP_ALERT_EMAIL to get an email (via Resend) if a backup fails.

async function sendFailureAlert(message: string) {
  const to = (Netlify.env.get("BACKUP_ALERT_EMAIL") || "").trim();
  const apiKey = Netlify.env.get("RESEND_KEY");
  if (!to || !apiKey) return;
  const surveyFrom = (Netlify.env.get("RESEND_FROM_EMAIL") || "").trim();
  const domain = surveyFrom.includes("@") ? surveyFrom.split("@")[1] : "";
  const from = (Netlify.env.get("RESEND_AUTH_FROM_EMAIL") || "").trim() || (domain ? `info@${domain}` : surveyFrom);
  if (!from) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Vi-SOCEX daily backup FAILED", text: message }),
  }).catch(() => {});
}

export default async () => {
  const backups = getStore(BACKUP_STORE);
  const started = Date.now();
  try {
    const m = await runBackup((name) => getStore({ name, consistency: "strong" }));
    const durationMs = Date.now() - started;
    const summary = {
      ok: true, day: m.day, at: new Date().toISOString(), durationMs,
      stores: m.stores, workspaces: m.workspaces, assets: m.assets, pruned: m.pruned,
    };
    await backups.setJSON("status/last-run", summary);
    await backups.setJSON("status/last-success", summary);
    console.log(`[backup] OK ${m.day} in ${durationMs}ms — ${JSON.stringify({ stores: m.stores, workspaces: m.workspaces, assets: m.assets, pruned: m.pruned })}`);
  } catch (err: any) {
    const error = err?.stack || err?.message || String(err);
    console.error(`[backup] FAILED after ${Date.now() - started}ms: ${error}`);
    await backups.setJSON("status/last-run", { ok: false, at: new Date().toISOString(), error }).catch(() => {});
    await sendFailureAlert(`The Vi-SOCEX daily backup failed at ${new Date().toISOString()}.\n\n${error}\n\nCheck Netlify → Logs → Functions → backup-daily.`);
  }
};

export const config: Config = {
  schedule: "@daily",
};
