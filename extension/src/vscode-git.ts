// Minimal slice of the API exposed by VS Code's built-in `vscode.git` extension.
// Full definitions live in the vscode repo at extensions/git/src/api/git.d.ts.
import type { Uri } from 'vscode';

export interface InputBox {
  value: string;
}

export interface RepositoryState {
  HEAD: { name?: string } | undefined;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
}

export interface API {
  readonly repositories: Repository[];
}

export interface GitExtension {
  getAPI(version: 1): API;
}
