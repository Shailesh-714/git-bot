# git-bot

An LLM-powered CLI assistant for writing conventional commit messages and branch names.

It reads the changes in your git repository, generates a relevant commit message following
configurable conventions, and can also create a matching branch name when you start new work.

## Features

- **Conventional commits**: enforces allowed commit types like `feat:`, `fix:`, `refactor:`, etc.
- **Branch naming**: generates branch names with allowed prefixes like `feature/`, `bugfix/`, etc.
- **Staged-first diff reading**: prefers staged changes and falls back to unstaged changes.
- **Combined workflow**: create a branch and commit in a single command.
- **LangGraph-powered generation**: structured LLM output with node-level retry policies and soft context restrictions.
- **Configurable rules**: customize commit types, branch prefixes, length limits, and credentials via TOML.

## Installation

Requires **Node.js >= 20**.

### npm (recommended)

Published to the public npm registry.

```bash
npm install -g @shailesh-714/git-bot
```

Run without installing:

```bash
npx @shailesh-714/git-bot commit --dry-run
```

### curl (GitHub Releases)

Install the latest release directly from GitHub:

```bash
curl -fsSL https://github.com/Shailesh-714/git-bot/releases/latest/download/install.sh | bash
```

Install a specific version:

```bash
curl -fsSL https://github.com/Shailesh-714/git-bot/releases/latest/download/install.sh | bash -s -- --version 0.1.1
```

### Manual

If you already have the repo cloned:

```bash
npm install
npm run build
node ./bundle/git-bot.cjs --help
```

## Configuration

Create `~/.config/git-bot/config.toml` (or pass `--config`):

```toml
[llm]
provider = "openai"
model = "gpt-4o-mini"
apiKey = "sk-..."            # or set OPENAI_API_KEY
baseUrl = ""                 # optional OpenAI-compatible endpoint
temperature = 0.2

[conventions.commit]
enabledTypes = [
    "feat", "fix", "refactor", "docs", "test", "chore", "style", "perf"
]
format = "{type}: {summary}"
maxLength = 72

[conventions.branch]
enabledPrefixes = [
    "feature", "bugfix", "hotfix", "release"
]
separator = "/"
maxLength = 60
```

Generate an example config:

```bash
git-bot config --init
```

## Usage

```bash
# Generate a commit message from staged changes (falls back to unstaged)
git-bot commit

# Stage all changes and commit in one step
git-bot commit --all

# Show the generated message without committing
git-bot commit --dry-run

# Skip confirmation prompts
git-bot commit --yes

# Generate a commit message and create a branch in one go
git-bot commit --branch

# Same with an issue identifier
git-bot commit --branch --issue JIRA-123

# Generate and create only a branch
git-bot branch

# Dry-run branch name only
git-bot branch --dry-run
```

## Environment Variables

- `OPENAI_API_KEY` — used when `apiKey` is not set in config.
- `GIT_BOT_CONFIG` — default config file path.

## Development

```bash
npm install
npm run dev -- commit --dry-run
npm test
npm run build
```

## Releasing

This project uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) via OIDC — no long-lived tokens required.

### One-time setup

1. Go to your package settings on [npmjs.com](https://www.npmjs.com).
2. Find **Trusted Publisher** and select **GitHub Actions**.
3. Fill in:
   - **Organization/user:** `Shailesh-714`
   - **Repository:** `git-bot`
   - **Workflow filename:** `release.yml`
   - **Allowed actions:** `npm publish`

### Publishing

1. Bump the version in `package.json`.
2. Push the change to `main`.
3. Go to **Actions → Release → Run workflow**.

The workflow will tag the release, build and test the package, publish it to the public npm registry with provenance, and create a GitHub Release.

## License

MIT
