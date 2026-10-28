'use strict';

// Reading and editing an environment file (a flat YAML map of variables) as text, without any
// VS Code API. Edits touch only the lines of one variable, so comments and order are kept.

/** Lines that continue the value of the key above them: indented, or a list at the top level. */
const CONTINUATION = /^([ \t]|-([ \t]|$))/;

const SECRET_NAME = /pass(word)?|pwd|secret|token|key|credential|auth|private|cookie|session/i;

/**
 * The variables of an environment file, in order.
 * `kind` is `scalar` (one line, editable), `flow` (`[a, b]` or `{ a: 1 }` on one line, editable)
 * or `block` (a value on the following lines, edited in the file).
 * Lines are 0-based; `start` and `end` are the columns of the value on its line, comment excluded.
 */
function parse(text) {
  const lines = text.split(/\r?\n/);
  const variables = [];

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (line === '' || /^[\s#]/.test(line) || /^(---|\.\.\.)(\s|$)/.test(line) || CONTINUATION.test(line)) continue;

    const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^#]*?)[ \t]*:(?=[ \t]|$)/.exec(line);
    if (!key) continue;

    const start = key[0].length + (/^[ \t]*/.exec(line.slice(key[0].length))[0].length);
    const raw = withoutComment(line.slice(start)).trimEnd();
    const end = start + raw.length;

    let endRow = row;
    for (let next = row + 1; next < lines.length; next++) {
      if (CONTINUATION.test(lines[next])) endRow = next;
      else if (lines[next].trim() !== '') break;
    }

    const block = endRow > row || /^[|>]/.test(raw);
    const kind = block ? 'block' : /^[[{]/.test(raw) ? 'flow' : 'scalar';
    variables.push({
      name: unquote(key[1]),
      line: row,
      endLine: endRow,
      start,
      end,
      raw,
      kind,
      value: kind === 'scalar' ? unquote(raw) : kind === 'flow' ? raw : blockSummary(raw, lines[row + 1])
    });
  }
  return variables;
}

/** The value text before a ` #` comment, quotes respected. */
function withoutComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(text[i - 1]))) {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function blockSummary(raw, next = '') {
  if (/^[|>]/.test(raw)) return '(text on several lines)';
  return /^\s*-([ \t]|$)/.test(next) ? '[…]' : '{…}';
}

function unquote(text) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/**
 * What to write for a value typed like YAML, as everywhere in the extension: `42` stays a number,
 * `"42"` a string, `[a, b]` a list. Text that YAML would misread (`a: b`, `#x`, ` padded `) is quoted.
 */
function yamlValue(input) {
  if (input === '') return '""';
  if (/^"(?:[^"\\]|\\.)*"$/.test(input) || /^'(?:[^']|'')*'$/.test(input)) return input;
  if (/^\[.*\]$/.test(input) || /^\{.*\}$/.test(input)) return input;
  return isPlain(input) ? input : JSON.stringify(input);
}

/** A key written as is, or quoted when YAML would not read it back as the same name. */
function yamlKey(name) {
  return isPlain(name) ? name : JSON.stringify(name);
}

function isPlain(text) {
  return text.trim() === text
    && !/[\t\r\n]/.test(text)
    && !/^[?:,[\]{}#&*!|>'"%@`]/.test(text)
    && !/^-(\s|$)/.test(text)
    && !/:(\s|$)/.test(text)
    && !/\s#/.test(text);
}

/** The text of the file with a variable's value replaced; its comment and the other lines are kept. */
function setValue(text, variable, input) {
  return replaceLines(text, variable.line, variable.line, line =>
    // `key:` with nothing after it needs the space before the value.
    [line.slice(0, variable.start) + (/\s$/.test(line.slice(0, variable.start)) ? '' : ' ') + yamlValue(input) + line.slice(variable.end)]);
}

/** The text of the file without a variable (its lines, with a value on several lines). */
function removeVariable(text, variable) {
  return replaceLines(text, variable.line, variable.endLine, () => []);
}

/** The text of the file with a new variable at the end. */
function addVariable(text, name, input) {
  const entry = `${yamlKey(name)}: ${yamlValue(input)}`;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (text === '') return entry + newline;
  return text + (text.endsWith('\n') ? '' : newline) + entry + newline;
}

function replaceLines(text, first, last, replace) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  lines.splice(first, last - first + 1, ...replace(lines[first]));
  return lines.join(newline);
}

/** A name that usually holds a secret: its value is hidden in the Environment view until shown. */
function isSecretName(name) {
  return SECRET_NAME.test(name);
}

/** The name of a new variable is a placeholder name: `${name}` must find it. */
function checkName(name, existing) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return 'A name starts with a letter or _ and has only letters, digits, _ and -.';
  if (existing.includes(name)) return `'${name}' is already in this environment.`;
  return undefined;
}

module.exports = { parse, yamlValue, yamlKey, setValue, removeVariable, addVariable, isSecretName, checkName };
