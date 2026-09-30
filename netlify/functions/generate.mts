import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Uses Anthropic's tool-use feature to force schema-valid structured output,
// rather than asking the model to format JSON in prose and hoping it parses.
// This is what actually fixed the "Expected ',' or ']'" parse failures.
// Occasionally the model still emits an array field as a single malformed
// string instead of separate array entries — seen so far as either
// "<item>foo</item>\n<item>bar</item>" markup, or the model leaking its own
// tool-call syntax ('<parameter name="x">[...]') into the field's own value —
// and schema validation then coerces that string into an array of individual
// characters/fragments to satisfy the "array" type. This detects that pattern
// and tries several recovery strategies, for plain string arrays or arrays of
// {label, result} objects (splitting each recovered chunk on the first
// colon/dash/em-dash).
function repairFragmentedArray(value: any, shape: "strings" | "labelResult"): any[] {
  // Case A: already a proper array — only intervene if it looks fragmented
  // (many very short string elements, the signature of a string that got
  // split character-by-character to satisfy an "array" schema type).
  if (Array.isArray(value)) {
    const looksFragmented = value.length > 15 && value.every((el: any) => typeof el === "string" && el.length <= 20);
    if (!looksFragmented) return value;
    return recoverArrayFromString(value.join(""), shape);
  }
  // Case B: came back as a raw string entirely — e.g. the model leaked its
  // own tool-call parameter syntax into the field's value instead of the
  // Anthropic SDK populating a real array.
  if (typeof value === "string" && value.trim()) {
    return recoverArrayFromString(value, shape);
  }
  return [];
}
function recoverArrayFromString(joined: string, shape: "strings" | "labelResult"): any[] {
  // Strategy 1: <item>...</item> markup
  const itemMatches = [...joined.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1].trim()).filter(Boolean);
  if (itemMatches.length > 0) return finishRepair(itemMatches, shape);

  // Strategy 2: leaked '<parameter name="...">[ ... ]' tool-call syntax
  // containing an actual JSON array as the field's own string value.
  const paramMatch = joined.match(/<parameter[^>]*>([\s\S]*?)(?:<\/parameter>\s*$|$)/);
  if (paramMatch) {
    try {
      const parsed = JSON.parse(paramMatch[1].trim());
      if (Array.isArray(parsed)) return finishRepair(parsed.map(String), shape);
    } catch {}
  }

  // Strategy 3: the string is just valid JSON on its own.
  try {
    const parsed = JSON.parse(joined);
    if (Array.isArray(parsed)) return finishRepair(parsed.map(String), shape);
  } catch {}

  return [];
}
function finishRepair(items: string[], shape: "strings" | "labelResult"): any[] {
  if (shape === "strings") return items;
  return items.map(item => {
    const nested = item.match(/<label>([\s\S]*?)<\/label>\s*<result>([\s\S]*?)<\/result>/);
    if (nested) return { label: nested[1].trim(), result: nested[2].trim() };
    const plain = item.match(/^(.*?)\s*[:\u2014-]\s*(.*)$/);
    return plain ? { label: plain[1].trim(), result: plain[2].trim() } : { label: item, result: "" };
  }).filter(m => m.label);
}

async function callClaudeStructured(system: string, userPrompt: string, schema: any, maxTokens: number) {
  const anthropic = new Anthropic();
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{ name: "submit_result", description: "Submit the structured result.", input_schema: schema }],
    tool_choice: { type: "tool", name: "submit_result" },
  });
  if (message.stop_reason === "max_tokens") {
    throw new Error("The response was too long and got cut off before finishing — try a shorter document or purpose, or try again.");
  }
  const toolUse: any = message.content.find((b: any) => b.type === "tool_use");
  if (!toolUse) throw new Error("AI engine did not return structured data.");
  return toolUse.input;
}

// Real, sourced research via Anthropic's server-executed web search tool now
// lives in market-report-background.mts, since it needs the longer execution
// window a background function gets — a standard function here times out
// well before a multi-search research call can finish.

