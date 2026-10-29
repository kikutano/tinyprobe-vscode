'use strict';

// Runs the integration tests in a separate VS Code instance, with no dependency to install:
//
//   TINYPROBE_PATH=/path/to/tinyprobe TINYPROBE_EXAMPLES=/path/to/tinyprobe/docs node test/integration/run.js
//
// TINYPROBE_EXAMPLES is the docs folder of the tinyprobe repository (example/api, example/workflows and
// environment.yaml); the tinyprobe test server must be running on http://localhost:5122.
// VS Code is found next to the `code` command on the PATH, or set VSCODE_PATH to its executable.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const examples = process.env.TINYPROBE_EXAMPLES;
if (!process.env.TINYPROBE_PATH || !examples) {
  console.error('Set TINYPROBE_PATH (the tinyprobe binary) and TINYPROBE_EXAMPLES (the docs folder of the tinyprobe repository).');
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyprobe-vscode-'));
const workspace = path.join(temp, 'workspace');
fs.cpSync(path.join(examples, 'example'), workspace, { recursive: true });
fs.copyFileSync(path.join(examples, 'environment.yaml'), path.join(workspace, 'environment.yaml'));
// Set before VS Code starts, so the extension uses this binary from its activation.
fs.mkdirSync(path.join(workspace, '.vscode'));
fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'tinyprobe.path': process.env.TINYPROBE_PATH }, null, 2));

const extension = path.resolve(__dirname, '..', '..');
const code = process.env.VSCODE_PATH || findVsCode();
const result = spawnSync(code, [
  workspace,
  `--extensionDevelopmentPath=${extension}`,
  `--extensionTestsPath=${path.join(__dirname, 'index.js')}`,
  `--user-data-dir=${path.join(temp, 'user-data')}`,
  `--extensions-dir=${path.join(temp, 'extensions')}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  '--new-window',
  // CI runners (Ubuntu 24.04) block the namespaces the Chromium sandbox needs, and have no GPU.
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])
], { stdio: 'inherit', env: withoutRunAsNode(process.env) });

const report = path.join(workspace, 'integration-results.txt');
const ran = fs.existsSync(report);
if (ran) console.log(fs.readFileSync(report, 'utf8'));
else console.error(`No results: VS Code did not run the tests${result.error ? ` (${result.error.message})` : ''}.`);

try {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch {
  // VS Code may still hold a file for a moment; the folder is in the temp directory anyway.
}
process.exit(ran ? result.status ?? 1 : 1);

/** Started from a VS Code terminal, ELECTRON_RUN_AS_NODE would make VS Code start as plain Node. */
function withoutRunAsNode(env) {
  const copy = { ...env };
  delete copy.ELECTRON_RUN_AS_NODE;
  return copy;
}

/**
 * The VS Code executable, not the `code` launcher: the launcher hands the window over to
 * the running VS Code and exits at once, before the tests have run.
 */
function findVsCode() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  const launcher = (which.stdout ?? '').split('\n').map(line => line.trim()).find(Boolean);
  if (!launcher) {
    console.error('VS Code not found: set VSCODE_PATH to its executable.');
    process.exit(2);
  }
  const real = fs.realpathSync(launcher);
  const install = path.resolve(path.dirname(real), '..');
  const candidates = process.platform === 'win32'
    ? [path.join(install, 'Code.exe')]
    : process.platform === 'darwin'
      ? [path.resolve(install, '..', 'MacOS', 'Electron'), path.resolve(install, '..', 'MacOS', 'Code')]
      : [path.join(install, 'code'), path.resolve(install, '..', 'code'), ...wrappedInstall(real)];
  return candidates.find(fs.existsSync) ?? launcher;
}

/**
 * Some Linux packages (Arch) install `code` as a script that runs `<install>/bin/code`
 * from elsewhere, e.g. /usr/share/code: the executable is found from the path in the script.
 */
function wrappedInstall(launcher) {
  let script;
  try {
    script = fs.readFileSync(launcher, 'utf8');
  } catch {
    return [];
  }
  if (!script.startsWith('#!')) return [];
  const match = /(\/\S+)\/bin\/code\b/.exec(script);
  return match ? [path.join(match[1], 'code')] : [];
}
