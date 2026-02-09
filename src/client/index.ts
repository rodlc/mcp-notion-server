/**
 * Notion API client wrapper
 */

import { convertToMarkdown } from "../markdown/index.js";
import {
  NotionResponse,
  BlockResponse,
  PageResponse,
  DatabaseResponse,
  ListResponse,
  UserResponse,
  CommentResponse,
  RichTextItemResponse,
  CreateDatabaseArgs,
} from "../types/index.js";
import fetch from "node-fetch";

// Constantes pour les limites Notion
const RICH_TEXT_CHAR_LIMIT = 2000;
const RICH_TEXT_ARRAY_LIMIT = 100;

// Block types qui contiennent des rich_text arrays
const RICH_TEXT_BLOCK_TYPES = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "callout",
  "quote",
  "code",
];

/**
 * Split un texte en chunks de taille maximale, sans couper les surrogate pairs
 */
function chunkText(text: string, limit: number = RICH_TEXT_CHAR_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let i = 0;

  while (i < text.length) {
    let end = Math.min(i + limit, text.length);

    // Ne pas couper les surrogate pairs (emoji, caractères Unicode rares)
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--;
    }

    chunks.push(text.slice(i, end));
    i = end;
  }

  return chunks;
}

/**
 * Split un rich_text item en N items si son content dépasse 2000 chars
 */
function chunkRichTextItem(
  item: RichTextItemResponse
): RichTextItemResponse[] {
  if (
    item.type !== "text" ||
    !item.text?.content ||
    item.text.content.length <= RICH_TEXT_CHAR_LIMIT
  ) {
    return [item];
  }

  return chunkText(item.text.content).map((chunk) => ({
    ...item,
    text: { ...item.text!, content: chunk },
    plain_text: chunk,
  }));
}

/**
 * Traite un array rich_text entier : chunk les items trop longs et cap à 100 elements
 */
function chunkRichTextArray(
  richText: RichTextItemResponse[]
): RichTextItemResponse[] {
  const result = richText.flatMap(chunkRichTextItem);
  return result.slice(0, RICH_TEXT_ARRAY_LIMIT);
}

/**
 * Traite récursivement les rich_text dans un block et ses children
 */
function chunkBlockRichText(block: any): any {
  if (!block?.type) return block;

  const typeData = block[block.type];

  // Chunk le rich_text du block si présent
  if (typeData?.rich_text && Array.isArray(typeData.rich_text)) {
    typeData.rich_text = chunkRichTextArray(typeData.rich_text);
  }

  // Traitement récursif des children
  if (typeData?.children && Array.isArray(typeData.children)) {
    typeData.children = typeData.children.map(chunkBlockRichText);
  }

  return block;
}

export class NotionClientWrapper {
  private notionToken: string;
  private baseUrl: string = "https://api.notion.com/v1";
  private headers: { [key: string]: string };

  constructor(token: string) {
    this.notionToken = token;
    this.headers = {
      Authorization: `Bearer ${this.notionToken}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };
  }

  async appendBlockChildren(
    block_id: string,
    children: Partial<BlockResponse>[]
  ): Promise<BlockResponse> {
    const chunkedChildren = children.map(chunkBlockRichText);
    const body = { children: chunkedChildren };

    const response = await fetch(
      `${this.baseUrl}/blocks/${block_id}/children`,
      {
        method: "PATCH",
        headers: this.headers,
        body: JSON.stringify(body),
      }
    );

    return response.json();
  }

  async retrieveBlock(block_id: string): Promise<BlockResponse> {
    const response = await fetch(`${this.baseUrl}/blocks/${block_id}`, {
      method: "GET",
      headers: this.headers,
    });

    return response.json();
  }

  async retrieveBlockChildren(
    block_id: string,
    start_cursor?: string,
    page_size?: number
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (start_cursor) params.append("start_cursor", start_cursor);
    if (page_size) params.append("page_size", page_size.toString());

    const response = await fetch(
      `${this.baseUrl}/blocks/${block_id}/children?${params}`,
      {
        method: "GET",
        headers: this.headers,
      }
    );

    return response.json();
  }

  async deleteBlock(block_id: string): Promise<BlockResponse> {
    const response = await fetch(`${this.baseUrl}/blocks/${block_id}`, {
      method: "DELETE",
      headers: this.headers,
    });

    return response.json();
  }

  async updateBlock(
    block_id: string,
    block: Partial<BlockResponse>
  ): Promise<BlockResponse> {
    const chunkedBlock = chunkBlockRichText(block);

    const response = await fetch(`${this.baseUrl}/blocks/${block_id}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(chunkedBlock),
    });

