// @ts-expect-error bun:sqlite available at runtime (bun is the configured runtime)
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ToolHandlerMap } from "../types.js";

interface DeepSearchArgs {
  query: string;
  type?: "page" | "all";
  limit?: number;
}

interface BlockRow {
  id: string;
  type: string;
  properties: string | null;
  parent_id: string;
  last_edited_time: number;
}

interface MatchResult {
  page_id: string;
  title: string;
  url: string;
  matches: Array<{ block_type: string; snippet: string }>;
  last_edited: string;
}

const NOTION_DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Notion",
  "notion.db",
);

function formatNotionId(raw: string): string {
  const clean = raw.replace(/-/g, "");
  if (clean.length !== 32) return raw;
  return [
    clean.slice(0, 8),
    clean.slice(8, 12),
    clean.slice(12, 16),
    clean.slice(16, 20),
    clean.slice(20),
  ].join("-");
}

function createNotionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function extractTextFromProperties(properties: string | null): string {
  if (!properties) return "";
  try {
    const parsed = JSON.parse(properties);
    const texts: string[] = [];
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (Array.isArray(item) && typeof item[0] === "string") {
            texts.push(item[0]);
          }
        }
      }
    }
    return texts.join(" ");
  } catch {
    return "";
  }
}

function extractTitle(properties: string | null): string {
  if (!properties) return "(untitled)";
  try {
    const parsed = JSON.parse(properties);
    const titleProp = parsed.title;
    if (Array.isArray(titleProp)) {
      return titleProp.map((item: unknown[]) => (Array.isArray(item) ? item[0] : "")).join("");
    }
    return "(untitled)";
  } catch {
    return "(untitled)";
  }
}

export const deepSearchHandlers: ToolHandlerMap = {
  async notion_deep_search(toolArguments) {
    const args = toolArguments as unknown as DeepSearchArgs;

    if (!args.query || args.query.trim().length === 0) {
      throw new Error("Missing required argument: query");
    }

    if (!existsSync(NOTION_DB_PATH)) {
      return {
        error: "Notion desktop cache not found",
        message: `Expected SQLite database at: ${NOTION_DB_PATH}. Install and open Notion desktop app to enable deep search.`,
      };
    }

    const limit = Math.min(args.limit ?? 20, 100);
    const db = new Database(NOTION_DB_PATH, { readonly: true });

    try {
      const typeFilter =
        args.type === "page" ? "AND type = 'page'" : "";

      const stmt = db.prepare(
        `SELECT id, type, properties, parent_id, last_edited_time
         FROM block
         WHERE alive = 1
           AND properties LIKE '%' || ? || '%' COLLATE NOCASE
           ${typeFilter}
         ORDER BY last_edited_time DESC
         LIMIT ?`,
      );

      const rows = stmt.all(args.query, limit * 3) as BlockRow[];

      const pageMap = new Map<string, MatchResult>();

      for (const row of rows) {
        const text = extractTextFromProperties(row.properties);
        if (!text.toLowerCase().includes(args.query.toLowerCase())) continue;

        const snippetStart = Math.max(
          0,
          text.toLowerCase().indexOf(args.query.toLowerCase()) - 40,
        );
        const snippet = text.slice(snippetStart, snippetStart + 120).trim();

        let pageId: string;
        let pageTitle: string;

        if (row.type === "page") {
          pageId = formatNotionId(row.id);
          pageTitle = extractTitle(row.properties);
        } else {
          const parentPage = resolveParentPage(db, row.parent_id, 10);
          if (!parentPage) continue;
          pageId = formatNotionId(parentPage.id);
          pageTitle = extractTitle(parentPage.properties);
        }

        const existing = pageMap.get(pageId);
        if (existing) {
          if (existing.matches.length < 5) {
            existing.matches.push({ block_type: row.type, snippet });
          }
        } else {
          pageMap.set(pageId, {
            page_id: pageId,
            title: pageTitle,
            url: createNotionUrl(pageId),
            matches: [{ block_type: row.type, snippet }],
            last_edited: row.last_edited_time
              ? new Date(row.last_edited_time).toISOString()
              : "",
          });
        }

        if (pageMap.size >= limit) break;
      }

      return {
        object: "deep_search_results",
        query: args.query,
        result_count: pageMap.size,
        results: Array.from(pageMap.values()),
      };
    } finally {
      db.close();
    }
  },
};

function resolveParentPage(
  db: Database,
  parentId: string,
  maxDepth: number,
): BlockRow | null {
  const stmt = db.prepare(
    "SELECT id, type, properties, parent_id, last_edited_time FROM block WHERE id = ? AND alive = 1",
  );
  let currentId = parentId;
  for (let i = 0; i < maxDepth; i++) {
    const row = stmt.get(currentId) as BlockRow | null;
    if (!row) return null;
    if (row.type === "page") return row;
    currentId = row.parent_id;
  }
  return null;
}
