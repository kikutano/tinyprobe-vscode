'use strict';

// Runs the tinyprobe binary. Plain Node: no VS Code API, so it can be reused by other front ends.

const { spawn } = require('node:child_process');
const { LineSplitter } = require('./protocol');

class TinyprobeNotFoundError extends Error {
  constructor(command) {
    super(`The tinyprobe binary was not found ('${command}'). Install it or set tinyprobe.path.`);
    this.name = 'TinyprobeNotFoundError';
    this.command = command;
  }
}

function start(command, args, cwd) {
  // No shell: arguments are passed as they are, whatever they contain.
  const child = spawn(command, args, { cwd, windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return child;
}

function exited(child, command, collect) {
  return new Promise((resolve, reject) => {
    child.on('error', error => reject(error.code === 'ENOENT' ? new TinyprobeNotFoundError(command) : error));
    child.on('close', code => resolve({ code, ...collect() }));
  });
}

/** Runs tinyprobe and returns its whole output: `--version`, `inspect --json`. */
async function execute(command, args, cwd) {
  const child = start(command, args, cwd);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return exited(child, command, () => ({ stdout, stderr }));
}

/** `tinyprobe inspect <file> --json`: the parsed document, or null when tinyprobe printed no JSON (bad arguments). */
async function inspect(command, file, cwd) {
  const { code, stdout, stderr } = await execute(command, ['inspect', file, '--json'], cwd);
  try {
    return { code, json: JSON.parse(stdout), stderr };
  } catch {
    return { code, json: null, stderr };
  }
}

/**
 * Runs tinyprobe with `--reporter ndjson` and calls `onEvent` for each event as it arrives.
 * `cancel()` stops the process.
 * @returns {{ done: Promise<{ code: number, stderr: string }>, cancel: () => void }}
 */
function stream(command, args, cwd, onEvent, onStderr) {
  const child = start(command, args, cwd);
  let stderr = '';
  const lines = new LineSplitter(line => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Not an event (should not happen on stdout): keep it with the diagnostics.
      stderr += `${line}\n`;
      return;
    }
    onEvent(event);
  });

  child.stdout.on('data', chunk => lines.push(chunk));
  child.stdout.on('end', () => lines.end());
  child.stderr.on('data', chunk => {
    stderr += chunk;
    onStderr?.(chunk);
  });

  return {
    done: exited(child, command, () => ({ stderr })),
    cancel: () => child.kill()
  };
}

module.exports = { TinyprobeNotFoundError, execute, inspect, stream };
