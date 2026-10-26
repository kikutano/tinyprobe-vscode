'use strict';

// "tinyprobe: Migrate with AI": recognise the exports of other API tools and write the prompt that
// hands them to the user's coding agent (decision 0001 of tinyprobe: the agent does the import).
// No VS Code API here: it runs, and is tested, with plain Node.

const path = require('node:path');

/** Enough of a file to recognise it: exports put their markers near the top. */
const SNIFF_BYTES = 64 * 1024;

const GUIDE_URL = 'https://raw.githubusercontent.com/kikutano/tinyprobe/main/docs/llm-guide.md';

/** @typedef {'postman' | 'postman-environment' | 'insomnia' | 'bruno' | 'openapi' | 'har'} SourceKind */

const LABELS = {
  postman: 'Postman collection',
  'postman-environment': 'Postman environment',
  insomnia: 'Insomnia export',
  bruno: 'Bruno collection',
  openapi: 'OpenAPI document',
  har: 'HAR recording'
};

/**
 * What kind of export a file is, from its name and the start of its text, or undefined.
 * @param {string} fileName
 * @param {string} text the first SNIFF_BYTES of the file
 * @returns {SourceKind | undefined}
 */
function detectSource(fileName, text) {
  const name = path.basename(fileName).toLowerCase();
  const extension = path.extname(name);

  if (name === 'bruno.json') return 'bruno';
  if (extension === '.har') return 'har';

  if (extension === '.json') {
    if (/"schema"\s*:\s*"https?:\/\/schema\.getpostman\.com\//.test(text)) return 'postman';
    if (/"_postman_variable_scope"\s*:/.test(text)) return 'postman-environment';
    if (/"__export_format"\s*:\s*4\b/.test(text) || /"_type"\s*:\s*"export"/.test(text)) return 'insomnia';
    if (/^\s*\{\s*"(openapi|swagger)"\s*:/.test(text) || /"(openapi|swagger)"\s*:\s*"[23]\./.test(text)) return 'openapi';
    if (/^\s*\{\s*"log"\s*:/.test(text) && /"entries"\s*:/.test(text)) return 'har';
    return undefined;
  }

  if (extension === '.yaml' || extension === '.yml') {
    if (/^(openapi|swagger)\s*:/m.test(text)) return 'openapi';
    if (/^type\s*:\s*collection\.insomnia\.rest\/5/m.test(text)) return 'insomnia';
  }
  return undefined;
}

/** @param {SourceKind} kind */
function sourceLabel(kind) {
  return LABELS[kind];
}

/** A Bruno collection is its folder; every other source is the file itself. */
function sourcePath(kind, file) {
  return kind === 'bruno' ? path.dirname(file) : file;
}

/**
 * The prompt for the agent, built like the README prompts of tinyprobe.
 * @param {{ kind: SourceKind, source: string, environments?: string[] }} migration
 *   source and environments are paths relative to the workspace, with forward slashes
 */
function migrationPrompt({ kind, source, environments = [] }) {
  const read = `Read the guide with \`tinyprobe guide\` (or ${GUIDE_URL})`;
  const secrets = 'Put secrets only in tinyprobe/env.local.yaml and add it to .gitignore.';
  const report = 'Write tinyprobe/MIGRATION.md with what you converted, what you skipped and why, and tell me which failures look like backend bugs.';

  if (kind === 'openapi') {
    return [
      `${read} and follow it, starting from the OpenAPI document ${source}: write one tinyprobe endpoint per operation`,
      'and workflows that check the documented status codes and response fields, then run them against the',
      'local backend until they pass. Take test values from the seed data, not from the examples in the document.',
      `${secrets} ${report}`,
      'Tell me where the backend does not do what the document says.'
    ].join('\n');
  }

  if (kind === 'postman' || kind === 'postman-environment') {
    const what = kind === 'postman'
      ? `the Postman collection ${source}${environments.length > 0 ? ` and the environments ${list(environments)}` : ''}`
      : `the Postman environment ${source} and the collections it belongs to`;
    return [
      `${read} and follow its section on migrating from Postman: convert ${what}`,
      'to tinyprobe files in tinyprobe/, one folder at a time, and run each workflow until it passes.',
      `${secrets} ${report}`
    ].join('\n');
  }

  return [
    `${read} and follow its section on migrating from other tools: convert the ${sourceLabel(kind)} ${source}`,
    'to tinyprobe files in tinyprobe/, one folder at a time, and run each workflow until it passes.',
    `${secrets} ${report}`
  ].join('\n');
}

function list(items) {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

module.exports = { SNIFF_BYTES, detectSource, sourceLabel, sourcePath, migrationPrompt };
