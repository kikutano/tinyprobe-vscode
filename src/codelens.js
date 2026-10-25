'use strict';

const vscode = require('vscode');
const path = require('node:path');
const protocol = require('./protocol');

/**
 * "▶ Call" above each endpoint defined in the file and "▶ Run workflow" at the top of a workflow,
 * placed with the locations of the last inspection.
 */
class TinyprobeCodeLens {
  /** @param {import('./inspector').Inspector} inspector */
  constructor(inspector, cwdFor) {
    this.inspector = inspector;
    this.cwdFor = cwdFor;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.changed.event;
    this.subscription = inspector.onDidInspect(() => this.changed.fire());
  }

  dispose() {
    this.subscription.dispose();
    this.changed.dispose();
  }

  provideCodeLenses(document) {
    const json = this.inspector.get(document.uri.fsPath);
    if (!json?.valid) return [];

    const lenses = [];
    if (json.kind === 'workflow') {
      lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: '$(play) Run workflow',
        tooltip: 'Run this workflow with the selected environment',
        command: 'tinyprobe.runWorkflow',
        arguments: [document.uri]
      }));
    }

    // Endpoints imported from other files get their lens in their own file.
    const here = path.normalize(document.uri.fsPath);
    const cwd = this.cwdFor(document.uri);
    for (const endpoint of json.endpoints) {
      if (!protocol.samePath(protocol.resolveFile(cwd, endpoint.location.file), here)) continue;
      const { line } = protocol.toPosition(endpoint.location);
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: `$(play) Call ${endpoint.method}`,
        tooltip: `tinyprobe call ${endpoint.name}`,
        command: 'tinyprobe.callEndpoint',
        arguments: [document.uri, endpoint.name]
      }));
    }
    return lenses;
  }
}

module.exports = { TinyprobeCodeLens };
