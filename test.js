import { config } from 'dotenv';
import { WikiParser } from './utils.js';
import { logger } from './logger.js';
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

const fixtureRoot = fs.mkdtempSync(path.join('/tmp', 'wiki-parser-fixture-'));
const singleWikiFile = path.join(fixtureRoot, 'WIKI.md');
const directoryWikiRoot = path.join(fixtureRoot, 'wiki');
const nestedWikiDir = path.join(directoryWikiRoot, 'nested');

fs.mkdirSync(directoryWikiRoot, { recursive: true });
fs.mkdirSync(nestedWikiDir, { recursive: true });

const singleWikiContent = `# Team Wiki

## Approval Workflow Deep Dive

This section explains approval flow.

### Determining "Fully Approved"

The fullyApproved field becomes true when all required criteria pass.

#### Implementation Notes

- Uses fullyApproved from derived status logic.

## Portage Backend Architecture

Services, queues, and integrations overview.
`;

const userWikiContent = `# User Wiki

## Approval Workflow Deep Dive

Directory-based section.

### Determining "Fully Approved"

This doc validates prefixed keys and search by filename.
`;

const operationsWikiContent = `# Operations

## Incident Basics

Runbook snippets.
`;

fs.writeFileSync(singleWikiFile, singleWikiContent);
fs.writeFileSync(path.join(directoryWikiRoot, 'user_wiki.md'), userWikiContent);
fs.writeFileSync(path.join(nestedWikiDir, 'operations.md'), operationsWikiContent);
fs.writeFileSync(path.join(nestedWikiDir, 'legacy.md'), '# Legacy\n\n## Approval Workflow Deep Dive\n\nAmbiguous legacy key test.\n');

const customAnchorContent = `# Main Documentation

## Getting Started {#getting-started}

Welcome to the guide.

### Quick Start {#quick-start}

Quick start content here.

## API Reference {#api-ref}

API documentation content.
`;

const customAnchorFile = path.join(directoryWikiRoot, 'custom_anchors.md');
fs.writeFileSync(customAnchorFile, customAnchorContent);

// --- Constructor & Index ---
console.log('1. Initialization');
const wiki = new WikiParser(singleWikiFile);
assert(wiki.getAllKeys().length > 0, 'should load sections from wiki');
assert(wiki.getAllKeys().includes('approval-workflow-deep-dive'), 'should include known section');

console.log('\n1a. Directory mode');
const directoryWiki = new WikiParser(directoryWikiRoot);
const directoryKeys = directoryWiki.getAllKeys();
assert(directoryKeys.length > 0, 'should load sections from markdown directory');
assert(
  directoryKeys.includes('user-wiki-approval-workflow-deep-dive'),
  'should prefix section keys with file slug in directory mode'
);
assert(
  directoryKeys.includes('nested-operations-incident-basics'),
  'should include nested markdown files when indexing directory'
);
assert(
  directoryKeys.includes('user-wiki-approval-workflow-deep-dive-determining-fully-approved'),
  'should include nested heading keys with file prefix'
);
assert(
  directoryKeys.includes('nested-legacy-approval-workflow-deep-dive'),
  'should include second file section for legacy ambiguity test'
);

// --- Path validation ---
console.log('\n1b. Path validation');
try {
  new WikiParser('');
  assert(false, 'should throw on empty path');
} catch (err) {
  assert(err.message.includes('WIKI_PATH is required'), 'should throw descriptive error');
}

