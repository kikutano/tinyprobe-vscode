'use strict';

// Integration tests, run inside VS Code (see test/integration/run.js). They need a tinyprobe binary
// (TINYPROBE_PATH) and the tinyprobe test server on http://localhost:5122, and use a workspace with the
// example files of the tinyprobe repository.

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const protocol = require('../../src/protocol');

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

  await check('a workflow gets a Run CodeLens, a Run to here lens per step line, and no Call lens for imported endpoints', async () => {
    await vscode.window.showTextDocument(users);
    const json = await waitFor(() => tinyprobe.inspector.get(users.fsPath), 'the inspection of the workflow');
    const version = await waitFor(() => tinyprobe.tinyprobe.version, 'the version of the binary');
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', users);
    if (!protocol.supportsRunTo(version)) {
      // A released binary older than --to: no Run to here, everything else as before.
      assert.deepEqual(lenses.map(l => l.command?.command), ['tinyprobe.runWorkflow']);
      return;
    }
    const lines = new Set(json.steps.map(s => s.location.line));
    assert.deepEqual(lenses.map(l => l.command?.command), ['tinyprobe.runWorkflow', ...[...lines].map(() => 'tinyprobe.runToHere')]);

    // The lens of a step runs up to it: its number, as `--to` takes it, on the step's line.
    const third = json.steps[2];
    const lens = lenses.find(l => l.command.command === 'tinyprobe.runToHere' && l.range.start.line === third.location.line - 1);
    assert.deepEqual(lens.command.arguments, [users, 3]);
  });

  await check('Run to here runs the workflow up to the step and shows it in the run view', async () => {
    if (!protocol.supportsRunTo(tinyprobe.tinyprobe.version)) return;
    await vscode.commands.executeCommand('tinyprobe.runToHere', users, 2);
    const finished = await waitFor(() => tinyprobe.runView.events.find(e => e.event === 'run_finished'), 'the end of the run');
    const started = tinyprobe.runView.events.find(e => e.event === 'run_started');
    assert.equal(started.to, 1);
    assert.equal(finished.success, true);
    assert.equal(finished.summary.stopped_after, 1);
    assert.equal(finished.summary.total_steps, 2);
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

  await check('the items of a for_each step become its children in the Test Explorer, with the run view showing them', async () => {
    const tables = file('workflows/tables.yaml');
    await tinyprobe.tests.runFile(tables);
    const workflow = tinyprobe.tests.controller.items.get(tables.toString());
    const first = workflow.children.get(`${workflow.id}#0`);
    const labels = [];
    first.children.forEach(child => labels.push([child.id, child.label]));
    assert.deepEqual(labels, [
      [`${first.id}/1`, 'item 1 of 3'],
      [`${first.id}/2`, 'item 2 of 3'],
      [`${first.id}/3`, 'item 3 of 3']
    ]);
    const completed = tinyprobe.runView.events.find(e => e.event === 'step_completed' && e.index === 0);
    assert.deepEqual(completed.iterations.map(i => i.status), [200, 404, 503]);
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

  await check('a call that was sent goes to the History view, newest first; one that sent nothing does not', async () => {
    const [last] = tinyprobe.history.entries;
    assert.equal(last.endpoint, 'status', 'the invalid create_user call is not kept');
    assert.deepEqual(last.args, [['code', '404']]);
    assert.equal(last.status, 404);
    assert.equal(last.success, true);
    assert.equal(last.method, 'GET');
    assert.equal(last.environment, path.join(root, 'environment.yaml'));

    const item = tinyprobe.history.getTreeItem(last);
    assert.equal(item.label, 'status');
    assert.match(item.description, /^404 · \d+ ms · /);
    assert.deepEqual(item.command.arguments, [last]);

    // Kept in the extension's storage, for the next session.
    await tinyprobe.history.saving;
    const saved = JSON.parse(fs.readFileSync(tinyprobe.history.file, 'utf8'));
    assert.equal(saved[0].id, last.id);
  });

  await check('a call of the history is shown again in the run view, and sent again with the same arguments', async () => {
    const last = tinyprobe.history.entries[0];
    await tinyprobe.caller.send(api, 'status', [['code', '201']]);
    assert.equal(tinyprobe.history.entries[0].status, 201);

    await vscode.commands.executeCommand('tinyprobe.history.show', last);
    assert.equal(tinyprobe.runView.title.startsWith('status ('), true, tinyprobe.runView.title);
    assert.deepEqual(tinyprobe.runView.events, last.events);

    const count = tinyprobe.history.entries.length;
    await vscode.commands.executeCommand('tinyprobe.history.sendAgain', last);
    const again = tinyprobe.history.entries[0];
    assert.equal(tinyprobe.history.entries.length, count + 1);
    assert.equal(again.endpoint, 'status');
    assert.deepEqual(again.args, [['code', '404']]);
    assert.notEqual(again.id, last.id);
    assert.equal(again.status, 404);

    await vscode.commands.executeCommand('tinyprobe.history.remove', again);
    assert.equal(tinyprobe.history.entries.length, count);
  });

  await check('the Environment view lists the variables of the selected file, secrets hidden until shown', async () => {
    const view = tinyprobe.environment;
    view.refresh();
    const variables = view.variables();
    assert.deepEqual(variables.map(v => v.name), ['baseUrl', 'apiKey', 'clientId', 'clientSecret']);
    assert.equal(variables[0].value, 'http://localhost:5122/');
    assert.equal(view.view.description, 'environment.yaml');

    const apiKey = view.getTreeItem(variables[1]);
    assert.equal(apiKey.description, '••••••••');
    view.setShowSecrets(true);
    assert.equal(view.getTreeItem(view.variables()[1]).description, 'tinyprobe-test-api-key');
    view.setShowSecrets(false);
    assert.equal(view.getTreeItem(variables[0]).description, 'http://localhost:5122/');
  });

  await check('the Environment view edits the file: add, change and delete a variable, the rest kept', async () => {
    const view = tinyprobe.environment;
    const envFile = path.join(root, 'environment.yaml');
    const original = fs.readFileSync(envFile, 'utf8');
    const env = require('../../src/environmentFile');
    const find = name => env.parse(fs.readFileSync(envFile, 'utf8')).find(v => v.name === name);
    try {
      await view.write(envFile, text => env.addVariable(text, 'retries', '3'));
      assert.equal(fs.readFileSync(envFile, 'utf8'), original + 'retries: 3\n', 'saved to disk');
      assert.ok(view.variables().some(v => v.name === 'retries'));

      await view.write(envFile, text => env.setValue(text, find('retries'), 'a: b'));
      assert.equal(find('retries').raw, '"a: b"');

      await view.write(envFile, text => env.removeVariable(text, find('retries')));
      assert.equal(fs.readFileSync(envFile, 'utf8'), original);
    } finally {
      fs.writeFileSync(envFile, original);
    }
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

  const sequence = file('sequences/log-in.yaml');
  const using = file('workflows/using.yaml');
  fs.writeFileSync(using.fsPath, [
    'import:',
    '  - ../api/testserver.yaml',
    '  - probe: ../api/probe.yaml',
    'steps:',
    '  - use: ../sequences/log-in.yaml',
    '    with:',
    '      ',
    '  - call: probe.health',
    ''
  ].join('\n'));

  await check('a sequence file is validated, with no Run lens and no test of its own', async () => {
    await vscode.window.showTextDocument(sequence);
    const json = await waitFor(() => tinyprobe.inspector.get(sequence.fsPath), 'the inspection of the sequence');
    assert.equal(json.kind, 'sequence');
    assert.deepEqual(vscode.languages.getDiagnostics(sequence), []);
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', sequence);
    assert.deepEqual(lenses.map(l => l.command?.command), []);
    await tinyprobe.tests.update(sequence);
    assert.equal(tinyprobe.tests.controller.items.get(sequence.toString()), undefined);
  });

  await vscode.window.showTextDocument(using);
  await waitFor(() => tinyprobe.inspector.get(using.fsPath)?.endpoints?.length > 0, 'the endpoints of the workflow with a use');

  await check('completion in the with of a use offers the params of the sequence, required first', async () => {
    const params = await completions(using, 6, 6, vscode.CompletionItemKind.Variable);
    const sorted = params.sort((a, b) => a.sortText.localeCompare(b.sortText));
    assert.deepEqual(sorted.map(labelOf), ['password', 'username']);
    assert.equal(sorted[0].detail, 'required param');
    assert.equal(sorted[1].detail, 'param, default "admin"');
  });

  await check('hover on a use shows the sequence and its params', async () => {
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', using, new vscode.Position(4, 14));
    const text = hover.map(h => h.contents.map(c => c.value ?? c).join('')).join('');
    assert.match(text, /\*\*Log in\*\* \(sequence, 1 steps\)/);
    assert.match(text, /`password` \(required\)/);
  });

  await check('go to definition opens the sequence of a use, an imported file and the endpoint of a call', async () => {
    const at = async (line, character) => (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', using, new vscode.Position(line, character)))
      .map(l => [path.relative(root, (l.uri ?? l.targetUri).fsPath), (l.range ?? l.targetRange).start.line]);
    assert.deepEqual(await at(4, 14), [[path.join('sequences', 'log-in.yaml'), 0]]);
    assert.deepEqual(await at(2, 16), [[path.join('api', 'probe.yaml'), 0]]);
    assert.deepEqual(await at(7, 14), [[path.join('api', 'probe.yaml'), 10]]);
  });

  const report = results.join('\n');
  fs.writeFileSync(path.join(root, 'integration-results.txt'), report);
  if (results.some(r => r.startsWith('FAIL'))) throw new Error(`Integration tests failed:\n${report}`);
}

module.exports = { run };
