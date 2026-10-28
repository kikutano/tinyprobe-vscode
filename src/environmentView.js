'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const env = require('./environmentFile');

const VALUE_HINT = 'Typed like YAML: 42 is a number, "42" a string, [a, b] a list.';
const HIDDEN = '••••••••';

/**
 * The Environment view: the variables of the selected environment file, then those of the
 * `tinyprobe.variables` setting, which are passed with --var and win over the file.
 * Values are edited in the file's text, so its comments and order are kept, and Undo works.
 */
class EnvironmentView {
  /** @param {import('./tinyprobe').Tinyprobe} tinyprobe */
  constructor(tinyprobe) {
    this.tinyprobe = tinyprobe;
    this.showSecrets = false;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;

    this.view = vscode.window.createTreeView('tinyprobe.environment', { treeDataProvider: this });
    const watcher = vscode.workspace.createFileSystemWatcher('**/env*.{yaml,yml}');
    const ifEnvironment = uri => { if (this.isEnvironment(uri)) this.refresh(); };
    this.subscriptions = [
      this.view,
      this.changed,
      watcher,
      watcher.onDidChange(ifEnvironment),
      watcher.onDidCreate(ifEnvironment),
      watcher.onDidDelete(ifEnvironment),
      tinyprobe.onDidChangeEnvironment(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument(e => ifEnvironment(e.document.uri)),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tinyprobe.variables')) this.refresh(); })
    ];
    this.refresh();
  }

  dispose() {
    this.subscriptions.forEach(s => s.dispose());
  }

  isEnvironment(uri) {
    const file = this.tinyprobe.environment();
    return !!file && path.normalize(uri.fsPath) === path.normalize(file);
  }

  refresh() {
    const file = this.tinyprobe.environment();
    this.view.description = file ? path.basename(file) : undefined;
    vscode.commands.executeCommand('setContext', 'tinyprobe.hasEnvironment', !!file);
    vscode.commands.executeCommand('setContext', 'tinyprobe.showSecrets', this.showSecrets);
    this.changed.fire();
  }

  setShowSecrets(show) {
    this.showSecrets = show;
    this.refresh();
  }

  /** The text of the environment file: the editor's, unsaved changes included, or the file on disk. */
  text(file) {
    const document = vscode.workspace.textDocuments.find(d => path.normalize(d.uri.fsPath) === path.normalize(file));
    if (document) return document.getText();
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  /** The variables of the selected file, and those of the setting. */
  variables() {
    const file = this.tinyprobe.environment();
    const settings = vscode.workspace.getConfiguration('tinyprobe').get('variables') ?? {};
    const inFile = file ? env.parse(this.text(file)).map(v => ({ ...v, file, overridden: v.name in settings })) : [];
    const inSettings = Object.entries(settings).map(([name, value]) => ({ name, value: String(value), kind: 'setting' }));
    return [...inFile, ...inSettings];
  }

  getChildren(element) {
    return element ? [] : this.variables();
  }

  /** @param {any} variable */
  getTreeItem(variable) {
    const item = new vscode.TreeItem(variable.name);
    const hidden = env.isSecretName(variable.name) && !this.showSecrets;
    const value = hidden ? HIDDEN : variable.value === '' ? '(empty)' : variable.value;

    if (variable.kind === 'setting') {
      item.id = `setting:${variable.name}`;
      item.description = `${value} · setting`;
      item.tooltip = `${variable.name} = ${hidden ? HIDDEN : variable.value}\nFrom the tinyprobe.variables setting, passed with --var: it wins over the environment file.`;
      item.iconPath = new vscode.ThemeIcon('settings-gear');
      item.contextValue = 'tinyprobe.settingVariable';
      item.command = { command: 'workbench.action.openSettings', title: 'Open Settings', arguments: ['tinyprobe.variables'] };
      return item;
    }

    item.id = `file:${variable.name}`;
    item.description = variable.overridden ? `${value} · overridden by the setting` : value;
    item.tooltip = `${variable.name}: ${hidden ? HIDDEN : variable.raw}\n${vscode.workspace.asRelativePath(variable.file)}, line ${variable.line + 1}`;
    item.iconPath = new vscode.ThemeIcon(hidden ? 'lock' : 'symbol-variable');
    item.contextValue = variable.kind === 'block' ? 'tinyprobe.environmentBlock' : 'tinyprobe.environmentVariable';
    item.command = { command: 'tinyprobe.environment.open', title: 'Open', arguments: [variable] };
    return item;
  }

  // --- Commands -----------------------------------------------------------------

  /** Opens the environment file, at a variable's line when given. */
  async open(variable) {
    const file = variable?.file ?? this.tinyprobe.environment();
    if (!file) return this.tinyprobe.selectEnvironment();
    const options = variable ? { selection: new vscode.Range(variable.line, variable.start, variable.line, variable.end) } : {};
    await vscode.window.showTextDocument(vscode.Uri.file(file), options);
  }

  async edit(variable) {
    if (!variable?.file) return;
    // A value on several lines (a list, a map, a text block) is edited in the file.
    if (variable.kind === 'block') return this.open(variable);

    const input = await vscode.window.showInputBox({
      title: `${path.basename(variable.file)}: ${variable.name}`,
      prompt: VALUE_HINT,
      value: variable.raw,
      ignoreFocusOut: true
    });
    if (input === undefined || input === variable.raw) return;
    await this.write(variable.file, text => {
      const current = env.parse(text).find(v => v.name === variable.name);
      return current ? env.setValue(text, current, input) : undefined;
    });
  }

  async add() {
    let file = this.tinyprobe.environment();
    if (!file) {
      if (!(await this.tinyprobe.selectEnvironment({ reason: 'tinyprobe: add the variable to which environment?' }))) return;
      file = this.tinyprobe.environment();
      if (!file) return;
    }

    const existing = env.parse(this.text(file)).map(v => v.name);
    const name = await vscode.window.showInputBox({
      title: `${path.basename(file)}: new variable`,
      prompt: 'Its name, as written in ${name}',
      validateInput: value => env.checkName(value, existing),
      ignoreFocusOut: true
    });
    if (name === undefined) return;
    const value = await vscode.window.showInputBox({
      title: `${path.basename(file)}: ${name}`,
      prompt: VALUE_HINT,
      ignoreFocusOut: true
    });
    if (value === undefined) return;
    await this.write(file, text => env.addVariable(text, name, value));
  }

  async remove(variable) {
    if (!variable?.file) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete '${variable.name}' from ${path.basename(variable.file)}?`, { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    await this.write(variable.file, text => {
      const current = env.parse(text).find(v => v.name === variable.name);
      return current ? env.removeVariable(text, current) : undefined;
    });
  }

  async copy(variable) {
    if (!variable) return;
    await vscode.env.clipboard.writeText(variable.value);
    vscode.window.setStatusBarMessage(`tinyprobe: copied the value of ${variable.name}`, 3000);
  }

  /**
   * Changes the file through its document, so the edit can be undone, and saves it unless it already
   * had unsaved changes of the user's. `change` returns the new text, or undefined to do nothing.
   */
  async write(file, change) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const before = document.getText();
    const after = change(before);
    if (after === undefined || after === before) return;

    const wasDirty = document.isDirty;
    const { start, end, text } = changedRange(before, after);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
    await vscode.workspace.applyEdit(edit);
    if (!wasDirty) await document.save();
    this.refresh();
  }
}

/** The smallest range of `before` to replace to get `after`, so the cursor and the rest of the file stay. */
function changedRange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, end: before.length - end, text: after.slice(start, after.length - end) };
}

module.exports = { EnvironmentView };
