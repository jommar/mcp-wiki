import fs from 'fs';
import path from 'path';
import { lexer } from 'marked';
import { logger } from './logger.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

const slugify = (text) => {
  if (!text || !text.trim()) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
};

/**
 * Extract custom anchor from heading text (e.g., "Title {#custom-anchor}" -> "Title", "custom-anchor")
 * Returns { text, anchor } where anchor may be undefined
 */
function extractCustomAnchor(text) {
  const match = text.match(/^(.+?)\s*\{#([^}]+)\}$/);
  if (!match) return { text, anchor: undefined };
  return { text: match[1].trim(), anchor: match[2] };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function resolveSafePath(sourcePath) {
  const resolved = path.resolve(sourcePath);

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return { resolved, type: 'directory' };

    const ext = path.extname(resolved).toLowerCase();
    if (!MARKDOWN_EXTENSIONS.has(ext)) {
      throw new Error(`Invalid file extension: "${ext}". Only .md/.markdown files are allowed`);
    }

    return { resolved, type: 'file' };
  } catch (err) {
    if (err.message.startsWith('Invalid file extension')) throw err;
    throw new Error(`Wiki source not found or not readable at "${resolved}": ${err.message}`);
  }
}

function collectMarkdownFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (MARKDOWN_EXTENSIONS.has(ext)) files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function collectDirectories(rootDir) {
  const directories = [rootDir];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(currentDir, entry.name);
      directories.push(fullPath);
      stack.push(fullPath);
    }
  }

  return directories;
}

/**
 * @typedef {Object} SectionMeta
 * @property {string} title
 * @property {string} parent
 * @property {string[]} breadcrumbs
 * @property {number} depth
 * @property {number} [start]
 * @property {number} [end]
 * @property {string} [file]
 * @property {string} [fileSlug]
 * @property {string} [filePath]
 * @property {string} [legacyKey]
 */

/**
 * @typedef {Object} Section
 * @property {string} title
 * @property {string} parent
 * @property {string[]} breadcrumbs
 * @property {number} depth
 * @property {number} start
 * @property {number} end
 * @property {string} content
 */

/**
 * @typedef {Object} SearchOptions
 * @property {boolean} [fuzzy]
 * @property {number} [limit]
 */

export class WikiParser {
  #sourcePath;
  #sourceType;
  #index = {};
  #documents = [];
  #watcher = null;
  #dirWatchers = new Map();
  #watchDebounce = null;
  #legacyAliasToCanonical = new Map();
  #legacyAmbiguous = new Set();
  #legacyWarningShown = new Set();
  #contentIndex = {};   // key -> lowercase content string for fast search
  #relatedMap = {};     // key -> array of related keys

  /**
   * @param {string} sourcePath
   * @param {{ watch?: boolean }} [options]
   */
  constructor(sourcePath, { watch = false } = {}) {
    if (!sourcePath) throw new Error('WIKI_PATH is required');

    const { resolved, type } = resolveSafePath(sourcePath);
    this.#sourcePath = resolved;
    this.#sourceType = type;
    this.#documents = this.#loadMarkdown();
    this.#buildIndex();

    if (watch) this.#startWatcher();
  }

  /**
   * Async factory for non-blocking initialization
   * @param {string} sourcePath
   * @param {{ watch?: boolean }} [options]
   * @returns {Promise<WikiParser>}
   */
  static async create(sourcePath, { watch = false } = {}) {
    const parser = new WikiParser(sourcePath, { watch: false });
    parser.#documents = await parser.#loadMarkdownAsync();
    await parser.#buildIndexAsync();
    if (watch) parser.#startWatcher();
    return parser;
  }

  #buildFileSlug(filePath, seenSlugs) {
    if (this.#sourceType === 'file') return '';

    const relativePath = path.relative(this.#sourcePath, filePath);
    const ext = path.extname(relativePath);
    const withoutExt = relativePath.slice(0, -ext.length);
    const normalized = withoutExt.replace(/[\\/]+/g, '-');
    const baseSlug = slugify(normalized) || 'index';

    seenSlugs[baseSlug] = (seenSlugs[baseSlug] || 0) + 1;
    if (seenSlugs[baseSlug] === 1) return baseSlug;
    return `${baseSlug}-${seenSlugs[baseSlug] - 1}`;
  }

  #loadDocumentsSync(filePaths) {
    const documents = [];
    const seenSlugs = {};

    for (const filePath of filePaths) {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`Wiki file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`);
      }

