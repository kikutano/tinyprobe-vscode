'use strict';

// The tinyprobe JSON protocol (https://github.com/kikutano/tinyprobe/blob/main/docs/protocol.md),
// without any VS Code API: everything here runs, and is tested, with plain Node.

const path = require('node:path');

/** The protocol version this extension understands. */
const SUPPORTED_PROTOCOL = 1;

/** The first version of the binary named `tinyprobe`, with `inspect`, `call` and `--reporter ndjson`. */
const MINIMUM_VERSION = '0.10.0';

/** The first version with `tinyprobe mcp`. Older binaries still work for everything else. */
const MCP_VERSION = '0.13.0';

/** The first version with `tinyprobe schema`, which completion and hover need. */
const SCHEMA_VERSION = '0.14.0';

/**
 * Splits text that arrives in chunks into lines: NDJSON events can be cut anywhere
 * by the pipe. Empty lines are skipped.
 */
class LineSplitter {
  /** @param {(line: string) => void} onLine */
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
  }

  /** @param {string} chunk */
  push(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') this.onLine(line);
    }
  }

  /** Emits what is left after the last newline. */
  end() {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line !== '') this.onLine(line);
  }
}

/** A tinyprobe file defines endpoints or steps at the top level; other YAML files are left alone. */
function isTinyprobeFile(text) {
  return /^(endpoints|steps)[ \t]*:/m.test(text);
}

/** A workflow has steps; an API file has only endpoints. */
function isWorkflowFile(text) {
  return /^steps[ \t]*:/m.test(text);
}

/** `env.local.yaml`, `env.example.yml`, `environment.yaml`, `env-dev.yaml`... */
function isEnvironmentFileName(fileName) {
  return /^env(ironment)?([._-][^/\\]*)?\.ya?ml$/i.test(path.basename(fileName));
}

/** `--var` arguments from a `{ name: value }` map. */
function variableArgs(variables) {
  return Object.entries(variables ?? {}).flatMap(([name, value]) => ['--var', `${name}=${value}`]);
}

function commonArgs({ environment, variables } = {}) {
  return [
    '--reporter', 'ndjson',
    ...(environment ? ['-e', environment] : []),
    ...variableArgs(variables)
  ];
}

/** Arguments of `tinyprobe run` with the NDJSON reporter. */
function runArgs(file, options) {
  return ['run', file, ...commonArgs(options)];
}

/** Arguments of `tinyprobe call`; `args` are `[name, value]` pairs, values typed like YAML. */
function callArgs(file, endpoint, args, options) {
  return [
    'call', file, endpoint,
    ...args.flatMap(([name, value]) => ['--with', `${name}=${value}`]),
    ...commonArgs(options)
  ];
}

/** Locations are relative to the directory tinyprobe ran in, unless the file is outside it. */
function resolveFile(cwd, file) {
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
}

/** Paths are compared ignoring case on Windows, where `c:\` and `C:\` are the same drive. */
function samePath(a, b, platform = process.platform) {
  const [x, y] = [path.normalize(a), path.normalize(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 1-based `{ line, column }` to 0-based; line 0 (the whole file) becomes the first line. */
function toPosition(location) {
  return {
    line: Math.max(0, (location.line ?? 0) - 1),
    character: Math.max(0, (location.column ?? 0) - 1)
  };
}

/**
 * Groups the `errors` of an invalid inspection or run by absolute file path.
 * @returns {Map<string, Array<{ line: number, character: number, message: string }>>}
 */
function problemsByFile(cwd, errors) {
  const byFile = new Map();
  for (const error of errors ?? []) {
    // "command line" problems (tinyprobe call arguments) belong to no file.
    if (error.file === 'command line') continue;
    const file = resolveFile(cwd, error.file);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ ...toPosition(error), message: error.message });
  }
  return byFile;
}

/** Why a step failed, one line per reason: the failure, then each failed check. */
function failureLines(step) {
  const lines = [];
  if (step.failure) lines.push(step.failure);
  for (const assertion of step.assertions ?? []) {
    if (!assertion.passed) lines.push(`${assertion.subject} ${assertion.condition}, actual ${assertion.actual}`);
  }
  if (lines.length === 0 && !step.success) lines.push('The step failed');
  return lines;
}

/** The name of the variable a step failed on ("Variable 'x' is not defined."), or undefined. */
function undefinedVariable(event) {
  if (event?.event !== 'step_completed' || event.success || !event.failure) return undefined;
  return /^Variable '([^']+)' is not defined/.exec(event.failure)?.[1];
}

