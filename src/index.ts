#!/usr/bin/env node

process.noDeprecation = true;

declare const PKG_VERSION: string;

import path from 'node:path';
import { Command, OptionValues } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { Config, configToToml, loadConfig, writeExampleConfig } from './config.js';
import {
  checkoutOrCreateBranch,
  commit,
  getDiff,
  isDirty,
  listLocalBranches,
  openRepo,
  pushCurrentBranch,
  stageAll,
} from './git.js';
import { generateCommitAndBranch, generateBranchName, generateCommitMessage } from './graph.js';
import {
  bitbucketPrCreationUrl,
  createBitbucketServerPullRequest,
  createPullRequest,
  getOriginUrl,
  isGhAvailable,
  isGitHubPullNewUrl,
  openInBrowser,
  parseRemote,
} from './pr.js';
import { GenerationError, GitBotError } from './types.js';
import type { SimpleGit } from 'simple-git';

interface GlobalOptions extends OptionValues {
  config?: string;
  verbose?: boolean;
}

interface RepoOptions extends OptionValues {
  repo?: string;
  dryRun?: boolean;
  yes?: boolean;
  issue?: string;
  push?: boolean;
}

function printBlock(title: string, content: string, color: keyof typeof chalk = 'green') {
  const paint = chalk[color] as (text: string) => string;
  const width = Math.max(title.length, content.length) + 4;
  const line = '─'.repeat(width);
  console.log(paint(`┌${line}┐`));
  console.log(paint(`│  ${title.padEnd(width - 2)}│`));
  console.log(paint(`├${line}┤`));
  console.log(paint(`│  ${content.padEnd(width - 2)}│`));
  console.log(paint(`└${line}┘`));
}

function validateApiKey(apiKey: string | undefined): asserts apiKey is string {
  if (!apiKey) {
    throw new GitBotError(
      'No API key configured. Set it in your config file or via the OPENAI_API_KEY environment variable.',
    );
  }
}

function requireChanges(hasChanges: boolean, source: string): void {
  if (!hasChanges) {
    if (source === 'none') {
      console.log(chalk.yellow('No changes detected. Nothing to do.'));
      process.exit(0);
    }
  }
}

async function handlePullRequestFlow(
  git: SimpleGit,
  config: Config,
  branch: string,
  repoPath: string,
  pushPrUrl?: string,
): Promise<void> {
  const { autoCreate, redirectToCreation } = config.pr;
  if (!autoCreate && !redirectToCreation) {
    return;
  }

  const remoteUrl = await getOriginUrl(git);
  const remote = remoteUrl ? parseRemote(remoteUrl, config.pr.provider) : undefined;

  // Non-GitHub servers (Bitbucket, GitLab) print the authoritative PR-creation
  // link in the push output; prefer it over opening a raw URL when we aren't
  // going to attempt token/API-based creation first.
  const hasBitbucketToken =
    remote?.provider === 'bitbucket-server' &&
    Boolean(
      config.pr.bitbucketToken || process.env.BITBUCKET_SERVER_TOKEN || process.env.BITBUCKET_TOKEN,
    );
  const willAttemptApiCreate = autoCreate && (hasBitbucketToken || remote?.provider !== 'bitbucket-server');

  if (redirectToCreation && !willAttemptApiCreate && pushPrUrl && !isGitHubPullNewUrl(pushPrUrl)) {
    await openInBrowser(pushPrUrl);
    console.log(chalk.green(`Opened PR creation page: ${pushPrUrl}`));
    return;
  }

  if (autoCreate) {
    if (remote?.provider === 'bitbucket-server') {
      const token =
        config.pr.bitbucketToken ||
        process.env.BITBUCKET_SERVER_TOKEN ||
        process.env.BITBUCKET_TOKEN;
      if (token) {
        const spinner = ora('Creating pull request on Bitbucket Server...').start();
        try {
          const prUrl = await createBitbucketServerPullRequest(git, remote, branch, token);
          spinner.succeed(`Pull request created: ${prUrl}`);
          if (redirectToCreation && prUrl) {
            await openInBrowser(prUrl);
          }
          return;
        } catch (error) {
          spinner.fail('Failed to create pull request');
          const message = error instanceof Error ? error.message : String(error);
          console.log(chalk.yellow(message));
          console.log(chalk.yellow('Falling back to the PR creation page.'));
        }
      } else {
        console.log(
          chalk.yellow(
            'No Bitbucket token configured (set pr.bitbucketToken or BITBUCKET_SERVER_TOKEN); falling back to the PR creation page.',
          ),
        );
      }
    } else if (await isGhAvailable()) {
      const spinner = ora('Creating pull request...').start();
      try {
        const prUrl = await createPullRequest(repoPath, branch);
        spinner.succeed(`Pull request created: ${prUrl}`);
        if (redirectToCreation && prUrl) {
          await openInBrowser(prUrl);
        }
        return;
      } catch (error) {
        spinner.fail('Failed to create pull request');
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.yellow(message));
        console.log(chalk.yellow('Falling back to the PR creation page.'));
      }
    } else {
      console.log(
        chalk.yellow(
          "GitHub CLI ('gh') not found; falling back to opening the PR creation page.",
        ),
      );
    }
  }

  // Prefer the server-printed link; construct the Bitbucket creation URL when
  // the push output carried none (SSH proxies can swallow remote messages).
  const creationUrl = pushPrUrl ?? (remote && bitbucketPrCreationUrl(remote, branch));
  if (!creationUrl) {
    return;
  }
  await openInBrowser(creationUrl);
  console.log(chalk.green(`Opened PR creation page: ${creationUrl}`));
}

