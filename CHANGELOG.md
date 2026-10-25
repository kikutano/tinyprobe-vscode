# Changelog

## 0.2.1

- The tinyprobe icon: a shell prompt followed by a check mark, in the Extensions view, on the Marketplace page and on the run view tab (with a light and a dark variant).

## 0.2.0

The extension is now named **tinyprobe**, like the CLI. It needs tinyprobe 0.10.0 or newer.

- Extension id `kikutano.tinyprobe-vscode`.
- Commands `tinyprobe.*` ("tinyprobe: Run Workflow"...).
- Settings `tinyprobe.path` (default `tinyprobe`), `tinyprobe.validateOnSave` and `tinyprobe.variables`.

## 0.1.0

First version.

- Validation of the API and workflow files when they are opened and saved, with the problems in the editor.
- "Call" above each endpoint: asks for the arguments and shows the response.
- "Run workflow" above each workflow, and workflows in the Test Explorer, one test per step.
- A run view with the request and response of every step.
- Environment file picker in the status bar, kept for each folder; `tinyprobe.variables` for `--var`.
- The first run or call of a folder asks for its environment file, and a step that fails on an undefined variable suggests picking another one.
