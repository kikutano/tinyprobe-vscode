# Changelog

## Unreleased

- **tinyprobe: Generate Tests with AI**: opens the chat in agent mode with the prompt that asks the agent to write and run tinyprobe tests from the backend's code, and copies it to the clipboard. "Migrate with AI" offers the same as its first choice, "The backend's code".
- The prompts of both commands ask the agent to use the tinyprobe tools when it has them.
- **Tools for the chat:** the extension registers the tinyprobe MCP server (`tinyprobe mcp`) with VS Code, so Copilot and the other chat agents of the editor get the tools `guide`, `inspect`, `call` and `run` without configuration. The server runs in the first workspace folder. It needs tinyprobe 0.13.0 or newer and VS Code 1.101 or newer; with older versions everything else works as before.

## 0.3.0

- **tinyprobe: Migrate with AI**: pick a Postman collection, an Insomnia or Bruno export, an OpenAPI document or a HAR recording of the workspace, and get the prompt for your coding agent. It opens in VS Code's chat when there is one, and is copied to the clipboard in any case. For a Postman collection, the prompt also names the Postman environments of the workspace.

## 0.2.2

- Published on the VS Code Marketplace and Open VSX: search for **tinyprobe** in the Extensions view.

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
