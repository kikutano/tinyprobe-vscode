'use strict';

const vscode = require('vscode');
const path = require('node:path');
const cli = require('./cli');
const protocol = require('./protocol');

/**
 * Validates tinyprobe files with `tinyprobe inspect --json` and keeps the last inspection of each
 * file: its problems become diagnostics, its endpoints and steps feed the CodeLens and the tests.
 */
class Inspector {
  /** @param {import('./tinyprobe').Tinyprobe} tinyprobe */
  constructor(tinyprobe) {
    this.tinyprobe = tinyprobe;
    this.diagnostics = vscode.languages.createDiagnosticCollection('tinyprobe');
    /** @type {Map<string, any>} file path -> last inspection JSON */
    this.inspections = new Map();
    /** @type {Map<string, Map<string, vscode.Diagnostic[]>>} inspected file -> diagnostics per file */
    this.problems = new Map();
    this.sequence = new Map();
    this.changed = new vscode.EventEmitter();
    /** Fired with the file path after each inspection. */
    this.onDidInspect = this.changed.event;
  }

  dispose() {
    this.diagnostics.dispose();
    this.changed.dispose();
  }

  /** The last inspection of a file, if any. */
  get(filePath) {
    return this.inspections.get(path.normalize(filePath));
  }

  /** Inspects a file now; resolves to its inspection JSON, or undefined when tinyprobe gave none. */
  async inspect(uri) {
    const file = path.normalize(uri.fsPath);
    const sequence = (this.sequence.get(file) ?? 0) + 1;
    this.sequence.set(file, sequence);

    const cwd = this.tinyprobe.cwdFor(uri);
    let result;
    try {
      result = await cli.inspect(this.tinyprobe.command(), file, cwd);
    } catch (error) {
      this.tinyprobe.reportError(error);
      return undefined;
    }
    // A newer inspection of the same file was started meanwhile: this one is stale.
    if (this.sequence.get(file) !== sequence) return this.inspections.get(file);

    if (!result.json) {
      this.tinyprobe.log(`tinyprobe inspect ${file} failed (exit ${result.code}): ${result.stderr.trim()}`);
      return undefined;
    }

    this.tinyprobe.checkProtocol(result.json);
    this.inspections.set(file, result.json);
    this.setProblems(file, result.json.valid ? [] : result.json.errors, cwd);
    this.changed.fire(file);
    return result.json;
  }

  /** Re-inspects every file inspected so far: a saved API file can fix or break the workflows that import it. */
  async inspectAll() {
    await Promise.all([...this.inspections.keys()].map(file => this.inspect(vscode.Uri.file(file))));
  }

  forget(filePath) {
    const file = path.normalize(filePath);
    this.inspections.delete(file);
    this.problems.delete(file);
    this.publish();
  }

  setProblems(file, errors, cwd) {
    const byFile = new Map();
    for (const [problemFile, problems] of protocol.problemsByFile(cwd, errors)) {
      byFile.set(problemFile, problems.map(p => {
        const start = new vscode.Position(p.line, p.character);
        // The end is clamped to the line by the editor: the whole rest of the line is marked.
        const diagnostic = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, 1000)), p.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'tinyprobe';
        return diagnostic;
      }));
    }
    this.problems.set(file, byFile);
    this.publish();
  }

  /** Several inspected files can report problems of the same imported file: show each problem once. */
  publish() {
    const merged = new Map();
    for (const byFile of this.problems.values()) {
      for (const [file, diagnostics] of byFile) {
        const list = merged.get(file) ?? [];
        for (const diagnostic of diagnostics) {
          const duplicate = list.some(d => d.message === diagnostic.message && d.range.isEqual(diagnostic.range));
          if (!duplicate) list.push(diagnostic);
        }
        merged.set(file, list);
      }
    }

    this.diagnostics.clear();
    for (const [file, diagnostics] of merged) this.diagnostics.set(vscode.Uri.file(file), diagnostics);
  }
}

module.exports = { Inspector };
