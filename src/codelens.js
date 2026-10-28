'use strict';

const vscode = require('vscode');
const path = require('node:path');
const protocol = require('./protocol');

/**
 * "▶ Call" above each endpoint defined in the file, "▶ Run workflow" at the top of a workflow and
 * "▶ Run to here" on each of its steps, placed with the locations of the last inspection.
 */
class TinyprobeCodeLens {
  /**
   * @param {import('./inspector').Inspector} inspector
   * @param {() => string | undefined} versionOf the version of the binary, once known
   */
  constructor(inspector, cwdFor, versionOf = () => undefined) {
    this.inspector = inspector;
    this.cwdFor = cwdFor;
    this.versionOf = versionOf;
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

    if (json.kind === 'workflow' && protocol.supportsRunTo(this.versionOf())) {
      const isThisFile = file => protocol.samePath(protocol.resolveFile(cwd, file), here);
      for (const target of protocol.runToTargets(json, isThisFile)) {
        lenses.push(new vscode.CodeLens(new vscode.Range(target.line, 0, target.line, 0), {
          title: '$(debug-step-over) Run to here',
          tooltip: `Run the workflow up to step ${target.step} (${target.name}) and show its response`,
          command: 'tinyprobe.runToHere',
          arguments: [document.uri, target.step]
        }));
      }
    }
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
