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
const startedAt = Date.now();

const server = new McpServer({
  name: 'wiki-explorer',
  version: '1.0.0',
});

// Lightweight request counter for shutdown summary
const requestCounts = {
  list_wiki: 0,
  browse_wiki: 0,
  search_wiki: 0,
  get_wiki_section: 0,
  get_wiki_sections: 0,
};

const readOnlyAnnotations = { readOnlyHint: true };

// MCP requires both `content` (text fallback for older clients) and
// `structuredContent` (for clients that support outputSchema).  The SDK
// official example returns both — omitting `content` causes clients that
// don't understand structuredContent to see empty results.
function withContent(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

// Shared output schemas
const sectionRefSchema = {
  key: z.string().describe('Canonical slug key for the section'),
  parent: z.string().describe('Parent topic/group name'),
  title: z.string().describe('Display title of the section'),
};

server.registerTool(
  'list_wiki',
  {
    description: 'List all available wiki section keys. Use browse_wiki instead for topic-filtered results.',
    inputSchema: {},
    outputSchema: {
      sections: z.array(z.object(sectionRefSchema)).describe('All wiki sections'),
      count: z.number().describe('Total number of sections'),
    },
    annotations: readOnlyAnnotations,
  },
  async () => {
    try {
      requestCounts.list_wiki++;
      const keys = wiki.getAllKeys();
      const sections = keys.map((k) => {
        const meta = wiki.getMeta(k);
        return { key: k, parent: meta.parent, title: meta.title };
      });

      logger.info('list_wiki', { count: keys.length });

      return withContent({ sections, count: keys.length });
    } catch (err) {
      logger.error('list_wiki failed', { error: err.message });
      return withContent({ error: err.message });
    }
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
    outputSchema: {
      groups: z.array(z.object({
        parent: z.string().describe('Parent topic name'),
        sections: z.array(z.object({
          key: z.string().describe('Canonical slug key'),
          title: z.string().describe('Display title'),
          depth: z.number().describe('Heading depth (2 = H2, 3 = H3, etc.)'),
        })),
      })).describe('Sections grouped by parent topic'),
      count: z.number().describe('Total number of matching sections'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ topic }) => {
    try {
      requestCounts.browse_wiki++;
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

      const groups = Object.entries(byParent).map(([parent, sections]) => ({ parent, sections }));

      logger.info('browse_wiki', { topic, count: filtered.length });

      return withContent({ groups, count: filtered.length });
    } catch (err) {
      logger.error('browse_wiki failed', { topic, error: err.message });
      return withContent({ groups: [], count: 0, error: err.message });
    }
  }
);

server.registerTool(
  'search_wiki',
  {
    description: 'Search wiki section titles and content by keyword. Returns matching section keys. Header matches are prioritized over content matches.',
    inputSchema: {
      query: z.string().min(1).max(200).describe('Keyword to search'),
      fuzzy: z.boolean().optional().default(false).describe('Enable fuzzy matching for typos'),
    },
    outputSchema: {
      results: z.array(z.object(sectionRefSchema)).describe('Matching sections, header matches first'),
      count: z.number().describe('Number of results'),
      suggestions: z.array(z.string()).optional().describe('Similar keys when no results found'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ query, fuzzy }) => {
    try {
      requestCounts.search_wiki++;
      const results = wiki.search(query, { fuzzy });

      if (results.length === 0) {
        const similar = wiki.findSimilar(query);
        const suggestions = similar.map((s) => s.key);

        logger.info('search_wiki no results', { query });

        return withContent({ results: [], count: 0, suggestions: suggestions.length > 0 ? suggestions : undefined });
      }

      const formattedResults = results.map((k) => {
        const meta = wiki.getMeta(k);
        return { key: k, parent: meta.parent, title: meta.title };
      });

      logger.info('search_wiki', { query, count: results.length });

      return withContent({ results: formattedResults, count: results.length });
    } catch (err) {
      logger.error('search_wiki failed', { query, error: err.message });
      return withContent({ results: [], count: 0, error: err.message });
    }
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
    outputSchema: {
      title: z.string().optional().describe('Section display title'),
      parent: z.string().optional().describe('Parent topic name'),
      source: z.string().optional().describe('Source file path'),
      content: z.string().optional().describe('Section markdown content'),
      totalLength: z.number().optional().describe('Total content length in characters'),
      offset: z.number().optional().describe('Current character offset'),
      limit: z.number().optional().describe('Applied character limit'),
      hasMore: z.boolean().optional().describe('Whether more content exists beyond this page'),
      nextOffset: z.number().optional().describe('Offset for the next page, if hasMore is true'),
      relatedSections: z.array(z.object({
        key: z.string().describe('Related section key'),
        title: z.string().describe('Related section title'),
      })).optional().describe('Related sections by key prefix'),
      error: z.string().optional().describe('Error message if section not found or key invalid'),
      suggestions: z.array(z.string()).optional().describe('Similar keys when section not found'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ key, offset, limit }) => {
    try {
      requestCounts.get_wiki_section++;
      const keyError = validateKey(key);
      if (keyError) {
        logger.warn('get_wiki_section invalid key', { key });
        return withContent({ error: keyError });
      }

      const section = wiki.getSection(key);
      if (!section) {
        const similar = wiki.findSimilar(key);
        const suggestions = similar.map((s) => s.key);

        logger.warn('get_wiki_section not found', { key });

        return withContent({
          error: `Section '${key}' not found`,
          suggestions: suggestions.length > 0 ? suggestions : undefined,
        });
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

      logger.info('get_wiki_section', { key, contentLength: content.length, totalLength });

      return withContent({
        title: section.title,
        parent: section.parent,
        source: section.filePath,
        content,
        totalLength,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + limit : undefined,
        relatedSections: relatedKeys.map((k) => ({ key: k, title: wiki.getMeta(k).title })),
      });
    } catch (err) {
      logger.error('get_wiki_section failed', { key, error: err.message });
      return withContent({ error: err.message });
    }
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
    outputSchema: {
      sections: z.array(z.union([
        z.object({
          key: z.string().describe('Section slug key'),
          title: z.string().describe('Section display title'),
          parent: z.string().describe('Parent topic name'),
          source: z.string().describe('Source file path'),
          content: z.string().describe('Section markdown content'),
          truncated: z.boolean().describe('Whether content was truncated'),
        }),
        z.object({
          key: z.string().describe('Requested section slug key'),
          error: z.string().describe('Error message'),
        }),
      ])).describe('Retrieved sections; error field present if section not found'),
      successCount: z.number().describe('Number of successfully retrieved sections'),
      errorCount: z.number().describe('Number of sections that failed'),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ keys }) => {
    try {
      requestCounts.get_wiki_sections++;
      const invalidKeys = keys.map(validateKey).filter(Boolean);
      if (invalidKeys.length > 0) {
        logger.warn('get_wiki_sections invalid keys', { keys });
        return withContent({ sections: keys.map((k) => ({ key: k, error: `Invalid key format: "${k}"` })), successCount: 0, errorCount: keys.length });
      }

      const sections = wiki.getSections(keys);
      const success = sections.filter((s) => !s.error);
      const errors = sections.filter((s) => s.error);
      if (errors.length > 0) {
        logger.warn('get_wiki_sections partial errors', { failedKeys: errors.map((s) => s.key) });
      }

      const result = {
        sections: sections.map((s) => {
          if (s.error) {
            return { key: s.key, error: s.error };
          }
          const truncated = s.content.length > MAX_CONTENT_LENGTH;
          const content = truncated ? s.content.slice(0, MAX_CONTENT_LENGTH) : s.content;
          return {
            key: s.key,
            title: s.title,
            parent: s.parent,
            source: s.filePath,
            content,
            truncated,
          };
        }),
        successCount: success.length,
        errorCount: errors.length,
      };

      logger.info('get_wiki_sections', { requested: keys.length, success: success.length, errors: errors.length });

      return withContent(result);
    } catch (err) {
      logger.error('get_wiki_sections failed', { keys, error: err.message });
      return withContent({ sections: [], successCount: 0, errorCount: keys.length, error: err.message });
    }
  }
);

function shutdown() {
  const uptimeSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalRequests = Object.values(requestCounts).reduce((a, b) => a + b, 0);
  const activeTools = Object.entries(requestCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(', ');

  logger.info('Shutting down', {
    uptime: `${uptimeSec}s`,
    totalRequests,
    sections: wiki.getAllKeys().length,
    tools: activeTools || 'none',
  });

  wiki.close();
  logger.close().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  // Synchronous fallback for the normal MCP stdio lifecycle:
  // when the client disconnects, stdin closes and the process exits
  // without SIGTERM/SIGINT, so the async shutdown handler never fires.
  const uptimeSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const totalRequests = Object.values(requestCounts).reduce((a, b) => a + b, 0);
  const activeTools = Object.entries(requestCounts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(', ');

  logger.flushSync('info', 'Shutting down', {
    uptime: `${uptimeSec}s`,
    totalRequests,
    sections: wiki.getAllKeys().length,
    tools: activeTools || 'none',
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  shutdown();
});

logger.info('Starting Wiki Explorer MCP Server', {
  wikiPath: process.env.WIKI_PATH,
  sections: wiki.getAllKeys().length,
  pid: process.pid,
  node: process.version,
});

const transport = new StdioServerTransport();
await server.connect(transport);
