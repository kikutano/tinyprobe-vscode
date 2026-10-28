'use strict';

const vscode = require('vscode');
const path = require('node:path');
const cli = require('./cli');
const protocol = require('./protocol');
const { IGNORED_FOLDERS } = require('./tinyprobe');

/**
 * Workflows in the Test Explorer: a workflow file is a test suite, each call step a test.
 * Running a step runs its whole workflow, since steps use the values saved by earlier ones.
 */
class WorkflowTests {
  /**
   * @param {import('./tinyprobe').Tinyprobe} tinyprobe
   * @param {import('./inspector').Inspector} inspector
   * @param {import('./runView').RunView} runView
   */
  constructor(tinyprobe, inspector, runView) {
    this.tinyprobe = tinyprobe;
    this.inspector = inspector;
    this.runView = runView;
    this.controller = vscode.tests.createTestController('tinyprobe', 'tinyprobe');
    this.controller.resolveHandler = item => (item ? this.resolveSteps(item) : this.discover());
    this.controller.refreshHandler = () => this.discover();
    this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}');
    this.watcher.onDidCreate(uri => this.update(uri));
    this.watcher.onDidChange(uri => this.update(uri));
    this.watcher.onDidDelete(uri => this.controller.items.delete(uri.toString()));

    // Steps follow the last inspection: names, positions, steps added or removed.
    this.subscription = inspector.onDidInspect(file => {
      const item = this.controller.items.get(vscode.Uri.file(file).toString());
      const json = inspector.get(file);
      if (item && json?.valid) this.setSteps(item, json);
    });
  }

  dispose() {
    this.subscription.dispose();
    this.watcher.dispose();
    this.controller.dispose();
  }

  async discover() {
    const files = await vscode.workspace.findFiles('**/*.{yaml,yml}', IGNORED_FOLDERS);
    await Promise.all(files.map(uri => this.update(uri)));
  }

  /** Adds, keeps or removes the test item of a file, depending on whether it is a workflow. */
  async update(uri) {
    if (/[\\/](node_modules|bin|obj|\.git)[\\/]/.test(uri.fsPath)) return;
    let text;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return;
    }

    const id = uri.toString();
    if (!protocol.isWorkflowFile(text)) {
      this.controller.items.delete(id);
      return;
    }

    let item = this.controller.items.get(id);
    if (!item) {
      item = this.controller.createTestItem(id, path.basename(uri.fsPath), uri);
      item.description = vscode.workspace.asRelativePath(path.dirname(uri.fsPath));
      item.canResolveChildren = true;
      this.controller.items.add(item);
    }
  }

  async resolveSteps(item) {
    const json = this.inspector.get(item.uri.fsPath) ?? await this.inspector.inspect(item.uri);
    if (json?.valid) this.setSteps(item, json);
    else item.error = json ? 'The workflow is not valid: see the Problems panel' : 'tinyprobe could not inspect this file';
  }

  setSteps(item, json) {
    item.error = undefined;
    item.label = json.name || path.basename(item.uri.fsPath);
    item.range = new vscode.Range(0, 0, 0, 0);
    const steps = json.steps
      .filter(step => step.type === 'call')
      .map(step => {
        const child = this.controller.createTestItem(`${item.id}#${step.index}`, step.name, item.uri);
        const { line, character } = protocol.toPosition(step.location);
        child.range = new vscode.Range(line, character, line, character);
        child.description = step.call;
        return child;
      });
    item.children.replace(steps);
    item.canResolveChildren = false;
  }

  /** The workflows to run for a request: a step stands for its workflow. */
  workflowsOf(request) {
    const items = request.include ?? [...gather(this.controller.items)];
    const workflows = new Map();
    for (const item of items) {
      const workflow = item.parent ?? item;
      workflows.set(workflow.id, workflow);
    }
    const excluded = new Set((request.exclude ?? []).map(item => item.id));
    return [...workflows.values()].filter(w => !excluded.has(w.id));
  }

  /**
   * Runs one workflow from the editor (CodeLens, title bar), in the Test Explorer and in the run view;
   * with `to`, only up to that step (`tinyprobe run --to`), whose response the run view then shows.
   */
  async runFile(uri, { to } = {}) {
    await this.update(uri);
    const item = this.controller.items.get(uri.toString());
    if (!item) {
      vscode.window.showWarningMessage('tinyprobe: this file is not a workflow (it has no steps).');
      return;
    }
    const request = new vscode.TestRunRequest([item]);
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await this.run(request, cancellation.token, { reveal: true, to });
    } finally {
      cancellation.dispose();
    }
  }

  async run(request, token, { reveal = false, to } = {}) {
    if (!(await this.tinyprobe.ensureEnvironment())) return;

    const run = this.controller.createTestRun(request);
    const events = [];
    try {
      for (const workflow of this.workflowsOf(request)) {
        if (token.isCancellationRequested) break;
        events.push(...await this.runWorkflow(workflow, run, token, reveal, to));
      }
    } finally {
      run.end();
    }
    // Not awaited: the message stays up while the run is already over.
    this.tinyprobe.explainUndefinedVariables(events);
  }

  async runWorkflow(item, run, token, reveal, to) {
    if (item.canResolveChildren || item.children.size === 0) await this.resolveSteps(item);
    const steps = new Map();
    item.children.forEach(child => {
      steps.set(Number(child.id.split('#').pop()), child);
      run.enqueued(child);
    });
    run.started(item);

    const options = { ...this.tinyprobe.runOptions(), to };
    const args = protocol.runArgs(item.uri.fsPath, options);
    const cwd = this.tinyprobe.cwdFor(item.uri);
    this.tinyprobe.log(`> tinyprobe ${args.join(' ')}`);
    run.appendOutput(`> tinyprobe ${args.join(' ')}\r\n`, undefined, item);
    this.runView.begin(item.label, { reveal, environment: options.environment });

    const completed = new Set();
    const events = [];
    let finished;
    let invalid;
    const execution = cli.stream(this.tinyprobe.command(), args, cwd, event => {
      events.push(event);
      this.runView.event(event);
      const child = steps.get(event.index);
      switch (event.event) {
        case 'step_started':
          if (child) run.started(child);
          break;
        case 'step_completed':
          if (!child) break;
          completed.add(child.id);
          if (event.success) {
            run.passed(child, event.duration_ms);
          } else {
            const message = new vscode.TestMessage(protocol.failureLines(event).join('\n'));
            message.location = new vscode.Location(child.uri, child.range);
            run.failed(child, message, event.duration_ms);
          }
          run.appendOutput(`${event.success ? '✓' : '✗'} ${event.name}  ${event.method ?? ''} ${event.status ?? '---'}  ${event.url ?? ''}\r\n`, undefined, child);
          break;
        case 'run_finished':
          finished = event;
          break;
        case 'invalid':
          invalid = event;
          break;
      }
    }, chunk => run.appendOutput(chunk.replace(/\r?\n/g, '\r\n'), undefined, item));

    const cancelled = token.onCancellationRequested(() => execution.cancel());
    let result;
    try {
      result = await execution.done;
    } catch (error) {
      this.tinyprobe.reportError(error);
      this.runView.error(error.message);
      run.errored(item, new vscode.TestMessage(error.message));
      return events;
    } finally {
      cancelled.dispose();
    }

    for (const [, child] of steps) {
      if (!completed.has(child.id)) run.skipped(child);
    }

    if (invalid) {
      const messages = invalid.errors.map(e => {
        const message = new vscode.TestMessage(e.message);
        if (e.file !== 'command line') {
          const { line, character } = protocol.toPosition(e);
          message.location = new vscode.Location(vscode.Uri.file(protocol.resolveFile(cwd, e.file)), new vscode.Position(line, character));
        }
        return message;
      });
      run.errored(item, messages);
      this.inspector.inspect(item.uri);
    } else if (finished) {
      if (finished.success) run.passed(item, finished.summary.duration_ms);
      else run.failed(item, new vscode.TestMessage(`${finished.summary.failed_steps} failed, ${finished.summary.not_run_steps} not run`), finished.summary.duration_ms);
    } else if (token.isCancellationRequested) {
      run.skipped(item);
    } else {
      const message = result.stderr.trim() || `tinyprobe exited with code ${result.code}`;
      this.runView.error(message);
      run.errored(item, new vscode.TestMessage(message));
    }
    return events;
  }
}

function* gather(collection) {
  const items = [];
  collection.forEach(item => items.push(item));
  yield* items;
}

module.exports = { WorkflowTests };
