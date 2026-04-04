import fs from 'fs';
import path from 'path';
import { lexer } from 'marked';
import { logger } from './logger.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/(^-|-$)/g, '');

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

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: "${resolved}"`);
  }

  return resolved;
}

/**
 * @typedef {Object} SectionMeta
 * @property {string} title
 * @property {string} parent
 * @property {number} depth
 * @property {number} [start]
 * @property {number} [end]
 */

/**
 * @typedef {Object} Section
 * @property {string} title
 * @property {string} parent
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

  #buildIndex() {
    if (!this.#rawMarkdown) return;

    const tokens = lexer(this.#rawMarkdown);
    let currentKey = '';
    let currentSection = null;
    const headingOrder = [];

    tokens.forEach((token) => {
      if (token.type === 'heading' && token.depth > 1) {
        const slug = slugify(token.text);

        if (token.depth === 3 && currentSection && currentSection.depth === 2) {
          currentKey = `${slugify(currentSection.text)}-${slug}`;
        } else {
          currentKey = slug;
        }

        this.#index[currentKey] = {
          title: token.text,
          parent: token.depth === 3 ? currentSection?.text : 'Root',
          depth: token.depth,
        };

        headingOrder.push({ key: currentKey, text: token.text, depth: token.depth });

        if (token.depth === 2) currentSection = token;
      }
    });

    let scanPos = 0;
    headingOrder.forEach((h) => {
      const headingLine = `${'#'.repeat(h.depth)} ${h.text}\n`;
      const found = this.#rawMarkdown.indexOf(headingLine, scanPos);
      if (found !== -1) {
        this.#index[h.key].start = found;
        scanPos = found + headingLine.length;
      }
    });

    const keys = Object.keys(this.#index);
    keys.forEach((key, i) => {
      const nextStart = this.#index[keys[i + 1]]?.start;
      this.#index[key].end = nextStart ?? this.#rawMarkdown.length;
    });

    logger.debug('Built index', { sections: keys.length });
  }

  #startWatcher() {
    if (this.#watcher) return;

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
        logger.warn('File watcher error, falling back to manual reload', { error: err.message });
        this.#stopWatcher();
      });
    } catch (err) {
      logger.warn('Could not start file watcher, manual reload required', { error: err.message });
    }
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
      const querySlug = slugify(query);
      const scored = keys.map((k) => {
        const keyWords = k.split('-');
        const titleWords = this.#index[k].title.toLowerCase().split(/\s+/);
        const allWords = [...keyWords, ...titleWords];

        let bestScore = Infinity;
        for (const word of allWords) {
          if (word.length < 2) continue;
          const dist = levenshtein(querySlug, word);
          if (dist < bestScore) bestScore = dist;
        }

        return { key: k, score: bestScore };
      });

      return scored
        .filter((s) => s.score <= Math.max(2, Math.floor(querySlug.length * 0.3)))
        .sort((a, b) => a.score - b.score)
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
      const content = this.#rawMarkdown.slice(meta.start, meta.end);
      return { ...meta, content };
    } catch (err) {
      logger.error(`Error reading section '${key}'`, { error: err.message });
      return null;
    }
  }

  /**
   * @param {string[]} keys
   * @returns {{ key: string, title?: string, parent?: string, depth?: number, content?: string, error?: string }[]}
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
