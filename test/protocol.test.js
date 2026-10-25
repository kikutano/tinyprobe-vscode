'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protocol = require('../src/protocol');

test('LineSplitter emits whole lines whatever the chunks', () => {
  const lines = [];
  const splitter = new protocol.LineSplitter(line => lines.push(line));

  splitter.push('{"event":"a"}\r\n{"ev');
  splitter.push('ent":"b"}\n\n');
  splitter.push('{"event":"c"}');
  assert.deepEqual(lines, ['{"event":"a"}', '{"event":"b"}']);

  splitter.end();
  assert.deepEqual(lines, ['{"event":"a"}', '{"event":"b"}', '{"event":"c"}']);
});

test('tinyprobe files are recognised by their top-level keys', () => {
  assert.equal(protocol.isTinyprobeFile('base_url: x\nendpoints:\n  a: { path: /a }\n'), true);
  assert.equal(protocol.isTinyprobeFile('name: x\nsteps:\n  - call: a\n'), true);
  assert.equal(protocol.isTinyprobeFile('services:\n  web:\n    image: nginx\n'), false);
  assert.equal(protocol.isTinyprobeFile('jobs:\n  build:\n    steps:\n      - run: make\n'), false, 'nested steps (GitHub Actions)');

  assert.equal(protocol.isWorkflowFile('steps:\n  - call: a\n'), true);
  assert.equal(protocol.isWorkflowFile('endpoints:\n  a: { path: /a }\n'), false);
});

test('Environment files are recognised by name', () => {
  for (const name of ['env.yaml', 'env.local.yaml', 'env.example.yml', 'env-dev.yaml', 'environment.yaml', 'ENV.Prod.YAML']) {
    assert.equal(protocol.isEnvironmentFileName(path.join('tinyprobe', name)), true, name);
  }
  for (const name of ['envoy.yaml', 'docker-compose.yaml', 'my-env.yaml', 'env.json']) {
    assert.equal(protocol.isEnvironmentFileName(name), false, name);
  }
});

test('run and call arguments use the NDJSON reporter, the environment and the variables', () => {
  assert.deepEqual(protocol.runArgs('flow.yaml', {}), ['run', 'flow.yaml', '--reporter', 'ndjson']);
  assert.deepEqual(
    protocol.runArgs('flow.yaml', { environment: 'env.local.yaml', variables: { userId: '7', name: '"Ada"' } }),
    ['run', 'flow.yaml', '--reporter', 'ndjson', '-e', 'env.local.yaml', '--var', 'userId=7', '--var', 'name="Ada"']);
  assert.deepEqual(
    protocol.callArgs('api.yaml', 'get_user', [['id', '1'], ['note', 'a b=c']], { environment: 'env.yaml' }),
    ['call', 'api.yaml', 'get_user', '--with', 'id=1', '--with', 'note=a b=c', '--reporter', 'ndjson', '-e', 'env.yaml']);
});

test('Locations become 0-based positions in absolute files', () => {
  const cwd = path.resolve('/work');
  assert.deepEqual(protocol.toPosition({ line: 4, column: 5 }), { line: 3, character: 4 });
  assert.deepEqual(protocol.toPosition({ line: 0, column: 0 }), { line: 0, character: 0 });
  assert.equal(protocol.resolveFile(cwd, 'tinyprobe/api.yaml'), path.join(cwd, 'tinyprobe', 'api.yaml'));
  assert.equal(protocol.resolveFile(cwd, path.join(cwd, 'x.yaml')), path.join(cwd, 'x.yaml'));
});

test('Problems are grouped by file; command-line problems have no file', () => {
  const cwd = path.resolve('/work');
  const problems = protocol.problemsByFile(cwd, [
    { file: 'flow.yaml', line: 4, column: 5, message: 'unknown endpoint' },
    { file: 'api.yaml', line: 0, column: 0, message: 'expected a mapping' },
    { file: 'flow.yaml', line: 9, column: 1, message: 'unknown key' },
    { file: 'command line', line: 0, column: 0, message: 'unknown argument' }
  ]);

  assert.deepEqual([...problems.keys()], [path.join(cwd, 'flow.yaml'), path.join(cwd, 'api.yaml')]);
  assert.deepEqual(problems.get(path.join(cwd, 'flow.yaml')), [
    { line: 3, character: 4, message: 'unknown endpoint' },
    { line: 8, character: 0, message: 'unknown key' }
  ]);
});

test('samePath ignores case only on Windows', () => {
  assert.equal(protocol.samePath('c:\\a\\B.yaml', 'C:\\a\\b.yaml', 'win32'), true);
  assert.equal(protocol.samePath('/a/B.yaml', '/a/b.yaml', 'linux'), false);
  assert.equal(protocol.samePath('/a/./b.yaml', '/a/b.yaml', 'linux'), true);
});

test('failureLines lists the failure and the failed checks', () => {
  assert.deepEqual(protocol.failureLines({
    success: false,
    failure: null,
    assertions: [
      { subject: '$.id', condition: '== 5', actual: '6', passed: false },
      { subject: '$.name', condition: 'exists', actual: '"Ada"', passed: true }
    ]
  }), ['$.id == 5, actual 6']);
  assert.deepEqual(protocol.failureLines({ success: false, failure: 'Expected status 200, got 404', assertions: [] }),
    ['Expected status 200, got 404']);
  assert.deepEqual(protocol.failureLines({ success: false, failure: null, assertions: [] }), ['The step failed']);
});

test('undefinedVariable finds the variable a step failed on', () => {
  const failed = failure => ({ event: 'step_completed', success: false, failure, assertions: [] });

  assert.equal(protocol.undefinedVariable(failed("Variable 'passengerEmail' is not defined.")), 'passengerEmail');
  assert.equal(protocol.undefinedVariable(failed('Expected status 200, got 401')), undefined);
  assert.equal(protocol.undefinedVariable(failed(null)), undefined);
  assert.equal(protocol.undefinedVariable({ event: 'step_completed', success: true, failure: null }), undefined);
  assert.equal(protocol.undefinedVariable({ event: 'run_finished', success: false }), undefined);
});

test('Versions are compared by their numbers', () => {
  assert.equal(protocol.compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(protocol.compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(protocol.compareVersions('0.8.1', '0.9.0'), -1);
  assert.equal(protocol.isSupportedVersion('0.10.0'), true);
  assert.equal(protocol.isSupportedVersion('1.0.0-beta.1'), true);
  assert.equal(protocol.isSupportedVersion('0.9.0'), false);
  assert.equal(protocol.isSupportedVersion('0.0.0-dev'), true);
});

test('endpointInputs puts required params first and describes the others', () => {
  const inputs = protocol.endpointInputs({
    params: [{ name: 'email', required: true, default: null }, { name: 'role', required: false, default: 'user' }],
    query: ['page'],
    arguments: ['baseUrl', 'email', 'page', 'role']
  });

  assert.deepEqual(inputs.required, ['email']);
  assert.deepEqual(inputs.optional, [
    { name: 'baseUrl', detail: 'variable' },
    { name: 'page', detail: 'query parameter' },
    { name: 'role', detail: 'param, default "user"' }
  ]);
});
