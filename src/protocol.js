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
  endpointInputs
};
