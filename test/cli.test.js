'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../src/cli');

// Node itself stands in for the tinyprobe binary: `node -e <script>` prints what tinyprobe would.
const node = process.execPath;

test('stream parses each NDJSON event as it arrives, split across writes', async () => {
  const script = `
    const out = process.stdout;
    out.write('{"event":"run_started","steps":[]}\\n{"event":"step_');
    setTimeout(() => out.write('started","index":0}\\n{"event":"run_finished","success":true}\\n'), 20);
  `;
  const events = [];

  const { code, stderr } = await cli.stream(node, ['-e', script], undefined, e => events.push(e.event)).done;

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(events, ['run_started', 'step_started', 'run_finished']);
});

test('stream keeps stderr and the exit code', async () => {
  const script = `process.stderr.write('Error: Missing endpoint name.\\n'); process.exit(2);`;
  const chunks = [];

  const { code, stderr } = await cli.stream(node, ['-e', script], undefined, () => {}, c => chunks.push(c)).done;

  assert.equal(code, 2);
  assert.match(stderr, /Missing endpoint name/);
  assert.match(chunks.join(''), /Missing endpoint name/);
});

test('cancel stops the process', async () => {
  const execution = cli.stream(node, ['-e', 'setTimeout(() => {}, 60000)'], undefined, () => {});
  execution.cancel();
  const { code } = await execution.done;
  assert.notEqual(code, 0);
});

test('a line that is not JSON is kept with stderr, not lost or thrown', async () => {
  const script = `console.log('warning: something'); console.log('{"event":"run_finished","success":true}');`;
  const events = [];

  const { stderr } = await cli.stream(node, ['-e', script], undefined, e => events.push(e.event)).done;

  assert.deepEqual(events, ['run_finished']);
  assert.match(stderr, /warning: something/);
});

test('execute returns stdout and the exit code', async () => {
  const { code, stdout } = await cli.execute(node, ['-e', 'console.log("0.9.0")']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '0.9.0');
});

test('a missing binary is a TinyprobeNotFoundError', async () => {
  await assert.rejects(cli.execute('tinyprobe-does-not-exist', ['--version']), cli.TinyprobeNotFoundError);
});
