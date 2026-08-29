import * as vscode from 'vscode';
import { loadConfig, type Config } from '../../src/config.js';
import {
  checkoutOrCreateBranch,
  commit as gitCommit,
  getDiff,
  openRepo,
  pushCurrentBranch,
  stageAll,
} from '../../src/git.js';
import {
  generateBranchName,
  generateCommitAndBranch,
  generateCommitMessage,
} from '../../src/graph.js';
import {
  createBitbucketServerPullRequest,
  createPullRequest,
  getOriginUrl,
  isGhAvailable,
  openInBrowser,
  parseRemote,
  prCreationUrl,
} from '../../src/pr.js';
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
    vscode.commands.registerCommand('gitBot.generateCommitMessageAutoPush', () =>
      runCommand(() => commitMessageCommand(true, true)),
    ),
    vscode.commands.registerCommand('gitBot.generateBranch', () =>
      runCommand(() => branchCommand(false)),
    ),
    vscode.commands.registerCommand('gitBot.generateBranchAuto', () =>
      runCommand(() => branchCommand(true)),
    ),
    vscode.commands.registerCommand('gitBot.generateBranchAutoPush', () =>
      runCommand(() => branchCommand(true, true)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitAndBranch', () =>
      runCommand(() => commitAndBranchCommand(false)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitAndBranchAuto', () =>
      runCommand(() => commitAndBranchCommand(true)),
    ),
    vscode.commands.registerCommand('gitBot.generateCommitAndBranchAutoPush', () =>
      runCommand(() => commitAndBranchCommand(true, true)),
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
}

function pushWithProgress(repo: Repository): Thenable<string> {
  const git = openRepo(repo.rootUri.fsPath);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Git Bot: Pushing to origin…' },
    () => pushCurrentBranch(git),
  );
}

// Success toast with a Push action: pushes the current branch to origin
// (setting the upstream) when clicked.
async function notifyWithPush(repo: Repository, config: Config, message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, 'Push');
  if (choice !== 'Push') {
    return;
  }
  const pushed = await pushWithProgress(repo);
  void vscode.window.showInformationMessage(`Git Bot: pushed '${pushed}' to origin.`);
  await handlePullRequestFlow(repo, config, pushed);
}

async function showPrCreated(prUrl: string, redirect: boolean): Promise<void> {
  if (redirect) {
    await openInBrowser(prUrl);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Git Bot: pull request created: ${prUrl}`,
    'Open',
  );
  if (choice === 'Open') {
    await openInBrowser(prUrl);
  }
}

async function handlePullRequestFlow(
  repo: Repository,
  config: Config,
  branch: string,
): Promise<void> {
  const { autoCreate, redirectToCreation } = config.pr;
  if (!autoCreate && !redirectToCreation) {
    return;
  }

  const git = openRepo(repo.rootUri.fsPath);
  const remoteUrl = await getOriginUrl(git);
  const remote = remoteUrl ? parseRemote(remoteUrl, config.pr.provider) : undefined;

  if (autoCreate) {
    if (remote?.provider === 'bitbucket-server') {
      const token =
        config.pr.bitbucketToken ||
        process.env.BITBUCKET_SERVER_TOKEN ||
        process.env.BITBUCKET_TOKEN;
      if (token) {
        try {
          const prUrl = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Git Bot: Creating pull request…',
            },
            () => createBitbucketServerPullRequest(git, remote, branch, token),
          );
          await showPrCreated(prUrl, redirectToCreation);
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showWarningMessage(
            `Git Bot: ${message} Opening the PR creation page instead.`,
          );
        }
      } else {
        void vscode.window.showWarningMessage(
          'Git Bot: no Bitbucket token configured (pr.bitbucketToken or BITBUCKET_SERVER_TOKEN); opening the PR creation page instead.',
        );
      }
    } else if (await isGhAvailable()) {
      try {
        const prUrl = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Git Bot: Creating pull request…',
          },
          () => createPullRequest(repo.rootUri.fsPath, branch),
        );
        await showPrCreated(prUrl, redirectToCreation);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(
          `Git Bot: ${message} Opening the PR creation page instead.`,
        );
      }
    } else {
      void vscode.window.showWarningMessage(
        "Git Bot: GitHub CLI ('gh') not found; opening the PR creation page instead.",
      );
    }
  }

  if (!remote) {
    void vscode.window.showWarningMessage(
      'Git Bot: could not determine a PR creation URL from the origin remote.',
    );
    return;
  }

  await openInBrowser(prCreationUrl(remote, branch));
}

async function commitMessageCommand(autoApprove: boolean, autoPush = false): Promise<void> {
  const repo = await pickRepository();
  const diff = await requireDiff(repo);
  const config = await resolveConfig();

  const message = await withGenerationProgress('Generating commit message…', () =>
    generateCommitMessage(diff.diff, config),
  );

  if (autoApprove) {
    await commitDirectly(repo, diff.source, message);
    if (autoPush) {
      const pushed = await pushWithProgress(repo);
      void vscode.window.showInformationMessage(
        `Git Bot: committed '${message}' and pushed '${pushed}' to origin.`,
      );
      await handlePullRequestFlow(repo, config, pushed);
      return;
    }
    await notifyWithPush(repo, config, `Git Bot: committed '${message}'.`);
    return;
  }

  repo.inputBox.value = message;
  await vscode.commands.executeCommand('workbench.view.scm');
}

async function branchCommand(autoApprove: boolean, autoPush = false): Promise<void> {
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
  if (autoPush) {
    const pushed = await pushWithProgress(repo);
    void vscode.window.showInformationMessage(
      `Git Bot: switched to branch '${branchName}' and pushed it to origin.`,
    );
    await handlePullRequestFlow(repo, config, pushed);
    return;
  }
  await notifyWithPush(repo, config, `Git Bot: switched to branch '${branchName}'.`);
}

async function commitAndBranchCommand(autoApprove: boolean, autoPush = false): Promise<void> {
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
    if (autoPush) {
      const pushed = await pushWithProgress(repo);
      void vscode.window.showInformationMessage(
        `Git Bot: switched to branch '${branchName}', committed '${result.commitMessage}', and pushed to origin.`,
      );
      await handlePullRequestFlow(repo, config, pushed);
      return;
    }
    await notifyWithPush(
      repo,
      config,
      `Git Bot: switched to branch '${branchName}' and committed '${result.commitMessage}'.`,
    );
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
