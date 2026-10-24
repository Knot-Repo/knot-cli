import { Command } from "commander";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspectRepository } from "./lib/repo-scanner.js";
import { injectRules } from "./lib/rule-injector.js";
import { configureEditorMcp } from "./lib/editor-config.js";
import {
  extractAgentStopSummary,
  extractCommitContextAtom,
  installLifecycleHooks,
} from "./lib/lifecycle-hooks.js";
import {
  clearCredentials,
  loadCredentials,
  loginWithOAuth,
} from "./lib/auth.js";

export function resolveToken(explicitToken?: string, rootDir?: string): string | undefined {
  if (explicitToken) return explicitToken;
  if (process.env.KNOT_BEARER_TOKEN) return process.env.KNOT_BEARER_TOKEN;
  const stored = loadCredentials();
  if (stored?.access_token) return stored.access_token;
  if (rootDir) {
    try {
      const cursorCfgPath = path.join(rootDir, ".cursor", "mcp.json");
      if (fs.existsSync(cursorCfgPath)) {
        const parsed = JSON.parse(fs.readFileSync(cursorCfgPath, "utf8"));
        const authHeader = parsed?.mcpServers?.knot?.headers?.Authorization;
        if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
          return authHeader.slice("Bearer ".length).trim();
        }
      }
    } catch {
      // Ignore config read errors
    }
  }
  return undefined;
}

async function fetchRemoteInvariants(endpoint: string, token: string, query: string): Promise<string[]> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "get_relevant_context",
          arguments: { query, max_items: 8 },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    const textBlock = payload.result?.content?.find((c) => c.type === "text")?.text;
    if (!textBlock) return [];
    const parsed = JSON.parse(textBlock) as {
      items?: Array<{ kind?: string; statement?: string }>;
    };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .filter((item) => typeof item.statement === "string" && item.statement.trim().length > 0)
      .map((item) => `[${(item.kind || "fact").toUpperCase()}] ${item.statement!.trim()}`);
  } catch {
    return [];
  }
}

export function runDoctorChecks(rootDir: string) {
  const gitExists = fs.existsSync(path.join(rootDir, ".git"));
  const cursorConfigPath = path.join(rootDir, ".cursor", "mcp.json");
  const cursorConfigured = fs.existsSync(cursorConfigPath);
  const gitignorePath = path.join(rootDir, ".gitignore");
  const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const gitignoreProtected = gitignoreContent.includes(".cursor/mcp.json") || gitignoreContent.includes(".knot");
  const discoveredAtomsCount = inspectRepository(rootDir).length;
  const postCommitHookPath = path.join(rootDir, ".git", "hooks", "post-commit");
  const postCommitHookInstalled =
    fs.existsSync(postCommitHookPath) &&
    fs.readFileSync(postCommitHookPath, "utf8").includes("KNOT-LIFECYCLE-HOOK");
  const storedCreds = loadCredentials();

  return {
    nodeVersion: process.version,
    gitExists,
    cursorConfigured,
    gitignoreProtected,
    discoveredAtomsCount,
    postCommitHookInstalled,
    isAuthenticated: Boolean(storedCreds?.access_token),
    domain: storedCreds?.domain,
  };
}

