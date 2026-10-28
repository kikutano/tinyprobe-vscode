# tinyprobe for VS Code

VS Code extension for [tinyprobe](https://github.com/kikutano/tinyprobe): validation on save, ▶ Call above endpoints, ▶ Run workflow, Test Explorer, run view.
It has **no engine of its own**: every feature runs the `tinyprobe` binary and reads its JSON protocol (`docs/protocol.md` in the tinyprobe repository, cloned next to this one, under any folder name).

## Commands

```bash
scripts/dev.sh test          # unit tests, plain Node (node --test), no VS Code
scripts/dev.sh integration   # builds tinyprobe from the repository next to this one, starts its test server, runs the tests in a real VS Code window
scripts/dev.sh check         # both: run before every PR
scripts/dev.sh package       # tinyprobe-vscode.vsix
scripts/dev.sh install       # package + install in your VS Code
```

Node 22 is in `~/.local/bin` on this machine. F5 in VS Code starts an Extension Development Host (`.vscode/launch.json`); set `tinyprobe.path` to `tinyprobe-dev` (from `scripts/dev.sh install` in the tinyprobe repository) to use the binary built from the sources.

## Architecture

Plain JavaScript (CommonJS), no dependency, no build step.

- `src/extension.js`: activation, commands, wiring.
- `src/protocol.js` and `src/cli.js`: **no VS Code API**, unit-tested with Node. Protocol parsing, argument building, version checks (`MINIMUM_VERSION`, `SUPPORTED_PROTOCOL`), spawning the binary and splitting NDJSON. Put new logic here when it can live without `vscode`.
- `src/tinyprobe.js`: shared state: binary path, output channel, environment picker (status bar), `--var` settings.
- `src/inspector.js`: `tinyprobe inspect --json` → diagnostics and cached file model.
- `src/migration.js` (no VS Code API: recognises exports, writes the agent prompt) and `src/migrate.js` (the "Migrate with AI" command: workspace scan, chat, clipboard).
- `src/editing.js`: completion and hover. The YAML context (path at the cursor, sibling keys) is in `src/protocol.js`; keys come from `tinyprobe schema`, endpoints from the inspection.
- `src/mcp.js`: registers `tinyprobe mcp` with VS Code (`vscode.lm.registerMcpServerDefinitionProvider`), only when the binary has it (`protocol.supportsMcp`).
- `src/history.js` (History view: calls recorded by `call.js`, kept as JSON in the extension's `storageUri`; the entry itself is built by `protocol.historyEntry`).
- `src/environmentFile.js` (no VS Code API: the variables of an environment file and text edits of one variable, comments kept; a text editor's view of the file, the values are still read by the binary) and `src/environmentView.js` (Environment view, edits through a `WorkspaceEdit` so Undo works).
- `src/codelens.js`, `src/call.js` (▶ Call: prompts for args), `src/testing.js` (Test Explorer, live ndjson), `src/runView.js` + `media/run-view.js` (webview; renders ndjson events in any browser, meant to be reused by other front ends).
- `test/*.test.js` unit tests; `test/integration/` runs in VS Code against `docs/example` of the tinyprobe repo.

## Roadmap

There is a single roadmap for the CLI and this extension: `ROADMAP.md` in the tinyprobe repository (here it is only a link). Extension tasks are marked `ext`. Specs and decisions are in that repository too (`docs/specs/`, `docs/decisions/`).

## Rules

- Never reimplement tinyprobe logic (YAML parsing, checks, variable resolution): ask the binary. If the extension needs data the protocol lacks, add it to the protocol in the tinyprobe repository first.
- Ignore unknown protocol keys; warn when `protocol` is greater than `SUPPORTED_PROTOCOL`.
- A feature that needs a newer binary raises `MINIMUM_VERSION` and the "Requirements" line of the README.
- New user-facing behavior: README feature list + `CHANGELOG.md`.
- English for docs and comments; comments explain why.

## Release

Version in `package.json` and `CHANGELOG.md`, then an annotated tag `vX.Y.Z` (`git tag -a v0.2.0 --cleanup=whitespace -F notes.md`); the Release workflow publishes the `.vsix` on GitHub. The workflow also publishes to Open VSX (`OVSX_PAT`). The VS Code Marketplace gets the `.vsix` by hand, on the publisher page (https://marketplace.visualstudio.com/manage).
