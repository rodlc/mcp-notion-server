import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const deepSearchTool: Tool = {
  name: "notion_deep_search",
  description:
    "Search inside Notion page content using the local desktop cache (SQLite). Finds text in all block types, not just page titles. Much more thorough than notion_find/notion_search which only match titles. Requires Notion desktop app installed.",
  annotations: {
    title: "Deep Search (Local Cache)",
    readOnlyHint: true,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to search for in page content",
      },
      type: {
        type: "string",
        enum: ["page", "all"],
        description:
          "Filter by block type: 'page' for pages only, 'all' for all blocks (default: all)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 20)",
      },
    },
    required: ["query"],
  },
};
