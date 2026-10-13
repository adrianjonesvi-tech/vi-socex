import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { DOMAINS_STORE, RESEND_REGION, SENDERS_STORE, cleanSenderName, domainOf, isValidEmail, normEmail, resendApi, senderStatus } from "../lib/email.mts";

// The guided email-sender setup behind Company Info → Email sender.
//
//   GET                       → this workspace's sender, its domain's status and
//                               DNS records, whether you're an admin, who the admins are
//   POST { action: "save", name, address }   admin only
//   POST { action: "setup" }                 admin only — adds the domain to Resend
//   POST { action: "verify" }                admin only — asks Resend to re-check DNS
//
// Everyone in the workspace can see the status; only its admins can change it.
// The domain always comes from the saved address, never from the request.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function workspaceAdmins(tenantId: string) {
  const tenants = getStore("visocex-tenants");
  const { blobs } = await tenants.list();
  const admins: { email: string; name: string }[] = [];
  for (const b of blobs) {
    const r = await tenants.get(b.key, { type: "json" });
    if (r && r.id === tenantId && r.isAdmin) admins.push({ email: r.email, name: r.personName || "" });
  }
  return admins;
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);
  const me = session.email ? await getStore("visocex-tenants").get(session.email, { type: "json" }) : null;
  const isAdmin = !!(me && me.isAdmin && me.id === session.tenantId);
  const apiKey = Netlify.env.get("RESEND_KEY") || "";
  const tenantId = session.tenantId;

  const report = async () => {
    const st = await senderStatus(getStore, apiKey, tenantId);
    return { ...st, isAdmin, admins: await workspaceAdmins(tenantId) };
  };

  if (req.method === "GET") return json(await report());
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!isAdmin) return json({ error: "Only this workspace's admins can change who its emails come from." }, 403);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const domains = getStore({ name: DOMAINS_STORE, consistency: "strong" });

  if (body.action === "save") {
    const name = cleanSenderName(body.name);
    const address = normEmail(body.address);
    if (address && !isValidEmail(address)) return json({ error: "That doesn't look like an email address." }, 400);
    if (address) {
      const owner = await domains.get(domainOf(address), { type: "json" });
      if (owner && owner.tenantId !== tenantId) return json({ error: `${domainOf(address)} is set up for another workspace. Use an address on your own domain.` }, 409);
    }
    await getStore({ name: SENDERS_STORE, consistency: "strong" }).setJSON(tenantId, { name, address, updatedBy: session.email || "", updatedAt: new Date().toISOString() });
    console.log(`email-sender: ${session.email} saved the sender for ${tenantId}`);
    return json(await report());
  }

  if (body.action === "setup" || body.action === "verify") {
    const st = await senderStatus(getStore, apiKey, tenantId);
    if (!st.sender.address) return json({ error: "Save a sending address first." }, 400);
    if (st.owner === "other") return json({ error: st.problem.message }, 409);
    if (!st.resend || !st.resend.canManage) return json({ error: st.problem ? st.problem.message : "Couldn't check the domain." }, 502);
    const domain = st.domain;

    if (body.action === "setup") {
      if (st.owner === "this") return json(await report());
      if (st.resend.found) {
        // Already in Resend from before this setup existed: only an admin whose
        // own login is on that domain can link it to this workspace.
        if (domainOf(session.email || "") !== domain) {
          return json({ error: `${domain} is already registered with the email service but isn't linked to this workspace. An admin whose own login is an @${domain} address can link it, or contact Vi-SOCEX support.` }, 403);
        }
        await domains.setJSON(domain, { tenantId, resendId: st.resend.id, region: st.resend.region, addedBy: session.email, addedAt: new Date().toISOString(), how: "claimed existing" });
        console.log(`email-sender: ${session.email} linked existing domain ${domain} to ${tenantId}`);
        return json(await report());
      }
      const created = await resendApi(apiKey, "POST", "/domains", { name: domain, region: RESEND_REGION });
      if (!created.ok) return json({ error: `The email service wouldn't add ${domain}: ${created.data.message || `error ${created.status}`}` }, 502);
      await domains.setJSON(domain, { tenantId, resendId: created.data.id, region: created.data.region || RESEND_REGION, addedBy: session.email, addedAt: new Date().toISOString(), how: "added" });
      console.log(`email-sender: ${session.email} added domain ${domain} for ${tenantId}`);
      return json(await report());
    }

    if (st.owner !== "this") return json({ error: "Set the domain up first." }, 400);
    const v = await resendApi(apiKey, "POST", `/domains/${encodeURIComponent(st.resend.id)}/verify`);
    if (!v.ok) return json({ error: `The email service couldn't start the check: ${v.data.message || `error ${v.status}`}` }, 502);
    // Resend checks DNS in the background; give it a moment before reporting.
    await new Promise(r => setTimeout(r, 3000));
    return json(await report());
  }

  return json({ error: "Unknown action" }, 400);
};

export const config: Config = {
  path: "/api/email-sender",
};
