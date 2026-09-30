import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// This function is intentionally unauthenticated — it's what powers the
// public "take this survey" link that gets shared outside the app. It only
// ever touches two things, both hard-coded (never a generic key like
// data.mts accepts): reading a tenant's questionnaire_templates to render
// the survey, and appending to that tenant's questionnaire_submissions when
// someone completes it. It can never read or write anything else.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// Only the fields the public survey-taking page actually needs — never leaks
// the sender's other data (leads, connections, other templates, etc.).
function publicTemplateFields(t: any) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    audienceType: t.audienceType,
    mode: t.mode,
    color: t.color,
    completionMessage: t.completionMessage,
    ctaMessage: t.ctaMessage,
    ctaButtonLabel: t.ctaButtonLabel,
    groups: (t.groups || []).map((g: any) => ({
      id: g.id,
      name: g.name,
      guidance: g.guidance,
      questions: (g.questions || []).map((q: any) => ({
        id: q.id,
        topic: q.topic,
        text: q.text,
        type: q.type || "single",
        options: q.options || [],
        maxSelections: q.maxSelections ?? null,
        items: q.items || [],
        scaleLabels: q.scaleLabels || [],
        rankCount: q.rankCount ?? null,
        // advice is only meaningful (and only shown) in self-assessment mode
        advice: t.mode === "selfAssessment" ? (q.advice || []) : [],
      })),
    })),
  };
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant");
  const templateId = url.searchParams.get("template");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  if (!tenantId || !templateId) {
    return json({ error: "Missing tenant or template id" }, 400);
  }

  const store = getStore("visocex-data");

  if (req.method === "GET") {
    const templates = await store.get(`${tenantId}__questionnaire_templates`, { type: "json" });
    const template = (templates || []).find((t: any) => t.id === templateId);
    if (!template) return json({ error: "This survey couldn't be found — the link may be out of date." }, 404);
    return json({ template: publicTemplateFields(template) });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid submission" }, 400);
    }

    const templates = await store.get(`${tenantId}__questionnaire_templates`, { type: "json" });
    const template = (templates || []).find((t: any) => t.id === templateId);
    if (!template) return json({ error: "This survey couldn't be found — the link may be out of date." }, 404);

    const submission = {
      templateId,
      orgLevel: body.orgLevel || "",
      teamName: (body.teamName || "").toString().slice(0, 200),
      respondentName: (body.respondentName || "").toString().slice(0, 200),
      date: new Date().toISOString().slice(0, 10),
      answers: Array.isArray(body.answers) ? body.answers : [],
    };

    const existing = (await store.get(`${tenantId}__questionnaire_submissions`, { type: "json" })) || [];
    await store.setJSON(`${tenantId}__questionnaire_submissions`, [...existing, submission]);
    return json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/public-survey",
};
