import fs from 'fs';
import path from 'path';
import { lexer } from 'marked';
import { logger } from './logger.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const slugify = (text) => {
  if (!text || !text.trim()) return '';
  return text
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/(^-|-$)/g, '');
};

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

function resolveSafePath(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();

  if (!['.md', '.markdown'].includes(ext)) {
    throw new Error(`Invalid file extension: "${ext}". Only .md/.markdown files are allowed`);
  }

  return resolved;
}

/**
 * @typedef {Object} SectionMeta
 * @property {string} title
 * @property {string} parent
 * @property {string[]} breadcrumbs
 * @property {number} depth
 * @property {number} [start]
 * @property {number} [end]
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
  #filePath;
  #index = {};
  #rawMarkdown = null;
  #watcher = null;
  #watchDebounce = null;
  #slugCounts = {};

  /**
   * @param {string} filePath
   * @param {{ watch?: boolean }} [options]
   */
  constructor(filePath, { watch = false } = {}) {
    if (!filePath) throw new Error('WIKI_PATH is required');

    this.#filePath = resolveSafePath(filePath);
    this.#loadMarkdown();
    this.#buildIndex();

    if (watch) this.#startWatcher();
  }

  /**
   * Async factory for non-blocking initialization
   * @param {string} filePath
   * @param {{ watch?: boolean }} [options]
   * @returns {Promise<WikiParser>}
   */
  static async create(filePath, { watch = false } = {}) {
    const parser = new WikiParser(filePath, { watch: false });
    await parser.#loadMarkdownAsync();
    await parser.#buildIndexAsync();
    if (watch) parser.#startWatcher();
    return parser;
  }

  #loadMarkdown() {
    try {
      const stat = fs.statSync(this.#filePath);
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(`Wiki file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      }

      this.#rawMarkdown = fs.readFileSync(this.#filePath, 'utf8');
      logger.debug('Loaded wiki file', { path: this.#filePath, size: stat.size });
    } catch (err) {
      if (err.message.includes('exceeds')) throw err;
      throw new Error(`Could not load wiki at "${this.#filePath}": ${err.message}`);
    }
  }

  async #loadMarkdownAsync() {
    const { stat, readFile } = fs.promises;
    try {
      const fileStat = await stat(this.#filePath);
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`Wiki file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`);
      }

      this.#rawMarkdown = await readFile(this.#filePath, 'utf8');
      logger.debug('Loaded wiki file (async)', { path: this.#filePath, size: fileStat.size });
    } catch (err) {
      if (err.message.includes('exceeds')) throw err;
      throw new Error(`Could not load wiki at "${this.#filePath}": ${err.message}`);
    }
  }

  #buildIndex() {
    if (!this.#rawMarkdown) return;

    const tokens = lexer(this.#rawMarkdown);
    const headingOrder = [];
    const headingStack = [];
    this.#slugCounts = {};

    tokens.forEach((token) => {
      if (token.type === 'heading' && token.depth > 1) {
        while (headingStack.length && headingStack.at(-1).depth >= token.depth) {
          headingStack.pop();
        }

        const slug = slugify(token.text);
        if (!slug) return;

        const parentSlug = headingStack.length ? headingStack.at(-1).runningSlug : '';
        const baseSlug = parentSlug ? `${parentSlug}-${slug}` : slug;

        this.#slugCounts[baseSlug] = (this.#slugCounts[baseSlug] || 0) + 1;
        const currentKey = this.#slugCounts[baseSlug] > 1
          ? `${baseSlug}-${this.#slugCounts[baseSlug] - 1}`
          : baseSlug;

        const parentText = headingStack.length ? headingStack.at(-1).text : 'Root';
        const breadcrumbs = headingStack.map((h) => h.text);

        this.#index[currentKey] = {
          title: token.text,
          parent: parentText,
          depth: token.depth,
          breadcrumbs,
        };

        headingOrder.push({ key: currentKey, text: token.text, depth: token.depth });
        headingStack.push({ slug, text: token.text, depth: token.depth, runningSlug: baseSlug });
      }
    });

    this.#assignPositions(headingOrder);

    const keys = Object.keys(this.#index);
    keys.forEach((key, i) => {
      const nextStart = this.#index[keys[i + 1]]?.start;
      this.#index[key].end = nextStart ?? this.#rawMarkdown.length;
    });

    logger.debug('Built index', { sections: keys.length });
  }

  async #buildIndexAsync() {
    if (!this.#rawMarkdown) return;

    const tokens = lexer(this.#rawMarkdown);
    const headingOrder = [];
    const headingStack = [];
    this.#slugCounts = {};

    for (const token of tokens) {
      if (token.type === 'heading' && token.depth > 1) {
        while (headingStack.length && headingStack.at(-1).depth >= token.depth) {
          headingStack.pop();
        }

        const slug = slugify(token.text);
        if (!slug) continue;

        const parentSlug = headingStack.length ? headingStack.at(-1).runningSlug : '';
        const baseSlug = parentSlug ? `${parentSlug}-${slug}` : slug;

        this.#slugCounts[baseSlug] = (this.#slugCounts[baseSlug] || 0) + 1;
        const currentKey = this.#slugCounts[baseSlug] > 1
          ? `${baseSlug}-${this.#slugCounts[baseSlug] - 1}`
          : baseSlug;

        const parentText = headingStack.length ? headingStack.at(-1).text : 'Root';
        const breadcrumbs = headingStack.map((h) => h.text);

        this.#index[currentKey] = {
          title: token.text,
          parent: parentText,
          depth: token.depth,
          breadcrumbs,
        };

        headingOrder.push({ key: currentKey, text: token.text, depth: token.depth });
        headingStack.push({ slug, text: token.text, depth: token.depth, runningSlug: baseSlug });
      }
    }

    this.#assignPositions(headingOrder);

    const keys = Object.keys(this.#index);
    keys.forEach((key, i) => {
      const nextStart = this.#index[keys[i + 1]]?.start;
      this.#index[key].end = nextStart ?? this.#rawMarkdown.length;
    });

    logger.debug('Built index (async)', { sections: keys.length });
  }

  #assignPositions(headingOrder) {
    let scanPos = 0;
    headingOrder.forEach((h) => {
      const headingPrefix = '#'.repeat(h.depth);
      const escapedText = escapeRegex(h.text);
      const headingRegex = new RegExp(`^${headingPrefix}\\s+${escapedText}\\s*(?:#+\\s*)?$`, 'gm');

      headingRegex.lastIndex = scanPos;
      const match = headingRegex.exec(this.#rawMarkdown);

      if (match) {
        this.#index[h.key].start = match.index;
        scanPos = match.index + match[0].length;
      } else {
        logger.warn('Heading not found in raw markdown', { key: h.key, text: h.text });
      }
    });
  }

  #startWatcher() {
    if (this.#watcher) return;

    const watchFile = () => {
      try {
        this.#watcher = fs.watch(this.#filePath, { persistent: false }, (eventType) => {
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
  }

  /**
   * @param {string} [query]
   * @param {SearchOptions} [options]
   * @returns {string[]}
   */
  search(query, { fuzzy = false, limit = 20 } = {}) {
    const keys = Object.keys(this.#index);
    if (!query) return keys;

    if (fuzzy) {
      const queryWords = slugify(query).split('-').filter((w) => w.length >= 2);
      const scored = keys.map((k) => {
        const keyWords = k.split('-').filter((w) => w.length >= 2);
        const titleWords = this.#index[k].title.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
        const allWords = [...keyWords, ...titleWords];

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

    return keys
      .filter(
        (k) => k.includes(slugify(query)) || this.#index[k].title.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, limit);
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
    const meta = this.#index[key];
    if (!meta || meta.start === undefined) return null;

    try {
      const headingLineEnd = this.#rawMarkdown.indexOf('\n', meta.start);
      const contentStart = headingLineEnd === -1 ? meta.end : headingLineEnd + 1;
      const content = this.#rawMarkdown.slice(contentStart, meta.end).trim();
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
    return this.#index[key] || null;
  }

  reload() {
    this.#index = {};
    this.#loadMarkdown();
    this.#buildIndex();
  }

  close() {
    this.#stopWatcher();
  }
}

export { slugify };
