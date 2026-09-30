import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Data model note: "tenantsStore" holds one entry per USER LOGIN, keyed by
// email. Multiple users can share the same `id` (their company/tenant ID) —
// that's what makes them see the same company data. `id` + `name` (company
// name) are duplicated across every user record for that company; this is a
// deliberate simplification, not an oversight, given the size of this app.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

async function sendAuthEmail(to: string, subject: string, message: string) {
  const apiKey = Netlify.env.get("RESEND_KEY");
  if (!apiKey) return { sent: false, reason: "Email sending isn't configured on this site yet." };
  // Account emails (invites, password resets) shouldn't come from the same
  // address as survey sends — default to info@<same domain> unless an
  // explicit override is set, so recipients don't see "surveys@" for
  // something that has nothing to do with a survey.
  const explicitAuthFrom = (Netlify.env.get("RESEND_AUTH_FROM_EMAIL") || "").trim();
  const surveyFrom = (Netlify.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev").trim();
  const domain = surveyFrom.includes("@") ? surveyFrom.split("@")[1] : "";
  const fromAddress = explicitAuthFrom || (domain ? `info@${domain}` : surveyFrom);
  const fromName = (Netlify.env.get("RESEND_FROM_NAME") || "").trim();
  const fromHeader = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromHeader, to: [to], subject, text: message }),
    });
    if (resp.ok) return { sent: true };
    const errBody = await resp.json().catch(() => ({}));
    return { sent: false, reason: (errBody as any).message || `Resend returned ${resp.status}` };
  } catch (err: any) {
    return { sent: false, reason: err?.message || "Network error" };
  }
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const tenantsStore = getStore("visocex-tenants");
  const sessionsStore = getStore("visocex-sessions");
  const invitesStore = getStore("visocex-invites");
  const resetsStore = getStore("visocex-resets");

  async function requireSession(): Promise<{ tenantId: string; email: string } | null> {
    const token = req.headers.get("X-Session-Token");
    if (!token) return null;
    const session = await sessionsStore.get(token, { type: "json" });
    if (!session) return null;
    return session;
  }

  if (req.method === "POST" && action === "login") {
    let body: { email?: string; password?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || !password) return json({ error: "email and password are required" }, 400);

    const tenant = await tenantsStore.get(email, { type: "json" });
    if (!tenant) return json({ error: "invalid email or password" }, 401);

    const attemptHash = hashPassword(password, tenant.salt);
    const a = Buffer.from(attemptHash, "hex");
    const b = Buffer.from(tenant.passwordHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return json({ error: "invalid email or password" }, 401);
    }

    const token = randomBytes(24).toString("hex");
    await sessionsStore.setJSON(token, { tenantId: tenant.id, email: tenant.email, createdAt: Date.now() });
    return json({ token, tenant: { id: tenant.id, name: tenant.name, email: tenant.email, personName: tenant.personName || "", role: tenant.role || "", phone: tenant.phone || "" } });
  }

  if (req.method === "GET" && action === "me") {
    const token = req.headers.get("X-Session-Token");
    if (!token) return json({ error: "no session token" }, 401);
    const session = await sessionsStore.get(token, { type: "json" });
    if (!session) return json({ error: "invalid or expired session" }, 401);
    const tenant = await tenantsStore.get(session.email, { type: "json" });
    if (!tenant) return json({ error: "tenant not found" }, 401);
    return json({ tenant: { id: tenant.id, name: tenant.name, email: tenant.email, personName: tenant.personName || "", role: tenant.role || "", phone: tenant.phone || "" } });
  }

  if (req.method === "POST" && action === "logout") {
    const token = req.headers.get("X-Session-Token");
    if (token) await sessionsStore.delete(token);
    return json({ ok: true });
  }

  // Invite a teammate to the same company. Requires being logged in already.
  if (req.method === "POST" && action === "invite") {
    const session = await requireSession();
    if (!session) return json({ error: "You need to be signed in to invite someone." }, 401);
    const inviter = await tenantsStore.get(session.email, { type: "json" });
    if (!inviter) return json({ error: "Account not found" }, 401);

    let body: { email?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const invitedEmail = (body.email || "").trim().toLowerCase();
    if (!invitedEmail || !invitedEmail.includes("@")) return json({ error: "Enter a valid email address." }, 400);

    const existing = await tenantsStore.get(invitedEmail, { type: "json" });
    if (existing) return json({ error: "That email already has an account." }, 400);

    const token = randomBytes(24).toString("hex");
    await invitesStore.setJSON(token, {
      tenantId: inviter.id, tenantName: inviter.name, email: invitedEmail, invitedBy: inviter.email, createdAt: Date.now(),
    });

    const link = `${url.origin}/app/?invite=${token}`;
    const emailResult = await sendAuthEmail(
      invitedEmail,
      `You've been invited to join ${inviter.name} on Vi-SOCEX`,
      `${inviter.email} has invited you to join ${inviter.name}'s workspace on Vi-SOCEX.\n\nSet up your account here: ${link}\n\nThis link expires in 7 days.`
    );
    return json({ ok: true, emailSent: emailResult.sent, emailError: emailResult.sent ? undefined : emailResult.reason });
  }

  if (req.method === "GET" && action === "validate-invite") {
    const token = url.searchParams.get("token") || "";
    const invite = await invitesStore.get(token, { type: "json" });
    if (!invite) return json({ error: "This invite link isn't valid — it may have already been used." }, 404);
    if (Date.now() - invite.createdAt > INVITE_EXPIRY_MS) return json({ error: "This invite link has expired. Ask for a new one." }, 410);
    return json({ email: invite.email, tenantName: invite.tenantName });
  }

  if (req.method === "POST" && action === "accept-invite") {
    let body: { token?: string; password?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const { token: inviteToken, password } = body;
    if (!inviteToken || !password) return json({ error: "Missing invite token or password" }, 400);
    if (password.length < 8) return json({ error: "Password needs to be at least 8 characters." }, 400);

    const invite = await invitesStore.get(inviteToken, { type: "json" });
    if (!invite) return json({ error: "This invite link isn't valid — it may have already been used." }, 404);
    if (Date.now() - invite.createdAt > INVITE_EXPIRY_MS) return json({ error: "This invite link has expired. Ask for a new one." }, 410);

    const salt = randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    await tenantsStore.setJSON(invite.email, {
      id: invite.tenantId, name: invite.tenantName, email: invite.email, salt, passwordHash,
      personName: "", role: "", phone: "",
    });
    await invitesStore.delete(inviteToken);

    const sessionToken = randomBytes(24).toString("hex");
    await sessionsStore.setJSON(sessionToken, { tenantId: invite.tenantId, email: invite.email, createdAt: Date.now() });
    return json({ token: sessionToken, tenant: { id: invite.tenantId, name: invite.tenantName, email: invite.email, personName: "", role: "", phone: "" } });
  }

  // Sets the current user's own name/role/phone — used right after accepting
  // an invite, and any time someone edits their own profile from the Team page.
  if (req.method === "POST" && action === "update-profile") {
    const session = await requireSession();
    if (!session) return json({ error: "You need to be signed in to update your profile." }, 401);
    const tenant = await tenantsStore.get(session.email, { type: "json" });
    if (!tenant) return json({ error: "Account not found" }, 404);

    let body: { personName?: string; role?: string; phone?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const personName = (body.personName || "").trim();
    const role = (body.role || "").trim();
    const phone = (body.phone || "").trim();
    await tenantsStore.setJSON(session.email, { ...tenant, personName, role, phone });
    return json({ tenant: { id: tenant.id, name: tenant.name, email: tenant.email, personName, role, phone } });
  }

  // List everyone who shares the current session's tenantId — the roster for
  // a "Team" view. Never returns salt/passwordHash.
  if (req.method === "GET" && action === "list-members") {
    const session = await requireSession();
    if (!session) return json({ error: "You need to be signed in to view the team." }, 401);
    const { blobs } = await tenantsStore.list();
    const members = [];
    for (const b of blobs) {
      const record = await tenantsStore.get(b.key, { type: "json" });
      if (record && record.id === session.tenantId) {
        members.push({ email: record.email, personName: record.personName || "", role: record.role || "", phone: record.phone || "" });
      }
    }
    return json({ members });
  }

  // Always responds the same way whether or not the email exists, so this
  // can't be used to check which emails are registered.
  if (req.method === "POST" && action === "forgot-password") {
    let body: { email?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const email = (body.email || "").trim().toLowerCase();
    if (email) {
      const tenant = await tenantsStore.get(email, { type: "json" });
      if (tenant) {
        const token = randomBytes(24).toString("hex");
        await resetsStore.setJSON(token, { email, createdAt: Date.now() });
        const link = `${url.origin}/app/?reset=${token}`;
        await sendAuthEmail(email, "Reset your Vi-SOCEX password", `We received a request to reset your Vi-SOCEX password.\n\nReset it here: ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`);
      }
    }
    return json({ ok: true });
  }

  if (req.method === "GET" && action === "validate-reset") {
    const token = url.searchParams.get("token") || "";
    const reset = await resetsStore.get(token, { type: "json" });
    if (!reset) return json({ error: "This reset link isn't valid — it may have already been used." }, 404);
    if (Date.now() - reset.createdAt > RESET_EXPIRY_MS) return json({ error: "This reset link has expired. Request a new one." }, 410);
    return json({ email: reset.email });
  }

  if (req.method === "POST" && action === "reset-password") {
    let body: { token?: string; password?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const { token: resetToken, password } = body;
    if (!resetToken || !password) return json({ error: "Missing reset token or password" }, 400);
    if (password.length < 8) return json({ error: "Password needs to be at least 8 characters." }, 400);

    const reset = await resetsStore.get(resetToken, { type: "json" });
    if (!reset) return json({ error: "This reset link isn't valid — it may have already been used." }, 404);
    if (Date.now() - reset.createdAt > RESET_EXPIRY_MS) return json({ error: "This reset link has expired. Request a new one." }, 410);

    const tenant = await tenantsStore.get(reset.email, { type: "json" });
    if (!tenant) return json({ error: "Account not found" }, 404);

    const salt = randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    await tenantsStore.setJSON(reset.email, { ...tenant, salt, passwordHash });
    await resetsStore.delete(resetToken);
    return json({ ok: true });
  }

  // Admin-only: create or update a user login directly. Protected by a secret
  // set as an environment variable, never exposed to the frontend.
  if (req.method === "POST" && action === "seed") {
    const secret = req.headers.get("X-Admin-Secret");
    if (!secret || secret !== Netlify.env.get("ADMIN_SEED_SECRET")) {
      return json({ error: "forbidden" }, 403);
    }
    let body: { id?: string; name?: string; email?: string; password?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const { id, name, email, password } = body;
    if (!id || !name || !email || !password) {
      return json({ error: "id, name, email, and password are required" }, 400);
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    await tenantsStore.setJSON(email.trim().toLowerCase(), {
      id, name, email: email.trim().toLowerCase(), salt, passwordHash,
    });
    return json({ ok: true });
  }

  // Admin-only: delete a user login. Protected the same way as "seed".
  if (req.method === "POST" && action === "admin-delete-user") {
    const secret = req.headers.get("X-Admin-Secret");
    if (!secret || secret !== Netlify.env.get("ADMIN_SEED_SECRET")) {
      return json({ error: "forbidden" }, 403);
    }
    let body: { email?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const email = (body.email || "").trim().toLowerCase();
    if (!email) return json({ error: "email is required" }, 400);
    await tenantsStore.delete(email);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = {
  path: "/api/auth",
};
