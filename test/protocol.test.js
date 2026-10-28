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

test('the MCP server needs tinyprobe 0.13.0, or a development build', () => {
  assert.equal(protocol.supportsMcp('0.13.0'), true);
  assert.equal(protocol.supportsMcp('0.14.2'), true);
  assert.equal(protocol.supportsMcp('1.0.0'), true);
  assert.equal(protocol.supportsMcp('0.12.0'), false);
  assert.equal(protocol.supportsMcp('0.9.9'), false);
  assert.equal(protocol.supportsMcp('0.0.0-dev'), true);
});

test('schema needs tinyprobe 0.14.0, or a development build', () => {
  assert.equal(protocol.supportsSchema('0.14.0'), true);
  assert.equal(protocol.supportsSchema('0.13.0'), false);
  assert.equal(protocol.supportsSchema('0.0.0-dev'), true);
  assert.equal(protocol.supportsRunTo('0.18.0'), true);
  assert.equal(protocol.supportsRunTo('0.17.0'), false);
  assert.equal(protocol.supportsRunTo('0.0.0-dev'), true);
  assert.equal(protocol.supportsRunTo(undefined), false);
});

const workflow = [
  'name: Users',              // 0
  'import: [../api/x.yaml]',  // 1
  '',                         // 2
  'steps:',                   // 3
  '  - name: Login',          // 4
  '    call: login',          // 5
  '    with:',                // 6
  '      username: admin',    // 7
  '      ',                   // 8
  '    expect:',              // 9
  '      status: 200',        // 10
  '      body:',              // 11
  '        $.id: { gte: 1 }', // 12
  '    # a comment',          // 13
  '    ',                     // 14
  '  - sleep: 1s',            // 15
  '  - '                      // 16
];

test('the YAML path is found by indentation, list items included', () => {
  assert.deepEqual(protocol.yamlPath(workflow, 10, 6), ['steps', { item: 4, col: 4 }, 'expect']);
  assert.deepEqual(protocol.yamlPath(workflow, 14, 4), ['steps', { item: 4, col: 4 }]);
  assert.deepEqual(protocol.yamlPath(workflow, 2, 0), []);
  assert.deepEqual(protocol.yamlPath(['steps:', '  - expect:', '      status: 200'], 2, 6), ['steps', { item: 1, col: 4 }, 'expect']);
});

test('completion knows where the cursor is', () => {
  const key = protocol.completionContext(workflow, 14, 4);
  assert.equal(key.kind, 'key');
  assert.deepEqual(key.path, ['steps', { item: 4, col: 4 }]);
  assert.deepEqual([...key.existing].sort(), ['call', 'expect', 'name', 'with']);

  const newItem = protocol.completionContext(workflow, 16, 4);
  assert.deepEqual(newItem.path, ['steps', { item: 16, col: 4 }]);
  assert.equal(newItem.existing.size, 0);

  const args = protocol.completionContext(workflow, 8, 6);
  assert.equal(args.kind, 'with');
  assert.equal(args.call, 'login');
  assert.deepEqual([...args.existing], ['username']);

  assert.deepEqual(protocol.completionContext(['steps:', '  - call: get_u'], 1, 15), { kind: 'call', partial: 'get_u' });
  assert.equal(protocol.completionContext(workflow, 10, 15), undefined, 'inside a value');
});

test('hover finds the key or the called endpoint under the cursor', () => {
  assert.deepEqual(protocol.hoverContext(workflow, 9, 6), { kind: 'key', path: ['steps', { item: 4, col: 4 }], key: 'expect' });
  assert.deepEqual(protocol.hoverContext(workflow, 4, 5), { kind: 'key', path: ['steps', { item: 4, col: 4 }], key: 'name' });
  assert.deepEqual(protocol.hoverContext(workflow, 5, 12), { kind: 'call', name: 'login' });
  assert.equal(protocol.hoverContext(workflow, 13, 6), undefined, 'a comment');
});

test('schema keys follow properties, items, maps and anyOf', () => {
  const schema = {
    properties: {
      steps: { type: 'array', items: { $ref: '#/$defs/step' } },
      endpoints: { type: 'object', additionalProperties: { $ref: '#/$defs/endpoint' } }
    },
    $defs: {
      step: { properties: { call: { description: 'The endpoint.' }, expect: { $ref: '#/$defs/expect' } } },
      expect: { properties: { body: { type: 'object', additionalProperties: { $ref: '#/$defs/check' } } } },
      check: { anyOf: [{ $ref: '#/$defs/condition' }, { type: 'string' }] },
      condition: { properties: { gt: { description: 'Greater.' }, lt: {} } },
      endpoint: { properties: { path: {} } }
    }
  };

  assert.deepEqual(protocol.schemaKeys(schema, []).map(k => k.name), ['steps', 'endpoints']);
  assert.deepEqual(protocol.schemaKeys(schema, ['steps', { item: 1, col: 4 }]), [
    { name: 'call', description: 'The endpoint.' },
    { name: 'expect', description: '' }
  ]);
  assert.deepEqual(protocol.schemaKeys(schema, ['steps', { item: 1, col: 4 }, 'expect', 'body', '$.id']).map(k => k.name), ['gt', 'lt']);
  assert.deepEqual(protocol.schemaKeys(schema, ['endpoints', 'get_user']).map(k => k.name), ['path']);
  assert.deepEqual(protocol.schemaKeys(schema, ['nope', 'deeper']), []);
});

