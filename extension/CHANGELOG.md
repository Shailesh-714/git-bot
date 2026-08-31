# Changelog

## 0.3.3

- Fix Bitbucket redirect after push: the PR-creation link printed by the server in the push output is now preferred over token/API-based creation.
- Detect self-hosted `*.bitbucket.*` remotes (including Bitbucket Data Center `ssh.` hosts) as Bitbucket Server, mapping the SSH host to the web UI host.
- When the push output carries no link, construct the Bitbucket PR-creation URL from the remote and redirect there.
- Add a "Git Bot" output channel with pull-request flow diagnostics.

## 0.2.2

- Add "(Auto Approve)" command variants that skip confirmations: commit generated messages immediately and create branches without the review prompt (CLI `-y` equivalent).
- Success notifications now offer a **Push** button that pushes the current branch to origin.
- Add "(Auto Approve + Push)" command variants that also push to origin automatically (CLI `-y --push` equivalent).

## 0.2.1

- Add marketplace icon.

## 0.2.0

Initial release.

- **Generate Commit Message** — ✨ button in the Source Control view generates a conventional commit message from staged changes (falls back to unstaged) and fills the commit input box.
- **Generate and Create Branch** — generates a branch name from your current changes, editable before the branch is created and checked out.
- **Generate Commit Message and Branch** — both in one step.
- **Set OpenAI API Key** — stores the key in VS Code secret storage.
- Reads the same `~/.config/git-bot/config.toml` as the [git-bot CLI](https://github.com/Shailesh-714/git-bot) for commit/branch conventions; `gitBot.model`, `gitBot.baseUrl`, and `gitBot.temperature` settings available in VS Code.
