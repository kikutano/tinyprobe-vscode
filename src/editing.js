'use strict';

const vscode = require('vscode');
const path = require('node:path');
const protocol = require('./protocol');

/**
 * Completion and hover in tinyprobe files: keys and their descriptions from `tinyprobe schema`, endpoint
 * names and arguments from the last inspection of the file (`inspect --json`, also for an invalid workflow).
 * Nothing runs the binary while typing.
 */
class TinyprobeEditing {
  /**
   * @param {import('./tinyprobe').Tinyprobe} tinyprobe
   * @param {import('./inspector').Inspector} inspector
   */
  constructor(tinyprobe, inspector) {
    this.tinyprobe = tinyprobe;
    this.inspector = inspector;
  }

  /** A YAML file with top-level endpoints or steps, or any YAML file in a `tinyprobe` folder (a new file). */
  isTinyprobe(document) {
    return document.uri.scheme === 'file'
      && (protocol.isTinyprobeFile(document.getText()) || document.uri.fsPath.split(/[\\/]/).includes('tinyprobe'));
  }

  endpoints(document) {
    return this.inspector.get(document.uri.fsPath)?.endpoints ?? [];
  }

  async provideCompletionItems(document, position) {
    if (!this.isTinyprobe(document)) return undefined;
    const lines = document.getText().split(/\r?\n/);
    const context = protocol.completionContext(lines, position.line, position.character);
    if (!context) return undefined;

    const range = new vscode.Range(position.translate(0, -context.partial.length), position);

    if (context.kind === 'call') {
      return this.endpoints(document).map(endpoint => {
        const item = new vscode.CompletionItem(endpoint.name, vscode.CompletionItemKind.Function);
        item.detail = `${endpoint.method} ${endpoint.path}`;
        item.documentation = endpointMarkdown(endpoint);
        item.range = range;
        return item;
      });
    }

    if (context.kind === 'with') {
      const endpoint = this.endpoints(document).find(e => e.name === context.call);
      if (!endpoint) return undefined;
      const inputs = protocol.withSuggestions(endpoint).filter(input => !context.existing.has(input.name));
      return inputs.map((input, index) => {
        const item = new vscode.CompletionItem(input.name, vscode.CompletionItemKind.Variable);
        item.detail = input.detail;
        item.insertText = `${input.name}: `;
        item.sortText = String(index).padStart(3, '0');
        item.range = range;
        return item;
      });
    }

    const schema = await this.tinyprobe.schema();
    if (!schema) return undefined;
    return protocol.schemaKeys(schema, context.path)
      .filter(key => !context.existing.has(key.name))
      .map(key => {
        const item = new vscode.CompletionItem(key.name, vscode.CompletionItemKind.Property);
        item.insertText = `${key.name}: `;
        item.documentation = new vscode.MarkdownString(key.description);
        item.range = range;
        return item;
      });
  }

  async provideHover(document, position) {
    if (!this.isTinyprobe(document)) return undefined;
    const lines = document.getText().split(/\r?\n/);
    const context = protocol.hoverContext(lines, position.line, position.character);
    if (!context) return undefined;

    if (context.kind === 'call') {
      const endpoint = this.endpoints(document).find(e => e.name === context.name);
      return endpoint ? new vscode.Hover(endpointMarkdown(endpoint)) : undefined;
    }

    const schema = await this.tinyprobe.schema();
    const key = schema && protocol.schemaKeys(schema, context.path).find(k => k.name === context.key);
    return key ? new vscode.Hover(new vscode.MarkdownString(`**${key.name}**: ${key.description}`)) : undefined;
  }
}

/** An endpoint as people read it: method and path, its params, and where it is defined. */
function endpointMarkdown(endpoint) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${endpoint.name}** \`${endpoint.method} ${endpoint.path}\``);
  const params = (endpoint.params ?? []).map(p => p.required ? `\`${p.name}\`` : `\`${p.name}\` = \`${JSON.stringify(p.default)}\``);
  if (params.length > 0) markdown.appendMarkdown(`\n\nParams: ${params.join(', ')}`);
  if (endpoint.query?.length > 0) markdown.appendMarkdown(`\n\nQuery: ${endpoint.query.map(q => `\`${q}\``).join(', ')}`);
  if (endpoint.location?.file) markdown.appendMarkdown(`\n\n${path.basename(endpoint.location.file)}:${endpoint.location.line}`);
  return markdown;
}

module.exports = { TinyprobeEditing };
