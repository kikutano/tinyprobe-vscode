'use strict';

const vscode = require('vscode');
const cli = require('./cli');
const protocol = require('./protocol');

const VALUE_HINT = 'Typed like YAML: 42 is a number, "42" a string, [a, b] a list. ${name} uses a variable.';

/**
 * `tinyprobe call` from the editor: asks for the endpoint's arguments (required params first,
 * then the optional ones the user picks), remembers them per endpoint, and shows the response.
 */
class EndpointCaller {
  /**
   * @param {import('./tinyprobe').Tinyprobe} tinyprobe
   * @param {import('./inspector').Inspector} inspector
   * @param {import('./runView').RunView} runView
   */
  constructor(tinyprobe, inspector, runView) {
    this.tinyprobe = tinyprobe;
    this.inspector = inspector;
    this.runView = runView;
  }

  /** @param {vscode.Uri} uri @param {string | undefined} name */
  async call(uri, name) {
    const json = this.inspector.get(uri.fsPath) ?? await this.inspector.inspect(uri);
    if (!json) return;
    if (!json.valid) {
      vscode.window.showErrorMessage('tinyprobe: the file is not valid, see the Problems panel.');
      return;
    }

    const endpoint = name
      ? json.endpoints.find(e => e.name === name)
      : await this.pickEndpoint(json.endpoints);
    if (!endpoint) return;
    if (!(await this.tinyprobe.ensureEnvironment())) return;

    const args = await this.askArguments(uri, endpoint);
    if (!args) return;

    await this.send(uri, endpoint.name, args);
  }

  async pickEndpoint(endpoints) {
    if (endpoints.length === 0) {
      vscode.window.showInformationMessage('tinyprobe: this file defines no endpoints.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      endpoints.map(e => ({ label: e.name, description: `${e.method} ${e.path}`, endpoint: e })),
      { title: 'tinyprobe: call an endpoint', matchOnDescription: true });
    return picked?.endpoint;
  }

  /** @returns {Promise<Array<[string, string]> | undefined>} undefined when the user cancels */
  async askArguments(uri, endpoint) {
    const key = `tinyprobe.call:${uri.toString()}:${endpoint.name}`;
    const remembered = this.tinyprobe.context.workspaceState.get(key) ?? {};
    const { required, optional } = protocol.endpointInputs(endpoint);
    const values = {};

    for (const param of required) {
      const value = await vscode.window.showInputBox({
        title: `${endpoint.name}: ${param} (required)`,
        prompt: VALUE_HINT,
        value: remembered[param] ?? '',
        ignoreFocusOut: true
      });
      if (value === undefined) return undefined;
      values[param] = value;
    }

    if (optional.length > 0) {
      const picked = await vscode.window.showQuickPick(
        optional.map(o => ({ label: o.name, description: o.detail, picked: o.name in remembered })),
        {
          title: `${endpoint.name}: optional arguments`,
          placeHolder: 'Pick the arguments to set, or press Enter to send without them',
          canPickMany: true,
          ignoreFocusOut: true
        });
      if (picked === undefined) return undefined;

      for (const { label } of picked) {
        const value = await vscode.window.showInputBox({
          title: `${endpoint.name}: ${label}`,
          prompt: VALUE_HINT,
          value: remembered[label] ?? '',
          ignoreFocusOut: true
        });
        if (value === undefined) return undefined;
        values[label] = value;
      }
    }

    await this.tinyprobe.context.workspaceState.update(key, values);
    return Object.entries(values);
  }

  async send(uri, endpoint, args) {
    const options = this.tinyprobe.runOptions();
    const argv = protocol.callArgs(uri.fsPath, endpoint, args, options);
    const cwd = this.tinyprobe.cwdFor(uri);
    this.tinyprobe.log(`> tinyprobe ${argv.join(' ')}`);
    this.runView.begin(endpoint, { reveal: true, environment: options.environment });

    let invalid;
    const events = [];
    const execution = cli.stream(this.tinyprobe.command(), argv, cwd, event => {
      if (event.event === 'invalid') invalid = event;
      events.push(event);
      this.runView.event(event);
    }, chunk => this.tinyprobe.output.append(chunk));

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `tinyprobe: calling ${endpoint}` },
        () => execution.done);
      if (invalid) {
        vscode.window.showErrorMessage(`tinyprobe: ${invalid.errors.map(e => e.message).join('; ')}`);
      } else if (result.code === 2 && result.stderr.trim()) {
        this.runView.error(result.stderr.trim());
      } else {
        this.tinyprobe.explainUndefinedVariables(events);
      }
    } catch (error) {
      this.tinyprobe.reportError(error);
      this.runView.error(error.message);
    }
  }
}

module.exports = { EndpointCaller };
