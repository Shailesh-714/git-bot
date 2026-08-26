import * as vscode from 'vscode';
import { loadConfig, type Config } from '../../src/config.js';
import {
  checkoutOrCreateBranch,
  commit as gitCommit,
  getDiff,
  openRepo,
  stageAll,
} from '../../src/git.js';
import {
  generateBranchName,
  generateCommitAndBranch,
  generateCommitMessage,
} from '../../src/graph.js';
import type { DiffResult } from '../../src/types.js';
import type { GitExtension, Repository } from './vscode-git.js';

const API_KEY_SECRET = 'gitBot.openaiApiKey';

let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('gitBot.generateCommitMessage', () =>
      runCommand(() => commitMessageCommand(false)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitMessageAuto', () =>
      runCommand(() => commitMessageCommand(true)),
    ),
    vscode.commands.registerCommand('gitBot.generateBranch', () =>
      runCommand(() => branchCommand(false)),
    ),
    vscode.commands.registerCommand('gitBot.generateBranchAuto', () =>
      runCommand(() => branchCommand(true)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitAndBranch', () =>
      runCommand(() => commitAndBranchCommand(false)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitAndBranchAuto', () =>
      runCommand(() => commitAndBranchCommand(true)),
    ),
    vscode.commands.registerCommand('gitBot.setApiKey', () => setApiKey()),
  );
}

export function deactivate(): void {}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    if (error instanceof UserCancelledError) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Git Bot: ${message}`);
  }
}

class UserCancelledError extends Error {}

async function commitDirectly(
  repo: Repository,
  diffSource: DiffResult['source'],
  message: string,
): Promise<void> {
  const git = openRepo(repo.rootUri.fsPath);
  if (diffSource === 'unstaged') {
    await stageAll(git);
  }
  await gitCommit(git, message);
  void vscode.window.showInformationMessage(`Git Bot: committed '${message}'.`);
}

async function commitMessageCommand(autoApprove: boolean): Promise<void> {
  const repo = await pickRepository();
  const diff = await requireDiff(repo);
  const config = await resolveConfig();

  const message = await withGenerationProgress('Generating commit message…', () =>
    generateCommitMessage(diff.diff, config),
  );

  if (autoApprove) {
    await commitDirectly(repo, diff.source, message);
    return;
  }

  repo.inputBox.value = message;
  await vscode.commands.executeCommand('workbench.view.scm');
}

async function branchCommand(autoApprove: boolean): Promise<void> {
  const repo = await pickRepository();
  const git = openRepo(repo.rootUri.fsPath);
  let diff = await getDiff(git);
  if (!diff.hasChanges) {
    diff = { diff: 'No changes provided.', source: 'none', hasChanges: false };
  }
  const config = await resolveConfig();

  const generated = await withGenerationProgress('Generating branch name…', () =>
    generateBranchName(diff.diff, config),
  );

  const branchName = autoApprove ? generated : await confirmBranchName(generated);
  await checkoutOrCreateBranch(git, branchName);
  void vscode.window.showInformationMessage(`Git Bot: switched to branch '${branchName}'.`);
}

async function commitAndBranchCommand(autoApprove: boolean): Promise<void> {
  const repo = await pickRepository();
  const git = openRepo(repo.rootUri.fsPath);
  const diff = await requireDiff(repo);
  const config = await resolveConfig();

  const result = await withGenerationProgress('Generating commit message and branch name…', () =>
    generateCommitAndBranch(diff.diff, config),
  );

  const branchName = autoApprove ? result.branchName : await confirmBranchName(result.branchName);
  await checkoutOrCreateBranch(git, branchName);

  if (autoApprove) {
    await commitDirectly(repo, diff.source, result.commitMessage);
    void vscode.window.showInformationMessage(`Git Bot: switched to branch '${branchName}'.`);
    return;
  }

  repo.inputBox.value = result.commitMessage;
  await vscode.commands.executeCommand('workbench.view.scm');
  void vscode.window.showInformationMessage(
    `Git Bot: switched to branch '${branchName}'. Review the message and commit when ready.`,
  );
}

async function setApiKey(): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your OpenAI API key (stored securely in VS Code secret storage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (!key || !key.trim()) {
    return false;
  }
  await extensionContext.secrets.store(API_KEY_SECRET, key.trim());
  void vscode.window.showInformationMessage('Git Bot: API key saved.');
  return true;
}

async function requireDiff(repo: Repository): Promise<DiffResult> {
  const git = openRepo(repo.rootUri.fsPath);
  const diff = await getDiff(git);
  if (!diff.hasChanges) {
    void vscode.window.showInformationMessage('Git Bot: no changes detected. Nothing to do.');
    throw new UserCancelledError();
  }
  return diff;
}

async function confirmBranchName(generated: string): Promise<string> {
  const edited = await vscode.window.showInputBox({
    prompt: 'Press Enter to create this branch, or edit the name first',
    value: generated,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Branch name cannot be empty'),
  });
  if (!edited) {
    throw new UserCancelledError();
  }
  return edited.trim();
}

async function resolveConfig(): Promise<Config> {
  // Base config comes from ~/.config/git-bot/config.toml (same file the CLI
  // uses), then VS Code settings and secret storage take precedence.
  const config = loadConfig(process.env.GIT_BOT_CONFIG);
  const settings = vscode.workspace.getConfiguration('gitBot');

  const model = settings.get<string>('model');
  if (model) {
    config.llm.model = model;
  }
  const baseUrl = settings.get<string>('baseUrl');
  if (baseUrl) {
    config.llm.baseUrl = baseUrl;
  }
  const temperature = settings.get<number>('temperature');
  if (typeof temperature === 'number' && temperature >= 0) {
    config.llm.temperature = temperature;
  }

  const secretKey = await extensionContext.secrets.get(API_KEY_SECRET);
  if (secretKey) {
    config.llm.apiKey = secretKey;
  }

  if (!config.llm.apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'Git Bot needs an OpenAI API key.',
      'Set API Key',
    );
    if (choice === 'Set API Key' && (await setApiKey())) {
      config.llm.apiKey = await extensionContext.secrets.get(API_KEY_SECRET);
    }
    if (!config.llm.apiKey) {
      throw new UserCancelledError();
    }
  }

  return config;
}

async function pickRepository(): Promise<Repository> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    throw new Error('The built-in Git extension is not available.');
  }
  const api = (await gitExtension.activate()).getAPI(1);

  const repos = api.repositories;
  if (repos.length === 0) {
    throw new Error('No git repository found in the current workspace.');
  }
  if (repos.length === 1) {
    return repos[0];
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const match = repos.find((repo) => activeUri.fsPath.startsWith(repo.rootUri.fsPath));
    if (match) {
      return match;
    }
  }

  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.rootUri.fsPath, repo })),
    { placeHolder: 'Select a repository' },
  );
  if (!picked) {
    throw new UserCancelledError();
  }
  return picked.repo;
}

function withGenerationProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Git Bot: ${title}` },
    () => task(),
  );
}
