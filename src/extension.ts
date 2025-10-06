
import * as path from 'path';
import * as vscode from 'vscode';
import { loadContext as loadKhTablesContext } from '@khgame/tables/lib/serializer/core';
import {
  EnumContextPayload,
  EnumOptionPayload,
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
  | { type: 'setKhMode'; override: KhTablesOverride };

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
    }
  | { type: 'khTablesState'; khTables: KhTablesWebviewState; context?: EnumContextPayload };

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'tables.csvEditor';

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

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready': {
          void this.postDocumentSnapshot(webview, document, 'init');
          break;
        }
        case 'update': {
          await this.updateTextDocument(document, message.text ?? '');
          void this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'requestSave': {
          await this.updateTextDocument(document, message.text ?? '');
          await vscode.workspace.saveAll();
          void this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'setKhMode': {
          void this.handleKhModeOverride(document, webview, message.override);
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
      context
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
      const rawContext = loadKhTablesContext(contextDirectory);
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
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'ag-grid-community', 'styles', 'ag-grid.css')
    );
    const agGridThemeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'ag-grid-community', 'styles', 'ag-theme-quartz.css')
    );
    const agGridScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'node_modules',
        'ag-grid-community',
        'dist',
        'ag-grid-community.min.js'
      )
    );
    const papaparseScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'papaparse', 'papaparse.min.js')
    );

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
    <div class="status-bar" role="group" aria-label="Editor status">
      <div class="status-group" id="kh-mode">
        <span class="status-label">Mode</span>
        <select id="kh-mode-select" aria-label="Tables mode">
          <option value="auto">Auto detect</option>
          <option value="on">Force on</option>
          <option value="off">Force off</option>
        </select>
        <span id="kh-mode-status" aria-live="polite"></span>
      </div>
      <div class="status-group" aria-live="polite">
        <span class="status-label">Edit</span>
        <span id="edit-status" class="status-value">Saved</span>
      </div>
      <div class="status-spacer" aria-hidden="true"></div>
      <div class="status-group actions">
        <button id="toggle-raw" aria-pressed="false">Raw CSV</button>
        <button id="save">Save</button>
      </div>
      <div id="status" role="status" aria-live="polite"></div>
    </div>
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
    <script nonce="${nonce}" src="${papaparseScriptUri}"></script>
    <script nonce="${nonce}" src="${agGridScriptUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private getLocalResourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'ag-grid-community'),
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'papaparse')
    ];
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
