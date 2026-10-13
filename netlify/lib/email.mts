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
//   (sender and domain stores are described further down)

import { createHmac, timingSafeEqual } from "node:crypto";

export const SUPPRESSION_STORE = "visocex-suppressions";
export const SEND_JOBS_STORE = "visocex-send-jobs";
// Keep in step with SUPPRESSED_STATUSES and effectiveBasis() in public/app/index.html.
export const SUPPRESSED_STATUSES = ["Unsubscribed", "Suppressed", "Not eligible", "Awaiting opt-in"];
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

// The workspace's chosen sender name, made safe for an email From header:
// no line breaks, quotes, angle brackets or backslashes, at most 60 characters.
export function cleanSenderName(s: unknown) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
}

export function fromHeader(name: string, address: string) {
  const n = cleanSenderName(name);
  return n ? `"${n}" <${address}>` : address;
}

// ---- Who each workspace's marketing emails come from ----------------------
//
// All email goes through the site's single Resend account. Each workspace has
// its own sender (name + address), which only its admins can change, and each
// sending domain belongs to exactly one workspace, so no workspace can send as
// another. A domain becomes a workspace's when one of its admins sets it up
// from the app (Resend then proves control of it through DNS), or — for a
// domain already verified in Resend before this — when an admin whose own
// login is on that domain claims it.
//
//   visocex-email-senders:  <tenantId>  → { name, address, updatedBy, updatedAt }
//   visocex-email-domains:  <domain>    → { tenantId, resendId, region, addedBy, addedAt, how }

export const SENDERS_STORE = "visocex-email-senders";
export const DOMAINS_STORE = "visocex-email-domains";
// Where Resend sends from for domains set up here (Ireland, close to UK customers).
export const RESEND_REGION = "eu-west-1";

export function domainOf(address: string) {
  return (normEmail(address).split("@")[1] || "").replace(/\.$/, "");
}

// The workspace's sender: its saved name (or, if none, the company's legal
// name from Company Info) and its saved address. Either can be empty.
export async function loadSender(getStore: StoreFactory, tenantId: string) {
  const [rec, ci] = await Promise.all([
    getStore({ name: SENDERS_STORE, consistency: "strong" }).get(tenantId, { type: "json" }),
    getStore({ name: "visocex-data", consistency: "strong" }).get(`${tenantId}__company_info`, { type: "json" }),
  ]);
  const customName = cleanSenderName(rec && rec.name);
  const defaultName = cleanSenderName(ci && ci.name);
  const raw = normEmail(rec && rec.address);
  return {
    name: customName || defaultName, customName, defaultName,
    address: raw && isValidEmail(raw) ? raw : "",
    updatedBy: (rec && rec.updatedBy) || "", updatedAt: (rec && rec.updatedAt) || null,
  };
}

// A small Resend API helper. `status` 0 means Resend couldn't be reached.
export async function resendApi(apiKey: string, method: string, path: string, body?: unknown) {
  try {
    const resp = await fetch(`https://api.resend.com${path}`, {
      method,
      headers: { "Authorization": `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data: any = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

// Everything needed to decide whether a workspace can send, and what to tell
// its people if it can't. `problem` is null when ready.
export async function senderStatus(getStore: StoreFactory, apiKey: string, tenantId: string) {
  const sender = await loadSender(getStore, tenantId);
  const domain = sender.address ? domainOf(sender.address) : "";
  const out: any = { sender, domain, owner: "none", resend: null, ready: false, problem: null };
  const fail = (code: string, message: string) => { out.problem = { code, message }; return out; };

  if (!sender.name) return fail("no_name", "There's no sender name yet. An admin can set one under Company Info → Email sender.");
  if (!sender.address) return fail("no_address", "There's no sending address yet. An admin can set one up under Company Info → Email sender.");

  const owner = await getStore({ name: DOMAINS_STORE, consistency: "strong" }).get(domain, { type: "json" });
  out.owner = !owner ? "none" : owner.tenantId === tenantId ? "this" : "other";
  if (out.owner === "other") return fail("other_workspace", `${domain} is set up for another workspace, so it can't be used here. An admin can choose an address on your own domain under Company Info → Email sender.`);

  if (!apiKey) return fail("no_key", "Email sending isn't configured on this site yet.");
  const list = await resendApi(apiKey, "GET", "/domains");
  if (list.status === 0) return fail("unreachable", "Couldn't reach the email service to check your domain. Try again in a moment.");
  if (list.status === 401 || list.status === 403) {
    out.resend = { canManage: false };
    return fail("key_cannot_manage", "The site's email key can only send email, so domains can't be checked or set up from here. Ask vi-tech to switch it to a full-access Resend key.");
  }
  const found = ((list.data && list.data.data) || []).find((d: any) => String(d.name || "").toLowerCase() === domain);
  out.resend = { canManage: true, found: !!found, id: found ? found.id : null, status: found ? found.status : "not_added", region: found ? found.region : null, records: [] };
  if (found && out.owner === "this") {
    const detail = await resendApi(apiKey, "GET", `/domains/${encodeURIComponent(found.id)}`);
    if (detail.ok) { out.resend.status = detail.data.status || out.resend.status; out.resend.records = detail.data.records || []; }
  }
  if (out.owner !== "this") return fail("not_set_up", `${domain} hasn't been set up for sending from this workspace yet. An admin can start it under Company Info → Email sender.`);
  if (out.resend.status !== "verified") return fail("not_verified", `${domain} is set up but not verified yet (status: ${out.resend.status.replace(/_/g, " ")}). Its DNS records need adding, then an admin can press "Check again" under Company Info → Email sender.`);
  out.ready = true;
  return out;
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
