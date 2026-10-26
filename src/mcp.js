'use strict';

const vscode = require('vscode');
const cli = require('./cli');
const protocol = require('./protocol');

/** The id declared in package.json under contributes.mcpServerDefinitionProviders. */
const PROVIDER_ID = 'tinyprobe.mcp';

/**
 * Registers `tinyprobe mcp` with VS Code, so the chat agents of the editor (Copilot and others) get the
 * tools guide, inspect, call and run without any configuration. The server runs in the first workspace
 * folder, where the paths the agent passes are relative to.
 */
class McpServerProvider {
  /** @param {import('./tinyprobe').Tinyprobe} tinyprobe */
  constructor(tinyprobe) {
    this.tinyprobe = tinyprobe;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeMcpServerDefinitions = this.changed.event;
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('tinyprobe.path')) this.changed.fire();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire())
    ];

    // VS Code before 1.101 has no MCP API: everything else of the extension still works there.
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
      this.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, this));
    }
  }

  dispose() {
    this.subscriptions.forEach(s => s.dispose());
  }

  /** One server, when the binary is found and has `tinyprobe mcp`; none otherwise. */
  async provideMcpServerDefinitions() {
    const command = this.tinyprobe.command();
    let version;
    try {
      version = (await cli.execute(command, ['--version'])).stdout.trim();
    } catch {
      return []; // the missing binary is reported by the other features, once
    }
    if (!protocol.supportsMcp(version)) {
      this.tinyprobe.log(`tinyprobe ${version} has no MCP server: 'tinyprobe update' to ${protocol.MCP_VERSION} or newer gives the chat its tools.`);
      return [];
    }

    const server = new vscode.McpStdioServerDefinition('tinyprobe', command, ['mcp'], {}, version);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) server.cwd = folder.uri;
    return [server];
  }

  resolveMcpServerDefinition(server) {
    return server;
  }
}

module.exports = { McpServerProvider, PROVIDER_ID };
