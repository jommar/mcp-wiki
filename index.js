import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { WikiParser } from './utils.js';
import { logger } from './logger.js';

config();

const MAX_BATCH_KEYS = 20;
const MAX_CONTENT_LENGTH = 8000;
const KEY_PATTERN = /^[a-z0-9-]+$/;

function validateKey(key) {
  if (!KEY_PATTERN.test(key)) {
    return `Invalid key format: "${key}". Keys must be lowercase alphanumeric with hyphens`;
  }
  return null;
}

const wiki = new WikiParser(process.env.WIKI_PATH, { watch: true });

const server = new McpServer({
  name: 'transact-wiki-explorer',
  version: '1.0.0',
});

const readOnlyAnnotations = { readOnlyHint: true };

server.registerTool(
  'list_wiki',
  {
    description: 'List all available wiki section keys. Use browse_wiki instead for topic-filtered results.',
    inputSchema: {},
    annotations: readOnlyAnnotations,
  },
  async () => {
    const keys = wiki.getAllKeys();
    const formattedList = keys
      .map((k) => {
        const meta = wiki.getMeta(k);
        return `- ${k} (${meta.parent} > ${meta.title})`;
      })
      .join('\n');

    logger.debug('list_wiki called', { count: keys.length });

    return {
      content: [{ type: 'text', text: `All wiki sections (${keys.length}):\n${formattedList}` }],
    };
  }
);

