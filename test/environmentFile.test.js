'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/environmentFile');

const FILE = [
  '# Local environment',
  'baseUrl: "http://localhost:5122/"',
  'apiKey: tinyprobe-test-api-key   # from the test server',
  "greeting: 'it''s me'",
  'retries: 3',
  'roles: [admin, user]',
  'empty:',
  'users:',
  '  - ada',
  '  - grace',
  '',
  'note: |',
  '  two',
  '  lines',
  '"odd name": x',
  ''
].join('\n');

test('the variables of an environment file, with their line, kind and value', () => {
  const variables = env.parse(FILE);
  assert.deepEqual(variables.map(v => [v.name, v.kind, v.value, v.line, v.endLine]), [
    ['baseUrl', 'scalar', 'http://localhost:5122/', 1, 1],
    ['apiKey', 'scalar', 'tinyprobe-test-api-key', 2, 2],
    ['greeting', 'scalar', "it's me", 3, 3],
    ['retries', 'scalar', '3', 4, 4],
    ['roles', 'flow', '[admin, user]', 5, 5],
    ['empty', 'scalar', '', 6, 6],
    ['users', 'block', '[…]', 7, 9],
    ['note', 'block', '(text on several lines)', 11, 13],
    ['odd name', 'scalar', 'x', 14, 14]
  ]);

  const apiKey = variables[1];
  assert.equal(FILE.split('\n')[2].slice(apiKey.start, apiKey.end), 'tinyprobe-test-api-key');
});

test('a list written at the top level under its key belongs to the key', () => {
  const variables = env.parse('hosts:\n- a\n- b\nport: 80\n');
  assert.deepEqual(variables.map(v => [v.name, v.kind, v.value, v.endLine]), [['hosts', 'block', '[…]', 2], ['port', 'scalar', '80', 3]]);
});

test('a # inside quotes or a word is part of the value', () => {
  const [a, b] = env.parse('a: "x # y"  # comment\nb: x#y\n');
  assert.equal(a.value, 'x # y');
  assert.equal(b.value, 'x#y');
});

test('typed values are written like YAML; text YAML would misread is quoted', () => {
  assert.equal(env.yamlValue('42'), '42');
  assert.equal(env.yamlValue('"42"'), '"42"');
  assert.equal(env.yamlValue("'a'"), "'a'");
  assert.equal(env.yamlValue('[a, b]'), '[a, b]');
  assert.equal(env.yamlValue('http://localhost:5122/'), 'http://localhost:5122/');
  assert.equal(env.yamlValue('-5'), '-5');
  assert.equal(env.yamlValue(''), '""');
  assert.equal(env.yamlValue('a: b'), '"a: b"');
  assert.equal(env.yamlValue('#hash'), '"#hash"');
  assert.equal(env.yamlValue('x #y'), '"x #y"');
  assert.equal(env.yamlValue(' padded'), '" padded"');
  assert.equal(env.yamlValue('say "hi"'), 'say "hi"');
  assert.equal(env.yamlValue('"unterminated'), '"\\"unterminated"');
});

test('setting a value keeps the comment and every other line', () => {
  const variables = env.parse(FILE);
  const text = env.setValue(FILE, variables[1], 'new key');
  assert.equal(text.split('\n')[2], 'apiKey: new key   # from the test server');
  assert.equal(text.split('\n').length, FILE.split('\n').length);
  assert.equal(env.parse(text)[1].value, 'new key');

  assert.equal(env.setValue('empty:\n', env.parse('empty:\n')[0], '1'), 'empty: 1\n');

  const crlf = 'a: 1\r\nb: 2\r\n';
  assert.equal(env.setValue(crlf, env.parse(crlf)[1], '3'), 'a: 1\r\nb: 3\r\n');
});

test('removing a variable removes its lines, also on several lines', () => {
  const variables = env.parse(FILE);
  const users = variables.find(v => v.name === 'users');
  const text = env.removeVariable(FILE, users);
  assert.deepEqual(env.parse(text).map(v => v.name), ['baseUrl', 'apiKey', 'greeting', 'retries', 'roles', 'empty', 'note', 'odd name']);
  assert.ok(!text.includes('grace'));
});

test('a new variable goes at the end, on its own line', () => {
  assert.equal(env.addVariable('a: 1\n', 'b', 'x y'), 'a: 1\nb: x y\n');
  assert.equal(env.addVariable('a: 1', 'b', '2'), 'a: 1\nb: 2\n');
  assert.equal(env.addVariable('', 'b', ''), 'b: ""\n');
  assert.equal(env.addVariable('a: 1\r\n', 'b', '2'), 'a: 1\r\nb: 2\r\n');
});

test('names of secrets and names of new variables', () => {
  for (const name of ['password', 'apiKey', 'clientSecret', 'token', 'AUTH_HEADER', 'sessionId']) assert.equal(env.isSecretName(name), true, name);
  for (const name of ['baseUrl', 'email', 'userId', 'retries']) assert.equal(env.isSecretName(name), false, name);

  assert.equal(env.checkName('baseUrl', []), undefined);
  assert.equal(env.checkName('base_url-2', []), undefined);
  assert.match(env.checkName('baseUrl', ['baseUrl']), /already/);
  assert.match(env.checkName('2x', []), /starts with a letter/);
  assert.match(env.checkName('a b', []), /only letters/);
});