/** Compares `0.9.0`, `0.10.1`, `1.0.0-beta.1` by their numbers; a pre-release counts as its version. */
function compareVersions(a, b) {
  const parse = version => String(version).split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** A development build (`0.0.0-dev`) has every feature of its sources. */
function isSupportedVersion(version) {
  return /^0\.0\.0-/.test(version) || compareVersions(version, MINIMUM_VERSION) >= 0;
}

/** Whether the binary has the MCP server (`tinyprobe mcp`). */
function supportsMcp(version) {
  return /^0\.0\.0-/.test(version) || compareVersions(version, MCP_VERSION) >= 0;
}

/** Whether the binary has `tinyprobe schema`. */
function supportsSchema(version) {
  return /^0\.0\.0-/.test(version) || compareVersions(version, SCHEMA_VERSION) >= 0;
}

// --- Completion and hover --------------------------------------------------------
//
// Block YAML is read line by line, by indentation: enough to know which mapping the cursor is in. The keys
// themselves come from `tinyprobe schema`, and the endpoints from `inspect --json`: nothing about the format
// is written here.

/**
 * One line of block YAML: its indentation, whether it starts a list item (`- `), the column of its key,
 * the key and the text after it. Null for blank lines and comments.
 */
function parseYamlLine(text) {
  if (/^\s*(#.*)?$/.test(text)) return null;
  const line = /^( *)(- +)?(.*)$/.exec(text);
  const indent = line[1].length;
  const keyCol = indent + (line[2]?.length ?? 0);
  const key = /^("[^"]*"|'[^']*'|[^\s#'"{[\]-][^:#]*?|-[^\s:#][^:#]*?)\s*:(\s|$)/.exec(line[3]);
  return {
    indent,
    dash: !!line[2],
    keyCol,
    key: key ? key[1].replace(/^(["'])(.*)\1$/, '$2') : null,
    value: key ? line[3].slice(key[0].length).trim() : line[3].trim()
  };
}

/**
 * The path of the mapping whose keys start at `col` on line `row`: key names, and `{ item }` for a list item
 * (its first line). For example `['steps', { item: 4 }, 'expect']` inside the `expect` of the step at line 4.
 */
function yamlPath(lines, row, col) {
  const path = [];
  let c = col;
  for (let r = row - 1; r >= 0 && c > 0; r--) {
    const line = parseYamlLine(lines[r]);
    if (!line) continue;
    if (line.dash && line.indent < c) {
      // `- expect:` with the cursor deeper: the key is the parent, inside the item.
      if (line.key !== null && line.keyCol < c && line.value === '') path.unshift(line.key);
      path.unshift({ item: r, col: line.keyCol });
      c = line.indent;
    } else if (!line.dash && line.key !== null && line.keyCol < c) {
      path.unshift(line.key);
      c = line.keyCol;
    }
  }
  return path;
}

/** The value of `key` in the list item that starts at `item.item`, such as the `call` of a step. */
function itemValue(lines, item, key) {
  for (let r = item.item; r < lines.length; r++) {
    const line = parseYamlLine(lines[r]);
    if (!line) continue;
    if (r > item.item && (line.keyCol < item.col || (line.dash && line.indent < item.col))) break;
    if (line.keyCol === item.col && line.key === key) return line.value.replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
  }
  return undefined;
}

/** The keys already written in the mapping at `col` around line `row`, so completion does not offer them again. */
function siblingKeys(lines, row, col) {
  const keys = new Set();
  const scan = (from, step) => {
    for (let r = from; r >= 0 && r < lines.length; r += step) {
      const line = parseYamlLine(lines[r]);
      if (!line) continue;
      if (line.keyCol < col || (line.dash && line.indent < col)) {
        // Going up, the first line of the list item holds one of its keys; going down, it is the next item.
        if (step < 0 && line.dash && line.keyCol === col && line.key !== null) keys.add(line.key);
        break;
      }
      if (line.keyCol === col && line.key !== null && !line.dash) keys.add(line.key);
      if (line.dash && line.keyCol === col) break;
    }
  };
  scan(row - 1, -1);
  scan(row + 1, 1);
  return keys;
}

/**
 * What to complete at a position: `{ kind: 'key', path, partial }` for a key of the mapping at `path`,
 * `{ kind: 'call', partial }` for the endpoint after `call:`, `{ kind: 'with', call, partial }` for an
 * argument of the step's endpoint; undefined elsewhere.
 */
function completionContext(lines, row, character) {
  const prefix = lines[row].slice(0, character);
  const call = /^\s*(- +)?call:\s*([\w.-]*)$/.exec(prefix);
  if (call) return { kind: 'call', partial: call[2] };

  const key = /^( *)(- +)?([^\s:#'"{}[\],]*)$/.exec(prefix);
  if (!key) return undefined;

  const indent = key[1].length;
  const col = indent + (key[2]?.length ?? 0);
  const path = key[2] ? [...yamlPath(lines, row, indent), { item: row, col }] : yamlPath(lines, row, col);
  const last = path[path.length - 1];
  const step = path[path.length - 2];
  if (last === 'with' && typeof step === 'object') {
    return { kind: 'with', call: itemValue(lines, step, 'call'), partial: key[3], existing: siblingKeys(lines, row, col) };
  }
  return { kind: 'key', path, partial: key[3], existing: key[2] ? new Set() : siblingKeys(lines, row, col) };
}

/**
 * What is under the cursor, for hover: `{ kind: 'key', path, key }` on a key, `{ kind: 'call', name }` on the
 * endpoint name after `call:`; undefined elsewhere.
 */
function hoverContext(lines, row, character) {
  const line = parseYamlLine(lines[row]);
  if (!line || line.key === null) return undefined;

  const keyEnd = lines[row].indexOf(':', line.keyCol);
  if (character >= line.keyCol && character <= keyEnd) {
    const path = line.dash ? [...yamlPath(lines, row, line.indent), { item: row, col: line.keyCol }] : yamlPath(lines, row, line.keyCol);
    return { kind: 'key', path, key: line.key };
  }
  if (line.key === 'call' && character > keyEnd && line.value !== '') return { kind: 'call', name: line.value.replace(/\s+#.*$/, '') };
  return undefined;
}

function resolveSchema(root, schema) {
  let resolved = schema;
  for (let i = 0; resolved?.$ref && i < 10; i++) resolved = root.$defs?.[resolved.$ref.replace('#/$defs/', '')];
  return resolved;
}

/**
 * The keys a mapping at `path` can have, from the JSON Schema of `tinyprobe schema`, with their description.
 * Maps of user names (endpoints, auth sets, JSONPath checks) lead to the schema of their values.
 */
function schemaKeys(root, path) {
  let schema = root;
  for (const element of path) {
    schema = resolveSchema(root, schema);
    if (!schema) return [];
    if (typeof element === 'string') {
      schema = schema.properties?.[element]
        ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
    } else {
      schema = schema.items;
    }
  }

  schema = resolveSchema(root, schema);
  if (!schema) return [];
  const properties = { ...(schema.properties ?? {}) };
  for (const branch of schema.anyOf ?? []) Object.assign(properties, resolveSchema(root, branch)?.properties ?? {});
  return Object.entries(properties).map(([name, property]) => ({ name, description: property.description ?? '' }));
}

/**
 * The arguments to suggest in a step's `with`, most likely first: required params, other params, query
 * parameters, placeholders of the path, then the other variables (base URL, headers, body), which usually
 * come from the environment or from a saved value.
 */
function withSuggestions(endpoint) {
  const params = endpoint.params ?? [];
  const query = endpoint.query ?? [];
  const inPath = [...String(endpoint.path ?? '').matchAll(/\$\{([^}$][^}]*)\}/g)].map(m => m[1]);
  const rank = name => {
    const param = params.find(p => p.name === name);
    if (param) return param.required ? [0, 'required param'] : [1, `param, default ${JSON.stringify(param.default)}`];
    if (query.includes(name)) return [2, 'query parameter'];
    if (inPath.includes(name)) return [3, 'in the path'];
    return [4, 'variable, usually from the environment or a saved value'];
  };
  const names = [...new Set([...params.map(p => p.name), ...(endpoint.arguments ?? [])])];
  return names
    .map((name, order) => ({ name, order, rank: rank(name) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.order - b.order)
    .map(({ name, rank }) => ({ name, detail: rank[1] }));
}

/**
 * The arguments a call can take, split for prompting: required params first, then
 * everything else (optional params with their default, query names, other placeholders).
 */
function endpointInputs(endpoint) {
  const params = new Map((endpoint.params ?? []).map(p => [p.name, p]));
  const required = [...params.values()].filter(p => p.required).map(p => p.name);
  const optional = (endpoint.arguments ?? [])
    .filter(name => !required.includes(name))
    .map(name => ({
      name,
      detail: params.has(name)
        ? `param, default ${JSON.stringify(params.get(name).default)}`
        : (endpoint.query ?? []).includes(name) ? 'query parameter' : 'variable'
    }));
  return { required, optional };
}

module.exports = {
  SUPPORTED_PROTOCOL,
  MINIMUM_VERSION,
  MCP_VERSION,
  SCHEMA_VERSION,
  LineSplitter,
  isTinyprobeFile,
  isWorkflowFile,
  isEnvironmentFileName,
  runArgs,
  callArgs,
  resolveFile,
  samePath,
  toPosition,
  problemsByFile,
  failureLines,
  undefinedVariable,
  compareVersions,
  isSupportedVersion,
  supportsMcp,
  supportsSchema,
  parseYamlLine,
  yamlPath,
  itemValue,
  completionContext,
  hoverContext,
  schemaKeys,
  withSuggestions,
  endpointInputs
};