// Sends one or more images to Claude's vision capability and returns plain
// extracted text — used for scanned PDFs (no text layer) and direct image
// uploads, neither of which pdf.js/mammoth can read since those only pull
// existing text objects, not perform OCR.
async function callClaudeVision(images: { data: string; mediaType: string }[], instruction: string, maxTokens: number) {
  const anthropic = new Anthropic();
  const content: any[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  content.push({ type: "text", text: instruction });
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  });
  const textBlock: any = message.content.find((b: any) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

function buildContext(product: any, persona: any, brand: any) {
  const parts: string[] = [];
  if (product) {
    parts.push(
      `Product/service: ${product.name || "Unnamed"}. ${product.description || ""} ` +
      `Audience: ${product.audience || "general"}. ` +
      `Key messages: ${(product.keyMessages || []).join(" | ") || "none provided"}. ` +
      `Preferred call to action: ${product.cta || "none specified"}.` +
      (product.website ? ` Real website link to reference where appropriate (only include it if the platform/format genuinely supports clickable links in the body, e.g. LinkedIn, Facebook, email, or an article — not Instagram captions): ${product.website}` : "")
    );
  }
  if (persona) {
    parts.push(
      `Target persona: ${persona.name || ""} (${persona.role || "unspecified role"}). ` +
      `Their pain points: ${(persona.painPoints || []).join(" | ") || "none provided"}. ` +
      `Language they respond to: ${(persona.language || []).join(", ") || "none provided"}.`
    );
  }
  if (brand) {
    if (brand.tone) parts.push(`Brand tone of voice: ${brand.tone}`);
    if (brand.rules && brand.rules.length) parts.push(`Brand rules to follow strictly: ${brand.rules.join(" | ")}`);
  }
  return parts.join("\n");
}

const SAFE_GOOGLE_FONTS = [
  "Inter", "Roboto", "Poppins", "Montserrat", "Playfair Display", "Merriweather", "Lora", "Raleway",
  "Nunito", "Work Sans", "Space Grotesk", "Oswald", "DM Sans", "Source Sans 3", "IBM Plex Sans",
  "IBM Plex Serif", "Crimson Text", "Libre Baskerville", "Cormorant Garamond", "Archivo", "Manrope",
  "Outfit", "Sora", "Josefin Sans", "Quicksand", "Karla", "Rubik", "Barlow", "Fraunces",
];

const SCHEMAS: Record<string, any> = {
  post: {
    type: "object",
    properties: {
      caption: { type: "string", description: "The ready-to-post caption text." },
      hashtags: { type: "array", items: { type: "string" }, description: "3-6 hashtags, plain words without #." },
    },
    required: ["caption", "hashtags"],
  },
  article: {
    type: "object",
    properties: {
      title: { type: "string" },
      paragraphs: { type: "array", items: { type: "string" } },
    },
    required: ["title", "paragraphs"],
  },
  adcopy: {
    type: "object",
    properties: {
      headline: { type: "string", description: "Under 40 characters." },
      primaryText: { type: "string", description: "Under 125 characters." },
    },
    required: ["headline", "primaryText"],
  },
  document_revise: {
    type: "object",
    properties: {
      revisedText: { type: "string", description: "The cleaned-up document text. Preserve all genuine content and its meaning and order. Remove verbatim duplication (keep one copy). Where the text is cut off, garbled, or a specific fact is genuinely missing, insert a clear bracketed placeholder like '[NEEDS INPUT: what does StrategiziT actually do here?]' describing exactly what's missing — never invent the missing content yourself. Do not add new claims, numbers, or facts that weren't already in the source." },
      changes: { type: "array", items: { type: "string" }, description: "A short list of what was changed, e.g. 'Removed duplicate GoSeeiT description', 'Marked missing StrategiziT description with a placeholder'." },
    },
    required: ["revisedText", "changes"],
  },
  entity_overview: {
    type: "object",
    properties: {
      overview: { type: "string", description: "3-6 sentences synthesising what the source material actually establishes about this company/product — written as a confident, accurate summary a reader could sanity-check against the sources. No hedging language, no meta-commentary about the documents themselves." },
      gaps: {
        type: "array",
        items: { type: "string" },
        description: "Specific things that are missing, unclear, ambiguous, or that different sources disagree on. Each item should name the specific gap or conflict, not a generic 'more detail would help'. Empty array if the material is genuinely comprehensive and consistent.",
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
        description: "2-4 specific, actionable marketing content ideas this material makes possible right now — each phrased as something a marketer could literally hand to a writer today, e.g. 'Write a LinkedIn post contrasting GoSeeiT's tiered Go-Look-See audits against generic checklist apps' or 'Draft a one-pager on how ResolviT's 8D methodology shortens root-cause investigations'. Ground every suggestion in something the source material actually says — do not suggest generic content unrelated to what's known. Empty array if the material doesn't yet support a genuinely specific idea.",
      },
    },
    required: ["overview", "gaps", "suggestions"],
  },
  case_study_extract: {
    type: "object",
    properties: {
      title: { type: "string", description: "A compelling headline for the case study." },
      client: { type: "string", description: "The client, company, or project name. Empty string if not stated or must stay anonymous (e.g. 'A major oil & gas operator in West Africa')." },
      industry: { type: "string", description: "Sector/industry, e.g. 'Oil & Gas', 'Manufacturing', 'Rail infrastructure'. Empty string if unclear." },
      location: { type: "string", description: "Geographic location if mentioned, empty string otherwise." },
      overview: { type: "string", description: "The client context / situation before Vi-Tech's involvement. 2-4 sentences." },
      challenge: { type: "string", description: "The specific problem(s) that needed solving. 2-4 sentences." },
      approach: { type: "string", description: "What Vi-Tech did — the method, platform(s), and process used. This is usually the longest section, 3-6 sentences." },
      keyFindings: { type: "array", items: { type: "string" }, description: "Optional bullet list of specific findings or systemic issues uncovered. Empty array if the source doesn't have distinct findings to list." },
      metrics: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, result: { type: "string" } }, required: ["label", "result"] },
        description: "Optional short results table as label/result pairs, e.g. {label: 'Team Collaboration', result: 'Observed throughout all tiers'}. Empty array if no discrete metrics are given.",
      },
      outcome: { type: "string", description: "The outcome and impact achieved. 2-4 sentences." },
      insight: { type: "string", description: "A closing reflective paragraph generalising the lesson, in the voice of 'This case study demonstrates/highlights...'. 1-3 sentences." },
      tagline: { type: "string", description: "A short, punchy 1-2 sentence closing soundbite that encapsulates the lesson, in the style of 'Planning makes work visible. Execution makes it reliable.'" },
    },
    required: ["title", "client", "industry", "location", "overview", "challenge", "approach", "keyFindings", "metrics", "outcome", "insight", "tagline"],
  },
  company_extract: {
    type: "object",
    properties: {
      tagline: { type: "string", description: "Empty string if not stated." },
      founded: { type: "string", description: "Year or date founded, empty string if not stated." },
      history: { type: "string", description: "1-3 sentence company history/about summary. Empty string if not discussed." },
      locations: { type: "array", items: { type: "object", properties: { label: { type: "string" }, address: { type: "string" } }, required: ["label", "address"] } },
      people: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } }, required: ["name", "role"] } },
      contactEmail: { type: "string", description: "Empty string if not stated." },
      contactPhone: { type: "string", description: "Empty string if not stated." },
      faqs: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] } },
    },
    required: ["tagline", "founded", "history", "locations", "people", "contactEmail", "contactPhone", "faqs"],
  },
  brand_extract: {
    type: "object",
    properties: {
      colors: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string" } }, required: ["name", "hex"] },
      },
      headingFont: { type: "string", description: "Empty string if not named in the document." },
      bodyFont: { type: "string", description: "Empty string if not named in the document." },
      tone: { type: "string", description: "Empty string if the document says nothing about voice." },
      rules: { type: "array", items: { type: "string" } },
    },
    required: ["colors", "headingFont", "bodyFont", "tone", "rules"],
  },
  brand_wizard: {
    type: "object",
    properties: {
      colors: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string" } }, required: ["name", "hex"] },
        description: "Exactly 5: primary, secondary, accent, dark neutral, light neutral.",
      },
      headingFont: { type: "string", enum: SAFE_GOOGLE_FONTS },
      bodyFont: { type: "string", enum: SAFE_GOOGLE_FONTS },
      tone: { type: "string" },
      rules: { type: "array", items: { type: "string" } },
      logoStyle: {
        type: "object",
        properties: {
          direction: { type: "string" },
          rationale: { type: "string" },
          notes: { type: "string" },
        },
        required: ["direction", "rationale", "notes"],
      },
    },
    required: ["colors", "headingFont", "bodyFont", "tone", "rules", "logoStyle"],
  },
  questionnaire_wizard: {
    type: "object",
    properties: {
      name: { type: "string" },
      short: { type: "string", description: "A short 1-3 word tab label." },
      description: { type: "string", description: "One sentence on who this is for and why." },
      groups: {
        type: "array",
        description: "3-5 topic groups, each with 2-3 questions.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            guidance: { type: "string", description: "A short prompt helping respondents answer honestly." },
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: { type: "string", description: "A short 2-4 word label for this question." },
                  text: { type: "string" },
                  type: {
                    type: "string",
                    enum: ["single", "multi", "text", "matrix", "ranking"],
                    description: "'single' for a normal one-answer question with exactly 3 graded options — use this by default. 'multi' for a genuine 'select all that apply' question. 'text' for a genuinely open-ended question that can't be reduced to fixed choices. 'matrix' for rating a whole list of distinct items on one shared scale (e.g. 'rate how much of a problem each of these 8 things is'). 'ranking' for picking and ordering the top N most important items from a list. Prefer 'single' whenever a question can reasonably be reduced to 3 graded choices — only reach for 'multi', 'text', 'matrix', or 'ranking' when the source material's own phrasing clearly calls for it.",
                  },
                  options: {
                    type: "array",
                    items: { type: "string" },
                    description: "For type 'single': exactly 3 answer choices, ordered from most positive/desirable to least — never include an 'N/A' option, that is added automatically. For type 'multi': 4-10 realistic answer choices the respondent can pick several of. For all other types: omit or leave empty.",
                  },
                  maxSelections: {
                    type: ["integer", "null"],
                    description: "For type 'multi' only: a limit on how many options they may pick, if the source material specifies one (e.g. 'select up to five'). Otherwise null.",
                  },
                  advice: {
                    type: "array",
                    items: { type: "string" },
                    description: "For type 'single' only: exactly 3 short pieces of advice, one per answer option in the same order — what the respondent should do next if they picked that answer. Write real, specific, actionable guidance, not generic filler. For every other type, leave as an empty array — advice does not apply.",
                  },
                  items_: {
                    type: "array",
                    items: { type: "string" },
                    description: "For type 'matrix' or 'ranking' only: the list of distinct things being rated or ranked (e.g. 8-15 named problems, capabilities, or tools). Omit or leave empty for other types.",
                  },
                  scaleLabels: {
                    type: "array",
                    items: { type: "string" },
                    description: "For type 'matrix' only: 3-5 scale point labels ordered low to high (e.g. 'Not a problem' → 'Critical problem'). Omit or leave empty for other types.",
                  },
                  rankCount: {
                    type: ["integer", "null"],
                    description: "For type 'ranking' only: how many top items the respondent should pick and order (e.g. 3 for 'rank your top 3'). Otherwise null.",
                  },
                },
                required: ["topic", "text", "type", "options", "maxSelections", "advice", "items_", "scaleLabels", "rankCount"],
              },
            },
          },
          required: ["name", "guidance", "questions"],
        },
      },
    },
    required: ["name", "short", "description", "groups"],
  },
  questionnaire_insights: {
    type: "object",
    properties: {
      opportunities: {
        type: "array",
        description: "Ways an existing linked product/service could address what the responses show — omit if nothing genuinely fits, don't force a connection.",
        items: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Which topic group this relates to." },
            product: { type: "string", description: "Which linked product this refers to." },
            insight: { type: "string", description: "1-2 sentences: what the data shows and how this product genuinely helps." },
          },
          required: ["topic", "product", "insight"],
        },
      },
      featureGaps: {
        type: "array",
        description: "Where responses suggest a genuine gap none of the linked products currently cover — potential new feature or product opportunities.",
        items: {
          type: "object",
          properties: {
            topic: { type: "string" },
            suggestion: { type: "string", description: "1-2 sentences: the gap observed and what a new feature or offering could address it." },
          },
          required: ["topic", "suggestion"],
        },
      },
    },
    required: ["opportunities", "featureGaps"],
  },
};

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = req.headers.get("X-Session-Token");
  if (!token) return json({ error: "unauthorized" }, 401);
  const sessionsStore = getStore("visocex-sessions");
  const session = await sessionsStore.get(token, { type: "json" });
  if (!session || !session.tenantId) return json({ error: "unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { type, topic, tone, platform, length, objective, product, persona, brand, text, answers, purpose, audienceType, products, topicAverages, templateName, images, documentContext, mode, entityName, entityType, gaps } = body;
  const contextStr = buildContext(product, persona, brand);

  try {
    if (type === "post") {
      const system = "You are Vi-SOCEX's marketing copywriter. Write on-brand, ready-to-publish social media content, genuinely ready to post as-is, in the requested tone, sized appropriately for the platform.";
      const user = `Write a ${tone || "Professional"} social media caption for ${platform || "social media"} about: ${topic}\n\n${contextStr}`;
      const result = await callClaudeStructured(system, user, SCHEMAS.post, 500);
      return json({ caption: result.caption, hashtags: result.hashtags || [] });
    }

    if (type === "article") {
      const paraCount = length || 5;
      const system = `You are Vi-SOCEX's content writer. Write a long-form article with exactly ${paraCount} paragraphs of real, complete prose.`;
      const user = `Write a ${tone || "Professional"} article about: ${topic}\n\n${contextStr}`;
      const result = await callClaudeStructured(system, user, SCHEMAS.article, 1800);
      return json({ title: result.title, paragraphs: result.paragraphs || [] });
    }

    if (type === "adcopy") {
      const system = "You are Vi-SOCEX's paid media copywriter. Write ad copy that is genuinely persuasive and specific to the product, not generic.";
      const user = `Write ad copy for objective "${objective || "general awareness"}".\n\n${contextStr}`;
      const result = await callClaudeStructured(system, user, SCHEMAS.adcopy, 400);
      return json({ headline: result.headline, primaryText: result.primaryText });
    }

    if (type === "document_revise") {
      if (!text || !text.trim()) return json({ error: "No document text provided" }, 400);
      const gapsNote = (gaps && gaps.length)
        ? `\n\nSpecific issues identified in this document (fix what applies to this specific text — some may relate to other documents, ignore those):\n${gaps.map((g: string) => `- ${g}`).join("\n")}`
        : "";
      const system = `You are helping clean up a source document that feeds an AI ingestion system. Remove verbatim duplication, fix obvious formatting breakage, and where content is cut off, garbled, or a specific fact is genuinely missing, insert a clear bracketed placeholder describing exactly what's needed — never invent the missing content. Keep everything else close to verbatim; this is a cleanup pass, not a rewrite.${gapsNote}`;
      const result = await callClaudeStructured(system, `Document:\n\n${text.slice(0, 16000)}`, SCHEMAS.document_revise, 4000);
      return json(result);
    }

    if (type === "entity_overview") {
      if (!text || !text.trim()) return json({ error: "No source material provided" }, 400);
      const typeNote = entityType === "company"
        ? "This is a company profile — the overview should read like a confident, accurate 'who they are and what they do' summary."
        : `This is a product/tool called "${entityName || "this product"}" — the overview should read like a confident, accurate summary of what it does, who it's for, and its key strengths.`;
      const system = `You are Vi-SOCEX's ingestion engine, reflecting back what you've actually understood from the source documents provided. This is shown directly to the customer to demonstrate what the AI has genuinely processed and reasoned about, to help them see where their source material is thin, vague, or contradictory, and to proactively suggest specific marketing content this material now makes possible. ${typeNote} Base the overview, gaps, and suggestions ONLY on what the source material actually says — never invent facts, numbers, or claims it doesn't support. Be specific and concrete, not generic ("more detail would help" is not a useful gap — name the actual missing thing; "write a blog post about the product" is not a useful suggestion — name the actual angle).`;
      const result = await callClaudeStructured(system, `Source material for "${entityName || "this entity"}":\n\n${text.slice(0, 16000)}`, SCHEMAS.entity_overview, 2200);
      result.gaps = repairFragmentedArray(result.gaps, "strings");
      result.suggestions = repairFragmentedArray(result.suggestions, "strings");
      return json(result);
    }

    if (type === "case_study_extract") {
      if (!text || !text.trim()) return json({ error: "No document text provided" }, 400);
      const productNote = (products && products.length)
        ? `\n\nThese are the client's products/services — if the source text names any of them, use that exact name; don't invent products it doesn't mention:\n${products.map((p: any) => `- ${p.name}`).join("\n")}`
        : "";
      const system = `You are a case study editor working from a rough draft, brief, or interview notes. Extract and rewrite the content into a clean, standard case-study structure: title, client, industry, location, overview (client context before), challenge, approach (what was done), optional key findings, optional metrics table, outcome and impact, a closing reflective insight paragraph, and a short punchy closing tagline in the style of "Planning makes work visible. Execution makes it reliable." Use only what the source text actually supports — do not invent client names, numbers, or outcomes it doesn't contain. Keep the tone professional and outcome-focused, matching a B2B case study written for prospective clients.${productNote}`;
      const result = await callClaudeStructured(system, `Source material:\n\n${text.slice(0, 14000)}`, SCHEMAS.case_study_extract, 2500);
      result.keyFindings = repairFragmentedArray(result.keyFindings, "strings");
      result.metrics = repairFragmentedArray(result.metrics, "labelResult");
      return json(result);
    }

    if (type === "company_extract") {
      if (!text || !text.trim()) return json({ error: "No document text provided" }, 400);
      const system = "You are Vi-SOCEX's company research analyst. Read the provided document (About page, website copy, company profile, or similar) and extract whatever real company information it actually contains — tagline, founding info, a brief history, office locations, named leadership/team members with their roles, contact email/phone, and any FAQs. Do not invent anything not evidenced in the text; leave fields empty, or arrays empty, where the document says nothing.";
      const result = await callClaudeStructured(system, `Document:\n\n${text.slice(0, 12000)}`, SCHEMAS.company_extract, 2500);
      return json(result);
    }

    if (type === "brand_extract") {
      if (!text || !text.trim()) return json({ error: "No document text provided" }, 400);
      const system = 'You are Vi-SOCEX\'s brand analyst. Read the provided document (brand guidelines, style guide, website copy, or similar) and extract whatever real brand information it actually contains. Only include a color if the document names a specific color (use your best judgment hex for named colors like "deep navy" if no hex code is given). Only fill headingFont/bodyFont if a typeface is actually named. "tone" should synthesize how the document describes the brand\'s voice, in 1-2 sentences — leave empty if not discussed. "rules" should be specific, actionable dos/don\'ts actually stated or clearly implied (up to 6). Do not invent anything not evidenced in the text.';
      const result = await callClaudeStructured(system, `Document:\n\n${text.slice(0, 12000)}`, SCHEMAS.brand_extract, 2000);
      return json(result);
    }

    if (type === "brand_wizard") {
      if (!answers) return json({ error: "No answers provided" }, 400);
      const system = `You are Vi-SOCEX's brand strategist, helping a company build a brand identity from scratch. Provide exactly 5 colors covering primary, secondary, accent, a dark neutral, and a light neutral, each with a real hex code that works well together. Choose headingFont and bodyFont as two DIFFERENT fonts that pair well together. "tone" should be 2-3 sentences describing how this brand should sound in writing. "rules" should be 4-6 specific, actionable brand rules. For logoStyle: "direction" is one short phrase (e.g. "Wordmark", "Icon + wordmark", "Abstract mark", "Lettermark"), "rationale" is 1-2 sentences on why that direction fits, "notes" is concrete guidance on shapes/style/what to avoid for a designer to action — this is style guidance only, not an actual logo.`;
      const user = `Business name: ${answers.name || "Unnamed business"}\nWhat the business does and who it serves: ${answers.description || "not specified"}\nThree words describing the desired brand personality: ${(answers.personality || []).join(", ") || "not specified"}\nPreferred style/vibe: ${answers.vibe || "not specified"}\nThings to avoid: ${answers.avoid || "none specified"}`;
      const result = await callClaudeStructured(system, user, SCHEMAS.brand_wizard, 1800);
      return json(result);
    }

    if (type === "questionnaire_wizard") {
      if (!purpose || !purpose.trim()) return json({ error: "No purpose provided" }, 400);
      const audienceNote = audienceType === "internal"
        ? "This is for internal staff, answering about their own organisation — questions should read naturally for an employee."
        : "This is for external respondents (customers or prospects) — questions should read naturally for someone outside the company.";
      const productNote = (products && products.length)
        ? `\n\nThis questionnaire is linked to these products/services — where genuinely relevant, questions can reference what they do so responses reveal whether these products meet the need or where they fall short:\n${products.map((p: any) => `- ${p.name}: ${p.description || ""}`).join("\n")}`
        : "";
      const modeNote = mode === "selfAssessment"
        ? "This is a self-assessment: the respondent is evaluating their own business or practice, and will see the advice for whichever answer they pick immediately, before moving on. Write advice that is genuinely useful to act on — specific next steps, not vague encouragement. Self-assessment questions should stay 'single' type, since advice only makes sense against one graded answer."
        : "This is a survey: the respondent will not see the advice — it is for internal use only, to help whoever sent this understand what to do about the results. Write it as an internal note, not a message to the respondent.";
      const system = `You are Vi-SOCEX's questionnaire designer. Given a stated purpose, design a complete, genuinely useful questionnaire. Create 3-4 topic groups, each with 2-3 questions — keep it focused rather than exhaustive. Each question has a type: default to 'single' (exactly 3 graded answer options, ordered most to least positive/desirable — never include a 4th "N/A" option, that's added automatically). Reach for 'multi' (4-10 realistic checkbox-style options), 'text' (genuinely open-ended), 'matrix' (rating a whole list of 8-15 distinct items on one shared 3-5 point scale, low to high), or 'ranking' (picking and ordering the top N most important items from a list of 5-10) only when the question itself can't reasonably be reduced to 3 graded choices, and matrix/ranking questions should be rare — at most one per questionnaire — since they take longer to answer. Every 'single' question also needs exactly 3 pieces of advice, one per option in the same order; every other type gets an empty advice array. ${modeNote} ${audienceNote} Keep questions specific to the stated purpose, not generic filler. If a supporting document is provided, ground the topic groups, specific questions, and advice in what it actually says — its structure, terminology, and any specific issues, advice, or metrics it names — rather than writing generically.${productNote}`;
      const docNote = documentContext && documentContext.trim() ? `\n\nSupporting document (use this to ground and inform the questionnaire):\n${documentContext.slice(0, 12000)}` : "";
      const result = await callClaudeStructured(system, `Purpose: ${purpose}${docNote}`, SCHEMAS.questionnaire_wizard, 6000);
      if (result.groups) {
        for (const g of result.groups) {
          if (!g.questions) continue;
          for (const q of g.questions) {
            q.options = repairFragmentedArray(q.options, "strings");
            q.advice = repairFragmentedArray(q.advice, "strings");
            q.items_ = repairFragmentedArray(q.items_, "strings");
            q.scaleLabels = repairFragmentedArray(q.scaleLabels, "strings");
          }
        }
      }
      return json(result);
    }

    if (type === "questionnaire_insights") {
      if (!products || !products.length) return json({ error: "No linked products to analyze against" }, 400);
      if (!topicAverages) return json({ error: "No response data to analyze" }, 400);
      const scoresText = Object.entries(topicAverages).map(([t, v]) => `${t}: ${v == null ? "no data" : `${(v as number).toFixed(1)}/5`}`).join("\n");
      const productsText = products.map((p: any) => `- ${p.name}: ${p.description || ""} Key messages: ${(p.keyMessages || []).join(" | ") || "none"}`).join("\n");
      const system = `You are Vi-SOCEX's product strategist. Given questionnaire results (average score per topic, out of 5, low = negative sentiment) and the company's linked products, find two things: (1) opportunities where an existing product genuinely addresses what a topic's score reveals — only where there's a real, specific fit, never force a connection; (2) feature gaps — topics with weak scores that none of the current products address, suggesting where a new feature or offering could help. Be specific and grounded in the actual scores and product descriptions given, not generic advice.`;
      const user = `Questionnaire: ${templateName || "Untitled"}\n\nAverage score by topic:\n${scoresText}\n\nLinked products:\n${productsText}`;
      const result = await callClaudeStructured(system, user, SCHEMAS.questionnaire_insights, 2000);
      return json(result);
    }

    if (type === "vision_extract") {
      if (!images || !images.length) return json({ error: "No images provided" }, 400);
      if (images.length > 5) return json({ error: "Too many pages/images at once — please split into smaller batches" }, 400);
      const instruction = "Transcribe all readable text from these image(s) as plain text, in reading order. If there's no readable text, briefly describe any visible brand-relevant details instead (colors, layout, logo). Do not add commentary or preamble — just the content.";
      const result = await callClaudeVision(images, instruction, 2000);
      if (!result || !result.trim()) return json({ error: "Couldn't find any readable content in that image." }, 422);
      return json({ text: result.trim() });
    }

    return json({ error: "unknown generation type" }, 400);
  } catch (err: any) {
    return json({ error: err.message || "Generation failed" }, 502);
  }
};

export const config: Config = {
  path: "/api/generate",
};
