import type { AdoMcpConnection } from "./adoMcpClient.js";

export interface WorkItemBrief {
  id: string;
  title: string;
  type: string;
  state: string;
  /** Compact plain-text summary sized for a small model's context window. */
  text: string;
  /** Free text worth searching the repo for (title + description + repro steps). */
  searchableText: string;
}

const FIELD_LABELS: Array<[field: string, label: string, maxChars: number]> = [
  ["System.Description", "Description", 1800],
  ["Microsoft.VSTS.TCM.ReproSteps", "Repro steps", 1800],
  ["Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance criteria", 1200],
  ["Microsoft.VSTS.TCM.SystemInfo", "System info", 600],
];

const META_FIELDS: Array<[field: string, label: string]> = [
  ["System.AssignedTo", "Assigned to"],
  ["System.Tags", "Tags"],
  ["Microsoft.VSTS.Common.Priority", "Priority"],
  ["Microsoft.VSTS.Common.Severity", "Severity"],
  ["System.AreaPath", "Area"],
  ["System.IterationPath", "Iteration"],
];

/** Work item text fields are HTML; the model needs plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function scalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const v = value as { displayName?: string; uniqueName?: string };
    return v.displayName ?? v.uniqueName ?? "";
  }
  return String(value);
}

/**
 * The Azure DevOps MCP server wraps work-item content in "<<nonce>> [UNTRUSTED ... CONTENT] <<nonce>>"
 * boundary lines (a prompt-injection guard) around the JSON body, so parse the outermost {...} span.
 */
export function parseJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Fetches a work item (+ comments) through the MCP server and reduces it to a small, model-friendly brief. */
export async function fetchWorkItemBrief(ado: AdoMcpConnection, project: string, id: string): Promise<WorkItemBrief> {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new Error(`"${id}" is not a valid work item ID (expected a positive integer).`);
  }

  const item = await ado.call("wit_work_item", { action: "get", id: numericId, project, expand: "All" });
  if (item.isError) {
    throw new Error(`Azure DevOps could not return work item #${id} in project "${project}": ${item.text}`);
  }
  const wi = parseJson(item.text);
  if (!wi?.fields) {
    throw new Error(`Unexpected response for work item #${id}: ${item.text.slice(0, 200)}`);
  }

  const f = wi.fields as Record<string, unknown>;
  const title = scalar(f["System.Title"]);
  const type = scalar(f["System.WorkItemType"]);
  const state = scalar(f["System.State"]);

  const lines: string[] = [`Work item #${id} — ${type}: ${title}`, `State: ${state}`];
  for (const [field, label] of META_FIELDS) {
    const v = scalar(f[field]);
    if (v) lines.push(`${label}: ${v}`);
  }

  const searchable: string[] = [title];
  for (const [field, label, max] of FIELD_LABELS) {
    const raw = scalar(f[field]);
    if (!raw) continue;
    const text = htmlToText(raw);
    if (!text) continue;
    searchable.push(text);
    lines.push(`\n${label}:\n${clip(text, max)}`);
  }

  const relations: string[] = Array.isArray(wi.relations)
    ? wi.relations
        .map((r: any) => `${r?.attributes?.name ?? r?.rel ?? "link"}: ${decodeURIComponent(String(r?.url ?? "")).slice(0, 160)}`)
        .slice(0, 10)
    : [];
  if (relations.length) lines.push(`\nLinks:\n${relations.map((r) => `- ${r}`).join("\n")}`);

  // Comments are supplementary — a failure here shouldn't sink the whole investigation.
  try {
    const c = await ado.call("wit_work_item", { action: "list_comments", workItemId: numericId, project, top: 5 });
    const comments = c.isError ? undefined : parseJson(c.text)?.comments;
    if (Array.isArray(comments) && comments.length) {
      const rendered = comments
        .slice(0, 5)
        .map((cm: any) => `- ${scalar(cm.createdBy) || "someone"}: ${clip(htmlToText(String(cm.text ?? "")), 400)}`);
      lines.push(`\nRecent comments:\n${rendered.join("\n")}`);
      searchable.push(...comments.slice(0, 5).map((cm: any) => htmlToText(String(cm.text ?? ""))));
    }
  } catch {
    // ignore
  }

  return { id, title, type, state, text: lines.join("\n"), searchableText: searchable.join("\n") };
}

/** Wraps a generated report as a work item comment, clearly labelled as an AI draft. */
export function formatCommentBody(report: string, modelLabel: string): string {
  return (
    `**TraceForge — automated investigation**\n` +
    `_AI-generated draft from ${modelLabel}, run locally. Verify before acting on it._\n\n` +
    report.trim()
  );
}

/** Posts a Markdown comment on a work item through the MCP server. */
export async function postWorkItemComment(
  ado: AdoMcpConnection,
  project: string,
  id: string,
  markdown: string
): Promise<void> {
  const res = await ado.call("wit_work_item_comment_write", {
    action: "add",
    project,
    workItemId: Number(id),
    text: markdown,
    format: "Markdown",
  });
  if (res.isError) {
    throw new Error(`Azure DevOps rejected the comment on #${id}: ${res.text}`);
  }
}

const STOPWORDS = new Set(
  (
    "about after again also because been before being below between both cannot could does doing done down during each " +
    "error fail fails failed from have here into just like make many more most much must never only other over same " +
    "should since some still such than that their them then there these they this those through under until upon very " +
    "want were what when where which while will with without work works would your issue problem bug task story " +
    "steps expected actual result results user users click page button"
  ).split(/\s+/)
);

/** Picks identifier-like and distinctive words from free text to grep the repo for. Most specific first. */
export function extractSearchTerms(text: string, max = 6): string[] {
  const terms: string[] = [];
  const add = (t: string) => {
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
  };

  for (const m of text.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|cs|py|java|go|rb|json|ya?ml|md|sql|html|css)\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z0-9_]+\b/g)) add(m[0]);
  for (const m of text.toLowerCase().matchAll(/\b[a-z]{5,}\b/g)) {
    if (!STOPWORDS.has(m[0])) add(m[0]);
  }
  return terms.slice(0, max);
}