async function commitAction(options: RepoOptions, command: Command): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOptions>();
  const config = loadConfig(globals.config);
  validateApiKey(config.llm.apiKey);

  const git = openRepo(options.repo);

  if (options.all) {
    await stageAll(git);
  }

  const diffResult = await getDiff(git);
  requireChanges(diffResult.hasChanges, diffResult.source);

  if (globals.verbose) {
    console.log(chalk.dim(`Using ${diffResult.source} changes...`));
  }

  let message: string;
  let branchName: string | undefined;

  if (options.branch) {
    const combinedSpinner = ora('Generating commit message and branch name...').start();
    try {
      const existingBranches = await listLocalBranches(git);
      const result = await generateCommitAndBranch(
        diffResult.diff,
        config,
        options.issue,
        existingBranches,
      );
      message = result.commitMessage;
      branchName = result.branchName;
      combinedSpinner.succeed('Commit message and branch name generated');
    } catch (error) {
      combinedSpinner.fail('Failed to generate commit message and branch name');
      throw error;
    }
    printBlock('Generated Commit Message', message);
    printBlock('Generated Branch Name', branchName, 'cyan');
  } else {
    const commitSpinner = ora('Generating commit message...').start();
    try {
      message = await generateCommitMessage(diffResult.diff, config);
      commitSpinner.succeed('Commit message generated');
    } catch (error) {
      commitSpinner.fail('Failed to generate commit message');
      throw error;
    }
    printBlock('Generated Commit Message', message);
  }

  if (options.dryRun) {
    return;
  }

  const prompt = branchName
    ? `Create branch '${branchName}' and commit with this message?`
    : 'Create commit with this message?';
  const proceed = options.yes || (await confirm({ message: prompt, default: false }));

  if (!proceed) {
    console.log(chalk.yellow('Aborted.'));
    process.exit(0);
  }

  if (branchName) {
    await checkoutOrCreateBranch(git, branchName);
    console.log(chalk.green(`Switched to branch ${branchName}.`));
  }

  if (options.all || diffResult.source === 'unstaged') {
    await stageAll(git);
    if (globals.verbose) {
      console.log(chalk.dim('Staged changes before committing.'));
    }
  }

  await commit(git, message);
  console.log(chalk.green('Committed successfully.'));

  if (options.push) {
    const pushed = await pushCurrentBranch(git);
    console.log(chalk.green(`Pushed '${pushed.branch}' to origin.`));
    const repoPath = options.repo ? path.resolve(options.repo) : process.cwd();
    await handlePullRequestFlow(git, config, pushed.branch, repoPath, pushed.prUrl);
  }
}

