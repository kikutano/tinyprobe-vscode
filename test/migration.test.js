'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../src/migration');

test('exports are recognised by their content', () => {
  const cases = [
    ['shop.postman_collection.json', '{\n  "info": {\n    "name": "Shop",\n    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"', 'postman'],
    ['local.json', '{ "id": "x", "name": "Local", "values": [], "_postman_variable_scope": "environment" }', 'postman-environment'],
    ['export.json', '{ "_type": "export", "__export_format": 4, "resources": [] }', 'insomnia'],
    ['collection.yaml', 'type: collection.insomnia.rest/5.0\nname: Shop\n', 'insomnia'],
    ['openapi.yaml', '# the API\nopenapi: 3.0.3\ninfo:\n  title: Shop\n', 'openapi'],
    ['swagger.yml', 'swagger: "2.0"\n', 'openapi'],
    ['api.json', '{"openapi":"3.1.0","info":{}}', 'openapi'],
    ['session.har', '{"log":{"version":"1.2","entries":[]}}', 'har'],
    ['recording.json', '{ "log": { "version": "1.2", "creator": {}, "entries": [] } }', 'har'],
    ['bruno.json', '{ "version": "1", "name": "Shop", "type": "collection" }', 'bruno']
  ];
  for (const [name, text, kind] of cases) assert.equal(migration.detectSource(name, text), kind, name);
});

test('other files are not exports', () => {
  const cases = [
    ['package.json', '{ "name": "app", "version": "1.0.0" }'],
    ['tsconfig.json', '{ "compilerOptions": { "strict": true } }'],
    ['docker-compose.yaml', 'services:\n  web:\n    image: nginx\n'],
    ['users.yaml', 'name: Users\nsteps:\n  - call: list_users\n'],
    ['notes.md', 'openapi: 3.0.0']
  ];
  for (const [name, text] of cases) assert.equal(migration.detectSource(name, text), undefined, name);
});

test('a Bruno collection is its folder', () => {
  assert.equal(migration.sourcePath('bruno', '/repo/api-tests/bruno.json'), '/repo/api-tests');
  assert.equal(migration.sourcePath('postman', '/repo/shop.json'), '/repo/shop.json');
});

test('the Postman prompt names the collection and its environments', () => {
  const prompt = migration.migrationPrompt({
    kind: 'postman',
    source: 'postman/shop.postman_collection.json',
    environments: ['postman/local.postman_environment.json', 'postman/staging.postman_environment.json']
  });

  assert.match(prompt, /`tinyprobe guide`/);
  assert.match(prompt, /section on migrating from Postman/);
  assert.match(prompt, /the Postman collection postman\/shop\.postman_collection\.json and the environments postman\/local\.postman_environment\.json and postman\/staging\.postman_environment\.json/);
  assert.match(prompt, /tinyprobe\/env\.local\.yaml/);
  assert.match(prompt, /MIGRATION\.md/);
});

test('the OpenAPI prompt asks for seed data and for the differences with the document', () => {
  const prompt = migration.migrationPrompt({ kind: 'openapi', source: 'docs/openapi.yaml' });

  assert.match(prompt, /starting from the OpenAPI document docs\/openapi\.yaml/);
  assert.match(prompt, /seed data, not from the examples/);
  assert.match(prompt, /does not do what the document says/);
});

test('other tools get the section on other tools, with their name', () => {
  const prompt = migration.migrationPrompt({ kind: 'bruno', source: 'api-tests' });

  assert.match(prompt, /section on migrating from other tools: convert the Bruno collection api-tests/);
  assert.doesNotMatch(prompt, /environments/);
});
