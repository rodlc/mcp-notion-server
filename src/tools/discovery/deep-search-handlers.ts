// @ts-expect-error bun:sqlite available at runtime (bun is the configured runtime)
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync, unlinkSync } from "node:fs";
import type { ToolHandlerMap } from "../types.js";

const NOTION_DB = join(
  homedir(),
  "Library",
  "Application Support",
  "Notion",
  "notion.db",
);
const FTS_DB = join(
  homedir(),
  "Library",
  "Application Support",
  "Notion",
  "notion_fts.db",
);
let cachedMtime = 0;

function formatId(raw: string): string {
  const c = raw.replace(/-/g, "");
  if (c.length !== 32) return raw;
  return `${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}`;
}

function extractText(props: string | null): string {
  if (!props) return "";
  try {
    const texts: string[] = [];
    for (const v of Object.values(JSON.parse(props)))
      if (Array.isArray(v))
        for (const item of v)
          if (Array.isArray(item) && typeof item[0] === "string")
            texts.push(item[0]);
    return texts.join(" ");
  } catch {
    return "";
  }
}

function extractTitle(props: string | null): string {
  if (!props) return "(untitled)";
  try {
    const t = JSON.parse(props).title;
    return Array.isArray(t)
      ? t.map((i: unknown[]) => (Array.isArray(i) ? i[0] : "")).join("")
      : "(untitled)";
  } catch {
    return "(untitled)";
  }
}

function sanitizeQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

type SourceRow = {
  id: string;
  type: string;
  properties: string | null;
  parent_id: string;
};

function buildFtsIndex(): void {
  if (existsSync(FTS_DB)) unlinkSync(FTS_DB);
  const src = new Database(NOTION_DB, { readonly: true });
  const fts = new Database(FTS_DB);
  fts.exec("PRAGMA journal_mode=WAL");
  fts.exec(`CREATE VIRTUAL TABLE block_fts USING fts5(
    block_id UNINDEXED, type UNINDEXED, parent_id UNINDEXED,
    title, content, tokenize="unicode61"
  )`);
  const rows = src
    .query(
      "SELECT id, type, properties, parent_id FROM block WHERE alive = 1",
    )
    .all() as SourceRow[];
  const ins = fts.prepare("INSERT INTO block_fts VALUES (?, ?, ?, ?, ?)");
  fts.transaction(() => {
    for (const r of rows) {
      const title = r.type === "page" ? extractTitle(r.properties) : "";
      const content = extractText(r.properties);
      if (title || content)
        ins.run(r.id, r.type, r.parent_id, title, content);
    }
  })();
  src.close();
  fts.close();
  cachedMtime = statSync(NOTION_DB).mtimeMs;
}

function ensureFtsIndex(): void {
  if (
    !existsSync(FTS_DB) ||
    statSync(NOTION_DB).mtimeMs !== cachedMtime
  )
    buildFtsIndex();
}

function resolveParentPage(
  db: Database,
  parentId: string,
): SourceRow | null {
  const stmt = db.prepare(
    "SELECT id, type, properties, parent_id FROM block WHERE id = ? AND alive = 1",
  );
  let id = parentId;
  for (let i = 0; i < 10; i++) {
    const row = stmt.get(id) as SourceRow | null;
    if (!row) return null;
    if (row.type === "page") return row;
    id = row.parent_id;
  }
  return null;
}

type FtsRow = {
  block_id: string;
  type: string;
  parent_id: string;
  title: string;
  snippet: string;
  rank: number;
};
type PageResult = {
  page_id: string;
  title: string;
  url: string;
  matches: { block_type: string; snippet: string }[];
  relevance_score: number;
};

export const deepSearchHandlers: ToolHandlerMap = {
  async notion_deep_search(toolArguments) {
    const args = toolArguments as unknown as {
      query: string;
      type?: string;
      limit?: number;
    };
    if (!args.query?.trim())
      throw new Error("Missing required argument: query");
    if (!existsSync(NOTION_DB))
      return {
        error: "Notion desktop cache not found",
        message: `Expected: ${NOTION_DB}. Open Notion desktop to enable deep search.`,
      };

    const limit = Math.min(args.limit ?? 20, 100);
    ensureFtsIndex();
    const fts = new Database(FTS_DB, { readonly: true });
    const notion = new Database(NOTION_DB, { readonly: true });

    try {
      const q = sanitizeQuery(args.query);
      const typeClause = args.type === "page" ? "AND type = 'page'" : "";

      const total = (
        fts
          .query(
            `SELECT COUNT(*) as n FROM block_fts WHERE block_fts MATCH ? ${typeClause}`,
          )
          .get(q) as { n: number }
      ).n;

      const rows = fts
        .query(
          `SELECT block_id, type, parent_id, title,
                  snippet(block_fts, 4, '', '', '…', 20) as snippet,
                  bm25(block_fts, 0, 0, 0, 10.0, 1.0) as rank
           FROM block_fts WHERE block_fts MATCH ? ${typeClause}
           ORDER BY rank LIMIT ?`,
        )
        .all(q, limit * 3) as FtsRow[];

      const pages = new Map<string, PageResult>();

      for (const r of rows) {
        let pageId: string;
        let pageTitle: string;
        if (r.type === "page") {
          pageId = formatId(r.block_id);
          pageTitle = r.title || "(untitled)";
        } else {
          const parent = resolveParentPage(notion, r.parent_id);
          if (!parent) continue;
          pageId = formatId(parent.id);
          pageTitle = extractTitle(parent.properties);
        }
        const existing = pages.get(pageId);
        if (existing) {
          if (existing.matches.length < 5)
            existing.matches.push({
              block_type: r.type,
              snippet: r.snippet,
            });
          if (r.rank < existing.relevance_score)
            existing.relevance_score = r.rank;
        } else {
          pages.set(pageId, {
            page_id: pageId,
            title: pageTitle,
            url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
            matches: [{ block_type: r.type, snippet: r.snippet }],
            relevance_score: r.rank,
          });
        }
        if (pages.size >= limit) break;
      }

      return {
        object: "deep_search_results",
        query: args.query,
        result_count: pages.size,
        total_matches: total,
        has_more: pages.size >= limit,
        results: [...pages.values()].sort(
          (a, b) => a.relevance_score - b.relevance_score,
        ),
      };
    } finally {
      fts.close();
      notion.close();
    }
  },
};
