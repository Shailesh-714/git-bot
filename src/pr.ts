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
  const isBitbucket =
    provider === 'bitbucket-server' ||
    (provider === 'auto' && (Boolean(scmMatch) || port === BITBUCKET_SSH_PORT));

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
    return {
      provider: 'bitbucket-server',
      webUrl: `${webScheme}://${host}${contextPath}`,
      projectKey,
      repoSlug,
    };
  }

  return { provider: 'github', webUrl: `${scheme}://${host}/${pathname}` };
}

export function prCreationUrl(remote: RemoteInfo, branch: string): string {
  if (remote.provider === 'bitbucket-server') {
    const source = encodeURIComponent(`refs/heads/${branch}`);
    return `${remote.webUrl}/projects/${remote.projectKey}/repos/${remote.repoSlug}/pull-requests?create&sourceBranch=${source}`;
  }
  return `${remote.webUrl}/compare/${encodeURIComponent(branch)}?expand=1`;
}

export function buildPrCreationUrl(
  remoteUrl: string,
  branch: string,
  provider: PrProviderSetting = 'auto',
): string | undefined {
  const remote = parseRemote(remoteUrl, provider);
  return remote ? prCreationUrl(remote, branch) : undefined;
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

  let targetRef = 'refs/heads/main';
  try {
    const res = await fetch(`${apiBase}/default-branch`, { headers });
    if (res.ok) {
      const data = (await res.json()) as { id?: string };
      if (data.id) {
        targetRef = data.id;
      }
    }
  } catch {
    // Keep the fallback target ref; creation below will surface real connectivity errors.
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
