import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { parsePipelineDocument } from './parser';
import { PipelineResolver } from './resolver/resolver';
import type { ResolverHost } from './resolver/types';
import { buildGraph } from './model/buildGraph';
import { writeExport } from './export/fileWriters';
import { SchemaService } from './schema/schemaService';

class PreviewController {
  private panel?: vscode.WebviewPanel;
  private fileUri?: vscode.Uri;
  private resolverDependencies = new Set<string>();
  private watchers = new Map<string, vscode.FileSystemWatcher>();
  private nodeIndex = new Map<string, { file: string; line: number }>();
  private parameterValues: Record<string, unknown> = {};
  private compareParameterValues?: Record<string, unknown>;
  private detailLevel: 'stages' | 'jobs' | 'full' = 'jobs';
  private pendingTimer?: NodeJS.Timeout;
  private fileTextCache = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly diagnostics: vscode.DiagnosticCollection, private readonly schemaService: SchemaService) {}

  open(uri: vscode.Uri, beside = false): void {
    this.fileUri = uri;
    this.detailLevel = vscode.workspace.getConfiguration('azdoDiagram').get<'stages' | 'jobs' | 'full'>('defaultDetailLevel', 'jobs');
    if (this.panel) {
      this.panel.reveal(beside ? vscode.ViewColumn.Beside : undefined);
      void this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel('azdoDiagram.preview', `AzDO Diagram: ${path.basename(uri.fsPath)}`, beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });

    const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    this.panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${this.panel.webview.cspSource}; script-src ${this.panel.webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body><div id="app"></div><script src="${script}"></script></body></html>`;

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.clearWatchers();
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'revealNode') {
        const ref = this.nodeIndex.get(msg.nodeId);
        if (!ref) return;
        const uriRef = vscode.Uri.file(ref.file);
        const doc = await vscode.workspace.openTextDocument(uriRef);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const pos = new vscode.Position(ref.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
      if (msg.type === 'parameterChanged') {
        this.parameterValues[msg.name] = msg.value;
        this.scheduleRefresh();
      }
      if (msg.type === 'detailLevel') {
        this.detailLevel = msg.value;
        this.scheduleRefresh();
      }
      if (msg.type === 'toggleCompare') {
        await this.toggleCompareMode();
      }
      if (msg.type === 'exportRequest') {
        await vscode.commands.executeCommand('azdoDiagram.exportDiagram');
      }
      if (msg.type === 'exportResult' && this.fileUri) {
        const format = msg.extension;
        const target = await vscode.window.showSaveDialog({ defaultUri: this.fileUri.with({ path: `${this.fileUri.path}.diagram.${format}` }) });
        if (target) {
          await writeExport(vscode, target, Uint8Array.from(msg.bytes as number[]));
          void vscode.window.showInformationMessage(`Exported diagram to ${target.fsPath}`);
        }
      }
    });

    void this.refresh();
  }

  scheduleRefresh(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const debounce = vscode.workspace.getConfiguration('azdoDiagram').get<number>('liveUpdateDebounceMs', 300);
    this.pendingTimer = setTimeout(() => { void this.refresh(); }, debounce);
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
  }

  private syncWatchers(files: string[]): void {
    const keep = new Set(files);
    for (const [file, watcher] of this.watchers.entries()) {
      if (!keep.has(file)) {
        watcher.dispose();
        this.watchers.delete(file);
      }
    }
    for (const file of keep) {
      if (this.watchers.has(file)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
      watcher.onDidChange(() => this.scheduleRefresh());
      watcher.onDidCreate(() => this.scheduleRefresh());
      watcher.onDidDelete(() => this.scheduleRefresh());
      this.watchers.set(file, watcher);
    }
  }

  async refresh(): Promise<void> {
    if (!this.panel || !this.fileUri) return;
    this.fileTextCache.clear();
    const doc = await vscode.workspace.openTextDocument(this.fileUri);
    const parsed = parsePipelineDocument(doc.uri.fsPath, doc.getText());

    const config = vscode.workspace.getConfiguration('azdoDiagram');
    await this.schemaService.getActiveSchema(config);
    const resolver = new PipelineResolver(createResolverHost(config), {
      maxTemplateDepth: config.get<number>('maxTemplateDepth', 50)
    });

    const resolved = await resolver.resolve({ rootFile: doc.uri.fsPath, rootContent: doc.getText(), parameterOverrides: this.parameterValues });
    this.resolverDependencies = new Set(resolved.dependencies);
    this.syncWatchers(resolved.dependencies);

    const graph = this.filterGraphByDetailLevel(buildGraph(resolved.expanded, resolved.provenanceByPath));
    this.nodeIndex.clear();
    for (const node of graph.nodes) {
      const file = node.file ?? doc.uri.fsPath;
      this.nodeIndex.set(`base:${node.id}`, { file, line: await this.findBestLine(file, node.kind, node.label) });
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const d of parsed.diagnostics) {
      const range = new vscode.Range(d.range?.start.line ?? 0, d.range?.start.column ?? 0, d.range?.end.line ?? 0, d.range?.end.column ?? 1);
      diagnostics.push(new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error));
    }
    for (const d of resolved.diagnostics) {
      const range = new vscode.Range(0, 0, 0, 1);
      diagnostics.push(new vscode.Diagnostic(range, d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning));
    }
    this.diagnostics.set(doc.uri, diagnostics);

    let compareGraph: ReturnType<typeof buildGraph> | undefined;
    if (this.compareParameterValues) {
      const compareResolved = await resolver.resolve({ rootFile: doc.uri.fsPath, rootContent: doc.getText(), parameterOverrides: this.compareParameterValues });
      compareGraph = this.filterGraphByDetailLevel(buildGraph(compareResolved.expanded, compareResolved.provenanceByPath));
      for (const node of compareGraph.nodes) {
        const file = node.file ?? doc.uri.fsPath;
        this.nodeIndex.set(`compare:${node.id}`, { file, line: await this.findBestLine(file, node.kind, node.label) });
      }
    }

    this.panel.webview.postMessage({
      type: 'graph',
      detailLevel: this.detailLevel,
      graph,
      compareGraph,
      parameters: resolved.parameters.map((p) => ({
        name: p.name,
        type: p.type,
        values: p.values,
        defaultValue: Object.prototype.hasOwnProperty.call(this.parameterValues, p.name) ? this.parameterValues[p.name] : p.defaultValue
      }))
    });
  }

  async requestExport(format: 'svg' | 'png' | 'jpeg' | 'pdf'): Promise<void> {
    if (!this.panel) return;
    const config = vscode.workspace.getConfiguration('azdoDiagram.export');
    this.panel.webview.postMessage({ type: 'export', format, scale: config.get<number>('scale', 2), background: config.get<string>('background', '') });
  }

  getPreviewUri(): vscode.Uri | undefined {
    return this.fileUri;
  }

  hasDependency(fsPath: string): boolean {
    return this.resolverDependencies.has(fsPath);
  }

  async saveParameterPreset(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'Preset name' });
    if (!name) return;
    const config = vscode.workspace.getConfiguration('azdoDiagram');
    const presets = config.get<Record<string, Record<string, unknown>>>('parameterPresets', {});
    presets[name] = { ...this.parameterValues };
    await config.update('parameterPresets', presets, vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage(`Saved preset '${name}'.`);
  }

  async loadParameterPreset(): Promise<void> {
    const config = vscode.workspace.getConfiguration('azdoDiagram');
    const presets = config.get<Record<string, Record<string, unknown>>>('parameterPresets', {});
    const pick = await vscode.window.showQuickPick(Object.keys(presets), { title: 'Load parameter preset' });
    if (!pick) return;
    this.parameterValues = { ...presets[pick] };
    this.compareParameterValues = undefined;
    this.scheduleRefresh();
  }

  private async toggleCompareMode(): Promise<void> {
    if (this.compareParameterValues) {
      this.compareParameterValues = undefined;
      this.scheduleRefresh();
      return;
    }
    const config = vscode.workspace.getConfiguration('azdoDiagram');
    const presets = config.get<Record<string, Record<string, unknown>>>('parameterPresets', {});
    const names = Object.keys(presets);
    if (names.length === 0) {
      void vscode.window.showWarningMessage('No parameter presets configured. Save a preset first.');
      return;
    }
    const pick = await vscode.window.showQuickPick(names, { title: 'Select comparison preset' });
    if (!pick) return;
    this.compareParameterValues = { ...presets[pick] };
    this.scheduleRefresh();
  }

  private filterGraphByDetailLevel(graph: ReturnType<typeof buildGraph>): ReturnType<typeof buildGraph> {
    if (this.detailLevel === 'full') {
      return graph;
    }
    const allowedKinds = this.detailLevel === 'stages'
      ? new Set(['pipeline', 'stage'])
      : new Set(['pipeline', 'stage', 'job', 'deployment', 'matrix-child']);
    const nodes = graph.nodes.filter((n) => allowedKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }

  private async findBestLine(file: string, kind: string, label: string): Promise<number> {
    try {
      const text = await this.readFileText(file);
      const probes = kind === 'stage'
        ? [`stage: ${label}`]
        : kind === 'job'
          ? [`job: ${label}`]
          : kind === 'deployment'
            ? [`deployment: ${label}`]
            : [`displayName: ${label}`, `script: ${label}`, label];
      for (const probe of probes) {
        const idx = text.indexOf(probe);
        if (idx >= 0) {
          return text.slice(0, idx).split('\n').length - 1;
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async readFileText(file: string): Promise<string> {
    if (this.fileTextCache.has(file)) {
      return this.fileTextCache.get(file) ?? '';
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    const text = open ? open.getText() : await fs.readFile(file, 'utf8');
    this.fileTextCache.set(file, text);
    return text;
  }
}

function findGitRoot(filePath: string): string {
  let current = path.dirname(filePath);
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return path.dirname(filePath);
}

function createResolverHost(configuration: vscode.WorkspaceConfiguration): ResolverHost {
  return {
    async readFile(file) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
      return open ? open.getText() : fs.readFile(file, 'utf8');
    },
    async fileExists(file) {
      try { await fs.access(file); return true; } catch { return false; }
    },
    async resolveRepository(alias, repoName, rootFile) {
      const mappings = configuration.get<Record<string, string>>('repositoryMappings', {});
      const direct = mappings[alias] || (repoName ? mappings[repoName] : undefined);
      if (direct) {
        return direct.replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
      }
      if (alias === 'self') return findGitRoot(rootFile);

      const tailName = repoName?.split('/').at(-1);
      const folderMatch = vscode.workspace.workspaceFolders?.find((f) => f.name === tailName);
      if (folderMatch) return folderMatch.uri.fsPath;

      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: `Select local checkout of repository '${repoName ?? alias}' (alias '${alias}')` });
      if (!picked?.[0]) return undefined;
      const localPath = picked[0].fsPath;

      const saveTarget = await vscode.window.showQuickPick(['Workspace', 'User', 'Session only'], { title: 'Save repository mapping?' });
      if (saveTarget && saveTarget !== 'Session only') {
        const target = saveTarget === 'Workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const updated = { ...mappings, [alias]: localPath };
        if (repoName) updated[repoName] = localPath;
        await configuration.update('repositoryMappings', updated, target);
      }
      return localPath;
    },
    dirname: (p) => path.dirname(p),
    join: (...parts) => path.join(...parts),
    resolvePath: (...parts) => path.resolve(...parts),
    normalize: (p) => path.normalize(p)
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('azdoDiagram');
  context.subscriptions.push(diagnostics);
  const schemaService = new SchemaService(context);
  const preview = new PreviewController(context, diagnostics, schemaService);

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.openPreview', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    preview.open(editor.document.uri);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.openPreviewToSide', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    preview.open(editor.document.uri, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.openPreviewForFile', async () => {
    const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { YAML: ['yml', 'yaml'] } });
    if (!file?.[0]) return;
    preview.open(file[0]);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.exportDiagram', async () => {
    const format = await vscode.window.showQuickPick(['svg', 'png', 'jpeg', 'pdf'], { title: 'Export format' }) as 'svg' | 'png' | 'jpeg' | 'pdf' | undefined;
    if (!format) return;
    await preview.requestExport(format);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.refreshSchema', async () => {
    try {
      await schemaService.refreshSchema(vscode.workspace.getConfiguration('azdoDiagram'));
      void vscode.window.showInformationMessage('AzDO schema refreshed.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to refresh schema: ${(err as Error).message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.mapRepository', async () => {
    const alias = await vscode.window.showInputBox({ prompt: 'Repository alias or name' });
    if (!alias) return;
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false });
    if (!picked?.[0]) return;
    const config = vscode.workspace.getConfiguration('azdoDiagram');
    const mappings = config.get<Record<string, string>>('repositoryMappings', {});
    await config.update('repositoryMappings', { ...mappings, [alias]: picked[0].fsPath }, vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage(`Mapped ${alias} -> ${picked[0].fsPath}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.saveParameterPreset', async () => {
    await preview.saveParameterPreset();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('azdoDiagram.loadParameterPreset', async () => {
    await preview.loadParameterPreset();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const previewUri = preview.getPreviewUri()?.toString();
    if (previewUri && e.document.uri.toString() === previewUri) {
      preview.scheduleRefresh();
      return;
    }
    if (preview.hasDependency(e.document.uri.fsPath)) {
      preview.scheduleRefresh();
    }
  }));
}

export function deactivate(): void {}
