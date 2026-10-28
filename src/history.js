'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');

const MAX_ENTRIES = 50;
const FILE_NAME = 'history.json';

/**
 * The History view: the last calls made from the editor with their responses, newest first.
 * A click shows one again in the run view; Send Again repeats it with the same arguments and the
 * environment selected now. Kept per workspace in the extension's storage, not in the repository.
 */
class RequestHistory {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./runView').RunView} runView
   * @param {import('./inspector').Inspector} inspector
   */
  constructor(context, runView, inspector) {
    this.context = context;
    this.runView = runView;
    this.inspector = inspector;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.entries = this.load();
    // Writes happen one after the other, so the file always holds the latest list.
    this.saving = Promise.resolve();
    this.view = vscode.window.createTreeView('tinyprobe.history', { treeDataProvider: this });
  }

  dispose() {
    this.view.dispose();
    this.changed.dispose();
  }

  /** Where the history is kept; undefined without a workspace, and then it lasts for the session only. */
  get file() {
    const folder = this.context.storageUri?.fsPath;
    return folder ? path.join(folder, FILE_NAME) : undefined;
  }

  load() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  save() {
    const file = this.file;
    if (!file) return this.saving;
    const json = JSON.stringify(this.entries);
    this.saving = this.saving
      .then(() => fs.promises.mkdir(path.dirname(file), { recursive: true }))
      .then(() => fs.promises.writeFile(file, json))
      .catch(error => console.error(`tinyprobe: could not save the request history: ${error.message}`));
    return this.saving;
  }

  /** Adds a call that was sent; a call that sent nothing (invalid arguments) is not kept. */
  async record({ file, endpoint, args, environment, events }) {
    const entry = protocol.historyEntry({ file, endpoint, args, environment, events, time: Date.now() });
    if (!entry) return undefined;
    entry.id = crypto.randomUUID();
    this.entries = protocol.addToHistory(this.entries, entry, MAX_ENTRIES);
    this.changed.fire();
    await this.save();
    return entry;
  }

  async remove(entry) {
    if (!entry) return;
    this.entries = this.entries.filter(e => e.id !== entry.id);
    this.changed.fire();
    await this.save();
  }

  async clear() {
    if (this.entries.length === 0) return;
    const choice = await vscode.window.showWarningMessage('Clear the tinyprobe request history?', { modal: true }, 'Clear');
    if (choice !== 'Clear') return;
    this.entries = [];
    this.changed.fire();
    await this.save();
  }

  /** Shows a call of the history in the run view, as it was. */
  show(entry) {
    if (!entry) return;
    this.runView.begin(`${entry.endpoint} (${when(entry.time)})`, { reveal: true, environment: entry.environment });
    for (const event of entry.events) this.runView.event(event);
  }

  /** Opens the API file at the endpoint. */
  async openEndpoint(entry) {
    if (!entry) return;
    const uri = vscode.Uri.file(entry.file);
    if (!fs.existsSync(entry.file)) {
      vscode.window.showWarningMessage(`tinyprobe: ${vscode.workspace.asRelativePath(uri)} no longer exists.`);
      return;
    }
    const json = this.inspector.get(uri.fsPath) ?? await this.inspector.inspect(uri);
    const location = json?.endpoints?.find(e => e.name === entry.endpoint)?.location;
    const position = location ? protocol.toPosition(location) : { line: 0, character: 0 };
    const at = new vscode.Position(position.line, position.character);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(at, at) });
  }

  getChildren(element) {
    return element ? [] : this.entries;
  }

  getTreeItem(entry) {
    const item = new vscode.TreeItem(entry.endpoint);
    item.id = entry.id;
    const outcome = entry.status ?? 'not sent';
    const duration = entry.status !== null && entry.duration_ms !== null ? ` · ${Math.round(entry.duration_ms)} ms` : '';
    item.description = `${outcome}${duration} · ${when(entry.time)}`;
    item.iconPath = entry.success
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    item.tooltip = tooltip(entry);
    item.contextValue = 'tinyprobe.historyEntry';
    item.command = { command: 'tinyprobe.history.show', title: 'Show Response', arguments: [entry] };
    return item;
  }
}

/** The time of a call, and its date when it was not today. */
function when(time) {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? clock : `${date.toLocaleDateString()} ${clock}`;
}

function tooltip(entry) {
  const text = new vscode.MarkdownString();
  text.appendMarkdown(`**${escape(entry.endpoint)}**`);
  if (entry.method && entry.url) text.appendMarkdown(`  \n\`${entry.method} ${entry.url}\``);
  if (entry.failure) text.appendMarkdown(`  \n${escape(entry.failure)}`);
  text.appendMarkdown(`  \n${escape(vscode.workspace.asRelativePath(entry.file))}`);
  text.appendMarkdown(`  \nEnvironment: ${entry.environment ? escape(vscode.workspace.asRelativePath(entry.environment)) : 'none'}`);
  if (entry.args.length > 0) text.appendMarkdown(`  \nArguments: ${entry.args.map(([name, value]) => `\`${name}=${value}\``).join(' ')}`);
  text.appendMarkdown(`  \n${new Date(entry.time).toLocaleString()}`);
  return text;
}

function escape(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

module.exports = { RequestHistory };