    return response.json();
  }

  async retrievePage(page_id: string): Promise<PageResponse> {
    const response = await fetch(`${this.baseUrl}/pages/${page_id}`, {
      method: "GET",
      headers: this.headers,
    });

    return response.json();
  }

  async updatePageProperties(
    page_id: string,
    properties: Record<string, any>
  ): Promise<PageResponse> {
    const body = { properties };

    const response = await fetch(`${this.baseUrl}/pages/${page_id}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async listAllUsers(
    start_cursor?: string,
    page_size?: number
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (start_cursor) params.append("start_cursor", start_cursor);
    if (page_size) params.append("page_size", page_size.toString());

    const response = await fetch(`${this.baseUrl}/users?${params.toString()}`, {
      method: "GET",
      headers: this.headers,
    });
    return response.json();
  }

  async retrieveUser(user_id: string): Promise<UserResponse> {
    const response = await fetch(`${this.baseUrl}/users/${user_id}`, {
      method: "GET",
      headers: this.headers,
    });
    return response.json();
  }

  async retrieveBotUser(): Promise<UserResponse> {
    const response = await fetch(`${this.baseUrl}/users/me`, {
      method: "GET",
      headers: this.headers,
    });
    return response.json();
  }

  async createDatabase(
    parent: CreateDatabaseArgs["parent"],
    properties: Record<string, any>,
    title?: RichTextItemResponse[]
  ): Promise<DatabaseResponse> {
    const body = { parent, title, properties };

    const response = await fetch(`${this.baseUrl}/databases`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async queryDatabase(
    database_id: string,
    filter?: Record<string, any>,
    sorts?: Array<{
      property?: string;
      timestamp?: string;
      direction: "ascending" | "descending";
    }>,
    start_cursor?: string,
    page_size?: number
  ): Promise<ListResponse> {
    const body: Record<string, any> = {};
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (start_cursor) body.start_cursor = start_cursor;
    if (page_size) body.page_size = page_size;

    const response = await fetch(
      `${this.baseUrl}/databases/${database_id}/query`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }
    );

    return response.json();
  }

  async retrieveDatabase(database_id: string): Promise<DatabaseResponse> {
    const response = await fetch(`${this.baseUrl}/databases/${database_id}`, {
      method: "GET",
      headers: this.headers,
    });

    return response.json();
  }

  async updateDatabase(
    database_id: string,
    title?: RichTextItemResponse[],
    description?: RichTextItemResponse[],
    properties?: Record<string, any>
  ): Promise<DatabaseResponse> {
    const body: Record<string, any> = {};
    if (title) body.title = title;
    if (description) body.description = description;
    if (properties) body.properties = properties;

    const response = await fetch(`${this.baseUrl}/databases/${database_id}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async createDatabaseItem(
    database_id: string,
    properties: Record<string, any>
  ): Promise<PageResponse> {
    const body = {
      parent: { database_id },
      properties,
    };

    const response = await fetch(`${this.baseUrl}/pages`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async createComment(
    parent?: { page_id: string },
    discussion_id?: string,
    rich_text?: RichTextItemResponse[]
  ): Promise<CommentResponse> {
    const chunkedRichText = rich_text ? chunkRichTextArray(rich_text) : rich_text;
    const body: Record<string, any> = { rich_text: chunkedRichText };
    if (parent) {
      body.parent = parent;
    }
    if (discussion_id) {
      body.discussion_id = discussion_id;
    }

    const response = await fetch(`${this.baseUrl}/comments`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async retrieveComments(
    block_id: string,
    start_cursor?: string,
    page_size?: number
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    params.append("block_id", block_id);
    if (start_cursor) params.append("start_cursor", start_cursor);
    if (page_size) params.append("page_size", page_size.toString());

    const response = await fetch(
      `${this.baseUrl}/comments?${params.toString()}`,
      {
        method: "GET",
        headers: this.headers,
      }
    );

    return response.json();
  }

  async search(
    query?: string,
    filter?: { property: string; value: string },
    sort?: {
      direction: "ascending" | "descending";
      timestamp: "last_edited_time";
    },
    start_cursor?: string,
    page_size?: number
  ): Promise<ListResponse> {
    const body: Record<string, any> = {};
    if (query) body.query = query;
    if (filter) body.filter = filter;
    if (sort) body.sort = sort;
    if (start_cursor) body.start_cursor = start_cursor;
    if (page_size) body.page_size = page_size;

    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async toMarkdown(response: NotionResponse): Promise<string> {
    return convertToMarkdown(response);
  }
}
