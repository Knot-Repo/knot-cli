import * as fs from "node:fs";
import * as path from "node:path";
import { scrubString } from "./scrubber.js";

export const KNOT_GIT_HOOK_START = "# >>> KNOT-LIFECYCLE-HOOK-START >>>";
export const KNOT_GIT_HOOK_END = "# <<< KNOT-LIFECYCLE-HOOK-END <<<";

export interface LifecycleHookInstallResult {
  gitPostCommitInstalled: boolean;
  gitHookPath: string | null;
  claudeStopHookInstalled: boolean;
  claudeSettingsPath: string;
}

export interface ExtractedCommitAtom {
  kind: "decision" | "constraint" | "project_state" | "fact";
  statement: string;
  rationale?: string;
}

export interface ExtractedAgentStopSummary {
  taskSummary: string;
  activitySummary: string;
  decisions: Array<{
    kind: "decision" | "constraint";
    statement: string;
  }>;
}

const TRIVIAL_COMMIT_REGEX =
  /^(wip|typo|fix typo|format|prettier|lint|chore:\s*lint|merge\s+(branch|pull request)|bump\s+version|initial commit)\b/i;

/**
 * Installs deterministic local lifecycle hooks:
 * 1. `.git/hooks/post-commit` -> runs `knot hook post-commit` asynchronously on every Git commit.
 * 2. `.claude/settings.local.json` -> registers `hooks.Stop` so coding agent turns automatically sync state and decisions.
 */
export function installLifecycleHooks(rootDir: string): LifecycleHookInstallResult {
  let gitPostCommitInstalled = false;
  let gitHookPath: string | null = null;

  const gitDir = path.join(rootDir, ".git");
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    const hooksDir = path.join(gitDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    gitHookPath = path.join(hooksDir, "post-commit");

    const hookBlock = [
      KNOT_GIT_HOOK_START,
      "# Deterministic zero-prompt context capture into Knot (3-Zone Epistemic Staging)",
      "if command -v knot >/dev/null 2>&1; then",
      "  knot hook post-commit >/dev/null 2>&1 &",
      "fi",
      KNOT_GIT_HOOK_END,
    ].join("\n");

    let existingHook = "#!/bin/sh\n";
    if (fs.existsSync(gitHookPath)) {
      existingHook = fs.readFileSync(gitHookPath, "utf8");
    }

    const startIdx = existingHook.indexOf(KNOT_GIT_HOOK_START);
    const endIdx = existingHook.indexOf(KNOT_GIT_HOOK_END);
    let updatedHook: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      updatedHook =
        existingHook.slice(0, startIdx) +
        hookBlock +
        existingHook.slice(endIdx + KNOT_GIT_HOOK_END.length);
    } else {
      updatedHook = `${existingHook.trimEnd()}\n\n${hookBlock}\n`;
    }

    fs.writeFileSync(gitHookPath, updatedHook, { encoding: "utf8", mode: 0o755 });
    try {
      fs.chmodSync(gitHookPath, 0o755);
    } catch {
      // Ignore chmod errors on non-POSIX filesystems
    }
    gitPostCommitInstalled = true;
  }

  // Install Claude Code / Agent Stop hook in .claude/settings.local.json
  const claudeDir = path.join(rootDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeSettingsPath = path.join(claudeDir, "settings.local.json");

  let settings: Record<string, any> = {};
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const stopCmd = "knot hook agent-stop >/dev/null 2>&1 || true";
  const existingStop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  const alreadyHasKnotStop = existingStop.some((entry: any) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("knot hook agent-stop"))
  );

  if (!alreadyHasKnotStop) {
    existingStop.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: stopCmd,
        },
      ],
    });
    settings.hooks.Stop = existingStop;
  }

  fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  // Ensure .gitignore protects .claude/settings.local.json
  const gitignorePath = path.join(rootDir, ".gitignore");
  const gitignoreExisting = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (!gitignoreExisting.includes(".claude/settings.local.json")) {
    const prefix = gitignoreExisting.length > 0 && !gitignoreExisting.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(
      gitignorePath,
      `${gitignoreExisting}${prefix}.claude/settings.local.json\n`,
      "utf8"
    );
  }

  return {
    gitPostCommitInstalled,
    gitHookPath,
    claudeStopHookInstalled: true,
    claudeSettingsPath,
  };
}

/**
 * Deterministically extracts a structured context atom from a Git commit message and changed file list.
 * Returns null for trivial/noisy commits (`wip`, `typo`, `merge`, `lint`) so Knot stays high-signal.
 */
