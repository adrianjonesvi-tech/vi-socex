import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textBetween(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseFeed(xml: string) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemTag = isAtom ? "entry" : "item";
  const itemRegex = new RegExp(`<${itemTag}[\\s\\S]*?<\\/${itemTag}>`, "gi");
  const items = xml.match(itemRegex) || [];
  return items.slice(0, 10).map((raw) => {
    const title = textBetween(raw, "title");
    let link = textBetween(raw, "link");
    if (!link) {
      const hrefMatch = raw.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    const pubDate = textBetween(raw, "pubDate") || textBetween(raw, "published") || textBetween(raw, "updated");
    return { title, link, pubDate };
  }).filter((it) => it.title);
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const sessionsStore = getStore("visocex-sessions");
  const session = await sessionsStore.get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const feedUrl = url.searchParams.get("feedUrl");
  if (!feedUrl) return json({ error: "feedUrl is required" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(feedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return json({ error: "That doesn't look like a valid URL." }, 400);
  }

  try {
    const res = await fetch(parsed.toString(), {
      headers: { "User-Agent": "Vi-SOCEX/1.0 (+website activity feed reader)" },
      redirect: "follow",
    });
    if (!res.ok) return json({ error: `The feed responded with ${res.status}.` }, 502);
    const xml = await res.text();
    const items = parseFeed(xml);
    if (items.length === 0) return json({ error: "Couldn't find any entries in that feed. Check the URL points to an RSS or Atom feed (often /feed, /rss, or /feed.xml)." }, 422);
    return json({ items });
  } catch (err: any) {
    return json({ error: "Couldn't reach that feed URL. " + (err.message || "") }, 502);
  }
};

export const config: Config = {
  path: "/api/rss",
};
