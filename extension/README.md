# Git Bot for VS Code

LLM-powered conventional commit messages and branch names, generated straight into the Source Control view.

This is the VS Code companion to the [`@shailesh-714/git-bot`](https://www.npmjs.com/package/@shailesh-714/git-bot) CLI. Both share the same generation engine and the same conventions config.

## Features

- **✨ Generate Commit Message** — click the sparkle button in the Source Control view title bar (or run the command) to generate a conventional commit message from your staged changes (falls back to unstaged) and fill the commit input box. Edit it if you like, then commit as usual.
- **Generate and Create Branch** — generates a branch name like `feature/add-login-flow` from your current changes, lets you edit it, then creates and checks out the branch.
- **Generate Commit Message and Branch** — both of the above in one step: creates the branch, then fills the commit input box.
- **Set OpenAI API Key** — stores your API key in VS Code secret storage (never in plaintext settings).

## Setup

1. Install the extension.
2. Run **Git Bot: Set OpenAI API Key** from the command palette.
3. Stage some changes and hit the ✨ button in the Source Control view.

If you already use the git-bot CLI, the extension reads the same `~/.config/git-bot/config.toml` — your commit types, branch prefixes, and other conventions apply automatically. An API key from the config file or `OPENAI_API_KEY` also works; secret storage takes precedence.

## Settings

| Setting | Description |
| --- | --- |
| `gitBot.model` | Model to use (default: config file value or `gpt-4o-mini`) |
| `gitBot.baseUrl` | Optional OpenAI-compatible endpoint |
| `gitBot.temperature` | Sampling temperature, 0–2 (−1 = use config file value) |

Commit and branch conventions (allowed types/prefixes, format, length limits) are configured via `~/.config/git-bot/config.toml` — see the [git-bot README](https://github.com/Shailesh-714/git-bot#configuration).

## Development

From the repository root:

```bash
npm install
cd extension
npm install
npm run build       # bundle to dist/extension.js
npm run typecheck
```

Then open the repository in VS Code and press **F5** (launch config "Run Extension") to start an Extension Development Host.

Package for the marketplace:

```bash
npm run package     # produces git-bot-<version>.vsix
```

## License

MIT
