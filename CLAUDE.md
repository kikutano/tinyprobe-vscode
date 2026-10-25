# Foxify for VS Code

VS Code extension for [Foxify](https://github.com/kikutano/foxify): validation on save, ▶ Call above endpoints, ▶ Run workflow, Test Explorer, run view.
It has **no engine of its own**: every feature runs the `foxify` binary and reads its JSON protocol (`docs/protocol.md` in the foxify repository, cloned next to this one as `../tyfapi` or `../foxify`).

## Commands

```bash
scripts/dev.sh test          # unit tests, plain Node (node --test), no VS Code
scripts/dev.sh integration   # builds foxify from ../tyfapi, starts its test server, runs the tests in a real VS Code window
scripts/dev.sh check         # both: run before every PR
scripts/dev.sh package       # foxify-vscode.vsix
scripts/dev.sh install       # package + install in your VS Code
```

Node 22 is in `~/.local/bin` on this machine. F5 in VS Code starts an Extension Development Host (`.vscode/launch.json`); set `foxify.path` to `foxify-dev` (from `../tyfapi/scripts/dev.sh install`) to use the binary built from the sources.

## Architecture

Plain JavaScript (CommonJS), no dependency, no build step.

- `src/extension.js`: activation, commands, wiring.
- `src/protocol.js` and `src/cli.js`: **no VS Code API**, unit-tested with Node. Protocol parsing, argument building, version checks (`MINIMUM_VERSION`, `SUPPORTED_PROTOCOL`), spawning the binary and splitting NDJSON. Put new logic here when it can live without `vscode`.
- `src/foxify.js`: shared state: binary path, output channel, environment picker (status bar), `--var` settings.
- `src/inspector.js`: `foxify inspect --json` → diagnostics and cached file model.
- `src/codelens.js`, `src/call.js` (▶ Call: prompts for args), `src/testing.js` (Test Explorer, live ndjson), `src/runView.js` + `media/run-view.js` (webview; renders ndjson events in any browser, meant to be reused by other front ends).
- `test/*.test.js` unit tests; `test/integration/` runs in VS Code against `docs/example` of the foxify repo.

## Roadmap

There is a single roadmap for the CLI and this extension: `ROADMAP.md` in the foxify repository (here it is only a link). Extension tasks are marked `ext`. Specs and decisions are in that repository too (`docs/specs/`, `docs/decisions/`).

## Rules

- Never reimplement Foxify logic (YAML parsing, checks, variable resolution): ask the binary. If the extension needs data the protocol lacks, add it to the protocol in the foxify repository first.
- Ignore unknown protocol keys; warn when `protocol` is greater than `SUPPORTED_PROTOCOL`.
- A feature that needs a newer binary raises `MINIMUM_VERSION` and the "Requirements" line of the README.
- New user-facing behavior: README feature list + `CHANGELOG.md`.
- English for docs and comments; comments explain why.

## Release

Version in `package.json` and `CHANGELOG.md`, then an annotated tag `vX.Y.Z` (`git tag -a v0.2.0 --cleanup=whitespace -F notes.md`); the Release workflow publishes the `.vsix` on GitHub. The extension is **not on the VS Code Marketplace / Open VSX yet**.
