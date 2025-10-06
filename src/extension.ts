
import * as vscode from 'vscode';
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
  | { type: HostDocumentMessageType; text: string; khTables: KhTablesWebviewState }
  | { type: 'khTablesState'; khTables: KhTablesWebviewState };

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'tables.csvEditor';

  private readonly updatingDocuments = new Set<string>();

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

      this.postDocumentSnapshot(webview, document, 'externalUpdate');
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready': {
          this.postDocumentSnapshot(webview, document, 'init');
          break;
        }
        case 'update': {
          await this.updateTextDocument(document, message.text ?? '');
          this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'requestSave': {
          await this.updateTextDocument(document, message.text ?? '');
          await vscode.workspace.saveAll();
          this.postDocumentSnapshot(webview, document, 'externalUpdate');
          break;
        }
        case 'setKhMode': {
          this.handleKhModeOverride(document, webview, message.override);
          break;
        }
      }
    });
  }

  private handleKhModeOverride(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    override: KhTablesOverride
  ): void {
    if (!['on', 'off', 'auto'].includes(override)) {
      return;
    }
    this.khTablesMode.setOverride(document.uri, override);
    const snapshot = this.khTablesMode.evaluate(document);
    const message: HostToWebviewMessage = {
      type: 'khTablesState',
      khTables: this.toWebviewState(snapshot)
    };
    void webview.postMessage(message);
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

  private postDocumentSnapshot(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    type: HostDocumentMessageType
  ): void {
    const snapshot = this.khTablesMode.evaluate(document);
    const message: HostToWebviewMessage = {
      type,
      text: document.getText(),
      khTables: this.toWebviewState(snapshot)
    };
    void webview.postMessage(message);
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
      `img-src ${webview.cspSource} https: data:`
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
    <div class="toolbar">
      <div class="toolbar-group">
        <button id="add-row">Add Row</button>
        <button id="remove-row">Remove Row</button>
        <button id="add-column">Add Column</button>
        <button id="remove-column">Remove Column</button>
      </div>
      <div class="toolbar-group" id="kh-mode">
        <label for="kh-mode-select">Tables mode</label>
        <select id="kh-mode-select">
          <option value="auto">Auto detect</option>
          <option value="on">Force on</option>
          <option value="off">Force off</option>
        </select>
        <span id="kh-mode-status" aria-live="polite"></span>
      </div>
      <span class="spacer"></span>
      <div id="status" role="status" aria-live="polite"></div>
      <button id="save">Save</button>
    </div>
    <div id="grid" class="ag-theme-quartz"></div>
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