test('with suggestions put what a step usually passes first', () => {
  const endpoint = {
    path: '/users/${id}/posts',
    query: ['page'],
    params: [{ name: 'limit', required: false, default: 10 }, { name: 'tenant', required: true, default: null }],
    arguments: ['baseUrl', 'id', 'limit', 'page', 'tenant', 'token']
  };

  assert.deepEqual(protocol.withSuggestions(endpoint), [
    { name: 'tenant', detail: 'required param' },
    { name: 'limit', detail: 'param, default 10' },
    { name: 'page', detail: 'query parameter' },
    { name: 'id', detail: 'in the path' },
    { name: 'baseUrl', detail: 'variable, usually from the environment or a saved value' },
    { name: 'token', detail: 'variable, usually from the environment or a saved value' }
  ]);
});

test('runArgs adds --to before the reporter, only when a step is given', () => {
  assert.deepEqual(protocol.runArgs('flow.yaml', { to: 3 }), ['run', 'flow.yaml', '--to', '3', '--reporter', 'ndjson']);
  assert.deepEqual(protocol.runArgs('flow.yaml', { to: undefined }), ['run', 'flow.yaml', '--reporter', 'ndjson']);
});

test('runToTargets gives one lens per line of steps, running to the last step of the line', () => {
  const step = (index, line, name, file = 'flow.yaml') => ({ index, name, location: { file, line, column: 5 } });
  const json = {
    steps: [
      step(0, 4, 'Log in › Get a token'),   // a sequence used on line 4: two steps, one lens
      step(1, 4, 'Log in › Me'),
      step(2, 7, 'List orders'),
      step(3, 2, 'Other', 'other.yaml')
    ]
  };
  assert.deepEqual(protocol.runToTargets(json, file => file === 'flow.yaml'), [
    { line: 3, step: 2, name: 'Log in › Me' },
    { line: 6, step: 3, name: 'List orders' }
  ]);
});

test('a history entry sums up a call from its events, with long bodies cut', () => {
  const completed = {
    event: 'step_completed', index: 0, name: 'get_user id=1', success: true, failure: null,
    method: 'GET', url: 'http://localhost:5122/api/users/1', status: 200, duration_ms: 12.5,
    request: { method: 'GET', url: 'http://localhost:5122/api/users/1', headers: [], body: null },
    response: { status: 200, reason: 'OK', headers: [], body: 'x'.repeat(10), body_truncated: false }
  };
  const events = [{ event: 'run_started' }, completed, { event: 'run_finished', success: true }];
  const entry = protocol.historyEntry({ file: '/w/api.yaml', endpoint: 'get_user', args: [['id', '1']], environment: '/w/env.yaml', events, time: 5 }, 4);

  assert.deepEqual({ ...entry, events: undefined }, {
    time: 5, file: '/w/api.yaml', endpoint: 'get_user', args: [['id', '1']], environment: '/w/env.yaml',
    method: 'GET', url: 'http://localhost:5122/api/users/1', status: 200, success: true, duration_ms: 12.5, failure: null,
    events: undefined
  });
  assert.equal(entry.events.length, 3);
  assert.deepEqual(entry.events[1].response, { status: 200, reason: 'OK', headers: [], body: 'xxxx', body_truncated: true });
  assert.equal(entry.events[1].request.body, null);
  assert.equal(completed.response.body.length, 10, 'the events of the run are not changed');
});

test('a call that sent nothing has no history entry; a failed one has', () => {
  const invalid = [{ event: 'invalid', errors: [{ message: "missing required param 'id'" }] }];
  assert.equal(protocol.historyEntry({ file: 'a', endpoint: 'e', args: [], events: invalid, time: 1 }), undefined);

  const failed = [{ event: 'step_completed', success: false, failure: "Variable 'token' is not defined.", method: null, url: null, status: null, request: null, response: null }];
  const entry = protocol.historyEntry({ file: 'a', endpoint: 'e', args: [], events: failed, time: 1 });
  assert.equal(entry.success, false);
  assert.equal(entry.status, null);
  assert.equal(entry.environment, null);
  assert.equal(entry.failure, "Variable 'token' is not defined.");
});

test('the history keeps the newest entries first, up to its size', () => {
  assert.deepEqual(protocol.addToHistory([2, 1], 3, 2), [3, 2]);
  assert.deepEqual(protocol.addToHistory([], 1, 2), [1]);
});
