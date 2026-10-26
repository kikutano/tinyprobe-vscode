'use strict';

const vscode = require('vscode');
const migration = require('./migration');

const EXPORTS = '**/*.{json,yaml,yml,har}';
const SKIPPED_FOLDERS = '**/{node_modules,.git,bin,obj,dist,build,out,.venv,vendor}/**';
const MAX_FILES = 2000;

/**
 * "tinyprobe: Migrate with AI": pick an export of another API tool, build the prompt for the coding agent,
 * and put it in the editor's chat when there is one, and on the clipboard in any case.
 */
class Migrator {
  /** @param {vscode.Uri} [uri] the file the command was invoked on, from the explorer */
  async migrate(uri) {
    const found = await this.findExports();
    let picked = uri ? await this.describe(uri) : await this.pick(found);
    if (uri && !picked) {
      vscode.window.showWarningMessage(
        `tinyprobe: ${vscode.workspace.asRelativePath(uri)} is not a Postman, Insomnia, Bruno, OpenAPI or HAR export.`);
      return;
    }
    if (!picked) return;

    const environments = picked.kind === 'postman'
      ? found.filter(e => e.kind === 'postman-environment').map(e => relative(e.uri))
      : [];
    const prompt = migration.migrationPrompt({
      kind: picked.kind,
      source: relative(vscode.Uri.file(migration.sourcePath(picked.kind, picked.uri.fsPath))),
      environments
    });

    return this.handOver(prompt);
  }

  /** The exports in the workspace, recognised by their content. */
  async findExports() {
    const files = await vscode.workspace.findFiles(EXPORTS, SKIPPED_FOLDERS, MAX_FILES);
    const described = await Promise.all(files.map(uri => this.describe(uri)));
    return described.filter(Boolean).sort((a, b) => relative(a.uri).localeCompare(relative(b.uri)));
  }

  /** @returns {Promise<{ uri: vscode.Uri, kind: string } | undefined>} */
  async describe(uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes.subarray(0, migration.SNIFF_BYTES)).toString('utf8');
      const kind = migration.detectSource(uri.fsPath, text);
      return kind ? { uri, kind } : undefined;
    } catch {
      return undefined;
    }
  }

  async pick(found) {
    const sources = found.filter(e => e.kind !== 'postman-environment');
    const browse = { label: '$(folder-opened) Browse...', description: 'Pick an export file' };
    const items = [
      ...sources.map(e => ({ label: relative(e.uri), description: migration.sourceLabel(e.kind), source: e })),
      browse
    ];

    const choice = sources.length === 0
      ? browse
      : await vscode.window.showQuickPick(items, {
        title: 'tinyprobe: migrate with AI',
        placeHolder: 'The collection or document your coding agent converts to tinyprobe files',
        matchOnDescription: true
      });
    if (!choice) return undefined;
    if (choice.source) return choice.source;

    const files = await vscode.window.showOpenDialog({
      title: 'tinyprobe: migrate with AI',
      openLabel: 'Migrate',
      canSelectMany: false,
      filters: { 'API exports': ['json', 'yaml', 'yml', 'har'] }
    });
    if (!files?.[0]) return undefined;

    const described = await this.describe(files[0]);
    if (!described) {
      vscode.window.showWarningMessage(
        'tinyprobe: this is not a Postman, Insomnia, Bruno (bruno.json), OpenAPI or HAR export.');
    }
    return described;
  }

  async handOver(prompt) {
    await vscode.env.clipboard.writeText(prompt);

    // VS Code's chat takes a prompt to review before sending; other editors may not have the command.
    let inChat = false;
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('workbench.action.chat.open')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true });
        inChat = true;
      } catch {
        inChat = false;
      }
    }

    // Not awaited: the command is done once the prompt is handed over, whether or not the message is answered.
    const show = 'Show Prompt';
    vscode.window.showInformationMessage(
      inChat
        ? 'tinyprobe: the migration prompt is in the chat, and on the clipboard. Check it, then send it to your agent.'
        : 'tinyprobe: the migration prompt is on the clipboard. Paste it in your coding agent\'s chat.',
      show).then(async answer => {
      if (answer !== show) return;
      const document = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
      await vscode.window.showTextDocument(document);
    });
    return { prompt, inChat };
  }
}

function relative(uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

module.exports = { Migrator };