async function branchAction(options: RepoOptions, command: Command): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOptions>();
  const config = loadConfig(globals.config);
  validateApiKey(config.llm.apiKey);

  const git = openRepo(options.repo);
  let diffResult = await getDiff(git);

  if (!diffResult.hasChanges) {
    console.log(chalk.yellow('No changes detected; branch name will be generic.'));
    diffResult = { diff: 'No changes provided.', source: 'none', hasChanges: false };
  }

  const spinner = ora('Generating branch name...').start();
  let branchName: string;
  try {
    const existingBranches = await listLocalBranches(git);
    branchName = await generateBranchName(diffResult.diff, config, options.issue, existingBranches);
    spinner.succeed('Branch name generated');
  } catch (error) {
    spinner.fail('Failed to generate branch name');
    throw error;
  }

  printBlock('Generated Branch Name', branchName, 'cyan');

  if (options.dryRun) {
    return;
  }

  const proceed =
    options.yes ||
    (await confirm({ message: `Create and checkout branch '${branchName}'?`, default: false }));

  if (!proceed) {
    console.log(chalk.yellow('Aborted.'));
    process.exit(0);
  }

  await checkoutOrCreateBranch(git, branchName);
  console.log(chalk.green(`Switched to branch ${branchName}.`));

  if (options.push) {
    const pushed = await pushCurrentBranch(git);
    console.log(chalk.green(`Pushed '${pushed.branch}' to origin.`));
    const repoPath = options.repo ? path.resolve(options.repo) : process.cwd();
    await handlePullRequestFlow(git, config, pushed.branch, repoPath, pushed.prUrl);
  }
}

async function configAction(options: { init?: boolean }, command: Command): Promise<void> {
  const globals = command.optsWithGlobals<GlobalOptions>();

  if (options.init) {
    const writePath = writeExampleConfig(globals.config);
    console.log(chalk.green(`Example config written to ${writePath}`));
    return;
  }

  const config = loadConfig(globals.config);
  console.log(chalk.blue('Active Configuration'));
  console.log(configToToml(config));
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof GitBotError || error instanceof GenerationError) {
      console.error(chalk.red(`Error: ${error.message}`));
    } else if (error instanceof Error) {
      console.error(chalk.red(`Unexpected error: ${error.message}`));
    } else {
      console.error(chalk.red(`Unexpected error: ${String(error)}`));
    }
    process.exit(1);
  }
}

const program = new Command()
  .name('git-bot')
  .description('git-bot: an LLM-powered CLI assistant for conventional commits and branch names.')
  .version(typeof PKG_VERSION !== 'undefined' ? PKG_VERSION : '0.0.0')
  .option('--config <path>', 'Path to config TOML')
  .option('-v, --verbose', 'Show additional debug output')
  .configureHelp({ sortSubcommands: true });

program
  .command('commit')
  .description('Generate a commit message from staged (or unstaged) changes.')
  .option('--dry-run', 'Print the message but do not commit')
  .option('-a, --all', 'Stage all changes before committing')
  .option('-b, --branch', 'Also create a branch for this commit')
  .option('--issue <id>', 'Issue/ticket identifier to include in the branch name')
  .option('--repo <path>', 'Path to the git repository')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('-p, --push', 'Push to origin after committing')
  .action((options, command) => run(() => commitAction(options as RepoOptions, command)));

program
  .command('branch')
  .description('Generate a branch name from staged (or unstaged) changes.')
  .option('--dry-run', 'Print the branch name but do not create it')
  .option('--issue <id>', 'Issue/ticket identifier to include in the branch name')
  .option('--repo <path>', 'Path to the git repository')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('-p, --push', 'Push the new branch to origin after creating it')
  .action((options, command) => run(() => branchAction(options as RepoOptions, command)));

program
  .command('config')
  .description('Show or initialize configuration.')
  .option('--init', 'Write an example config file to the default location')
  .action((options, command) => run(() => configAction(options, command)));

program.parse();

export { openRepo, getDiff, isDirty };
