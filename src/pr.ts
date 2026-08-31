import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SimpleGit } from 'simple-git';
import { GitBotError } from './types.js';

const execFileAsync = promisify(execFile);

export type PrProvider = 'github' | 'bitbucket-server';
export type PrProviderSetting = 'auto' | PrProvider;

export interface RemoteInfo {
  provider: PrProvider;
  /** GitHub: repo web URL. Bitbucket Server: instance base URL (including any context path). */
  webUrl: string;
  projectKey?: string;
  repoSlug?: string;
}

const BITBUCKET_SSH_PORT = '7999';

export async function getOriginUrl(git: SimpleGit): Promise<string | undefined> {
  try {
    const url = await git.remote(['get-url', 'origin']);
    return url ? url.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function parseRemote(
  remoteUrl: string,
  provider: PrProviderSetting = 'auto',
): RemoteInfo | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');

  let scheme = 'https';
  let host: string;
  let port: string | undefined;
  let pathname: string;

  const sshUrl = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::(\d+))?\/(.+)$/);
  const scpStyle = trimmed.match(/^(?:[^@/]+@)([^:/]+):(.+)$/);
  const httpUrl = trimmed.match(/^(https?):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/);

  if (sshUrl) {
    [, host, port, pathname] = sshUrl;
  } else if (scpStyle) {
    [, host, pathname] = scpStyle;
  } else if (httpUrl) {
    [, scheme, host, pathname] = httpUrl;
  } else {
    return undefined;
  }

  // Bitbucket Server HTTPS clone URLs look like https://host[/context]/scm/PROJECT/repo.git
  const scmMatch = pathname.match(/^(?:(.+)\/)?scm\/([^/]+)\/([^/]+)$/);
  // bitbucket.org is Bitbucket Cloud, which has a different API; only treat
  // self-hosted bitbucket.* hosts as Bitbucket Server.
  const bitbucketHost = /(^|\.)bitbucket\./i.test(host) && host.toLowerCase() !== 'bitbucket.org';
  const isBitbucket =
    provider === 'bitbucket-server' ||
    (provider === 'auto' && (Boolean(scmMatch) || port === BITBUCKET_SSH_PORT || bitbucketHost));

  if (isBitbucket) {
    let contextPath = '';
    let projectKey: string;
    let repoSlug: string;
    if (scmMatch) {
      contextPath = scmMatch[1] ? `/${scmMatch[1]}` : '';
      projectKey = scmMatch[2];
      repoSlug = scmMatch[3];
    } else {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length < 2) {
        return undefined;
      }
      projectKey = parts[parts.length - 2];
      repoSlug = parts[parts.length - 1];
    }
    // SSH remotes carry no web port; assume the web UI is on the default https port.
    const webScheme = httpUrl ? scheme : 'https';
    // Bitbucket Data Center often exposes SSH on a dedicated ssh.* host; the
    // web UI lives on the same name without that prefix.
    const webHost = httpUrl ? host : host.replace(/^ssh\./i, '');
    return {
      provider: 'bitbucket-server',
      webUrl: `${webScheme}://${webHost}${contextPath}`,
      projectKey,
      repoSlug,
    };
  }

  return { provider: 'github', webUrl: `${scheme}://${host}/${pathname}` };
}

/**
 * GitHub announces new branches with a `.../pull/new/<branch>` link, which the
 * `gh`-based creation flow supersedes. Any other link printed in the push
 * output (Bitbucket `pull-requests?create`, GitLab `merge_requests/new`, ...)
 * is the server telling us exactly where PRs for this repo are created, and
 * should be preferred over API-based creation.
 */
export function isGitHubPullNewUrl(url: string): boolean {
  return /\/pull\/new\//.test(url);
}

/**
 * Bitbucket Server's PR creation page, constructed from the remote. Used when
 * the push output carries no link (e.g. SSH proxies that swallow remote
 * messages, or a branch that was already published).
 */
export function bitbucketPrCreationUrl(remote: RemoteInfo, branch: string): string | undefined {
  if (remote.provider !== 'bitbucket-server' || !remote.projectKey || !remote.repoSlug) {
    return undefined;
  }
  const source = encodeURIComponent(`refs/heads/${branch}`);
  return `${remote.webUrl}/projects/${remote.projectKey.toUpperCase()}/repos/${remote.repoSlug}/pull-requests?create&sourceBranch=${source}`;
}

export async function getDefaultBranch(git: SimpleGit): Promise<string | undefined> {
  try {
    const ref = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const match = ref.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) {
      return match[1];
    }
  } catch {
    // origin/HEAD is not always set locally; fall through to the remote query.
  }
  try {
    const ref = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
    const match = ref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function isGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function createPullRequest(repoPath: string, branch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'create', '--head', branch, '--fill'], {
      cwd: repoPath,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitBotError(`Failed to create pull request via gh: ${detail}`);
  }
}

export async function createBitbucketServerPullRequest(
  git: SimpleGit,
  remote: RemoteInfo,
  branch: string,
  token: string,
): Promise<string> {
  const apiBase = `${remote.webUrl}/rest/api/1.0/projects/${remote.projectKey}/repos/${remote.repoSlug}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  let targetRef: string | undefined;
  try {
    const res = await fetch(`${apiBase}/default-branch`, { headers });
    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      targetRef = data.id;
    }
  } catch {
    // Creation below will surface real connectivity errors.
  }
  if (!targetRef) {
    const defaultBranch = await getDefaultBranch(git);
    targetRef = defaultBranch ? `refs/heads/${defaultBranch}` : 'refs/heads/main';
  }

  const log = await git.log({ maxCount: 1 });
  const title = log.latest?.message ?? `Merge ${branch}`;
  const description = log.latest?.body ?? '';

  const repository = {
    slug: remote.repoSlug,
    project: { key: remote.projectKey },
  };

  let res: Response;
  try {
    res = await fetch(`${apiBase}/pull-requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title,
        description,
        fromRef: { id: `refs/heads/${branch}`, repository },
        toRef: { id: targetRef, repository },
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitBotError(`Failed to reach Bitbucket Server at ${remote.webUrl}: ${detail}`);
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { errors?: Array<{ message?: string }> };
      const messages = data.errors?.map((e) => e.message).filter(Boolean);
      if (messages && messages.length > 0) {
        detail = messages.join('; ');
      }
    } catch {
      // Response body was not JSON; keep the status line.
    }
    throw new GitBotError(`Bitbucket Server rejected the pull request: ${detail}`);
  }

  const data = (await res.json()) as {
    id?: number;
    links?: { self?: Array<{ href?: string }> };
  };
  return (
    data.links?.self?.[0]?.href ??
    `${remote.webUrl}/projects/${remote.projectKey}/repos/${remote.repoSlug}/pull-requests/${data.id ?? ''}`
  );
}

export async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await execFileAsync('open', [url]);
    } else if (platform === 'win32') {
      await execFileAsync('cmd', ['/c', 'start', '', url]);
    } else {
      await execFileAsync('xdg-open', [url]);
    }
  } catch {
    throw new GitBotError(`Could not open browser. Visit the URL manually: ${url}`);
  }
}
