# Changelog

## 0.2.0

Foxify is now **tinyprobe**: the same features, under a new name. It needs tinyprobe 0.10.0 or newer, the first release of the binary under that name.

- New extension id `kikutano.tinyprobe-vscode`. VS Code does not replace the old "Foxify" extension: uninstall it, then install this one.
- Commands are `tinyprobe.*` ("tinyprobe: Run Workflow"...).
- Settings are `tinyprobe.path` (default `tinyprobe`), `tinyprobe.validateOnSave` and `tinyprobe.variables`. The old `foxify.*` settings are not read: copy them over if you changed them.
- The environment picked for each folder is asked again once.

## 0.1.0

First version, for Foxify 0.9.0 or newer.

- Validation of Foxify files when they are opened and saved, with the problems in the editor.
- "Call" above each endpoint: asks for the arguments and shows the response.
- "Run workflow" above each workflow, and workflows in the Test Explorer, one test per step.
- A run view with the request and response of every step.
- Environment file picker in the status bar, kept for each folder; `foxify.variables` for `--var`.
- The first run or call of a folder asks for its environment file, and a step that fails on an undefined variable suggests picking another one.
