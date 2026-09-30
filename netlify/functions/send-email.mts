import type { Context, Config } from "@netlify/functions";

// Sends real email via Resend (https://resend.com). Needs a RESEND_KEY
// environment variable set in the Netlify site — without it, this endpoint
// tells the caller clearly rather than pretending to have sent anything.
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

function isValidEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const apiKey = Netlify.env.get("RESEND_KEY");
  if (!apiKey) {
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

  const validEmails = recipients.filter(r => typeof r === "string" && isValidEmail(r));
  const skipped = recipients.filter(r => !validEmails.includes(r));

  if (validEmails.length === 0) {
    return json({ sent: [], failed: [], skipped, error: "None of the recipients look like valid email addresses — a name alone isn't enough, an actual email is needed." }, 200);
  }

  const fromAddress = (Netlify.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev").trim();
  const fromName = (Netlify.env.get("RESEND_FROM_NAME") || "").trim();
  const fromHeader = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
  const sent: string[] = [];
  const failed: { email: string; reason: string }[] = [];

  for (const email of validEmails) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromHeader,
          to: [email],
          subject,
          text: message,
        }),
      });
      if (resp.ok) {
        sent.push(email);
      } else {
        const errBody = await resp.json().catch(() => ({}));
        failed.push({ email, reason: (errBody as any).message || `Resend returned ${resp.status}` });
      }
    } catch (err: any) {
      failed.push({ email, reason: err?.message || "Network error" });
    }
  }

  return json({ sent, failed, skipped });
};

export const config: Config = {
  path: "/api/send-email",
};