try {
  new WikiParser(path.join(process.cwd(), 'index.js'));
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

const fileSearchResults = directoryWiki.search('user wiki');
assert(
  fileSearchResults.some((k) => k.startsWith('user-wiki-')),
  'should match sections by file slug/file name in directory mode'
);

const emptyResults = wiki.search('nonexistent-xyz');
assert(emptyResults.length === 0, 'should return empty for unknown query');

const allResults = wiki.search();
assert(allResults.length === wiki.getAllKeys().length, 'should return all keys with no query');

// --- Content Search ---
console.log('\n2a. Content Search');
// Search for content within sections (not in headers)
const contentResults = wiki.search('fullyApproved');
assert(contentResults.length > 0, 'should find sections by content keyword');
// Should find the section that contains "fullyApproved" in its content
const hasFullyApprovedSection = contentResults.some((k) => {
  const section = wiki.getSection(k);
  return section && section.content.includes('fullyApproved');
});
assert(hasFullyApprovedSection, 'should return section containing the content keyword');

// Content matches should be sorted after header matches
const implementationNotesSection = wiki.getSection('approval-workflow-deep-dive-determining-fully-approved-implementation-notes');
const usesFullyApproved = wiki.search('uses');
assert(usesFullyApproved.length > 0, 'should find "uses" in content');
const usesIndex = usesFullyApproved.indexOf('approval-workflow-deep-dive-determining-fully-approved-implementation-notes');
assert(usesIndex !== -1, 'should find section containing "uses" in its content');

// Test that header matches come before content-only matches
const approvalAndContent = wiki.search('approval');
const fullyApprovedContent = wiki.search('fullyApproved');
assert(approvalAndContent[0] === 'approval-workflow-deep-dive', 'header match should be first for "approval"');
assert(fullyApprovedContent[0] !== 'approval-workflow-deep-dive', 'content-only match should not be first for "fullyApproved"');

// --- Fuzzy Search ---
console.log('\n2b. Fuzzy Search');
const fuzzyResults = wiki.search('approvl', { fuzzy: true });
assert(fuzzyResults.length > 0, 'should find matches with typo');
assert(fuzzyResults.some((k) => k.includes('approval')), 'should match "approval" despite typo');

const fuzzyFileResults = directoryWiki.search('usr wik', { fuzzy: true });
assert(
  fuzzyFileResults.some((k) => k.startsWith('user-wiki-')),
  'should fuzzy-match file names/slugs in directory mode'
);

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

console.log('\n3a. Canonical keys (directory mode)');
const canonicalDirMeta = directoryWiki.getMeta('user-wiki-approval-workflow-deep-dive-determining-fully-approved');
assert(canonicalDirMeta !== null, 'should return meta for canonical key in directory mode');
assert(canonicalDirMeta.title === 'Determining "Fully Approved"', 'canonical key should have correct title');
assert(canonicalDirMeta.fileSlug === 'user-wiki', 'canonical key should have correct fileSlug');

console.log('\n3b. Legacy key compatibility');
const legacyMeta = directoryWiki.getMeta('approval-workflow-deep-dive-determining-fully-approved');
assert(legacyMeta !== null, 'should resolve legacy key for meta lookup in directory mode');
assert(
  legacyMeta?.fileSlug === 'user-wiki',
  'legacy key meta lookup should resolve to canonical prefixed section'
);

const legacyRootMeta = directoryWiki.getMeta('approval-workflow-deep-dive');
assert(legacyRootMeta !== null, 'should resolve legacy root key to canonical key');

const legacyRootMetaDuplicate = directoryWiki.getMeta('approval-workflow-deep-dive-1');
assert(legacyRootMetaDuplicate !== null, 'should resolve suffixed legacy key for duplicate heading path');

// --- Get Section ---
console.log('\n4. Get Section');
const section = wiki.getSection('approval-workflow-deep-dive-determining-fully-approved');
assert(section !== null, 'should return section for valid key');
assert(section.content.length > 0, 'should have non-empty content');
assert(section.content.includes('fullyApproved'), 'should include section body text');
assert(section.content.includes('fullyApproved'), 'should contain expected keywords');

const missingSection = wiki.getSection('does-not-exist');
assert(missingSection === null, 'should return null for invalid key');

console.log('\n4c. Canonical keys (directory mode)');
const canonicalDirSection = directoryWiki.getSection('user-wiki-approval-workflow-deep-dive-determining-fully-approved');
assert(canonicalDirSection !== null, 'should return section for canonical key in directory mode');
assert(canonicalDirSection.content.includes('prefixed keys'), 'canonical key section should have content');

console.log('\n4d. Legacy key compatibility');
const legacySection = directoryWiki.getSection('approval-workflow-deep-dive-determining-fully-approved');
assert(legacySection !== null, 'should resolve legacy key for section lookup in directory mode');
assert(
  legacySection?.content.includes('prefixed keys'),
  'legacy key section lookup should return canonical section content'
);

const legacySearch = directoryWiki.search('approval-workflow-deep-dive-determining-fully-approved');
assert(
  legacySearch.includes('user-wiki-approval-workflow-deep-dive-determining-fully-approved'),
  'search should match legacy key query and return canonical key'
);

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

const beforeDirCount = directoryWiki.getAllKeys().length;
directoryWiki.reload();
const afterDirCount = directoryWiki.getAllKeys().length;
assert(beforeDirCount === afterDirCount, 'should keep same section count after directory reload');

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

console.log('\n7b. Directory watcher');
const watchDir = fs.mkdtempSync(path.join('/tmp', 'wiki-watch-dir-'));
const initialDoc = path.join(watchDir, 'alpha.md');
const addedDoc = path.join(watchDir, 'beta.md');
fs.writeFileSync(initialDoc, '# Alpha\n\n## Initial\n\nBase content.\n');

const watchedDirectoryWiki = new WikiParser(watchDir, { watch: true });
assert(watchedDirectoryWiki.getAllKeys().includes('alpha-initial'), 'should index directory file on startup');

fs.writeFileSync(addedDoc, '# Beta\n\n## Added\n\nMore content.\n');
await new Promise((r) => setTimeout(r, 700));
assert(watchedDirectoryWiki.getAllKeys().includes('beta-added'), 'should auto-reload on directory add');
watchedDirectoryWiki.close();
fs.rmSync(watchDir, { recursive: true, force: true });

// --- Key validation ---
console.log('\n8. Key format validation');
const validKeys = ['portage-backend', 'approval-workflow', 'test-123'];
const invalidKeys = ['UPPERCASE', 'with spaces', 'with/slashes', 'with.dots'];

// --- Custom Anchors ---
console.log('\n8a. Custom Anchors');
const customAnchorWiki = new WikiParser(customAnchorFile);
const customKeys = customAnchorWiki.getAllKeys();
assert(customKeys.includes('getting-started'), 'should create key from custom anchor');
assert(customKeys.includes('getting-started-quick-start'), 'should create nested key from custom anchor');
assert(customKeys.includes('api-ref'), 'should create key from api custom anchor');

// Verify custom anchor keys are registered
const gettingStartedMeta = customAnchorWiki.getMeta('getting-started');
assert(gettingStartedMeta !== null, 'should find section by custom anchor key');
assert(gettingStartedMeta.title === 'Getting Started', 'should have title without anchor syntax');

// Verify content is cleaned (no anchor syntax in output)
const gettingStartedSection = customAnchorWiki.getSection('getting-started');
assert(gettingStartedSection !== null, 'should get section with custom anchor key');
assert(!gettingStartedSection.content.includes('{#'), 'should not contain anchor syntax in content');
assert(gettingStartedSection.content.includes('Welcome to the guide'), 'should have actual content');

// Verify title stripping
assert(gettingStartedSection.title === 'Getting Started', 'title should not have anchor suffix');

// Verify canonical nested key works directly
const quickStartCanonical = customAnchorWiki.getMeta('getting-started-quick-start');
assert(quickStartCanonical !== null, 'should find nested section by canonical custom anchor key');
assert(quickStartCanonical.title === 'Quick Start', 'canonical custom anchor key should have correct title');

// Verify legacy alias registration (quick-start resolves to nested key)
console.log('\n8b. Custom anchor legacy alias');
const quickStartLegacy = customAnchorWiki.getMeta('quick-start');
assert(quickStartLegacy !== null, 'should resolve custom anchor as legacy alias');
assert(quickStartLegacy.title === 'Quick Start', 'should resolve to correct title');

// Clean up
customAnchorWiki.close();

for (const k of validKeys) {
  assert(/^[a-z0-9-]+$/.test(k), `"${k}" should be valid format`);
}

for (const k of invalidKeys) {
  assert(!/^[a-z0-9-]+$/.test(k), `"${k}" should be invalid format`);
}

// --- Close cleanup ---
console.log('\n9. Close');
wiki.close();
directoryWiki.close();
await logger.close();
assert(true, 'should close without error');

fs.rmSync(fixtureRoot, { recursive: true, force: true });

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
