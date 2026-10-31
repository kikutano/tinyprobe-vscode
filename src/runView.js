'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');

/**
 * The panel that shows a run or a call: the steps, and the request and response of the selected one.
 * It is fed the NDJSON events as they arrive; they are kept, so a reopened panel shows the last run again.
 */
class RunView {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.title = '';
    this.environment = null;
    this.events = [];
  }

  dispose() {
    this.panel?.dispose();
  }

  get hasRun() {
    return this.events.length > 0;
  }

  /** Starts a new run in the panel; `reveal` opens it, otherwise it is updated only if already open. */
  begin(title, { reveal = true, environment } = {}) {
    this.title = title;
    this.environment = environment ? vscode.workspace.asRelativePath(environment) : null;
    this.events = [];
    if (reveal) this.show();
    this.post({ type: 'reset', title, environment: this.environment });
  }

  event(event) {
    this.events.push(event);
    this.post({ type: 'event', event });
  }

  /** Something went wrong outside the protocol (tinyprobe missing, bad arguments). */
  error(message) {
    this.post({ type: 'error', message });
  }

  show() {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }

    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('tinyprobe.run', 'tinyprobe', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true
    });
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'icon-light.svg'), dark: vscode.Uri.joinPath(media, 'icon-dark.svg') };
    this.panel.webview.html = this.html(this.panel.webview, media);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage(message => {
      // The page is ready (also after being reopened): replay the run so far.
      if (message.type === 'ready') {
        this.post({ type: 'reset', title: this.title, environment: this.environment });
        for (const event of this.events) this.post({ type: 'event', event });
      }
    });
  }

  post(message) {
    if (!this.panel) return;
    this.panel.title = this.title ? `tinyprobe: ${this.title}` : 'tinyprobe';
    this.panel.webview.postMessage(message);
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...parts));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${uri('run-view-host.css')}">
  <link rel="stylesheet" href="${uri('shared', 'run-view.css')}">
  <title>tinyprobe</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${uri('shared', 'run-view.js')}"></script>
  <script nonce="${nonce}" src="${uri('run-view-host.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { RunView };
