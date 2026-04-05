# Wiki Explorer MCP Server

A generic MCP (Model Context Protocol) server that exposes any project wiki to AI assistants, enabling contextual wiki lookups during development sessions.

## Features

- **Lazy loading** — indexes headings once, loads content on-demand via byte positions
- **Auto-reload** — watches the wiki file or markdown directory for changes with debouncing
- **Fuzzy search** — handles typos and partial matches via levenshtein distance
- **Batch fetch** — retrieve multiple sections in one call (max 20)
- **Smart suggestions** — returns similar keys when a section isn't found
- **Path safety** — validates markdown sources and safe path resolution
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
WIKI_PATH=path/to/your/wiki-source  # file (.md/.markdown) or directory
LOG_LEVEL=info  # debug, info, warn, error
```

## MCP Tools

| Tool | Description | Parameters |
|---|---|---|
| `list_wiki` | List all available wiki sections | none |
| `browse_wiki` | Browse sections by topic/parent | `topic` (string, optional) |
| `search_wiki` | Search sections by keyword | `query` (string), `fuzzy` (boolean) |
| `get_wiki_section` | Get a single section's content | `key` (string), `offset` (number), `limit` (number) |
| `get_wiki_sections` | Get multiple sections at once | `keys` (string[], max 20) |

## Connecting to AI Assistants

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "wiki-explorer": {
      "command": "node",
      "args": ["/path/to/wiki-explorer/index.js"],
      "env": {
        "WIKI_PATH": "/path/to/your/docs/wiki"
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
    "wiki-explorer": {
      "command": "node",
      "args": ["/path/to/wiki-explorer/index.js"],
      "env": {
        "WIKI_PATH": "/path/to/your/docs/wiki"
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
    "wiki-explorer": {
      "command": "node",
      "args": ["/path/to/wiki-explorer/index.js"],
      "env": {
        "WIKI_PATH": "/path/to/your/docs/wiki"
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

- **Constructor** — validates file/directory source, loads markdown docs, builds heading index with byte positions
- **`search(query, { fuzzy, limit })`** — find sections by keyword
- **`findSimilar(key)`** — get similar keys via levenshtein distance
- **`getSection(key)`** — retrieve content for a single section
- **`getSections(keys)`** — batch retrieve multiple sections
- **`reload()`** — re-read file and rebuild index
- **`close()`** — stop file watcher

### Key Compatibility

- Canonical keys in directory mode are prefixed by file slug (e.g. `user-wiki-approval-workflow-deep-dive`)
- Legacy heading-only keys are still accepted in `getMeta`/`getSection` for backward compatibility
- Ambiguous legacy keys require suffixed form (`-1`, `-2`) to resolve deterministically
- Search accepts legacy key queries but returns canonical keys

### Security

- Source validation (`.md`/`.markdown` file or directory)
- Safe path resolution via `path.resolve` + fs stat checks
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
