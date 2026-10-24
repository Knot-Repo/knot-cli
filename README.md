# @knot/cli

Local Context Seeder, Environment Bridge & Turn-0 Invariant Synchronizer for **Knot**.

The Knot CLI connects your local developer environment (Cursor, Windsurf, Claude Code, Antigravity) to Knot's cross-tool continuity bus. It eliminates cold starts and manual prompt copy-pasting by synchronizing ratified project decisions, tech stack invariants, and lifecycle handoffs directly into your editor's prompt window.

---

## Installation

Install globally via npm:
```bash
npm install -g @knot/cli
```

Or run directly with `npx`:
```bash
npx @knot/cli --help
```

Or install directly from GitHub (releases / repository):
```bash
# Direct from GitHub repository
npm install -g github:Knot-Repo/knot-cli

# Direct from GitHub Release tarball
npm install -g https://github.com/Knot-Repo/knot-cli/releases/download/v0.1.0/knot-cli-0.1.0.tgz
```

---

## Quickstart

### 1. Log in with Knot
Authenticate with your Knot account via browser OAuth 2.0 PKCE. Credentials are encrypted and stored locally in `~/.knot/credentials.json`:
```bash
knot login
```

### 2. Initialize in Your Project
Run `knot init` in your project root to automatically configure your editor's MCP settings (`.cursor/mcp.json`), protect secrets in `.gitignore`, and install non-blocking git lifecycle hooks:
```bash
knot init
```

### 3. Verify Health
Run `knot doctor` to ensure your local environment, git hooks, and MCP connections are correctly wired:
```bash
knot doctor
```

---

## Commands

### `knot login`
Authenticates via browser-based OAuth 2.0 PKCE with Knot and saves credentials locally.
```bash
knot login [--domain <domain>] [--port <port>] [--no-browser]
```

### `knot whoami`
Displays your current Knot authentication status and checks connectivity to the Knot MCP gateway.
```bash
knot whoami
```

### `knot init`
Initializes Knot in the current directory:
- Discovers and configures editor MCP settings (`.cursor/mcp.json`).
- Automatically adds sensitive files and credentials to `.gitignore`.
- Installs local git post-commit and agent-stop lifecycle hooks.
- Scans initial project context.
```bash
knot init [--endpoint <url>] [--token <token>]
```

### `knot seed`
Scans local repository facts, architecture rules, and configs. Extracts scrubbed context atoms with zero high-entropy secret leakage:
```bash
# Dry run to inspect extracted atoms locally
knot seed --dry-run

# Push scrubbed context atoms to Knot cloud
knot seed --push
```

### `knot sync`
Syncs active Knot project invariants directly into `.cursorrules` or `.windsurfrules`. Preserves user-defined custom rules and idempotently updates Knot-managed blocks:
```bash
knot sync [--rules-file .cursorrules] [--branch main]
```

### `knot watch`
Starts a lightweight local background daemon to poll for incoming agent handoffs and project invariant updates:
```bash
knot watch [--rules-file .cursorrules] [--poll-interval 15000]
```

### `knot doctor`
Performs an automated environment audit verifying:
- Node.js runtime compatibility.
- Git repository detection.
- Knot authentication status.
- Editor MCP configuration.
- `.gitignore` credential protection.
- Deterministic lifecycle hook installation.
```bash
knot doctor
```

### `knot hook`
Deterministic zero-prompt lifecycle hooks invoked by git or agent events:
```bash
# Git post-commit: extracts architectural decisions from commit messages
knot hook post-commit

# Agent stop: captures completed turns and ratified invariants
knot hook agent-stop
```

### `knot logout`
Clears stored credentials from `~/.knot/credentials.json`:
```bash
knot logout
```

---

## Architecture & Privacy Guarantees

1. **Zero Secret Leakage**: The integrated secret scrubber strips high-entropy keys (`sk_live_*`, AWS access keys, GitHub tokens, JWTs, passwords) before any atom leaves your machine.
2. **Credential Isolation**: Local MCP tokens are saved only to `~/.knot/credentials.json` or `.gitignore`-protected local files.
3. **Turn-0 Injection**: Invariants are injected directly into editor rule files so AI models adhere to project constraints from prompt 0 without manual invocation.

---

## License

MIT © [Knot Team](https://connectknot.com)