server.registerTool(
  'browse_wiki',
  {
    description:
      'Browse wiki sections by topic/parent. Returns section keys and titles without full content. Use this to discover relevant sections before fetching content.',
    inputSchema: {
      topic: z
        .string()
        .optional()
        .describe('Filter by parent topic (e.g., "Portage Backend", "Approval Workflow Deep Dive")'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ topic }) => {
    const keys = wiki.getAllKeys();
    const filtered = topic
      ? keys.filter((k) => {
          const meta = wiki.getMeta(k);
          return meta.parent.toLowerCase().includes(topic.toLowerCase()) || k.includes(topic.toLowerCase());
        })
      : keys;

    const byParent = {};
    for (const k of filtered) {
      const meta = wiki.getMeta(k);
      if (!byParent[meta.parent]) byParent[meta.parent] = [];
      byParent[meta.parent].push({ key: k, title: meta.title, depth: meta.depth });
    }

    const formatted = Object.entries(byParent)
      .map(([parent, sections]) => {
        const lines = sections.map((s) => `  - ${s.key} (${s.depth === 2 ? 'H2' : 'H3'}: ${s.title})`);
        return `## ${parent}\n${lines.join('\n')}`;
      })
      .join('\n\n');

    logger.debug('browse_wiki', { topic, count: filtered.length });

    return {
      content: [{ type: 'text', text: `Found ${filtered.length} section(s):\n\n${formatted}` }],
    };
  }
);

server.registerTool(
  'search_wiki',
  {
    description: 'Search wiki section titles by keyword. Returns matching keys without content.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('Keyword to search'),
      fuzzy: z.boolean().optional().default(false).describe('Enable fuzzy matching for typos'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ query, fuzzy }) => {
    const results = wiki.search(query, { fuzzy });

    if (results.length === 0) {
      const similar = wiki.findSimilar(query);
      const suggestion =
        similar.length > 0 ? `\n\nDid you mean one of these?\n${similar.map((s) => `- ${s.key}`).join('\n')}` : '';

      logger.debug('search_wiki no results', { query });

      return {
        content: [{ type: 'text', text: `No matches found for "${query}".${suggestion}` }],
      };
    }

    const formattedList = results
      .map((k) => {
        const meta = wiki.getMeta(k);
        return `- ${k} (${meta.parent} > ${meta.title})`;
      })
      .join('\n');

    logger.debug('search_wiki', { query, count: results.length });

    return {
      content: [{ type: 'text', text: `Found ${results.length} section(s):\n${formattedList}` }],
    };
  }
);

server.registerTool(
  'get_wiki_section',
  {
    description: `Retrieve markdown content of a wiki section. Defaults to ${MAX_CONTENT_LENGTH} chars to save tokens. Set limit higher or use offset to read the full section.`,
    inputSchema: {
      key: z.string().describe("The unique slug key of the section (e.g., 'portage-backend-architecture')"),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Character offset to start from. Use to paginate through large sections.'),
      limit: z
        .number()
        .optional()
        .default(MAX_CONTENT_LENGTH)
        .describe(
          `Max characters to return. Default is ${MAX_CONTENT_LENGTH} but you can set it higher to get the full content in one call.`
        ),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, offset, limit }) => {
    const keyError = validateKey(key);
    if (keyError) {
      return {
        content: [{ type: 'text', text: keyError }],
      };
    }

    const section = wiki.getSection(key);
    if (!section) {
      const similar = wiki.findSimilar(key);
      const suggestion =
        similar.length > 0 ? `\n\nDid you mean one of these?\n${similar.map((s) => `- ${s.key}`).join('\n')}` : '';

      logger.debug('get_wiki_section not found', { key });

      return {
        content: [
          {
            type: 'text',
            text: `Section '${key}' not found.${suggestion}\n\nUse list_wiki or search_wiki to find valid keys.`,
          },
        ],
      };
    }

    const totalLength = section.content.length;
    const content = section.content.slice(offset, offset + limit);
    const hasMore = offset + limit < totalLength;

    const relatedKeys = wiki
      .getAllKeys()
      .filter(
        (k) =>
          k !== key &&
          (k.startsWith(key.split('-').slice(0, 2).join('-')) || key.startsWith(k.split('-').slice(0, 2).join('-')))
      )
      .slice(0, 5);

    let output = `### ${section.parent} > ${section.title}\n\n${content}`;

    if (hasMore) {
      const nextOffset = offset + limit;
      output += `\n\n---\n[Content truncated. ${totalLength - nextOffset} characters remaining. Use offset: ${nextOffset} to continue.]`;
    }

    if (relatedKeys.length > 0) {
      output += `\n\n---\nRelated sections:\n${relatedKeys.map((k) => `- ${k} (${wiki.getMeta(k).title})`).join('\n')}`;
    }

    logger.debug('get_wiki_section', { key, contentLength: content.length, totalLength });

    return {
      content: [{ type: 'text', text: output }],
    };
  }
);

server.registerTool(
  'get_wiki_sections',
  {
    description: 'Retrieve multiple wiki sections at once. Each section is truncated to save tokens.',
    inputSchema: {
      keys: z
        .array(z.string())
        .min(1)
        .max(MAX_BATCH_KEYS)
        .describe(`Array of section slug keys to retrieve (max ${MAX_BATCH_KEYS})`),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ keys }) => {
    const invalidKeys = keys.map(validateKey).filter(Boolean);
    if (invalidKeys.length > 0) {
      return {
        content: [{ type: 'text', text: `Invalid keys:\n${invalidKeys.join('\n')}` }],
      };
    }

    const sections = wiki.getSections(keys);
    const success = sections.filter((s) => !s.error);
    const errors = sections.filter((s) => s.error);

    let output = '';

    if (errors.length > 0) {
      output += `Errors (${errors.length}):\n${errors.map((e) => `- ${e.error}`).join('\n')}\n\n`;
    }

    if (success.length > 0) {
      output += success
        .map((s) => {
          const content =
            s.content.length > MAX_CONTENT_LENGTH
              ? s.content.slice(0, MAX_CONTENT_LENGTH) +
                `\n\n[Truncated. ${s.content.length - MAX_CONTENT_LENGTH} more characters.]`
              : s.content;
          return `## ${s.parent} > ${s.title}\n\n${content}`;
        })
        .join('\n\n---\n\n');
    }

    logger.debug('get_wiki_sections', { requested: keys.length, success: success.length, errors: errors.length });

    return {
      content: [{ type: 'text', text: output || 'No sections found.' }],
    };
  }
);

function shutdown() {
  logger.info('Shutting down');
  wiki.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  shutdown();
});

logger.info('Starting TransAct Wiki MCP Server', { wikiPath: process.env.WIKI_PATH });

const transport = new StdioServerTransport();
await server.connect(transport);
