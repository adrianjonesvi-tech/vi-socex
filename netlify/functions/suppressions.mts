import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { SUPPRESSION_STORE, normEmail, suppressionKey } from "../lib/email.mts";

// The workspace's unsubscribe list, for the app.
//   GET                → { suppressions: [{ email, at, via }] }
//                        The app marks matching contacts "Unsubscribed".
//   DELETE { email }   → removes one address (in the body, so it stays out of logs), used when someone has asked to be
//                        re-subscribed and a user confirms it in the app.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req: Request, context: Context) => {
  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const session = await getStore("visocex-sessions").get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);
  const tenantId: string = session.tenantId;
  const store = getStore({ name: SUPPRESSION_STORE, consistency: "strong" });

  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: `${tenantId}/` });
    const suppressions = await Promise.all(blobs.map(async ({ key }: { key: string }) => {
      const v = await store.get(key, { type: "json" });
      return { email: decodeURIComponent(key.slice(tenantId.length + 1)), at: v?.at || null, via: v?.via || "" };
    }));
    return json({ suppressions });
  }

  if (req.method === "DELETE") {
    let body: any = {};
    try { body = await req.json(); } catch { /* handled below */ }
    const email = normEmail(body.email);
    if (!email) return json({ error: "email is required" }, 400);
    await store.delete(suppressionKey(tenantId, email));
    console.log(`suppressions: ${session.email || "?"} re-subscribed an address in ${tenantId}`);
    return json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/suppressions",
};
