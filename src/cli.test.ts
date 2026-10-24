import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scrubString, scrubObject } from "./lib/scrubber.js";
import { injectRules, KNOT_DELIMITER_START, KNOT_DELIMITER_END } from "./lib/rule-injector.js";
import { configureEditorMcp } from "./lib/editor-config.js";
import { inspectRepository } from "./lib/repo-scanner.js";
import { runDoctorChecks } from "./index.js";

test("Knot CLI Unit & Security Test Suite", async (t) => {
  await t.test("Scrubber: redacts sensitive keys and API tokens", () => {
    const raw = {
      name: "test-app",
      apiKey: "sk_live_123456789012345678901234",
      jwt: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
      config: {
        password: "supersecretpassword",
        publicFlag: true,
      }
    };
    const scrubbed = scrubObject(raw);
    assert.equal(scrubbed.apiKey, "[REDACTED_SECRET]");
    assert.equal(scrubbed.config.password, "[REDACTED_SECRET]");
    assert.equal(scrubbed.config.publicFlag, true);
    assert.equal(scrubbed.name, "test-app");
  });

  await t.test("Rule Injector: idempotent insertion and preservation of custom rules", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-test-"));
    const rulesFile = path.join(tempDir, ".cursorrules");
    
    // Existing user custom rules
    const customUserContent = "### My Custom Team Rules\n- Never use any in TypeScript\n- Write unit tests";
    fs.writeFileSync(rulesFile, customUserContent, "utf-8");

    const invariants = ["Arch: Modular Monolith", "Auth: Principal authenticates"];

    // 1. Initial injection
    const res1 = injectRules({
      filePath: rulesFile,
      invariants,
      branchName: "feature/test",
      commitHash: "abcdef123456",
    });

    assert.equal(res1.updated, true);
    assert.ok(res1.content.includes(KNOT_DELIMITER_START));
    assert.ok(res1.content.includes(KNOT_DELIMITER_END));
    assert.ok(res1.content.includes("Never use any in TypeScript"), "Custom user rules must be preserved");

    // 2. Second injection (idempotent replacement)
    const newInvariants = ["Arch: Modular Monolith Updated"];
    const res2 = injectRules({
      filePath: rulesFile,
      invariants: newInvariants,
      branchName: "feature/test",
      commitHash: "abcdef123456",
    });

    assert.ok(res2.content.includes("Arch: Modular Monolith Updated"));
    assert.ok(!res2.content.includes("- Arch: Modular Monolith <!--"), "Old invariant must be replaced");
    assert.ok(res2.content.includes("Never use any in TypeScript"), "Custom user rules must still be preserved");

    // 3. Two-Way Reverse Compilation: simulate developer editing an anchored bullet in-place
    const editedFileContent = res2.content.replace(
      "Arch: Modular Monolith Updated",
      "Arch: Event-Driven Microkernel with Postgres UNLOGGED tables",
    );
    fs.writeFileSync(rulesFile, editedFileContent, "utf-8");

    const res3 = injectRules({
      filePath: rulesFile,
      invariants: newInvariants,
      branchName: "feature/test",
      commitHash: "abcdef123456",
      preserveLocalEdits: true,
    });

    assert.equal(res3.mutations.length, 1, "Must detect 1 in-place developer edit");
    assert.equal(res3.mutations[0]?.type, "supersede");
    assert.equal(res3.mutations[0]?.previousVersion, 1);
    assert.equal(res3.mutations[0]?.nextVersion, 2);
    assert.equal(
      res3.mutations[0]?.newStatement,
      "Arch: Event-Driven Microkernel with Postgres UNLOGGED tables",
    );
    assert.ok(res3.content.includes('v="2"'), "Updated bullet must advance anchor version to v=\"2\"");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Editor Config & Gitignore Guard: auto-configures and protects credentials", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-test-"));
    
    const results = configureEditorMcp(tempDir, "https://example.com/api/mcp", "test-secret-token");
    assert.equal(results.length, 1);
    assert.equal(results[0].editor, "cursor");
    assert.equal(results[0].gitignoreProtected, true);

    // Verify file written
    const cursorConfig = JSON.parse(fs.readFileSync(results[0].configPath, "utf-8"));
    assert.equal(cursorConfig.mcpServers.knot.url, "https://example.com/api/mcp");
    assert.equal(cursorConfig.mcpServers.knot.headers.Authorization, "Bearer test-secret-token");

    // Verify .gitignore was created and contains the path
    const gitignoreContent = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf-8");
    assert.ok(gitignoreContent.includes(".cursor/mcp.json"), ".gitignore must contain the sensitive config path");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Repo Scanner (Seed Knots): extracts and classifies CLAUDE.md and .cursorrules bullets while scrubbing secrets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-seed-test-"));
    fs.writeFileSync(
      path.join(tempDir, "CLAUDE.md"),
      [
        "# Engineering Standards",
        "- Never commit plaintext API keys like sk_live_123456789012345678901234 to git",
        "- Decided to migrate primary billing webhooks from Stripe v1 to Paddle",
        "- Prefer concise, high-density TypeScript modules",
        KNOT_DELIMITER_START,
        "- [CONSTRAINT] Old injected invariant that should not be re-ingested",
        KNOT_DELIMITER_END,
      ].join("\n"),
      "utf-8",
    );

    const atoms = inspectRepository(tempDir);
    const claudeAtoms = atoms.filter((a) => a.entity_hint === "CLAUDE.md");
    assert.equal(claudeAtoms.length, 3);
    assert.equal(claudeAtoms[0].kind, "constraint");
    assert.ok(claudeAtoms[0].statement.includes("[REDACTED_SECRET]"));
    assert.equal(claudeAtoms[1].kind, "decision");
    assert.equal(claudeAtoms[2].kind, "preference");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Doctor Checks: verifies real filesystem state for .git, .cursor/mcp.json, and .gitignore", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-doctor-test-"));

    // 1. Before configuration, checks fail cleanly
    const before = runDoctorChecks(tempDir);
    assert.equal(before.gitExists, false);
    assert.equal(before.cursorConfigured, false);
    assert.equal(before.gitignoreProtected, false);

    // 2. Initialize .git and configure MCP + .gitignore
    fs.mkdirSync(path.join(tempDir, ".git"));
    configureEditorMcp(tempDir, "https://connectknot.com/api/mcp", "test-token");
    injectRules({
      filePath: path.join(tempDir, ".cursorrules"),
      invariants: ["[CONSTRAINT] Zero-plaintext storage"],
    });

    const after = runDoctorChecks(tempDir);
    assert.equal(after.gitExists, true);
    assert.equal(after.cursorConfigured, true);
    assert.equal(after.gitignoreProtected, true);
    assert.equal(after.postCommitHookInstalled, false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Pillar 2 Lifecycle Hooks: installs post-commit and agent-stop hooks and extracts scrubbed decisions", async () => {
    const {
      installLifecycleHooks,
      extractCommitContextAtom,
      extractAgentStopSummary,
    } = await import("./lib/lifecycle-hooks.js");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knot-hooks-test-"));
    fs.mkdirSync(path.join(tempDir, ".git"));

    const res = installLifecycleHooks(tempDir);
    assert.equal(res.gitPostCommitInstalled, true);
    assert.ok(res.gitHookPath && fs.existsSync(res.gitHookPath));
    assert.equal(res.claudeStopHookInstalled, true);
    assert.ok(fs.existsSync(res.claudeSettingsPath));

    const doctor = runDoctorChecks(tempDir);
    assert.equal(doctor.postCommitHookInstalled, true);

    // Trivial commit should be ignored
    assert.equal(extractCommitContextAtom("wip", ["src/index.ts"]), null);
    assert.equal(extractCommitContextAtom("fix typo", ["README.md"]), null);

    // Architectural migration commit should extract as decision and scrub secrets
    const migrationAtom = extractCommitContextAtom(
      "feat(billing): Migrate primary billing webhooks from Stripe v1 to Paddle instead of Stripe v1\n\nToken sk_live_123456789012345678901234 rotated.",
      ["src/billing/webhooks.ts", "src/billing/paddle.ts"]
    );
    assert.ok(migrationAtom);
    assert.equal(migrationAtom.kind, "decision");
    assert.equal(
      migrationAtom.statement,
      "Migrate primary billing webhooks from Stripe v1 to Paddle instead of Stripe v1."
    );
    assert.ok(migrationAtom.rationale?.includes("[REDACTED_SECRET]"));
    assert.ok(migrationAtom.rationale?.includes("src/billing/webhooks.ts"));

    // Agent Stop summary extraction
    const stopSummary = extractAgentStopSummary(
      JSON.stringify({
        last_assistant_message: [
          "Completed the billing webhook migration and database TLS audit.",
          "- Primary billing webhooks uses Paddle instead of Stripe v1",
          "- Production database connections must never allow unencrypted plaintext sockets",
        ].join("\n"),
      }),
      "knot-app"
    );
    assert.ok(stopSummary);
    assert.equal(stopSummary.decisions.length, 2);
    assert.equal(stopSummary.decisions[0]?.kind, "decision");
    assert.equal(stopSummary.decisions[1]?.kind, "constraint");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Auth & Credential Storage: PKCE generation and token resolution", async () => {
    const { generatePkce, saveCredentials, loadCredentials, clearCredentials } = await import("./lib/auth.js");
    const { resolveToken } = await import("./index.js");

    const pkce = generatePkce();
    assert.ok(pkce.codeVerifier && pkce.codeVerifier.length >= 43);
    assert.ok(pkce.codeChallenge && pkce.codeChallenge.length >= 43);
    assert.ok(pkce.state && pkce.state.length >= 16);

    const testToken = "knot_test_token_123456789";
    saveCredentials({
      access_token: testToken,
      domain: "staging.connectknot.com",
      created_at: new Date().toISOString(),
    });

    const loaded = loadCredentials();
    assert.equal(loaded?.access_token, testToken);
    assert.equal(loaded?.domain, "staging.connectknot.com");

    const resolved = resolveToken();
    assert.equal(resolved, testToken);

    // Explicit override takes precedence
    assert.equal(resolveToken("explicit_token"), "explicit_token");

    clearCredentials();
    assert.equal(loadCredentials(), null);
  });
});