export function writeOrUpdateEnvFile(filePath: string, entries: Record<string, string>): boolean {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  for (const [key, val] of Object.entries(entries)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}="${val}"`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content = content.trim().length > 0 ? `${content.trim()}\n${line}\n` : `${line}\n`;
    }
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("knot")
    .description("Knot CLI: Local Context Seeder, Environment Bridge & Turn-0 Invariant Synchronizer")
    .version("0.1.1");

  program
    .command("login")
    .description("Log in to Knot via browser OAuth 2.0 PKCE flow and store credentials locally")
    .option("--domain <domain>", "Knot domain", process.env.KNOT_DOMAIN || "production.connectknot.com")
    .option("--port <port>", "Local callback port", "8080")
    .option("--no-browser", "Do not automatically launch web browser")
    .action(async (options) => {
      console.log(`\n🔐 Initiating Knot OAuth 2.0 PKCE authentication...`);
      console.log(`  Connecting to: https://${options.domain}`);
      console.log(`  Listening on:  http://localhost:${options.port}/callback\n`);

      try {
        const result = await loginWithOAuth({
          domain: options.domain,
          port: parseInt(options.port, 10),
          openBrowserUrl: options.browser !== false,
        });
        console.log(`\n✔ Successfully authenticated with Knot!`);
        console.log(`  Domain:   ${result.domain}`);
        console.log(`  Token:    ${result.access_token.slice(0, 10)}...${result.access_token.slice(-6)}`);
        console.log(`  Saved to: ~/.knot/credentials.json`);
        console.log(`\n🎉 Your local editor MCP configuration has been synchronized. Run 'knot doctor' to verify.`);
      } catch (err) {
        console.error(`\n✖ Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("logout")
    .description("Log out of Knot and clear stored local credentials")
    .action(() => {
      const removed = clearCredentials();
      if (removed) {
        console.log("\n✔ Successfully logged out. Cleared ~/.knot/credentials.json");
      } else {
        console.log("\n✔ No stored credentials found.");
      }
    });

  program
    .command("whoami")
    .description("Show current Knot authentication status")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/mcp")
    .action(async (options) => {
      const creds = loadCredentials();
      if (!creds?.access_token) {
        console.log("\n⚠  Not logged in. Run 'knot login' to authenticate with Knot.");
        return;
      }

      console.log("\n👤 Knot Authentication Status:");
      console.log(`  Status:    Active`);
      console.log(`  Domain:    ${creds.domain || "production.connectknot.com"}`);
      console.log(`  Token:     ${creds.access_token.slice(0, 10)}...${creds.access_token.slice(-6)}`);
      console.log(`  Saved At:  ${creds.created_at || "Local session"}`);

      try {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.access_token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_knot_connection_status",
              arguments: {},
            },
          }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          console.log(`  Cloud MCP: Connected and responsive (HTTP ${res.status})`);
        } else {
          console.log(`  Cloud MCP: Server reachable (HTTP ${res.status})`);
        }
      } catch {
        console.log(`  Cloud MCP: Offline or unreachable`);
      }
      console.log("");
    });

  program
    .command("init")
    .description("Initialize Knot in the current directory, configure local editor MCP settings, and install deterministic lifecycle hooks")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .action((options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      console.log(`\n🚀 Initializing Knot in ${rootDir}...`);

      const configs = configureEditorMcp(rootDir, options.endpoint, token);
      for (const cfg of configs) {
        console.log(`  ✔ Configured ${cfg.editor} MCP (${cfg.configPath})`);
        if (cfg.gitignoreProtected) {
          console.log(`  🛡 Verified .gitignore protection for ${cfg.editor} config`);
        }
      }

      const hooks = installLifecycleHooks(rootDir);
      if (hooks.gitPostCommitInstalled) {
        console.log(`  🪝 Installed Git post-commit lifecycle hook (${hooks.gitHookPath})`);
      }
      if (hooks.claudeStopHookInstalled) {
        console.log(`  🪝 Installed Agent Stop lifecycle hook (${hooks.claudeSettingsPath})`);
      }

      console.log("\n📦 Running initial repository inspection...");
      const atoms = inspectRepository(rootDir);
      console.log(`  ✔ Discovered ${atoms.length} repository context atoms.`);
      console.log("\n✅ Knot initialization complete. Ready for zero-prompt continuity!");
    });

  program
    .command("seed")
    .description("Scan local repository facts/rules and optionally push scrubbed context atoms to Knot")
    .option("--dry-run", "Output extracted atoms without transmitting")
    .option("--push", "Transmit discovered atoms to the configured Knot MCP endpoint")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      console.log(`\n🔍 Inspecting repository context for ${rootDir}...`);
      const atoms = inspectRepository(rootDir);

      console.log(`Discovered ${atoms.length} scrubbed context atoms:`);
      for (const atom of atoms) {
        console.log(`\n[${atom.kind.toUpperCase()}] (${atom.entity_hint}):\n${atom.statement}`);
      }

      if (options.dryRun || !options.push) {
        console.log("\n✨ Local scan complete. Pass --push to hydrate your cloud Knot.");
        return;
      }

      if (!token) {
        console.error("\n⚠️  Missing bearer token. Run 'knot login' or provide --token <token>.");
        process.exitCode = 1;
        return;
      }

      console.log(`\n🚀 Pushing ${atoms.length} seed atoms to ${options.endpoint}...`);
      try {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "sync_context_snapshot",
              arguments: {
                entity_hint: path.basename(rootDir),
                items: atoms.slice(0, 20).map((a) => ({
                  kind: a.kind,
                  statement: a.statement,
                  confidence: "high",
                })),
              },
            },
          }),
        });
        if (!res.ok) {
          console.error(`  ✖ Server returned HTTP ${res.status}`);
          process.exitCode = 1;
          return;
        }
        console.log(`  ✔ Successfully seeded ${Math.min(atoms.length, 20)} context atoms into Knot!`);
      } catch (err) {
        console.error(`  ✖ Failed to reach Knot endpoint: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("sync")
    .description("Sync active project invariants into .cursorrules / .windsurfrules")
    .option("--rules-file <file>", "Target rules file", ".cursorrules")
    .option("--branch <branch>", "Branch identifier", "main")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      const targetPath = path.resolve(rootDir, options.rulesFile);
      const remoteInvariants = token
        ? await fetchRemoteInvariants(options.endpoint, token, path.basename(rootDir))
        : [];
      const repoAtoms = inspectRepository(rootDir)
        .filter((a) => a.kind === "constraint" || a.kind === "decision" || a.kind === "project_state")
        .slice(0, 8)
        .map((a) => `[${a.kind.toUpperCase()}] ${a.statement.split("\n")[0]}`);

      const combined = Array.from(new Set([...remoteInvariants, ...repoAtoms])).slice(0, 12);
      const invariants =
        combined.length > 0
          ? combined
          : [
              "Architecture: Modular monolith with clean domain boundaries",
              "Authority: Principal authenticates; Client identifies; Knot authorizes",
              "Tokens: Payloads capped at 1,500 tokens; ambient reads capped at 350 tokens",
            ];

      console.log(`\n🔄 Syncing turn-0 invariants into ${options.rulesFile}...`);
      const result = injectRules({
        filePath: targetPath,
        invariants,
        branchName: options.branch,
        preserveLocalEdits: true,
      });

      if (result.mutations.length > 0) {
        console.log(`  ⚡ Detected ${result.mutations.length} local rule edit(s) in ${options.rulesFile}:`);
        for (const m of result.mutations) {
          if (m.type === "supersede") {
            console.log(`    ↳ Superseded ${m.supersedesId} (v${m.previousVersion} → v${m.nextVersion}): ${m.newStatement}`);
          } else {
            console.log(`    ↳ Created new rule (v1): ${m.newStatement}`);
          }
        }
        if (token) {
          try {
            await fetch(options.endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                  name: "sync_context_snapshot",
                  arguments: {
                    entity_hint: path.basename(rootDir),
                    items: result.mutations.map((m) => ({
                      kind: "decision",
                      statement: m.newStatement,
                      confidence: "high",
                    })),
                  },
                },
              }),
              signal: AbortSignal.timeout(5000),
            });
            console.log(`  ✔ Pushed ${result.mutations.length} local supersession(s) back to Knot cloud.`);
          } catch {
            // Non-blocking if offline
          }
        }
      }

      if (result.updated) {
        console.log(`  ✔ Successfully updated ${options.rulesFile} with ${invariants.length} active Knot invariants.`);
      }
    });

  program
    .command("doctor")
    .description("Verify local Knot connectivity, editor configurations, and git environment health")
    .action(async () => {
      const rootDir = process.cwd();
      console.log(`\n🩺 Running Knot Environment Doctor for ${rootDir}...\n`);
      const status = runDoctorChecks(rootDir);

      console.log(`  ✔ Node.js runtime: ${status.nodeVersion}`);
      console.log(`  ${status.gitExists ? "✔" : "⚠"} Git repository: ${status.gitExists ? "Detected (.git)" : "Not found in current directory"}`);
      console.log(`  ${status.isAuthenticated ? "✔" : "⚠"} Knot Auth: ${status.isAuthenticated ? `Authenticated (${status.domain || "active"})` : "Not logged in (run 'knot login')"}`);
      console.log(`  ${status.cursorConfigured ? "✔" : "⚠"} Cursor MCP Config: ${status.cursorConfigured ? "Configured (.cursor/mcp.json)" : "Missing (run knot init)"}`);
      console.log(`  ${status.gitignoreProtected ? "✔" : "⚠"} .gitignore Credential Guard: ${status.gitignoreProtected ? "Active" : "Not configured (run knot init)"}`);
      console.log(`  ${status.postCommitHookInstalled ? "✔" : "⚠"} Git post-commit Hook: ${status.postCommitHookInstalled ? "Installed (.git/hooks/post-commit)" : "Not installed (run knot init)"}`);
      console.log(`  ✔ Local Seedable Atoms: ${status.discoveredAtomsCount} discovered`);

      console.log("\n✨ Knot Doctor: Environment diagnostic complete.\n");
    });

  const hookCommand = program
    .command("hook")
    .description("Deterministic local lifecycle hooks for zero-prompt context capture");

  hookCommand
    .command("post-commit")
    .description("Extract ratified architectural decisions from the latest Git commit and push via 3-Zone Epistemic Staging")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .option("--message <msg>", "Optional explicit commit message override for testing")
    .action(async (options) => {
      const rootDir = process.cwd();
      let commitMessage = typeof options.message === "string" ? options.message : "";
      let changedFiles: string[] = [];
      let commitSha = `local-${Date.now()}`;

      if (!commitMessage) {
        try {
          commitMessage = execSync("git log -1 --pretty=%B", { cwd: rootDir, encoding: "utf8" }).trim();
          commitSha = execSync("git rev-parse --short HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
          const diffNames = execSync("git diff-tree --no-commit-id --name-only -r HEAD", {
            cwd: rootDir,
            encoding: "utf8",
          }).trim();
          changedFiles = diffNames ? diffNames.split(/\r?\n/).filter(Boolean) : [];
        } catch {
          return;
        }
      }

      const atom = extractCommitContextAtom(commitMessage, changedFiles);
      if (!atom) return;

      const token = resolveToken(options.token, rootDir);
      if (!token) return;

      try {
        await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "propose_context",
              arguments: {
                entity_hint: path.basename(rootDir),
                kind: atom.kind,
                statement: atom.statement,
                ...(atom.rationale ? { rationale: atom.rationale } : {}),
                reconcile_mode: "epistemic_staging",
                confidence: "high",
                interaction_ref: `git:commit:${commitSha}`,
                idempotency_key: `git-post-commit:${commitSha}`,
              },
            },
          }),
          signal: AbortSignal.timeout(4000),
        });
      } catch {
        // Non-blocking background hook
      }
    });

  hookCommand
    .command("agent-stop")
    .description("Capture completed agent turn activity and ratified decisions on IDE/CLI Agent Stop event")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .option("--input <payload>", "Optional stop payload string (reads from stdin if omitted)")
    .action(async (options) => {
      const rootDir = process.cwd();
      const projectLabel = path.basename(rootDir);
      let rawInput = typeof options.input === "string" ? options.input : "";

      if (!rawInput && !process.stdin.isTTY) {
        try {
          rawInput = fs.readFileSync(0, "utf8");
        } catch {
          rawInput = "";
        }
      }

      const extracted = extractAgentStopSummary(rawInput, projectLabel);
      if (!extracted) return;

      const token = resolveToken(options.token, rootDir);
      if (!token) return;

      try {
        await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "report_active_state",
              arguments: {
                project_label: projectLabel,
                thread_key: "agent-turn",
                status: "completed",
                end_reason: "completed",
                task_summary: extracted.taskSummary,
                activity_summary: extracted.activitySummary,
                observed_at: new Date().toISOString(),
              },
            },
          }),
          signal: AbortSignal.timeout(4000),
        });

        for (let i = 0; i < extracted.decisions.length; i++) {
          const dec = extracted.decisions[i]!;
          await fetch(options.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now() + i + 1,
              method: "tools/call",
              params: {
                name: "propose_context",
                arguments: {
                  entity_hint: projectLabel,
                  kind: dec.kind,
                  statement: dec.statement,
                  reconcile_mode: "epistemic_staging",
                  confidence: "high",
                  idempotency_key: `agent-stop:${Date.now()}:${i}`,
                },
              },
            }),
            signal: AbortSignal.timeout(4000),
          });
        }
      } catch {
        // Non-blocking background hook
      }
    });

  const appCmd = program
    .command("app")
    .description("Manage developer applications, OAuth clients and API keys for Knot SDK integration");

  appCmd
    .command("create")
    .description("Provision a new developer app and issue API credentials")
    .requiredOption("--name <name>", "Application name (e.g. 'Support AI Assistant')")
    .option("--redirect <url>", "OAuth callback redirect URI", "http://localhost:3000/api/auth/callback/knot")
    .option("--env <environment>", "Target environment ('development' or 'sandbox')", "development")
    .option("--write-env [file]", "Write credentials directly into environment file", ".env.local")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Explicit Bearer token (overrides stored credentials)")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      if (!token) {
        console.error("\n✖ Not authenticated. Run 'knot login' first or pass --token <token>");
        process.exitCode = 1;
        return;
      }
      try {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "knot_provision_developer_app",
              arguments: {
                name: options.name,
                redirect_uris: [options.redirect],
                environment: options.env,
              },
            },
          }),
        });
        const data = (await res.json()) as any;
        if (data.error) {
          throw new Error(data.error.message || "Failed to provision app");
        }
        const app = data.result?.structuredContent;
        if (!app || app.status !== "provisioned") {
          throw new Error("Invalid response from Knot MCP");
        }

        console.log(`\n✔ Developer application "${app.name}" provisioned successfully!`);
        console.log(`  Product ID:   ${app.product_id}`);
        console.log(`  Client ID:    ${app.client_id}`);
        console.log(`  Environment:  ${app.environment}`);
        console.log(`  Redirect URI: ${app.redirect_uris[0]}`);
        console.log(`  Secret:       ${app.secret}`);

        if (options.writeEnv) {
          const envFile = typeof options.writeEnv === "string" ? options.writeEnv : ".env.local";
          const envPath = path.resolve(rootDir, envFile);
          writeOrUpdateEnvFile(envPath, {
            NEXT_PUBLIC_KNOT_CLIENT_ID: app.client_id,
            KNOT_SECRET: app.secret,
            NEXT_PUBLIC_KNOT_REDIRECT_URI: app.redirect_uris[0],
          });
          console.log(`\n📄 Written to ${envFile}:`);
          console.log(`  NEXT_PUBLIC_KNOT_CLIENT_ID="${app.client_id}"`);
          console.log(`  KNOT_SECRET="${app.secret.slice(0, 16)}..."`);
          console.log(`  NEXT_PUBLIC_KNOT_REDIRECT_URI="${app.redirect_uris[0]}"`);
        }
        console.log("\n🚀 One-shot integration ready! You can now import <ContinueWithKnot /> in your app.");
      } catch (err: any) {
        console.error(`\n✖ Provisioning failed: ${err.message || String(err)}`);
        process.exitCode = 1;
      }
    });

  appCmd
    .command("list")
    .description("List registered developer applications and active API key prefixes")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Explicit Bearer token")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      if (!token) {
        console.error("\n✖ Not authenticated. Run 'knot login' first or pass --token <token>");
        process.exitCode = 1;
        return;
      }
      try {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "knot_list_developer_apps",
              arguments: {},
            },
          }),
        });
        const data = (await res.json()) as any;
        if (data.error) {
          throw new Error(data.error.message || "Failed to list apps");
        }
        const result = data.result?.structuredContent;
        const apps = result?.apps || [];
        console.log(`\n📦 Registered Developer Applications (${apps.length}):`);
        if (apps.length === 0) {
          console.log("  No applications found. Run 'knot app create --name <name>' to create one.");
          return;
        }
        for (const app of apps) {
          console.log(`\n  • ${app.name} (${app.environment})`);
          console.log(`    Product ID:   ${app.id}`);
          console.log(`    Client ID:    ${app.client_id}`);
          console.log(`    Callbacks:    ${app.redirect_uris.join(", ")}`);
          console.log(`    Active Keys:  ${app.active_keys.length > 0 ? app.active_keys.map((k: any) => k.prefix + "...").join(", ") : "None"}`);
        }
      } catch (err: any) {
        console.error(`\n✖ Listing failed: ${err.message || String(err)}`);
        process.exitCode = 1;
      }
    });

  appCmd
    .command("rotate")
    .description("Rotate API key for an application with zero-downtime dual-key support")
    .requiredOption("--product-id <id>", "Application / Product ID")
    .option("--revoke-previous", "Immediately revoke previous active keys instead of keeping grace period", false)
    .option("--write-env [file]", "Update KNOT_SECRET directly in environment file", ".env.local")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Explicit Bearer token")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      if (!token) {
        console.error("\n✖ Not authenticated. Run 'knot login' first or pass --token <token>");
        process.exitCode = 1;
        return;
      }
      try {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "knot_rotate_developer_credential",
              arguments: {
                product_id: options.productId,
                revoke_previous: Boolean(options.revokePrevious),
              },
            },
          }),
        });
        const data = (await res.json()) as any;
        if (data.error) {
          throw new Error(data.error.message || "Failed to rotate credential");
        }
        const rotated = data.result?.structuredContent;
        console.log(`\n✔ API key rotated successfully!`);
        console.log(`  Product ID:            ${rotated.product_id}`);
        console.log(`  Client ID:             ${rotated.client_id}`);
        console.log(`  New Secret:            ${rotated.secret}`);
        console.log(`  Previous Keys Revoked: ${rotated.previous_keys_revoked ? "Yes" : "No (Grace period active)"}`);

        if (options.writeEnv) {
          const envFile = typeof options.writeEnv === "string" ? options.writeEnv : ".env.local";
          const envPath = path.resolve(rootDir, envFile);
          writeOrUpdateEnvFile(envPath, {
            KNOT_SECRET: rotated.secret,
          });
          console.log(`\n📄 Updated KNOT_SECRET in ${envFile}`);
        }
      } catch (err: any) {
        console.error(`\n✖ Key rotation failed: ${err.message || String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("watch")
    .description("Run local background daemon to pull incoming handoffs and repo invariants into .cursorrules for Turn-0 execution")
    .option("--rules-file <file>", "Target rules file", ".cursorrules")
    .option("--branch <branch>", "Branch identifier", "main")
    .option("--poll-interval <ms>", "Polling interval in milliseconds", "15000")
    .option("--endpoint <url>", "Knot MCP endpoint", process.env.KNOT_API_URL || "https://production.connectknot.com/api/mcp")
    .option("--token <token>", "Knot Bearer Token")
    .option("--once", "Execute a single synchronization pass and exit")
    .action(async (options) => {
      const rootDir = process.cwd();
      const token = resolveToken(options.token, rootDir);
      const targetPath = path.resolve(rootDir, options.rulesFile);
      const intervalMs = Math.max(1000, Number(options.pollInterval) || 15000);
      let lastDigest = "";

      const runSyncTick = async () => {
        const remote = token
          ? await fetchRemoteInvariants(options.endpoint, token, path.basename(rootDir))
          : [];
        const local = inspectRepository(rootDir)
          .filter((a) => a.kind === "constraint" || a.kind === "decision" || a.kind === "project_state")
          .slice(0, 8)
          .map((a) => `[${a.kind.toUpperCase()}] ${a.statement.split("\n")[0]}`);
        const invariants = Array.from(new Set([...remote, ...local])).slice(0, 12);
        const digest = JSON.stringify(invariants);
        if (digest !== lastDigest && invariants.length > 0) {
          injectRules({
            filePath: targetPath,
            invariants,
            branchName: options.branch,
          });
          lastDigest = digest;
          console.log(`  ✔ [${new Date().toISOString()}] Synced ${invariants.length} Turn-0 invariants into ${options.rulesFile}`);
        }
      };

      console.log(`\n👁 Starting Knot Turn-0 Daemon (monitoring ${options.rulesFile})...`);
      await runSyncTick();

      if (options.once) {
        return;
      }

      console.log(`  ✔ Polling every ${intervalMs}ms for cross-agent handoffs & rule updates (Press Ctrl+C to stop)`);
      const timer = setInterval(() => {
        void runSyncTick();
      }, intervalMs);

      const cleanup = () => {
        clearInterval(timer);
        process.exit(0);
      };
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);
    });

  return program;
}

if (process.argv[1] && !process.argv[1].endsWith(".test.ts") && !process.argv[1].endsWith(".test.js")) {
  createProgram().parse();
}
