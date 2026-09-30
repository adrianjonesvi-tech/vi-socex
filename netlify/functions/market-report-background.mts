import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";

// Background function: Netlify invokes this asynchronously (202 immediately,
// runs up to 15 minutes) because a real, multi-search web research report
// takes far longer than a standard synchronous function's ~60s limit allows.
// The result is written to blob storage under the job's ID; the client polls
// report-status.mts for it rather than waiting on this request directly.

async function callClaudeWithWebSearch(system: string, userPrompt: string, maxTokens: number, maxSearches = 10) {
  const anthropic = new Anthropic();
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches } as any],
  });
  if (message.stop_reason === "max_tokens") {
    throw new Error("The report was too long and got cut off before finishing — try again.");
  }
  const textBlocks = message.content.filter((b: any) => b.type === "text");
  const text = textBlocks.map((b: any) => b.text).join("\n\n").trim();
  if (!text) throw new Error("The research engine didn't return a report — try again.");
  return text;
}

export default async (req: Request, context: Context) => {
  const jobsStore = getStore("visocex-report-jobs");
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  const { jobId, marketName, region, industry, brand, products, websiteUrl } = body;
  if (!jobId || !marketName) return new Response("missing jobId or marketName", { status: 400 });

  try {
    const brandNote = brand && (brand.tone || (brand.rules && brand.rules.length))
      ? `\n\nCompany's brand voice: ${brand.tone || "(not specified)"}.${brand.rules && brand.rules.length ? ` Brand rules: ${brand.rules.join("; ")}.` : ""}`
      : "";
    const productsNote = products && products.length
      ? `\n\nCompany's products/services and their key messages:\n${products.map((p: any) => `- ${p.name}: ${(p.keyMessages || []).join("; ")}`).join("\n")}`
      : "";
    const websiteNote = websiteUrl && websiteUrl.trim() ? `\n\nCompany's own website to check: ${websiteUrl.trim()}` : "\n\nNo company website URL was provided — skip the direct website comparison and note that it's missing rather than guessing.";
    const system = `You are a market research analyst producing a genuinely sourced report for a marketing team. Research using web search and write a clear, well-organised report on the market described, covering exactly these five sections in order: 1) Recent events — real news and announcements in this market from the last few months, with dates. 2) Trends — what's actually shifting: demand, channels, pricing, buyer behaviour, backed by what you found. 3) Competitors — specific named competitors and what they're actually posting, running as ads, or publishing recently, not generic industry commentary. 4) Your website — compare the company's own website (if given) against what's actually landing well in this market right now; if no URL was given, say so plainly instead of fabricating a comparison. 5) Your messaging — checked against the company's actual brand voice and product key messages (if given), noting genuine gaps or alignment, not generic advice. Every claim must come from what you actually found via search — never invent statistics, dates, or competitor activity. Write in clear prose with the five section headings, concise and specific, citing where things came from naturally in the text (e.g. "According to..."). If you can't find good information for a section, say so honestly rather than padding it with generic filler.`;
    const userPrompt = `Market: ${marketName}${region ? `, region: ${region}` : ""}${industry ? `, industry: ${industry}` : ""}.${brandNote}${productsNote}${websiteNote}\n\nProduce the five-section market report now.`;

    const report = await callClaudeWithWebSearch(system, userPrompt, 8000);
    await jobsStore.setJSON(jobId, { status: "done", report, completedAt: Date.now() });
  } catch (err: any) {
    await jobsStore.setJSON(jobId, { status: "error", error: err.message || "Generation failed", completedAt: Date.now() });
  }

  return new Response("ok");
};

export const config: Config = {
  path: "/api/market-report-background",
};
