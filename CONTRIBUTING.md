# Contributing to Foxify for VS Code

Thanks for helping. This extension is the editor side of [Foxify](https://github.com/kikutano/Foxify). Both repositories follow the same [roadmap](https://github.com/kikutano/Foxify/blob/main/ROADMAP.md), where the extension's tasks are marked `ext`. The general rules (specs before format or protocol changes, recorded decisions, commit style) are in the [Foxify contributing guide](https://github.com/kikutano/Foxify/blob/main/CONTRIBUTING.md).

## Ways to help

- **Report a bug** in the editor (validation, ▶ Call, ▶ Run workflow, Test Explorer, run view, environments) with the *Bug report* form.
- **Propose a feature** with the *Feature request* form, after checking the roadmap.
- Problems with the YAML format, the CLI or its output belong to the [Foxify repository](https://github.com/kikutano/Foxify/issues). Questions go to its [Discussions](https://github.com/kikutano/Foxify/discussions).

## Build and test

The extension is plain JavaScript on the VS Code API: no dependency to install, no build step. You need Node.js 22 and VS Code.

```bash
scripts/dev.sh test          # unit tests, with Node's test runner
scripts/dev.sh integration   # integration tests in a separate VS Code window
scripts/dev.sh check         # both: what CI runs
scripts/dev.sh package       # foxify-vscode.vsix
```

The integration tests need the [Foxify repository](https://github.com/kikutano/Foxify) cloned **next to this one** (as `../Foxify`, `../foxify` or `../tyfapi`, or set `FOXIFY_REPO`) and the .NET 10 SDK. The script builds `foxify` from those sources, starts its test server, and runs the tests against its `docs/example`.

To try a change by hand, open this folder in VS Code and press **F5**. To use the binary built from the sources, run `scripts/dev.sh install` in the Foxify repository, then set `foxify.path` to `foxify-dev`.

[CLAUDE.md](CLAUDE.md) maps the modules.

## Rules

- **No engine here.** The extension runs the `foxify` binary and reads its [JSON protocol](https://github.com/kikutano/Foxify/blob/main/docs/protocol.md); it never parses Foxify YAML or evaluates checks. When the extension needs data the protocol lacks, the protocol changes first, in the Foxify repository.
- Logic that needs no VS Code API goes in `src/protocol.js` or `src/cli.js`, with unit tests.
- Unknown protocol keys are ignored. A feature that needs a newer binary raises `MINIMUM_VERSION` in `src/protocol.js` and the "Requirements" of the README.
- User-facing changes update the README and `CHANGELOG.md`.
- English for code, comments and docs. Comments explain *why*.

## Pull requests

One topic per pull request, on a branch such as `feature/…` or `fix/…`, with `scripts/dev.sh check` passing. Commit titles in the imperative.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