      const rawMarkdown = fs.readFileSync(filePath, 'utf8');
      documents.push({
        filePath,
        fileName: path.basename(filePath),
        fileSlug: this.#buildFileSlug(filePath, seenSlugs),
        rawMarkdown,
      });
    }

    return documents;
  }

  async #loadDocumentsAsync(filePaths) {
    const documents = [];
    const seenSlugs = {};

    for (const filePath of filePaths) {
      const fileStat = await fs.promises.stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`Wiki file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`);
      }

      const rawMarkdown = await fs.promises.readFile(filePath, 'utf8');
      documents.push({
        filePath,
        fileName: path.basename(filePath),
        fileSlug: this.#buildFileSlug(filePath, seenSlugs),
        rawMarkdown,
      });
    }

    return documents;
  }

  #loadMarkdown() {
    try {
      let documents;
      if (this.#sourceType === 'file') {
        documents = this.#loadDocumentsSync([this.#sourcePath]);
      } else {
        const filePaths = collectMarkdownFiles(this.#sourcePath);
        documents = this.#loadDocumentsSync(filePaths);
      }

      logger.debug('Loaded wiki source', {
        path: this.#sourcePath,
        type: this.#sourceType,
        files: documents.length,
      });

      return documents;
    } catch (err) {
      if (err.message.includes('exceeds')) throw err;
      throw new Error(`Could not load wiki at "${this.#sourcePath}": ${err.message}`);
    }
  }

  async #loadMarkdownAsync() {
    try {
      let documents;
      if (this.#sourceType === 'file') {
        documents = await this.#loadDocumentsAsync([this.#sourcePath]);
      } else {
        const filePaths = collectMarkdownFiles(this.#sourcePath);
        documents = await this.#loadDocumentsAsync(filePaths);
      }

      logger.debug('Loaded wiki source (async)', {
        path: this.#sourcePath,
        type: this.#sourceType,
        files: documents.length,
      });

      return documents;
    } catch (err) {
      if (err.message.includes('exceeds')) throw err;
      throw new Error(`Could not load wiki at "${this.#sourcePath}": ${err.message}`);
    }
  }

  #registerLegacyAlias(legacyKey, canonicalKey) {
    if (!legacyKey || legacyKey === canonicalKey) return;
    if (this.#legacyAmbiguous.has(legacyKey)) return;

    const existing = this.#legacyAliasToCanonical.get(legacyKey);
    if (!existing) {
      this.#legacyAliasToCanonical.set(legacyKey, canonicalKey);
      return;
    }

    if (existing !== canonicalKey) {
      this.#legacyAliasToCanonical.delete(legacyKey);
      this.#legacyAmbiguous.add(legacyKey);
    }
  }

  #resolveKey(key, { warnLegacy = false } = {}) {
    if (this.#index[key]) return key;

    const canonicalKey = this.#legacyAliasToCanonical.get(key);
    if (!canonicalKey) return null;

    if (warnLegacy && !this.#legacyWarningShown.has(key)) {
      logger.warn('Legacy wiki key used; prefer canonical key', { legacyKey: key, canonicalKey });
      this.#legacyWarningShown.add(key);
    }

    return canonicalKey;
  }

  #buildIndexForDocument(document, slugCounts, legacySlugCounts) {
    const tokens = lexer(document.rawMarkdown);
    const headingOrder = [];
    const headingStack = [];

    for (const token of tokens) {
      if (token.type !== 'heading' || token.depth <= 1) continue;

      while (headingStack.length && headingStack.at(-1).depth >= token.depth) {
        headingStack.pop();
      }

      // Extract custom anchor if present (e.g., "Title {#custom-anchor}")
      const { text: headingText, anchor: customAnchor } = extractCustomAnchor(token.text);
      const headingSlug = slugify(headingText);
      if (!headingSlug) continue;

      // Use custom anchor if provided, otherwise generate from heading text
      const slugToUse = customAnchor || headingSlug;

      const parentHeadingSlug = headingStack.length ? headingStack.at(-1).runningSlug : '';
      const baseHeadingSlug = parentHeadingSlug ? `${parentHeadingSlug}-${slugToUse}` : slugToUse;
      const prefixedBaseSlug = document.fileSlug ? `${document.fileSlug}-${baseHeadingSlug}` : baseHeadingSlug;

      legacySlugCounts[baseHeadingSlug] = (legacySlugCounts[baseHeadingSlug] || 0) + 1;
      const legacyKey = legacySlugCounts[baseHeadingSlug] > 1
        ? `${baseHeadingSlug}-${legacySlugCounts[baseHeadingSlug] - 1}`
        : baseHeadingSlug;

      slugCounts[prefixedBaseSlug] = (slugCounts[prefixedBaseSlug] || 0) + 1;
      const currentKey = slugCounts[prefixedBaseSlug] > 1
        ? `${prefixedBaseSlug}-${slugCounts[prefixedBaseSlug] - 1}`
        : prefixedBaseSlug;

      this.#registerLegacyAlias(legacyKey, currentKey);

      // If custom anchor was used, also register it directly as a legacy alias
      // This allows TOC links like #portage-backend-architecture to work
      if (customAnchor) {
        // Also register the simple anchor (e.g., "portage-backend-architecture" without file prefix)
        const simpleAnchor = customAnchor;
        this.#registerLegacyAlias(simpleAnchor, currentKey);
      }

      const parentText = headingStack.length ? headingStack.at(-1).text : 'Root';
      const breadcrumbs = headingStack.map((h) => h.text);

      // Store the title without the custom anchor syntax for display
      this.#index[currentKey] = {
        title: headingText,
        parent: parentText,
        depth: token.depth,
        breadcrumbs,
        file: document.fileName,
        fileSlug: document.fileSlug,
        filePath: document.filePath,
        legacyKey,
      };

      headingOrder.push({ key: currentKey, text: token.text, depth: token.depth });
      headingStack.push({ slug: headingSlug, text: token.text, depth: token.depth, runningSlug: baseHeadingSlug });
    }

    this.#assignPositions(document, headingOrder);

    for (let i = 0; i < headingOrder.length; i++) {
      const currentKey = headingOrder[i].key;
      const nextStart = i + 1 < headingOrder.length ? this.#index[headingOrder[i + 1].key]?.start : undefined;
      this.#index[currentKey].end = nextStart ?? document.rawMarkdown.length;
    }
  }

  #buildIndex() {
    if (!this.#documents.length) return;

    const index = {};
    const slugCounts = {};
    const legacySlugCounts = {};
    const legacyAliasToCanonical = new Map();
    const legacyAmbiguous = new Set();

    // Temporarily swap index and alias maps so #buildIndexForDocument writes into locals
    const prevIndex = this.#index;
    const prevAlias = this.#legacyAliasToCanonical;
    const prevAmbiguous = this.#legacyAmbiguous;
    this.#index = index;
    this.#legacyAliasToCanonical = legacyAliasToCanonical;
    this.#legacyAmbiguous = legacyAmbiguous;

    for (const document of this.#documents) {
      this.#buildIndexForDocument(document, slugCounts, legacySlugCounts);
    }

    // Build content index and related-sections map from the new index
    const contentIndex = this.#buildContentIndex();
    const relatedMap = this.#buildRelatedMap();

    // Atomic swap — readers never see an empty/partial state
    this.#index = index;
    this.#legacyAliasToCanonical = legacyAliasToCanonical;
    this.#legacyAmbiguous = legacyAmbiguous;
    this.#legacyWarningShown.clear();
    this.#contentIndex = contentIndex;
    this.#relatedMap = relatedMap;

    logger.debug('Built index', { sections: Object.keys(index).length, files: this.#documents.length });
  }

  async #buildIndexAsync() {
    if (!this.#documents.length) return;

    const index = {};
    const slugCounts = {};
    const legacySlugCounts = {};
    const legacyAliasToCanonical = new Map();
    const legacyAmbiguous = new Set();

    const prevIndex = this.#index;
    const prevAlias = this.#legacyAliasToCanonical;
    const prevAmbiguous = this.#legacyAmbiguous;
    this.#index = index;
    this.#legacyAliasToCanonical = legacyAliasToCanonical;
    this.#legacyAmbiguous = legacyAmbiguous;

    for (const document of this.#documents) {
      this.#buildIndexForDocument(document, slugCounts, legacySlugCounts);
    }

    const contentIndex = this.#buildContentIndex();
    const relatedMap = this.#buildRelatedMap();

    this.#index = index;
    this.#legacyAliasToCanonical = legacyAliasToCanonical;
    this.#legacyAmbiguous = legacyAmbiguous;
    this.#legacyWarningShown.clear();
    this.#contentIndex = contentIndex;
    this.#relatedMap = relatedMap;

    logger.debug('Built index (async)', { sections: Object.keys(index).length, files: this.#documents.length });
  }

  #assignPositions(document, headingOrder) {
    let scanPos = 0;
    headingOrder.forEach((h) => {
      const headingPrefix = '#'.repeat(h.depth);
      const escapedText = escapeRegex(h.text);
      const headingRegex = new RegExp(`^${headingPrefix}\\s+${escapedText}\\s*(?:#+\\s*)?$`, 'gm');

      headingRegex.lastIndex = scanPos;
      const match = headingRegex.exec(document.rawMarkdown);

      if (match) {
        this.#index[h.key].start = match.index;
        scanPos = match.index + match[0].length;
      } else {
        logger.warn('Heading not found in raw markdown', { key: h.key, text: h.text, filePath: document.filePath });
      }
    });
  }

  /**
   * Build a lowercase content index for fast search without calling getSection().
   * Stores key -> { lower: string, length: number } for each section.
   */
  #buildContentIndex() {
    const contentIndex = {};
    for (const [key, meta] of Object.entries(this.#index)) {
      if (meta.start === undefined) continue;

      const sourceDocument = this.#documents.find((d) => d.filePath === meta.filePath);
      if (!sourceDocument) continue;

      const headingLineEnd = sourceDocument.rawMarkdown.indexOf('\n', meta.start);
      const contentStart = headingLineEnd === -1 ? meta.end : headingLineEnd + 1;
      let content = sourceDocument.rawMarkdown.slice(contentStart, meta.end).trim();
      content = content.replace(/\s*\{#[^}]+\}/g, '');

      contentIndex[key] = { lower: content.toLowerCase(), length: content.length };
    }
    return contentIndex;
  }

  /**
   * Build a map of key -> related keys based on shared key prefix (first 2 segments).
   * Pre-computed so get_wiki_section doesn't scan all keys on every call.
   */
  #buildRelatedMap() {
    const prefixGroups = {};
    for (const key of Object.keys(this.#index)) {
      const prefix = key.split('-').slice(0, 2).join('-');
      if (!prefixGroups[prefix]) prefixGroups[prefix] = [];
      prefixGroups[prefix].push(key);
    }

    const relatedMap = {};
    for (const key of Object.keys(this.#index)) {
      const prefix = key.split('-').slice(0, 2).join('-');
      const siblings = (prefixGroups[prefix] || []).filter((k) => k !== key);
      relatedMap[key] = siblings.slice(0, 5);
    }
    return relatedMap;
  }

  #refreshDirectoryWatchers() {
    const targetDirectories = new Set(collectDirectories(this.#sourcePath));

    for (const [watchedDir, watcher] of this.#dirWatchers.entries()) {
      if (targetDirectories.has(watchedDir)) continue;
      watcher.close();
      this.#dirWatchers.delete(watchedDir);
    }

    for (const dirPath of targetDirectories) {
      if (this.#dirWatchers.has(dirPath)) continue;

      try {
        const watcher = fs.watch(dirPath, { persistent: false }, () => {
          clearTimeout(this.#watchDebounce);
          this.#watchDebounce = setTimeout(() => {
            logger.info('Wiki directory changed, reloading', { sourcePath: this.#sourcePath });
            this.reload();
            this.#refreshDirectoryWatchers();
          }, 300);
        });

        watcher.on('error', (err) => {
          logger.warn('Directory watcher error, retrying in 1s', { dirPath, error: err.message });
          clearTimeout(this.#watchDebounce);
          this.#watchDebounce = setTimeout(() => this.#refreshDirectoryWatchers(), 1000);
        });

        this.#dirWatchers.set(dirPath, watcher);
      } catch (err) {
        logger.warn('Could not start directory watcher, retrying in 1s', { dirPath, error: err.message });
        clearTimeout(this.#watchDebounce);
        this.#watchDebounce = setTimeout(() => this.#refreshDirectoryWatchers(), 1000);
      }
    }
  }

  #startWatcher() {
    if (this.#sourceType === 'directory') {
      if (this.#dirWatchers.size > 0) return;
      this.#refreshDirectoryWatchers();
      return;
    }

    if (this.#watcher) return;

    const watchFile = () => {
      try {
        this.#watcher = fs.watch(this.#sourcePath, { persistent: false }, (eventType) => {
          if (eventType !== 'change') return;

          clearTimeout(this.#watchDebounce);
          this.#watchDebounce = setTimeout(() => {
            logger.info('Wiki file changed, reloading');
            this.reload();
          }, 300);
        });

        this.#watcher.on('error', (err) => {
          logger.warn('File watcher error, retrying in 1s', { error: err.message });
          this.#stopWatcher();
          setTimeout(() => this.#startWatcher(), 1000);
        });
      } catch (err) {
        logger.warn('Could not start file watcher, retrying in 1s', { error: err.message });
        setTimeout(() => this.#startWatcher(), 1000);
      }
    };

    watchFile();
  }

  #stopWatcher() {
    clearTimeout(this.#watchDebounce);
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }

    for (const watcher of this.#dirWatchers.values()) {
      watcher.close();
    }
    this.#dirWatchers.clear();
  }

  /**
   * @param {string} [query]
   * @param {SearchOptions} [options]
   * @returns {string[] | { key: string, headerMatch: boolean, contentMatch: boolean }[]}
   */
  search(query, { fuzzy = false, limit = 20, detailed = false } = {}) {
    const keys = Object.keys(this.#index);
    if (!query) return keys;

    if (fuzzy) {
      const queryWords = slugify(query).split('-').filter((w) => w.length >= 2);
      const scored = keys.map((k) => {
        const keyWords = k.split('-').filter((w) => w.length >= 2);
        const legacyWords = (this.#index[k].legacyKey || '').split('-').filter((w) => w.length >= 2);
        const titleWords = this.#index[k].title.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
        const fileWords = slugify(this.#index[k].fileSlug || this.#index[k].file || '')
          .split('-')
          .filter((w) => w.length >= 2);
        const allWords = [...keyWords, ...legacyWords, ...titleWords, ...fileWords];

        let totalScore = 0;
        let matchedWords = 0;

        for (const qWord of queryWords) {
          let bestScore = Infinity;
          for (const word of allWords) {
            const dist = levenshtein(qWord, word);
            if (dist < bestScore) bestScore = dist;
          }
          if (bestScore <= Math.max(2, Math.floor(qWord.length * 0.3))) {
            totalScore += bestScore;
            matchedWords++;
          }
        }

        return { key: k, score: matchedWords > 0 ? totalScore / matchedWords : Infinity, matchedWords };
      });

      return scored
        .filter((s) => s.matchedWords > 0)
        .sort((a, b) => a.score - b.score || b.matchedWords - a.matchedWords)
        .slice(0, limit)
        .map((s) => s.key);
    }

    const queryLower = query.toLowerCase();

    // Score sections: header matches are weighted higher than content matches
    // Uses pre-built #contentIndex instead of calling getSection() per key
    return keys
      .map((k) => {
        // Check header-based matches (higher priority)
        const headerMatch =
          k.includes(slugify(query)) ||
          this.#index[k].legacyKey?.includes(slugify(query)) ||
          this.#index[k].title.toLowerCase().includes(queryLower) ||
          this.#index[k].file?.toLowerCase().includes(queryLower) ||
          this.#index[k].fileSlug?.includes(slugify(query));

        // Check content-based match using pre-built index
        const hasContentMatch = this.#contentIndex[k]?.lower.includes(queryLower) ?? false;

        // Return priority score (lower is better): 0 = header match, 1 = content match only
        return {
          key: k,
          headerMatch,
          contentMatch: hasContentMatch,
          priority: headerMatch ? 0 : hasContentMatch ? 1 : -1,
        };
      })
      .filter((r) => r.priority >= 0)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, limit)
      .map((r) => detailed ? { key: r.key, headerMatch: r.headerMatch, contentMatch: r.contentMatch } : r.key);
  }

  /**
   * @param {string} key
   * @param {number} [maxResults]
   * @returns {{ key: string, score: number }[]}
   */
  findSimilar(key, maxResults = 5) {
    const keys = Object.keys(this.#index);
    return keys
      .map((k) => ({ key: k, score: levenshtein(k, key) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, maxResults)
      .filter((s) => s.score > 0 && s.score < key.length);
  }

  /**
   * @param {string} key
   * @returns {Section | null}
   */
  getSection(key) {
    const resolvedKey = this.#resolveKey(key, { warnLegacy: true });
    if (!resolvedKey) return null;

    const meta = this.#index[resolvedKey];
    if (!meta || meta.start === undefined) return null;

    try {
      const sourceDocument = this.#documents.find((d) => d.filePath === meta.filePath);
      if (!sourceDocument) return null;

      const headingLineEnd = sourceDocument.rawMarkdown.indexOf('\n', meta.start);
      const contentStart = headingLineEnd === -1 ? meta.end : headingLineEnd + 1;
      let content = sourceDocument.rawMarkdown.slice(contentStart, meta.end).trim();
      
      // Clean custom anchor syntax from content (e.g., "{#custom-anchor}")
      content = content.replace(/\s*\{#[^}]+\}/g, '');
      
      return { ...meta, content };
    } catch (err) {
      logger.error(`Error reading section '${key}'`, { error: err.message });
      return null;
    }
  }

  /**
   * @param {string[]} keys
   * @returns {{ key: string, title?: string, parent?: string, breadcrumbs?: string[], depth?: number, content?: string, error?: string }[]}
   */
  getSections(keys) {
    return keys
      .map((key) => {
        const section = this.getSection(key);
        return section ? { key, ...section } : { key, error: `Section '${key}' not found` };
      });
  }

  /** @returns {string[]} */
  getAllKeys() {
    return Object.keys(this.#index);
  }

  /**
   * @param {string} key
   * @returns {SectionMeta | null}
   */
  getMeta(key) {
    const resolvedKey = this.#resolveKey(key, { warnLegacy: true });
    if (!resolvedKey) return null;
    const meta = this.#index[resolvedKey] || null;
    if (!meta) return null;
    // Attach contentLength from pre-built index
    const contentLength = this.#contentIndex[resolvedKey]?.length ?? 0;
    return { ...meta, contentLength };
  }

  /**
   * Get related section keys for a given key (pre-computed).
   * @param {string} key
   * @returns {string[]}
   */
  getRelatedKeys(key) {
    const resolvedKey = this.#resolveKey(key, { warnLegacy: false });
    return this.#relatedMap[resolvedKey] || [];
  }

  /**
   * Get content length for a section without reading the full content.
   * @param {string} key
   * @returns {number}
   */
  getContentLength(key) {
    const resolvedKey = this.#resolveKey(key, { warnLegacy: false });
    return this.#contentIndex[resolvedKey]?.length ?? 0;
  }

  /**
   * Get a content snippet around a search match.
   * @param {string} key
   * @param {string} query
   * @param {number} [radius=100]
   * @returns {string|undefined}
   */
  getSnippet(key, query, radius = 100) {
    const resolvedKey = this.#resolveKey(key, { warnLegacy: false });
    const entry = this.#contentIndex[resolvedKey];
    if (!entry) return undefined;

    const idx = entry.lower.indexOf(query.toLowerCase());
    if (idx === -1) return undefined;

    const section = this.getSection(key);
    if (!section) return undefined;

    const start = Math.max(0, idx - radius);
    const end = Math.min(section.content.length, idx + query.length + radius);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < section.content.length ? '...' : '';
    return prefix + section.content.slice(start, end) + suffix;
  }

  reload() {
    // Build into local vars first, then swap atomically so concurrent
    // readers never see an empty/partial index.
    const newDocuments = this.#loadMarkdown();
    const prevDocuments = this.#documents;
    this.#documents = newDocuments;
    this.#buildIndex();
  }

  close() {
    this.#stopWatcher();
  }
}

export { slugify };
