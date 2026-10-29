# Changelog

## Unreleased

- Go to definition on the file of a `schema` check (tinyprobe 0.20): `$: { schema: ../openapi.yaml#/components/schemas/User }` opens `openapi.yaml`. Completion and hover of `schema` and `matches` come from `tinyprobe schema`, with no change.

## 0.8.0

- **Sequence files** (`sequence:`, tinyprobe 0.18) are recognised: validated on save, with completion and hover. They get no Run link and no Test Explorer entry, since they run through a `use`; Run Workflow on one says so.
- In the `with` of a `use`, completion offers the params of the sequence, required first; hover on a `use` shows the sequence's name, description and params.
- **Go to definition** (F12, Ctrl+click): on the endpoint of a `call`, its line in the API file; on the path of a `use`, of an `import` or of a `file` (`for_each`, uploads), that file.
- **`for_each` items**: the run view shows a row for each item of a `for_each` step (status, duration), with its own request, response and checks, and the step shows how many passed; a failed step opens on its first failed item. In the Test Explorer the items become children of their step, each passed or failed, and the step's message lists every failed item.

## 0.7.0

- **History view**, in the new tinyprobe sidebar: the last 50 calls made with ▶ Call, newest first, with their status, duration and time. A click shows the request and response again in the run view; **Send Again** repeats a call with the same arguments and the environment selected now; **Open Endpoint** goes to its API file. The history is kept per workspace in VS Code's storage, bodies cut at 64 KiB; **Clear History** empties it.
- **Environment view**, in the same sidebar: the variables of the selected environment file, then those of `tinyprobe.variables`, marked as winning over the file. Edit a value, add or delete a variable: the file is changed in place and saved, its comments and order kept, and Undo works. Values typed like YAML, as in ▶ Call. Names that look like secrets have their values hidden until shown with the eye.

## 0.6.0

- **Run to here**: a lens on every step of a workflow runs it up to that step (`tinyprobe run --to`) and opens the run view on it, with its request and response. The steps of a sequence share the line of their `use`, whose lens runs the whole sequence. Needs tinyprobe 0.18.0 or newer; with an older binary the lens is not shown and everything else works as before.
- Completion and hover know the keys added by tinyprobe 0.17 and 0.18 (`form`, `multipart`, `cookies`, `basic`, `oauth2`, `for_each`, `use`, `sequence`, named imports), from `tinyprobe schema`, and the run view shows the `Cookie` and `Authorization` headers as sent.

## 0.5.0

- **Completion and hover in tinyprobe files.** Keys at the cursor with their description (from `tinyprobe schema`), minus those already written; endpoint names after `call:`, also in a workflow that is not valid yet; the arguments of the called endpoint in `with:`, required params first; hover on a key and on the endpoint of a `call`. Needs tinyprobe 0.14.0 or newer; with an older binary everything else works as before.

## 0.4.0

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
