import { config } from 'dotenv';
import { WikiParser } from './utils.js';
import fs from 'fs';
import path from 'path';

config();

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log('WikiParser Tests\n');

// --- Constructor & Index ---
console.log('1. Initialization');
const wiki = new WikiParser(process.env.WIKI_PATH);
assert(wiki.getAllKeys().length > 0, 'should load sections from wiki');
assert(wiki.getAllKeys().includes('approval-workflow-deep-dive'), 'should include known section');

// --- Path validation ---
console.log('\n1b. Path validation');
try {
  new WikiParser('');
  assert(false, 'should throw on empty path');
} catch (err) {
  assert(err.message.includes('WIKI_PATH is required'), 'should throw descriptive error');
}

try {
  new WikiParser('../../etc/passwd');
  assert(false, 'should reject non-markdown files');
} catch (err) {
  assert(err.message.includes('Invalid file extension'), 'should reject non-.md extensions');
}

try {
  new WikiParser('/nonexistent/path/file.md');
  assert(false, 'should reject missing files');
} catch (err) {
  assert(err.message.includes('not found or not readable'), 'should reject unreadable paths');
}

// --- Search ---
console.log('\n2. Search');
const approvalResults = wiki.search('approval');
assert(approvalResults.length > 0, 'should find sections matching "approval"');
assert(approvalResults.includes('approval-workflow-deep-dive'), 'should include exact match');

const emptyResults = wiki.search('nonexistent-xyz');
assert(emptyResults.length === 0, 'should return empty for unknown query');

const allResults = wiki.search();
assert(allResults.length === wiki.getAllKeys().length, 'should return all keys with no query');

// --- Fuzzy Search ---
console.log('\n2b. Fuzzy Search');
const fuzzyResults = wiki.search('approvl', { fuzzy: true });
assert(fuzzyResults.length > 0, 'should find matches with typo');
assert(fuzzyResults.some((k) => k.includes('approval')), 'should match "approval" despite typo');

const fuzzyLimit = wiki.search('a', { fuzzy: true, limit: 3 });
assert(fuzzyLimit.length <= 3, 'should respect limit parameter');

// --- findSimilar ---
console.log('\n2c. findSimilar');
const similar = wiki.findSimilar('aprovla-workflow');
assert(similar.length > 0, 'should return similar keys');
assert(similar[0].score > 0, 'should have non-zero score');
assert(similar[0].score < 'aprovla-workflow'.length, 'should filter out exact matches');

// --- Meta ---
console.log('\n3. Get Meta');
const meta = wiki.getMeta('approval-workflow-deep-dive-determining-fully-approved');
assert(meta !== null, 'should return meta for valid key');
assert(meta.title === 'Determining "Fully Approved"', 'should have correct title');
assert(meta.parent === 'Approval Workflow Deep Dive', 'should have correct parent');
assert(meta.depth === 3, 'should track heading depth');
assert(meta.start !== undefined && meta.start !== null, 'should have start position');
assert(meta.end !== undefined && meta.end !== null, 'should have end position');

const missingMeta = wiki.getMeta('does-not-exist');
assert(missingMeta === null, 'should return null for invalid key');

// --- Get Section ---
console.log('\n4. Get Section');
const section = wiki.getSection('approval-workflow-deep-dive-determining-fully-approved');
assert(section !== null, 'should return section for valid key');
assert(section.content.length > 0, 'should have non-empty content');
assert(section.content.includes('###'), 'should include heading in content');
assert(section.content.includes('fullyApproved'), 'should contain expected keywords');

const missingSection = wiki.getSection('does-not-exist');
assert(missingSection === null, 'should return null for invalid key');

// --- Get Sections (batch) ---
console.log('\n4b. Get Sections (batch)');
const batch = wiki.getSections([
  'approval-workflow-deep-dive',
  'does-not-exist',
  'portage-backend-architecture',
]);
assert(batch.length === 3, 'should return results for all requested keys');
assert(batch.filter((s) => s.error).length === 1, 'should have one error');
assert(batch.filter((s) => !s.error).length === 2, 'should have two successes');
assert(batch[0].content?.length > 0, 'successful section should have content');
assert(batch[1].error, 'missing section should have error');

// --- Section Boundaries ---
console.log('\n5. Section Boundaries');
const keys = wiki.getAllKeys();
for (const key of keys.slice(0, 5)) {
  const s = wiki.getSection(key);
  assert(s.content.trim().length > 0, `section "${key}" should have content`);
}

// --- Reload ---
console.log('\n6. Reload');
const beforeCount = wiki.getAllKeys().length;
wiki.reload();
const afterCount = wiki.getAllKeys().length;
assert(beforeCount === afterCount, 'should have same section count after reload');
assert(afterCount > 0, 'should still have sections after reload');

// --- FS Watcher ---
console.log('\n7. FS Watcher');
const tmpFile = path.join('/tmp', `wiki-test-${Date.now()}.md`);
fs.writeFileSync(tmpFile, '## Test Section\n\nSome content.\n');
const watchedWiki = new WikiParser(tmpFile, { watch: true });
assert(watchedWiki.getAllKeys().includes('test-section'), 'should index watched file');

fs.writeFileSync(tmpFile, '## Test Section\n\nUpdated content.\n');
fs.writeFileSync(tmpFile, '## Test Section\n\nUpdated content.\n## New Section\n\nMore.\n');

await new Promise((r) => setTimeout(r, 500));
assert(watchedWiki.getAllKeys().includes('new-section'), 'should auto-reload on file change');
watchedWiki.close();
fs.unlinkSync(tmpFile);

// --- Key validation ---
console.log('\n8. Key format validation');
const validKeys = ['portage-backend', 'approval-workflow', 'test-123'];
const invalidKeys = ['UPPERCASE', 'with spaces', 'with/slashes', 'with.dots'];

for (const k of validKeys) {
  assert(/^[a-z0-9-]+$/.test(k), `"${k}" should be valid format`);
}

for (const k of invalidKeys) {
  assert(!/^[a-z0-9-]+$/.test(k), `"${k}" should be invalid format`);
}

// --- Close cleanup ---
console.log('\n9. Close');
wiki.close();
assert(true, 'should close without error');

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
