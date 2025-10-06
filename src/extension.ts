import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    CsvEditorProvider.register(context),
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
  | { type: 'requestSave'; text: string };

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'tables.csvEditor';

  private readonly updatingDocuments = new Set<string>();

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CsvEditorProvider(context);
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

    const updateWebview = () => {
      webview.postMessage({ type: 'init', text: document.getText() });
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== documentUri) {
        return;
      }

      if (this.updatingDocuments.has(documentUri)) {
        return;
      }

      webview.postMessage({ type: 'externalUpdate', text: document.getText() });
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'ready': {
          updateWebview();
          break;
        }
        case 'update': {
          await this.updateTextDocument(document, message.text ?? '');
          break;
        }
        case 'requestSave': {
          await this.updateTextDocument(document, message.text ?? '');
          await vscode.workspace.saveAll();
          break;
        }
      }
    });
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
      <button id="add-row">Add Row</button>
      <button id="remove-row">Remove Row</button>
      <button id="add-column">Add Column</button>
      <button id="remove-column">Remove Column</button>
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
