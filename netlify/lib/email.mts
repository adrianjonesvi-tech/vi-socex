// Shared by the email-sending functions.
//
// Unsubscribes live in their own store, keyed per workspace, rather than being
// written into the workspace's contacts list. The contacts list is edited by
// people's open tabs; a server-side write could overwrite a teammate's save.
// Instead every send checks this store, and the app marks matching contacts
// "Unsubscribed" through its normal save-and-merge path.
//
//   visocex-suppressions:  <tenantId>/<encoded email>  → { email, at, via, jobId? }
//   visocex-send-jobs:     <jobId>                     → the queued send (see send-email.mts)

import { createHmac, timingSafeEqual } from "node:crypto";

export const SUPPRESSION_STORE = "visocex-suppressions";
export const SEND_JOBS_STORE = "visocex-send-jobs";
// Keep in step with SUPPRESSED_STATUSES and effectiveBasis() in public/app/index.html.
export const SUPPRESSED_STATUSES = ["Unsubscribed", "Suppressed", "Not eligible"];
const BASES = ["Unknown basis", "Consent (evidenced)", "Legitimate interests", "Existing customer"];

// A basis only counts once someone has chosen it (basisSetAt). Older contacts
// defaulted to "Consent" unchecked, so they read as Unknown basis until reviewed.
export function effectiveBasis(c: any) {
  if (!c || !c.basisSetAt) return "Unknown basis";
  if (c.consentBasis === "Consent (evidenced)" && !String(c.consentEvidence || "").trim()) return "Unknown basis";
  return BASES.includes(c.consentBasis) ? c.consentBasis : "Unknown basis";
}
export const MAX_RECIPIENTS = 5000;

type StoreFactory = (name: any) => any;

export function normEmail(s: unknown) {
  return String(s ?? "").trim().toLowerCase();
}

export function isValidEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export function suppressionKey(tenantId: string, email: string) {
  return `${tenantId}/${encodeURIComponent(normEmail(email))}`;
}

export async function listSuppressions(getStore: StoreFactory, tenantId: string): Promise<string[]> {
  const { blobs } = await getStore(SUPPRESSION_STORE).list({ prefix: `${tenantId}/` });
  return blobs.map((b: { key: string }) => decodeURIComponent(b.key.slice(tenantId.length + 1)));
}

// Every address this workspace must not email: anyone who used an unsubscribe
// link, plus contacts whose marketing status is suppressed or whose consent
// basis is still Unknown.
export async function suppressedEmails(getStore: StoreFactory, tenantId: string): Promise<Set<string>> {
  const out = new Set(await listSuppressions(getStore, tenantId));
  const contacts = await getStore({ name: "visocex-data", consistency: "strong" }).get(`${tenantId}__contacts`, { type: "json" });
  if (Array.isArray(contacts)) {
    for (const c of contacts) {
      if (c && c.email && (SUPPRESSED_STATUSES.includes(c.marketingStatus) || effectiveBasis(c) === "Unknown basis")) out.add(normEmail(c.email));
    }
  }
  return out;
}

export function unsubscribeSignature(secret: string, jobId: string, index: number) {
  return createHmac("sha256", secret).update(`${jobId}.${index}`).digest("base64url");
}

export function checkSignature(secret: string, jobId: string, index: number, sig: string) {
  const a = Buffer.from(unsubscribeSignature(secret, jobId, index));
  const b = Buffer.from(sig || "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unsubscribeUrl(baseUrl: string, jobId: string, index: number, secret: string) {
  const u = new URL("/api/unsubscribe", baseUrl);
  u.searchParams.set("j", jobId);
  u.searchParams.set("r", String(index));
  u.searchParams.set("s", unsubscribeSignature(secret, jobId, index));
  return u.toString();
}

export function withFooter(message: string, senderName: string, link: string) {
  const who = senderName ? `${senderName}` : "us";
  return `${message}\n\n—\nYou're receiving this email from ${who}. To stop receiving these emails, unsubscribe here: ${link}`;
}
