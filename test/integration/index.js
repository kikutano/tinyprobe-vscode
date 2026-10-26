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

  await check('Migrate with AI on a Postman collection puts the prompt on the clipboard, with its environment', async () => {
    const collection = file('postman/tinyprobe-test-server.postman_collection.json');
    await vscode.env.clipboard.writeText('');

    const result = await vscode.commands.executeCommand('tinyprobe.migrateWithAi', collection);

    const prompt = await vscode.env.clipboard.readText();
    assert.equal(result.prompt, prompt);
    assert.match(prompt, /the Postman collection postman\/tinyprobe-test-server\.postman_collection\.json and the environments postman\/local\.postman_environment\.json/);
  });

  await check('Generate Tests with AI puts the backend prompt on the clipboard', async () => {
    await vscode.env.clipboard.writeText('');
    const result = await vscode.commands.executeCommand('tinyprobe.generateWithAi');
    assert.equal(await vscode.env.clipboard.readText(), result.prompt);
    assert.match(result.prompt, /look at this backend's routes/);
  });

  await check('the workspace scan finds the exports and skips other JSON and YAML files', async () => {
    const found = await tinyprobe.migrator.findExports();
    const kinds = Object.fromEntries(found.map(e => [vscode.workspace.asRelativePath(e.uri, false), e.kind]));
    assert.equal(kinds['postman/tinyprobe-test-server.postman_collection.json'], 'postman');
    assert.equal(kinds['postman/local.postman_environment.json'], 'postman-environment');
    assert.equal(kinds['api/testserver.yaml'], undefined);
  });

  await check('the tinyprobe MCP server is offered to VS Code, in the workspace folder', async () => {
    assert.equal(typeof vscode.lm.registerMcpServerDefinitionProvider, 'function', 'this VS Code has the MCP API');
    const servers = await tinyprobe.mcp.provideMcpServerDefinitions();
    assert.equal(servers.length, 1);
    assert.ok(servers[0] instanceof vscode.McpStdioServerDefinition);
    assert.equal(servers[0].label, 'tinyprobe');
    assert.equal(servers[0].command, tinyprobe.tinyprobe.command());
    assert.deepEqual(servers[0].args, ['mcp']);
    assert.equal(servers[0].cwd.fsPath, root);
  });

  const labelOf = item => typeof item.label === 'string' ? item.label : item.label.label;
  const completions = async (uri, line, character, kind) => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(line, character));
    return list.items.filter(i => i.kind === kind);
  };
  const typing = file('workflows/typing.yaml');
  fs.writeFileSync(typing.fsPath, [
    'import: [../api/testserver.yaml]',
    'steps:',
    '  - call: get_usr',
    '    ',
    '  - call: get_user',
    '    with:',
    '      ',
    '    expect:',
    '      status: 200',
    ''
  ].join('\n'));
  await vscode.window.showTextDocument(typing);
  // The workflow is invalid (get_usr), but its import loads: the inspection still has the endpoints.
  await waitFor(() => tinyprobe.inspector.get(typing.fsPath)?.endpoints?.length > 0, 'the endpoints of the invalid workflow');

  await check('completion offers the keys of a step, with their description, minus those already written', async () => {
    const keys = await completions(typing, 3, 4, vscode.CompletionItemKind.Property);
    const labels = keys.map(labelOf);
    assert.ok(labels.includes('expect') && labels.includes('until') && labels.includes('save'), labels.join(', '));
    assert.ok(!labels.includes('call'), 'call is already written');
    assert.match(keys.find(k => labelOf(k) === 'until').documentation.value, /Polling/);
  });

  await check('completion after call: offers the endpoints of the imports, even in an invalid workflow', async () => {
    const endpoints = await completions(typing, 2, 17, vscode.CompletionItemKind.Function);
    const user = endpoints.find(e => labelOf(e) === 'get_user');
    assert.ok(user, endpoints.map(labelOf).join(', '));
    assert.equal(user.detail, 'GET /api/users/${id}');
  });

  await check('completion in with: offers the arguments of the called endpoint, required first', async () => {
    const args = await completions(typing, 6, 6, vscode.CompletionItemKind.Variable);
    const sorted = args.sort((a, b) => a.sortText.localeCompare(b.sortText));
    assert.deepEqual(sorted.map(labelOf), ['id', 'baseUrl', 'token']);
    assert.equal(sorted[0].detail, 'in the path');
  });

  await check('hover shows the description of a key and the endpoint of a call', async () => {
    const onKey = await vscode.commands.executeCommand('vscode.executeHoverProvider', typing, new vscode.Position(7, 6));
    assert.match(onKey.map(h => h.contents.map(c => c.value ?? c).join('')).join(''), /\*\*expect\*\*: What the response must be/);
    const onCall = await vscode.commands.executeCommand('vscode.executeHoverProvider', typing, new vscode.Position(4, 14));
    assert.match(onCall.map(h => h.contents.map(c => c.value ?? c).join('')).join(''), /GET \/api\/users\/\$\{id\}/);
  });

  const report = results.join('\n');
  fs.writeFileSync(path.join(root, 'integration-results.txt'), report);
  if (results.some(r => r.startsWith('FAIL'))) throw new Error(`Integration tests failed:\n${report}`);
}

module.exports = { run };
