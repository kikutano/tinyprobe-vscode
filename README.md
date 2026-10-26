# tinyprobe for VS Code

Explore endpoints and run [tinyprobe](https://github.com/kikutano/tinyprobe) API workflows without leaving the editor.

<p align="center">
  <img src="media/screen.png" alt="A tinyprobe workflow open in VS Code: a Run workflow link above it, a green check next to each step, and the run view with the steps, the checks of the selected step and its response">
</p>

- **Problems as you save.** tinyprobe files are validated when you open and save them: an unknown endpoint, a missing param or a misspelled key is underlined where it is, with the suggestion of tinyprobe (`did you mean 'get_user'?`).
- **Completion and hover.** While you type, the keys you can write where the cursor is, with what they do; after `call:`, the endpoints of the workflow and of its imports (also while the workflow is not valid yet); in `with:`, the arguments of the called endpoint, required ones first. Hover on a key or on the endpoint of a `call` to see what it is. Needs tinyprobe 0.14.0 or newer.
- **Call an endpoint.** A **▶ Call** link sits above every endpoint of an API file. It asks for the required params, lets you pick optional ones, and shows the response, whatever its status. The last values are remembered for each endpoint.
- **Run workflows.** **▶ Run workflow** at the top of a workflow, or the **Test Explorer**: each workflow is a test suite and each step a test, updated live as the run goes. A failed step shows why, at its line.
- **See every exchange.** The run view lists the steps; select one to see its checks, saved values, request and response.
- **Generate tests with AI.** **tinyprobe: Generate Tests with AI** opens VS Code's chat in agent mode with the prompt that asks the agent to read your backend's routes, authentication and seed data, and to write and run the tinyprobe tests. It uses the model you already have, and the tinyprobe tools (below) to check its work. The prompt is also copied to the clipboard, for any other agent.
- **Migrate with AI.** **tinyprobe: Migrate with AI** finds the Postman collections and environments, Insomnia and Bruno exports, OpenAPI documents and HAR recordings of the workspace, and writes the prompt that asks your coding agent to convert the one you pick, following `tinyprobe guide`. The prompt goes into VS Code's chat, ready to review and send, and on the clipboard for any other agent. It is also in the explorer's context menu of those files.
- **Tools for the chat.** The extension gives VS Code's chat agents (Copilot and others) the tinyprobe tools, from `tinyprobe mcp`: `guide`, `inspect`, `call` and `run`, with nothing to configure. They appear in the chat's tool list as **tinyprobe**; VS Code asks you before an agent sends requests with `call` or `run`. Needs tinyprobe 0.13.0 or newer.
- **Environments.** The environment file (`env.local.yaml`, `env.dev.yaml`...) is passed to every run and call. Pick it in the status bar, bottom left; the choice is kept for each folder. If you have not picked one yet and the folder has environment files, the first run or call asks which one to use. When a step fails on an undefined variable, a message tells you, with a button to change the environment.

The extension has no runtime dependency and no engine of its own: it runs the `tinyprobe` binary, and reads its [JSON protocol](https://github.com/kikutano/tinyprobe/blob/main/docs/protocol.md). What you see in VS Code is what `tinyprobe run` does in CI.

## Install

Search for **tinyprobe** in the Extensions view of VS Code, or install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kikutano.tinyprobe-vscode). Cursor, Windsurf and VSCodium find it on [Open VSX](https://open-vsx.org/extension/kikutano/tinyprobe-vscode). From a terminal:

```bash
code --install-extension kikutano.tinyprobe-vscode
```

Every release also has the `.vsix` on [GitHub](https://github.com/kikutano/tinyprobe-vscode/releases/latest), to install with **Extensions** → **⋯** → **Install from VSIX...**.

To try it right away, open the [example](https://github.com/kikutano/tinyprobe/tree/main/example) folder of the tinyprobe repository: it calls a public test API, so there is nothing else to install.

## Requirements

[tinyprobe](https://github.com/kikutano/tinyprobe#install) 0.10.0 or newer, on the `PATH` or set with `tinyprobe.path`; the tools for the chat need 0.13.0 and VS Code 1.101 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/kikutano/tinyprobe/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/kikutano/tinyprobe/main/install.ps1 | iex
```

## Settings

| Setting | Default | |
|---|---|---|
| `tinyprobe.path` | `tinyprobe` | Path of the `tinyprobe` binary. |
| `tinyprobe.validateOnSave` | `true` | Validate tinyprobe files when they are opened and saved. |
| `tinyprobe.variables` | `{}` | Variables passed with `--var` to every run and call, over the environment file, e.g. `{ "baseUrl": "http://localhost:8081" }`. Values are typed like YAML. |

## Commands

- **tinyprobe: Run Workflow**: runs the current workflow.
- **tinyprobe: Call Endpoint**: calls an endpoint of the current file, picked from a list.
- **tinyprobe: Generate Tests with AI**: the prompt that asks your coding agent to write the tests from your backend's code.
- **tinyprobe: Migrate with AI**: the prompt that hands a Postman, Insomnia, Bruno, OpenAPI or HAR export to your coding agent.
- **tinyprobe: Select Environment**: the environment file passed with `-e`.
- **tinyprobe: Show Last Run**: reopens the run view.
- **tinyprobe: Validate File**: validates the current file now.

## How files are recognised

A YAML file with a top-level `endpoints:` or `steps:` key is a tinyprobe file; one with `steps:` is a workflow. Environment files are found by name: `env.yaml`, `env.*.yaml`, `env-*.yaml`, `environment.yaml`. Other YAML files are left alone.

A step cannot run on its own, since it uses the values saved by the steps before it: running a step from the Test Explorer runs its whole workflow.

**Secrets.** The run view shows requests as they are sent, `Authorization` headers included. They stay in VS Code: nothing is written to disk or sent anywhere.

## Development

No dependency to install: the extension is plain JavaScript on the VS Code API.

- **Run it**: open this folder in VS Code and press `F5` (**Run Extension**).
- **Unit tests**: `npm test` (Node's test runner, no VS Code needed).
- **Integration tests** run in a separate VS Code instance, with a temporary profile. They need a `tinyprobe` binary, the tinyprobe test server and the examples of the [tinyprobe repository](https://github.com/kikutano/tinyprobe):

  ```bash
  # in the tinyprobe repository: start the test server on http://localhost:5122
  dotnet run --project tests/Tinyprobe.RealServer.Tests --urls http://localhost:5122

  # here
  TINYPROBE_PATH=$(command -v tinyprobe) TINYPROBE_EXAMPLES=../tinyprobe/docs node test/integration/run.js
  ```

- **Package**: `npm run package` builds a `.vsix` with [vsce](https://github.com/microsoft/vscode-vsce), which you can install with **Extensions: Install from VSIX...**.
- **Release**: set the version in `package.json` and `CHANGELOG.md`, then push a matching annotated tag (`git tag -a v0.2.0 --cleanup=whitespace -F notes.md`). The [Release workflow](.github/workflows/release.yml) tests, packages and publishes a GitHub Release with `tinyprobe-vscode.vsix`; the tag message after its first line goes on top of the notes.

`src/protocol.js` and `src/cli.js` use no VS Code API, and `media/run-view.js` renders the NDJSON events in any browser: they are meant to be reused by other front ends.

## License

[MIT](LICENSE)
