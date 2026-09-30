import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Whitelist of keys this app is allowed to read/write. Keeps the generic
// store endpoint from being used to write arbitrary keys.
const ALLOWED_KEYS = [
  "posts", "campaigns", "ads", "articles", "products", "connections",
  "onboarded", "leads", "brand", "personas", "markets", "company_info",
  "questionnaire_templates", "questionnaire_submissions", "questionnaire_sends",
  "case_studies", "companies", "contacts", "activities", "tasks", "documents",
  "assets",
];
const ALLOWED = new Set(ALLOWED_KEYS);

// Multi-user safety:
//  * Strong consistency — a read always sees the latest write, so a teammate
//    never loads an out-of-date copy just because they read moments after a save.
//  * Every write stamps a version in the blob's metadata. The browser sends the
//    version its copy was based on (X-Base-Version); if someone else has saved
//    since, the write is refused with 409 + the current value, and the browser
//    merges both people's changes instead of silently overwriting them.
//  * Requests without X-Base-Version (older open tabs) are still accepted, so
//    nothing breaks for anyone mid-session when this is deployed.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function newVersion() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);

  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const sessionsStore = getStore("visocex-sessions");
  const session = await sessionsStore.get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  // Every key is scoped to the authenticated tenant, so customers can never
  // read or write each other's data even though they share the same store.
  const store = getStore({ name: "visocex-data", consistency: "strong" });
  const scoped = (k: string) => `${session.tenantId}__${k}`;

  async function currentVersion(k: string): Promise<string> {
    const meta = await store.getMetadata(scoped(k));
    if (!meta) return "none";
    return (meta.metadata && (meta.metadata as any).version) || "legacy";
  }

  // Cheap change-check: one request returns the version of every key, so an
  // open tab can poll this and only re-download the sections that changed.
  if (req.method === "GET" && url.searchParams.get("versions") === "1") {
    const entries = await Promise.all(ALLOWED_KEYS.map(async k => [k, await currentVersion(k)]));
    return json({ versions: Object.fromEntries(entries) });
  }

  const key = url.searchParams.get("key");
  if (!key || !ALLOWED.has(key)) {
    return json({ error: "unknown or missing key" }, 400);
  }

  if (req.method === "GET") {
    const result = await store.getWithMetadata(scoped(key), { type: "json" });
    if (!result) return json({ value: null, version: "none" });
    const version = (result.metadata && (result.metadata as any).version) || "legacy";
    return json({ value: result.data ?? null, version });
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const baseVersion = req.headers.get("X-Base-Version");
    if (baseVersion !== null) {
      const current = await currentVersion(key);
      if (current !== baseVersion) {
        const latest = await store.getWithMetadata(scoped(key), { type: "json" });
        return json({ error: "conflict", value: latest ? latest.data : null, version: current }, 409);
      }
    }
    const version = newVersion();
    await store.setJSON(scoped(key), body, { metadata: { version, savedBy: session.email || "", savedAt: Date.now() } });
    return json({ ok: true, version });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/data",
};
