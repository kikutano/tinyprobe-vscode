'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const protocol = require('./protocol');
const { Tinyprobe } = require('./tinyprobe');
const { Inspector } = require('./inspector');
const { RunView } = require('./runView');
const { WorkflowTests } = require('./testing');
const { EndpointCaller } = require('./call');
const { TinyprobeCodeLens } = require('./codelens');
const { Migrator } = require('./migrate');
const { McpServerProvider } = require('./mcp');
const { TinyprobeEditing } = require('./editing');
const { RequestHistory } = require('./history');
const { EnvironmentView } = require('./environmentView');

const YAML = [{ language: 'yaml', scheme: 'file' }];

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const tinyprobe = new Tinyprobe(context);
  const inspector = new Inspector(tinyprobe);
  const runView = new RunView(context);
  const tests = new WorkflowTests(tinyprobe, inspector, runView);
  const history = new RequestHistory(context, runView, inspector);
  const caller = new EndpointCaller(tinyprobe, inspector, runView, history);
  const environment = new EnvironmentView(tinyprobe);
  const lenses = new TinyprobeCodeLens(inspector, uri => tinyprobe.cwdFor(uri), () => tinyprobe.version);
  // "Run to here" appears once the binary's version is known.
  tinyprobe.versionChanged = () => lenses.changed.fire();
  const migrator = new Migrator();
  const mcp = new McpServerProvider(tinyprobe);
  const editing = new TinyprobeEditing(tinyprobe, inspector);
  context.subscriptions.push(tinyprobe, inspector, runView, tests, lenses, mcp, history, environment);

  const isTinyprobe = document => document.uri.scheme === 'file' && document.languageId === 'yaml' && protocol.isTinyprobeFile(document.getText());
  const validateOnSave = () => vscode.workspace.getConfiguration('tinyprobe').get('validateOnSave');

  const validate = document => {
    if (isTinyprobe(document) && validateOnSave()) inspector.inspect(document.uri);
  };

  /** The editor's file, or the one a command was invoked on (CodeLens, title bar, explorer). */
  const target = uri => uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;

  const updateContext = editor => {
    const isWorkflow = !!editor && editor.document.languageId === 'yaml' && protocol.isWorkflowFile(editor.document.getText());
    vscode.commands.executeCommand('setContext', 'tinyprobe.isWorkflow', isWorkflow);
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(YAML, lenses),
    vscode.languages.registerCompletionItemProvider(YAML, editing, ' ', ':'),
    vscode.languages.registerHoverProvider(YAML, editing),
    vscode.languages.registerDefinitionProvider(YAML, editing),

    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidSaveTextDocument(async document => {
      if (!isTinyprobe(document) || !validateOnSave()) return;
      await inspector.inspect(document.uri);
      // A saved API file can fix or break the workflows that import it.
      await inspector.inspectAll();
    }),
    // A closed file's problems go away with it, like a language server's.
    vscode.workspace.onDidCloseTextDocument(document => inspector.forget(document.uri.fsPath)),
    vscode.window.onDidChangeActiveTextEditor(updateContext),

    vscode.commands.registerCommand('tinyprobe.runWorkflow', async uri => {
      const file = target(uri);
      if (!file) return;
      await saveIfDirty(file);
      await tests.runFile(file);
    }),
    vscode.commands.registerCommand('tinyprobe.runToHere', async (uri, step) => {
      const file = target(uri);
      if (!file || typeof step !== 'number') return;
      await saveIfDirty(file);
      await tests.runFile(file, { to: step });
    }),
    vscode.commands.registerCommand('tinyprobe.callEndpoint', async (uri, endpoint) => {
      const file = target(uri);
      if (!file) return;
      await saveIfDirty(file);
      await caller.call(file, typeof endpoint === 'string' ? endpoint : undefined);
    }),
    vscode.commands.registerCommand('tinyprobe.generateWithAi', () => migrator.generate()),
    vscode.commands.registerCommand('tinyprobe.migrateWithAi', uri => migrator.migrate(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('tinyprobe.selectEnvironment', () => tinyprobe.selectEnvironment()),
    vscode.commands.registerCommand('tinyprobe.showRun', () => {
      if (runView.hasRun) runView.show();
      else vscode.window.showInformationMessage('tinyprobe: nothing has run yet.');
    }),
    vscode.commands.registerCommand('tinyprobe.history.show', entry => history.show(entry)),
    vscode.commands.registerCommand('tinyprobe.history.sendAgain', async entry => {
      if (!entry) return;
      const file = vscode.Uri.file(entry.file);
      if (!fs.existsSync(entry.file)) {
        vscode.window.showWarningMessage(`tinyprobe: ${vscode.workspace.asRelativePath(file)} no longer exists.`);
        return;
      }
      await saveIfDirty(file);
      if (!(await tinyprobe.ensureEnvironment())) return;
      await caller.send(file, entry.endpoint, entry.args);
    }),
    vscode.commands.registerCommand('tinyprobe.history.openEndpoint', entry => history.openEndpoint(entry)),
    vscode.commands.registerCommand('tinyprobe.history.remove', entry => history.remove(entry)),
    vscode.commands.registerCommand('tinyprobe.history.clear', () => history.clear()),
    vscode.commands.registerCommand('tinyprobe.environment.open', variable => environment.open(variable)),
    vscode.commands.registerCommand('tinyprobe.environment.edit', variable => environment.edit(variable)),
    vscode.commands.registerCommand('tinyprobe.environment.add', () => environment.add()),
    vscode.commands.registerCommand('tinyprobe.environment.remove', variable => environment.remove(variable)),
    vscode.commands.registerCommand('tinyprobe.environment.copy', variable => environment.copy(variable)),
    vscode.commands.registerCommand('tinyprobe.environment.showValues', () => environment.setShowSecrets(true)),
    vscode.commands.registerCommand('tinyprobe.environment.hideValues', () => environment.setShowSecrets(false)),
    vscode.commands.registerCommand('tinyprobe.validate', async uri => {
      const file = target(uri);
      if (!file) return;
      await saveIfDirty(file);
      const json = await inspector.inspect(file);
      if (json?.valid) vscode.window.showInformationMessage(`tinyprobe: ${vscode.workspace.asRelativePath(file)} is valid.`);
      else if (json) vscode.commands.executeCommand('workbench.actions.view.problems');
    })
  );

  tinyprobe.checkVersion();
  vscode.workspace.textDocuments.forEach(validate);
  updateContext(vscode.window.activeTextEditor);

  // The extension's API, used by the integration tests.
  return { tinyprobe, inspector, runView, tests, caller, lenses, migrator, mcp, editing, history, environment };
}

/** tinyprobe reads files from disk: unsaved changes are saved first, as a run would expect. */
async function saveIfDirty(uri) {
  const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (document?.isDirty) await document.save();
}

function deactivate() {}

module.exports = { activate, deactivate };
