'use strict';

// Integration tests, run inside VS Code (see test/integration/run.js). They need a tinyprobe binary
// (TINYPROBE_PATH) and the tinyprobe test server on http://localhost:5122, and use a workspace with the
// example files of the tinyprobe repository.

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const results = [];

async function check(name, body) {
  try {
    await body();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${String(error.stack ?? error).split('\n').slice(0, 4).join('\n     ')}`);
  }
}

async function waitFor(condition, what, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = relative => vscode.Uri.file(path.join(root, relative));
  const api = file('api/testserver.yaml');
  const users = file('workflows/users.yaml');

  const extension = vscode.extensions.getExtension('kikutano.tinyprobe-vscode');
  const tinyprobe = await extension.activate();
  await tinyprobe.tinyprobe.context.workspaceState.update('tinyprobe.environment', path.join(root, 'environment.yaml'));
  tinyprobe.tinyprobe.updateStatus();

  await check('an API file is inspected when opened', async () => {
    await vscode.window.showTextDocument(api);
    const json = await waitFor(() => tinyprobe.inspector.get(api.fsPath), 'the inspection of the API file');
    assert.equal(json.kind, 'api');
    assert.ok(json.endpoints.length > 10);
    assert.deepEqual(vscode.languages.getDiagnostics(api), []);
  });

  await check('each endpoint has a Call CodeLens on its line', async () => {
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', api);
    const json = tinyprobe.inspector.get(api.fsPath);
    const calls = lenses.filter(l => l.command?.command === 'tinyprobe.callEndpoint');
    assert.equal(calls.length, json.endpoints.length);
    const login = calls.find(l => l.command.arguments[1] === 'login');
    const loginLine = json.endpoints.find(e => e.name === 'login').location.line - 1;
    assert.equal(login.range.start.line, loginLine);
  });

  await check('a workflow gets a Run CodeLens and no Call lens for imported endpoints', async () => {
    await vscode.window.showTextDocument(users);
    await waitFor(() => tinyprobe.inspector.get(users.fsPath), 'the inspection of the workflow');
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', users);
    assert.deepEqual(lenses.map(l => l.command?.command), ['tinyprobe.runWorkflow']);
  });

  await check('problems are shown where they are, with the message of tinyprobe', async () => {
    const broken = file('workflows/broken.yaml');
    fs.writeFileSync(broken.fsPath, 'import: [../api/testserver.yaml]\nsteps:\n  - call: get_usr\n    with:\n      id: 1\n');
    await vscode.window.showTextDocument(broken);
    const diagnostics = await waitFor(() => {
      const list = vscode.languages.getDiagnostics(broken);
      return list.length > 0 ? list : undefined;
    }, 'the diagnostics of the broken workflow');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].range.start.line, 2);
    assert.match(diagnostics[0].message, /unknown endpoint 'get_usr' \(did you mean 'get_user'\?\)/);

    fs.writeFileSync(broken.fsPath, 'import: [../api/testserver.yaml]\nsteps:\n  - call: get_user\n    with:\n      id: 1\n');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await tinyprobe.inspector.inspect(broken);
    assert.deepEqual(vscode.languages.getDiagnostics(broken), []);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.unlinkSync(broken.fsPath);
  });

  await check('workflows are discovered as tests, with one child per call step', async () => {
    await tinyprobe.tests.discover();
    const item = tinyprobe.tests.controller.items.get(users.toString());
    assert.ok(item, 'users.yaml is a test item');
    await tinyprobe.tests.resolveSteps(item);
    const json = tinyprobe.inspector.get(users.fsPath);
    assert.equal(item.children.size, json.steps.filter(s => s.type === 'call').length);
    assert.equal(item.label, json.name);
  });

  await check('running a workflow streams its events to the run view', async () => {
    await vscode.commands.executeCommand('tinyprobe.runWorkflow', users);
    const events = tinyprobe.runView.events;
    assert.equal(events[0].event, 'run_started');
    const finished = events.at(-1);
    assert.equal(finished.event, 'run_finished');
    assert.equal(finished.success, true, JSON.stringify(finished.summary));
    assert.ok(events.filter(e => e.event === 'step_completed').every(e => e.request && e.response));
  });

  await check('a call shows the response, whatever the status', async () => {
    await tinyprobe.caller.send(api, 'status', [['code', '404']]);
    const completed = tinyprobe.runView.events.find(e => e.event === 'step_completed');
    assert.equal(completed.success, true);
    assert.equal(completed.status, 404);
    assert.match(completed.response.body, /simulated HTTP 404/);
  });

  await check('a call with a missing required param is reported, not sent', async () => {
    await tinyprobe.caller.send(api, 'create_user', [['firstName', 'Ada']]);
    const invalid = tinyprobe.runView.events.find(e => e.event === 'invalid');
    assert.ok(invalid, 'an invalid event');
    assert.match(invalid.errors[0].message, /missing required param 'lastName'/);
  });

  await check('without a chosen environment, a run first asks for one; dismissing it cancels the run', async () => {
    const state = tinyprobe.tinyprobe.context.workspaceState;
    const chosen = state.get('tinyprobe.environment');
    await state.update('tinyprobe.environment', undefined);
    try {
      assert.equal(tinyprobe.tinyprobe.hasChosenEnvironment(), false);
      const asked = tinyprobe.tinyprobe.ensureEnvironment();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      assert.equal(await asked, false);

      await state.update('tinyprobe.environment', '');
      assert.equal(tinyprobe.tinyprobe.hasChosenEnvironment(), true, '"No environment" is a choice');
      assert.equal(await tinyprobe.tinyprobe.ensureEnvironment(), true);
    } finally {
      await state.update('tinyprobe.environment', chosen);
    }
  });

  const report = results.join('\n');
  fs.writeFileSync(path.join(root, 'integration-results.txt'), report);
  if (results.some(r => r.startsWith('FAIL'))) throw new Error(`Integration tests failed:\n${report}`);
}

module.exports = { run };
