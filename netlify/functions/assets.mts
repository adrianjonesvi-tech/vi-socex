import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

// Stores the actual file bytes for the Assets library — separate from the
// "assets" metadata array in data.mts, which only holds name/type/size/date.
// Netlify Functions cap binary request bodies at roughly 4.5MB effective
// (base64 overhead included), so this comfortably covers documents, PDFs,
// and images, but not most real video files — that's a genuine platform
// limit, not something this code works around.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function getTenantId(req: Request, sessionsStore: any, tokenFromQuery?: string | null) {
  const token = req.headers.get("X-Session-Token") || tokenFromQuery;
  if (!token) return null;
  const session = await sessionsStore.get(token, { type: "json" });
  return session && session.tenantId ? session.tenantId : null;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const sessionsStore = getStore("visocex-sessions");
  const filesStore = getStore("visocex-asset-files");

  if (req.method === "POST" && action === "upload") {
    const tenantId = await getTenantId(req, sessionsStore, null);
    if (!tenantId) return json({ error: "unauthorized" }, 401);

    let body: { name?: string; mimeType?: string; dataBase64?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body.name || !body.mimeType || !body.dataBase64) {
      return json({ error: "name, mimeType, and dataBase64 are required" }, 400);
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(body.dataBase64, "base64"));
    } catch {
      return json({ error: "dataBase64 could not be decoded" }, 400);
    }
    if (bytes.length > 4_500_000) {
      return json({ error: "That file is too large — this stores files up to about 4.5MB (documents, PDFs, and images fit comfortably; most videos won't)." }, 413);
    }

    const id = randomUUID();
    const key = `${tenantId}/${id}`;
    await filesStore.set(key, bytes, { metadata: { mimeType: body.mimeType, name: body.name } });
    return json({ id, sizeBytes: bytes.length });
  }

  if (req.method === "GET" && action === "download") {
    const tokenFromQuery = url.searchParams.get("token");
    const tenantId = await getTenantId(req, sessionsStore, tokenFromQuery);
    if (!tenantId) return json({ error: "unauthorized" }, 401);

    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const key = `${tenantId}/${id}`;

    const result = await filesStore.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) return json({ error: "not found" }, 404);
    const meta: any = result.metadata || {};
    return new Response(result.data as ArrayBuffer, {
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${(meta.name || "file").replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  if (req.method === "POST" && action === "delete") {
    const tenantId = await getTenantId(req, sessionsStore, null);
    if (!tenantId) return json({ error: "unauthorized" }, 401);
    let body: { id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body.id) return json({ error: "id is required" }, 400);
    await filesStore.delete(`${tenantId}/${body.id}`);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = {
  path: "/api/assets",
};
