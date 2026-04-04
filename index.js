import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from 'dotenv';
import { WikiParser } from './utils.js';
import { logger } from './logger.js';

config();

const MAX_BATCH_KEYS = 20;
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

server.tool(
  {
    name: 'list_wiki',
    description: 'List all available wiki section keys',
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

server.tool(
  {
    name: 'search_wiki',
    description: 'Search wiki section titles by keyword',
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
      const suggestion = similar.length > 0
        ? `\n\nDid you mean one of these?\n${similar.map((s) => `- ${s.key}`).join('\n')}`
        : '';

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

server.tool(
  {
    name: 'get_wiki_section',
    description: 'Retrieve the full markdown content of a specific wiki section',
    inputSchema: {
      key: z.string().describe("The unique slug key of the section (e.g., 'portage-backend-architecture')"),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key }) => {
    const keyError = validateKey(key);
    if (keyError) {
      return {
        content: [{ type: 'text', text: keyError }],
      };
    }

    const section = wiki.getSection(key);
    if (!section) {
      const similar = wiki.findSimilar(key);
      const suggestion = similar.length > 0
        ? `\n\nDid you mean one of these?\n${similar.map((s) => `- ${s.key}`).join('\n')}`
        : '';

      logger.debug('get_wiki_section not found', { key });

      return {
        content: [{ type: 'text', text: `Section '${key}' not found.${suggestion}\n\nUse list_wiki or search_wiki to find valid keys.` }],
      };
    }

    logger.debug('get_wiki_section', { key, contentLength: section.content.length });

    return {
      content: [
        {
          type: 'text',
          text: `### ${section.parent} > ${section.title}\n\n${section.content}`,
        },
      ],
    };
  }
);

server.tool(
  {
    name: 'get_wiki_sections',
    description: 'Retrieve multiple wiki sections at once',
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
        .map((s) => `## ${s.parent} > ${s.title}\n\n${s.content}`)
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
