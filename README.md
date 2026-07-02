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

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Shailesh-714/git-bot/main/scripts/install.sh | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Shailesh-714/git-bot/main/scripts/install.sh | bash -s -- --version 0.1.0
```

After installing, start a new shell or run `source ~/.bashrc` / `source ~/.zshrc`.

### Windows

Download the latest `git-bot-windows-x64.zip` from the [Releases page](https://github.com/Shailesh-714/git-bot/releases), extract it, and add the `bin` folder to your PATH.

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

1. Bump the version in `package.json`.
2. Push the change to `main`.
3. Go to **Actions → Release → Run workflow**.

The workflow will tag the release, build and test the package, publish it to the GitHub Packages npm registry, and create a GitHub Release.

## License

MIT
