import type * as vscode from 'vscode';

export async function writeExport(vscodeApi: typeof vscode, uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await vscodeApi.workspace.fs.writeFile(uri, bytes);
}