export function extractCommitContextAtom(
  rawCommitMessage: string,
  changedFiles: string[] = []
): ExtractedCommitAtom | null {
  const scrubbedMsg = scrubString(rawCommitMessage || "").trim();
  if (!scrubbedMsg) return null;

  const lines = scrubbedMsg
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"));
  if (lines.length === 0) return null;

  const subjectLine = lines[0]!;
  if (subjectLine.length < 12 || TRIVIAL_COMMIT_REGEX.test(subjectLine)) {
    return null;
  }

  const bodyLines = lines.slice(1).filter(Boolean);
  const bodyText = bodyLines.join(" ").trim();
  const combinedLower = `${subjectLine} ${bodyText}`.toLowerCase();

  let kind: ExtractedCommitAtom["kind"] = "project_state";
  if (
    /\b(must\s+not|never\s+|do\s+not|forbid|enforce|require|mandatory|invariant|constraint|security\s+rule)\b/i.test(
      combinedLower
    )
  ) {
    kind = "constraint";
  } else if (
    /\b(migrate|migrated|replace|replaced|switch|switched|instead\s+of|over\s+|adopt|standardize|architecture|decided|decision|use\s+|uses\s+|refactor)\b/i.test(
      combinedLower
    )
  ) {
    kind = "decision";
  }

  // Strip conventional-commit prefix (e.g., "feat(db): ", "arch: ") for cleaner canonical propositions
  const cleanStatement = subjectLine.replace(
    /^(feat|fix|arch|refactor|perf|security|chore|docs)(\([^)]+\))?!?:\s*/i,
    ""
  );
  const normalizedStatement =
    cleanStatement.charAt(0).toUpperCase() +
    cleanStatement.slice(1) +
    (/[.!?]$/.test(cleanStatement) ? "" : ".");

  const fileSuffix =
    changedFiles.length > 0
      ? `Changed files: ${changedFiles.slice(0, 6).join(", ")}${changedFiles.length > 6 ? ` (+${changedFiles.length - 6} more)` : ""}.`
      : "";
  const rationaleParts = [bodyText, fileSuffix].filter(Boolean);

  return {
    kind,
    statement: normalizedStatement,
    ...(rationaleParts.length > 0 ? { rationale: rationaleParts.join(" ").slice(0, 1500) } : {}),
  };
}

/**
 * Extracts completed work state and ratified decisions from an Agent Stop lifecycle payload
 * (supports JSON hook payloads from Claude Code / Cursor / Antigravity or plain text summaries).
 */
export function extractAgentStopSummary(
  rawInput: string,
  projectLabel: string
): ExtractedAgentStopSummary | null {
  const trimmed = (rawInput || "").trim();
  if (!trimmed) return null;

  let summaryText = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.last_assistant_message === "string" && parsed.last_assistant_message.trim()) {
      summaryText = parsed.last_assistant_message.trim();
    } else if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      summaryText = parsed.summary.trim();
    } else if (typeof parsed.message === "string" && parsed.message.trim()) {
      summaryText = parsed.message.trim();
    }
  } catch {
    // Plain text input
  }

  const scrubbed = scrubString(summaryText).trim();
  if (scrubbed.length < 12) return null;

  const lines = scrubbed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const firstLine = (lines[0] || `Completed agent turn on ${projectLabel}`)
    .replace(/^[-*#>\s]+/, "")
    .slice(0, 240);

  const decisions: Array<{ kind: "decision" | "constraint"; statement: string }> = [];
  for (const line of lines) {
    const bulletMatch = line.match(/^[-*•]\s+(.{15,300})$/);
    const candidate = bulletMatch ? bulletMatch[1]!.trim() : line;
    if (candidate.length < 15 || candidate.length > 300) continue;

    if (/\b(must\s+not|never\s+|enforce|require|constraint|invariant)\b/i.test(candidate)) {
      decisions.push({
        kind: "constraint",
        statement: candidate + (/[.!?]$/.test(candidate) ? "" : "."),
      });
    } else if (
      /\b(migrated|replaced|switched|instead\s+of|uses\s+|decided\s+to|adopted|standardized\s+on)\b/i.test(
        candidate
      )
    ) {
      decisions.push({
        kind: "decision",
        statement: candidate + (/[.!?]$/.test(candidate) ? "" : "."),
      });
    }
    if (decisions.length >= 5) break;
  }

  return {
    taskSummary: firstLine,
    activitySummary: scrubbed.slice(0, 1200),
    decisions,
  };
}
