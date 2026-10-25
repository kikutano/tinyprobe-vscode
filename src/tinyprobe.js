'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const cli = require('./cli');
const protocol = require('./protocol');

const INSTALL_URL = 'https://github.com/kikutano/tinyprobe#install';
const ENVIRONMENT_KEY = 'tinyprobe.environment';
const IGNORED_FOLDERS = '**/{node_modules,bin,obj,.git}/**';

/**
 * What every feature shares: the binary and its settings, the output channel,
 * the selected environment file and the --var variables.
 */
class Tinyprobe {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('tinyprobe');
    this.warned = new Set();

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'tinyprobe.selectEnvironment';
    this.updateStatus();
    this.status.show();
  }

  dispose() {
    this.output.dispose();
    this.status.dispose();
  }

  command() {
    return vscode.workspace.getConfiguration('tinyprobe').get('path') || 'tinyprobe';
  }

  /** tinyprobe runs in the workspace folder, so the locations it reports are relative to it. */
  cwdFor(uri) {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
  }

  /** Options of run and call: the environment file and the variables of the settings. */
  runOptions() {
    return {
      environment: this.environment(),
      variables: vscode.workspace.getConfiguration('tinyprobe').get('variables') ?? {}
    };
  }

  log(message) {
    this.output.appendLine(message);
  }

  /** Shows a problem with the binary once per session, with a way to fix it. */
  async reportError(error) {
    this.log(String(error.message ?? error));
    if (!(error instanceof cli.TinyprobeNotFoundError)) {
      vscode.window.showErrorMessage(`tinyprobe: ${error.message ?? error}`);
      return;
    }
    if (this.warned.has('missing')) return;
    this.warned.add('missing');

    const choice = await vscode.window.showWarningMessage(
      `tinyprobe CLI not found ('${error.command}'). Install it, or set its path in the settings.`,
      'How to install', 'Open settings');
    if (choice === 'How to install') vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
    if (choice === 'Open settings') vscode.commands.executeCommand('workbench.action.openSettings', 'tinyprobe.path');
  }

  /** Warns, once, when the binary is too old or speaks a newer protocol than this extension. */
  async checkVersion() {
    let result;
    try {
      result = await cli.execute(this.command(), ['--version']);
    } catch (error) {
      this.reportError(error);
      return;
    }

    const version = result.stdout.trim();
    this.log(`Using tinyprobe ${version} (${this.command()})`);
    if (!protocol.isSupportedVersion(version)) {
      vscode.window.showWarningMessage(
        `This extension needs tinyprobe ${protocol.MINIMUM_VERSION} or newer, and found ${version}. Run 'tinyprobe update'.`);
    }
  }

  checkProtocol(json) {
    if (json.protocol > protocol.SUPPORTED_PROTOCOL && !this.warned.has('protocol')) {
      this.warned.add('protocol');
      vscode.window.showWarningMessage(
        `tinyprobe ${json.version} speaks protocol ${json.protocol}; this extension knows protocol ${protocol.SUPPORTED_PROTOCOL}. Update the extension.`);
    }
  }

  // --- Environment -----------------------------------------------------------

  // The choice is stored per workspace: a file path, or '' for "no environment", chosen on purpose.
  // Nothing stored (a new folder) or a file that no longer exists means "not chosen yet".

  /** The selected environment file, if it still exists. */
  environment() {
    const file = this.context.workspaceState.get(ENVIRONMENT_KEY);
    return file && fs.existsSync(file) ? file : undefined;
  }

  hasChosenEnvironment() {
    return this.context.workspaceState.get(ENVIRONMENT_KEY) === '' || this.environment() !== undefined;
  }

  updateStatus() {
    const file = this.environment();
    this.status.text = `$(server-environment) ${file ? path.basename(file) : 'No environment'}`;
    this.status.tooltip = file
      ? `tinyprobe environment: ${vscode.workspace.asRelativePath(file)}\nClick to change it`
      : 'tinyprobe: select the environment file passed with -e';
  }

  async environmentFiles() {
    return (await vscode.workspace.findFiles('**/*.{yaml,yml}', IGNORED_FOLDERS))
      .filter(uri => protocol.isEnvironmentFileName(uri.fsPath))
      .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /** Asks for the environment file; resolves to false when the user dismisses the list. */
  async selectEnvironment({ reason } = {}) {
    const files = await this.environmentFiles();
    const current = this.environment();

    const items = [
      ...files.map(uri => ({
        label: path.basename(uri.fsPath),
        description: [vscode.workspace.asRelativePath(path.dirname(uri.fsPath)), uri.fsPath === current ? '(current)' : '']
          .filter(Boolean).join(' '),
        file: uri.fsPath
      })),
      { label: 'No environment', description: 'run without -e', file: '' }
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: reason ?? 'tinyprobe environment',
      placeHolder: files.length === 0 ? 'No env*.yaml file found in the workspace' : 'The file passed with -e to every run and call',
      ignoreFocusOut: !!reason
    });
    if (!picked) return false;

    await this.context.workspaceState.update(ENVIRONMENT_KEY, picked.file);
    this.updateStatus();
    return true;
  }

  /**
   * Before a run or a call: when no environment was chosen for this workspace and it has
   * environment files, asks which one to use. Resolves to false when the user dismisses it,
   * and the run does not start.
   */
  async ensureEnvironment() {
    if (this.hasChosenEnvironment()) return true;
    if ((await this.environmentFiles()).length === 0) return true;
    return this.selectEnvironment({ reason: 'tinyprobe: which environment should this run use?' });
  }

  /**
   * After a run or a call: a step that failed on an undefined variable usually means a
   * missing or wrong environment file. Says so, with a way to pick another one.
   */
  async explainUndefinedVariables(events) {
    const names = [...new Set(events.map(protocol.undefinedVariable).filter(Boolean))];
    if (names.length === 0) return;

    const file = this.environment();
    const variables = names.map(n => `'${n}'`).join(', ');
    const message = file
      ? `tinyprobe: ${variables} ${names.length === 1 ? 'is' : 'are'} not defined. Add ${names.length === 1 ? 'it' : 'them'} to ${path.basename(file)}, to the workflow's variables or to tinyprobe.variables, or pick another environment.`
      : `tinyprobe: ${variables} ${names.length === 1 ? 'is' : 'are'} not defined, and no environment file is selected.`;

    const choice = await vscode.window.showWarningMessage(message, 'Select environment');
    if (choice === 'Select environment') await this.selectEnvironment();
  }
}

module.exports = { Tinyprobe, IGNORED_FOLDERS };
