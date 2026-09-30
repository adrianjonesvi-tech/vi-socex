import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textBetween(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function metaContent(html: string, name: string): string {
  const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i");
  const match = html.match(re) || html.match(re2);
  return match ? match[1].trim() : "";
}

function visibleText(html: string): string {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

function findHexColors(html: string): string[] {
  const matches = html.match(/#[0-9a-fA-F]{6}\b/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const hex = m.toUpperCase();
    if (!seen.has(hex) && hex !== "#FFFFFF" && hex !== "#000000") {
      seen.add(hex);
      out.push(hex);
    }
    if (out.length >= 8) break;
  }
  return out;
}

// A plain fetch only sees server-rendered HTML — it can't execute JavaScript,
// so any content that only appears after a click (accordions, tabs, "load
// more") or that's fetched client-side after page load is invisible to it.
// The most common victim is FAQ accordions: a run of short "?"-ending
// fragments with barely anything between them is a strong signal that the
// questions came through but the answers, revealed only on click, did not.
function looksLikeHiddenAccordionContent(text: string): boolean {
  const sentences = text.split(/(?<=[.?!])\s+/).filter(Boolean);
  let questionRun = 0;
  let maxRun = 0;
  for (const s of sentences) {
    const isShortQuestion = s.trim().endsWith("?") && s.trim().length < 90;
    questionRun = isShortQuestion ? questionRun + 1 : 0;
    maxRun = Math.max(maxRun, questionRun);
  }
  return maxRun >= 6;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const sessionsStore = getStore("visocex-sessions");
  const session = await sessionsStore.get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "url is required" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return json({ error: "That doesn't look like a valid URL." }, 400);
  }

  try {
    const res = await fetch(parsed.toString(), {
      headers: { "User-Agent": "Vi-SOCEX/1.0 (+brand identity scan)" },
      redirect: "follow",
    });
    if (!res.ok) return json({ error: `The site responded with ${res.status}.` }, 502);
    const html = await res.text();

    const title = textBetween(html, "title");
    const description = metaContent(html, "description") || metaContent(html, "og:description");
    const text = visibleText(html).slice(0, 6000);
    const colors = findHexColors(html);

    if (!text && !title) {
      return json({ error: "Couldn't find any readable content on that page." }, 422);
    }

    const hiddenContentWarning = looksLikeHiddenAccordionContent(text)
      ? "This page looks like it has collapsible content (an FAQ accordion, tabs, or similar) that only reveals its full text on click — a plain scan can't see that. If what came through looks incomplete, try expanding those sections on the live page, then copy and paste the text directly instead."
      : "";

    return json({ title, description, text, colors, warning: hiddenContentWarning });
  } catch (err: any) {
    return json({ error: "Couldn't reach that website. " + (err.message || "") }, 502);
  }
};

export const config: Config = {
  path: "/api/scan-website",
};
