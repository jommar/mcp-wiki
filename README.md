# TransAct Wiki MCP Server

An MCP (Model Context Protocol) server that exposes your project wiki to AI assistants, enabling contextual wiki lookups during development sessions.

## Features

- **Lazy loading** — indexes headings once, loads content on-demand via byte positions
- **Auto-reload** — watches the wiki file for changes with debouncing
- **Fuzzy search** — handles typos and partial matches via levenshtein distance
- **Batch fetch** — retrieve multiple sections in one call (max 20)
- **Smart suggestions** — returns similar keys when a section isn't found
- **Path safety** — validates file extensions and prevents traversal attacks
- **Graceful shutdown** — handles SIGINT/SIGTERM, cleans up watchers
- **Structured logging** — configurable log levels for debugging

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure wiki path
cp .env.example .env

# 3. Run tests
npm test
```

### .env

```env
WIKI_PATH=../docs/WIKI.md
LOG_LEVEL=info  # debug, info, warn, error
```

## MCP Tools

| Tool | Description | Parameters |
|---|---|---|
| `list_wiki` | List all available wiki sections | none |
| `search_wiki` | Search sections by keyword | `query` (string), `fuzzy` (boolean) |
| `get_wiki_section` | Get a single section's content | `key` (string, lowercase-hyphenated) |
| `get_wiki_sections` | Get multiple sections at once | `keys` (string[], max 20) |

## Connecting to AI Assistants

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "transact-wiki": {
      "command": "node",
      "args": ["/transAct/mcp/index.js"],
      "env": {
        "WIKI_PATH": "/transAct/docs/WIKI.md"
      }
    }
  }
}
```

### Cursor

Add to Cursor MCP settings:

```json
{
  "mcpServers": {
    "transact-wiki": {
      "command": "node",
      "args": ["/transAct/mcp/index.js"],
      "env": {
        "WIKI_PATH": "/transAct/docs/WIKI.md"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "transact-wiki": {
      "command": "node",
      "args": ["/transAct/mcp/index.js"],
      "env": {
        "WIKI_PATH": "/transAct/docs/WIKI.md"
      }
    }
  }
}
```

## Running

```bash
# Start MCP server (stdio transport)
npm start

# Debug mode
LOG_LEVEL=debug npm start
```

## Architecture

```
index.js          → MCP server + tool registration + signal handlers
utils.js          → WikiParser class (indexing, search, content extraction)
logger.js         → Structured logging with configurable levels
test.js           → 49 assertions covering all functionality
.env              → WIKI_PATH, LOG_LEVEL configuration
```

### WikiParser Class

- **Constructor** — validates/resolves path, loads markdown, builds heading index with byte positions
- **`search(query, { fuzzy, limit })`** — find sections by keyword
- **`findSimilar(key)`** — get similar keys via levenshtein distance
- **`getSection(key)`** — retrieve content for a single section
- **`getSections(keys)`** — batch retrieve multiple sections
- **`reload()`** — re-read file and rebuild index
- **`close()`** — stop file watcher

### Security

- File extension validation (`.md`/`.markdown` only)
- Path traversal prevention via `path.resolve` + `fs.access`
- File size cap (50MB default)
- Key format validation (lowercase alphanumeric + hyphens)
- Batch request limits (max 20 keys)

### Graceful Shutdown

Handles `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`. Cleans up file watchers and exits cleanly.

## Testing

```bash
npm test
```

Covers: initialization, path validation, search, fuzzy search, findSimilar, meta, sections, batch fetch, boundaries, reload, file watcher, key format validation, and cleanup.

## CI/CD

GitHub Actions runs tests on Node 20 and 22 for every push/PR to `main`. See `.github/workflows/ci.yml`.
