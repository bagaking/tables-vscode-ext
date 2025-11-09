
import * as path from 'path';
import * as vscode from 'vscode';
import {
  EnumContextPayload,
  convertContextToEnumPayload,
  findContextDirectoryForPath
} from './features/khTables/enumContext';
import { KhTablesModeService, KhTablesModeSnapshot, KhTablesOverride } from './features/khTables/state';

export function activate(context: vscode.ExtensionContext): void {
  const khTablesModeService = new KhTablesModeService(context.workspaceState);
  context.subscriptions.push(
    CsvEditorProvider.register(context, khTablesModeService),
    vscode.commands.registerCommand('tablesCsvEditor.openFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showErrorMessage('Open a CSV file first or select one in the Explorer.');
        return;
      }

      try {
        await vscode.commands.executeCommand('vscode.openWith', target, CsvEditorProvider.viewType);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open CSV with Tables editor: ${error}`);
      }
    }),
    vscode.commands.registerCommand('tablesCsvEditor.exportMarkdown', async (uri?: vscode.Uri) => {
      try {
        const target = await resolveTargetCsvUri(uri);
        if (!target) {
          vscode.window.showWarningMessage('Select a CSV file first.');
          return;
        }
        const content = await readTextFile(target);
        const rows = parseCsvToRows(content);
        const markdown = toGfmMarkdown(rows);
        const defaultUri = target.with({
          path: target.path.replace(/\.[^./\\]*$/u, '') + '.md'
        });
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { Markdown: ['md'] }
        });
        if (!saveUri) {
          return;
        }
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(markdown, 'utf8'));
        void vscode.window.showInformationMessage(`Exported Markdown to ${saveUri.fsPath}`);
        try {
          const doc = await vscode.workspace.openTextDocument(saveUri);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          // ignore
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand('tablesCsvEditor.runDiagnostics', async () => {
      console.log('[tables] Trigger: runDiagnostics');
      CsvEditorProvider.requestDiagnostics();
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up: everything is disposed via subscriptions.
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'update'; text: string }
  | { type: 'requestSave'; text: string }
  | { type: 'setKhMode'; override: KhTablesOverride }
  | { type: 'exportMarkdown' }
  | { type: 'diagnostics'; scope?: string; details?: unknown };

type HostDocumentMessageType = 'init' | 'externalUpdate';

interface KhTablesWebviewState {
  readonly active: boolean;
  readonly override: KhTablesOverride;
  readonly detection: {
    readonly hasMarkers: boolean;
    readonly markRowIndex: number | null;
    readonly tokenHits: readonly string[];
    readonly confidence: number;
  };
}

type HostToWebviewMessage =
  | {
      type: HostDocumentMessageType;
      text: string;
      khTables: KhTablesWebviewState;
      context?: EnumContextPayload;
      // Reflect VS Code document dirty state so the webview can show accurate save status
      dirty: boolean;
    }
  | {
      type: 'khTablesState';
      khTables: KhTablesWebviewState;
      context?: EnumContextPayload;
      dirty?: boolean;
    };

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'tables.csvEditor';
  private static liveWebviews = new Set<vscode.Webview>();

  private readonly updatingDocuments = new Set<string>();
  private readonly enumContextCache = new Map<string, EnumContextPayload | null>();
  private readonly contextDirectoryCache = new Map<string, string | undefined>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly khTablesMode: KhTablesModeService
  ) {}

  public static register(
    context: vscode.ExtensionContext,
    khTablesMode: KhTablesModeService
  ): vscode.Disposable {
    const provider = new CsvEditorProvider(context, khTablesMode);
    return vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }

  public static requestDiagnostics(): void {
    for (const webview of Array.from(CsvEditorProvider.liveWebviews)) {
      try {
        void webview.postMessage({ type: 'diagnosticsRequest' });
      } catch (err) {
        console.error('[tables] diagnosticsRequest failed:', err);
      }
    }
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: this.getLocalResourceRoots()
    };
    webview.html = this.getHtmlForWebview(webview);
    CsvEditorProvider.liveWebviews.add(webview);

    const documentUri = document.uri.toString();

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== documentUri) {
        return;
      }

      if (this.updatingDocuments.has(documentUri)) {
        return;
      }

      void this.postDocumentSnapshot(webview, document, 'externalUpdate');
    });

    const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() !== documentUri) {
        return;
      }
      // Notify webview that the document is now saved (dirty=false)
      void this.postDocumentSnapshot(webview, document, 'externalUpdate');
    });

    webviewPanel.onDidDispose(() => {
      CsvEditorProvider.liveWebviews.delete(webview);
      changeSubscription.dispose();
      saveSubscription.dispose();
    });

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready': {
          void this.postDocumentSnapshot(webview, document, 'init');
          break;
        }
        case 'update': {
          await this.updateTextDocument(document, message.text ?? '');
          // Echo latest snapshot (including dirty flag) so the webview status reflects unsaved changes
          void this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'requestSave': {
          await this.updateTextDocument(document, message.text ?? '');
          // Save only the active document to disk; avoid surprising global saves
          try {
            await document.save();
          } catch (err) {
            console.error('[tables] document.save() failed:', err);
          }
          void this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'setKhMode': {
          void this.handleKhModeOverride(document, webview, message.override);
          break;
        }
        case 'exportMarkdown': {
          try {
            await exportActiveDocumentAsMarkdown(document);
          } catch (error) {
            vscode.window.showErrorMessage(`Export failed: ${String(error)}`);
          }
          break;
        }
        case 'diagnostics': {
          console.log('[tables] Webview diagnostics:', message);
          break;
        }
      }
    });
  }

  private async handleKhModeOverride(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    override: KhTablesOverride
  ): Promise<void> {
    if (!['on', 'off', 'auto'].includes(override)) {
      return Promise.resolve();
    }
    this.khTablesMode.setOverride(document.uri, override);
    const snapshot = this.khTablesMode.evaluate(document);
    const context = await this.getEnumContext(document);
    const message: HostToWebviewMessage = {
      type: 'khTablesState',
      khTables: this.toWebviewState(snapshot),
      context
    };
    await webview.postMessage(message);
  }

  private async updateTextDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const documentUri = document.uri.toString();

    if (text === document.getText()) {
      return;
    }

    this.updatingDocuments.add(documentUri);

    const edit = new vscode.WorkspaceEdit();
    const fullRange = this.getDocumentRange(document);
    edit.replace(document.uri, fullRange, text);

    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.updatingDocuments.delete(documentUri);
    }
  }

  private async postDocumentSnapshot(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    type: HostDocumentMessageType
  ): Promise<void> {
    const snapshot = this.khTablesMode.evaluate(document);
    return this.buildAndSendSnapshotMessage(webview, document, type, snapshot);
  }

  private async buildAndSendSnapshotMessage(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    type: HostDocumentMessageType,
    snapshot: KhTablesModeSnapshot
  ): Promise<void> {
    const context = await this.getEnumContext(document);
    const message: HostToWebviewMessage = {
      type,
      text: document.getText(),
      khTables: this.toWebviewState(snapshot),
      context,
      dirty: document.isDirty
    };
    await webview.postMessage(message);
  }

  private toWebviewState(snapshot: KhTablesModeSnapshot): KhTablesWebviewState {
    return {
      active: snapshot.active,
      override: snapshot.override,
      detection: {
        hasMarkers: snapshot.detection.hasMarkers,
        markRowIndex: snapshot.detection.markRowIndex ?? null,
        tokenHits: snapshot.detection.tokenHits,
        confidence: snapshot.detection.confidence
      }
    };
  }

  private async getEnumContext(document: vscode.TextDocument): Promise<EnumContextPayload | undefined> {
    const baseDir = path.dirname(document.uri.fsPath);
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const contextDirectory = await findContextDirectoryForPath(baseDir, {
      workspaceRoot,
      cache: this.contextDirectoryCache
    });
    if (!contextDirectory) {
      return undefined;
    }

    const cached = this.enumContextCache.get(contextDirectory);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    try {
      // Lazy import to avoid activation failure if dependency is missing or broken
      const mod = (await import('@khgame/tables/lib/serializer/core')) as { loadContext?: (dir: string) => unknown };
      if (!mod || typeof mod.loadContext !== 'function') {
        throw new Error('loadContext not available');
      }
      const rawContext = mod.loadContext(contextDirectory);
      const payload = convertContextToEnumPayload(rawContext);
      this.enumContextCache.set(contextDirectory, payload ?? null);
      return payload ?? undefined;
    } catch (error) {
      console.error(`[tables] Failed to load context from ${contextDirectory}:`, error);
      this.enumContextCache.set(contextDirectory, null);
      return undefined;
    }
  }

  private getDocumentRange(document: vscode.TextDocument): vscode.Range {
    const lastLine = document.lineCount > 0 ? document.lineAt(document.lineCount - 1) : undefined;
    const endPosition = lastLine?.range.end ?? new vscode.Position(0, 0);
    return new vscode.Range(new vscode.Position(0, 0), endPosition);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    const agGridStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'ag-grid.css')
    );
    const agGridThemeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'ag-theme-quartz.css')
    );
    const agGridScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'ag-grid-community.min.js')
    );
    const papaparseScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', 'papaparse.min.js')
    );
    console.log('[tables] Vendor URIs', {
      agGridStyleUri: String(agGridStyleUri),
      agGridThemeUri: String(agGridThemeUri),
      agGridScriptUri: String(agGridScriptUri),
      papaparseScriptUri: String(papaparseScriptUri)
    });

    const nonce = getNonce();

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource} data:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${agGridStyleUri}" />
    <link rel="stylesheet" href="${agGridThemeUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Tables CSV Editor</title>
  </head>
  <body>
    <div class="command-strip" role="group" aria-label="Editor actions">
      <div class="brand-lockup" aria-label="TableLens">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-name">TableLens</span>
      </div>
      <div class="status-group compact" id="edit-group" aria-live="polite">
        <span class="status-icon" id="edit-icon" aria-hidden="true"></span>
        <span id="edit-status" class="status-value">Saved</span>
      </div>
      <div class="command-spacer" aria-hidden="true"></div>
      <div class="status-group actions">
        <button id="toggle-raw" aria-pressed="false" title="Toggle Raw CSV view">Raw</button>
        <button id="export-md" aria-pressed="false" title="Export as GitHub Flavored Markdown">Export</button>
        <button id="run-diag" aria-pressed="false" title="Run Diagnostics">Diag</button>
        <button id="save" title="Save this CSV file">Save</button>
      </div>
    </div>
    <div class="schema-rail" role="group" aria-label="Schema status">
      <div class="schema-items" id="schema-items" aria-live="polite"></div>
      <div id="status-area" role="status" aria-live="polite">
        <button id="status-indicator" class="status-indicator" aria-label="Status" title="Ready" type="button"></button>
        <span id="status-text" class="sr-only">Ready</span>
      </div>
    </div>
    <div id="workspace-shell">
      <div id="view-container">
        <div id="grid" class="ag-theme-quartz" aria-label="CSV grid"></div>
        <textarea
          id="raw-view"
          aria-label="Raw CSV"
          hidden
          spellcheck="false"
          wrap="off"
        ></textarea>
      </div>
      <aside id="inspector" aria-label="Selection inspector">
        <div class="inspector-header">
          <span class="inspector-kicker" id="inspector-kicker">Selection</span>
          <h2 id="inspector-title">No cell</h2>
          <p id="inspector-subtitle">Select a cell to inspect schema state.</p>
        </div>
        <div id="inspector-body" class="inspector-body"></div>
      </aside>
    </div>
    <div class="bottom-status" role="group" aria-label="Editor status">
      <div class="status-group" id="kh-mode">
        <span class="status-icon" id="kh-mode-icon" aria-hidden="true"></span>
        <span class="status-label">Schema</span>
        <select id="kh-mode-select" aria-label="Tables mode">
          <option value="auto">Auto detect</option>
          <option value="on">Force on</option>
          <option value="off">Force off</option>
        </select>
        <span id="kh-mode-status" aria-live="polite"></span>
      </div>
      <div class="status-spacer" aria-hidden="true"></div>
      <div id="table-meta" class="table-meta">TableLens · Saved · 0 rows · 0 columns</div>
    </div>
    <script nonce="${nonce}" src="${papaparseScriptUri}"></script>
    <script nonce="${nonce}" src="${agGridScriptUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private getLocalResourceRoots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// (diagnostics broadcaster implemented as CsvEditorProvider.requestDiagnostics())

async function exportActiveDocumentAsMarkdown(document: vscode.TextDocument): Promise<void> {
  const rows = parseCsvToRows(document.getText());
  const markdown = toGfmMarkdown(rows);
  const defaultUri = document.uri.with({ path: document.uri.path.replace(/\.[^./\\]*$/u, '') + '.md' });
  const saveUri = await vscode.window.showSaveDialog({ defaultUri, filters: { Markdown: ['md'] } });
  if (!saveUri) return;
  await vscode.workspace.fs.writeFile(saveUri, Buffer.from(markdown, 'utf8'));
  void vscode.window.showInformationMessage(`Exported Markdown to ${saveUri.fsPath}`);
  try {
    const doc = await vscode.workspace.openTextDocument(saveUri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    // ignore
  }
}

async function resolveTargetCsvUri(initial?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (initial) {
    return initial;
  }
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && activeDoc.uri && /\.(csv)$/i.test(activeDoc.uri.fsPath)) {
    return activeDoc.uri;
  }
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { CSV: ['csv'] } });
  return picked && picked.length > 0 ? picked[0] : undefined;
}

async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function parseCsvToRows(text: string): string[][] {
  // Minimal CSV parser: supports commas, CR/LF, quotes with "" escaping; does not skip empty lines
  if (typeof text !== 'string' || text.length === 0) return [[]];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') {
      // ignore CR, handle on LF
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((v) => (v != null ? String(v) : '')));
}

function toGfmMarkdown(rows: string[][]): string {
  const safe = (value: string): string => {
    if (value == null) return '';
    // escape pipe, normalize line breaks within a cell
    const text = String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>');
    return text;
  };
  const width = rows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);
  const normalized = rows.map((r) => {
    const row = Array.isArray(r) ? r.slice() : [String(r)];
    while (row.length < width) row.push('');
    return row;
  });
  if (normalized.length === 0) {
    return '';
  }
  const header = normalized[0];
  const lines: string[] = [];
  lines.push(`| ${header.map(safe).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (let i = 1; i < normalized.length; i += 1) {
    lines.push(`| ${normalized[i].map(safe).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}
