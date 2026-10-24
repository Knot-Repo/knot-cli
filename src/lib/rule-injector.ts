import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const KNOT_DELIMITER_START = "<!-- KNOT_CONTEXT_START";
export const KNOT_DELIMITER_END = "<!-- KNOT_CONTEXT_END -->";

export interface AnchoredInvariant {
  id?: string;
  version?: number;
  text: string;
}

export interface RuleDiffMutation {
  type: "supersede" | "create";
  supersedesId?: string;
  previousVersion?: number;
  nextVersion: number;
  newStatement: string;
}

export interface RuleInjectionOptions {
  filePath: string;
  invariants: Array<string | AnchoredInvariant>;
  branchName?: string;
  commitHash?: string;
  preserveLocalEdits?: boolean;
}

const ANCHOR_REGEX = /\s*<!--\s*knot:id="([^"]+)"\s+v="(\d+)"(?:\s+sha="([a-f0-9]+)")?\s*-->\s*$/;

export function computeRuleSha(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 8);
}

export function deterministicAnchorId(text: string): string {
  return `ctx_${computeRuleSha(text)}`;
}

/**
 * Reverse Compiler: Scans an existing CLAUDE.md or .cursorrules file for in-place developer edits
 * inside the Knot context block and compiles them into v1 -> v2 causal supersession mutations.
 */
export function extractTwoWayRuleDiffs(fileContent: string): RuleDiffMutation[] {
  const startIdx = fileContent.indexOf(KNOT_DELIMITER_START);
  const endIdx = fileContent.indexOf(KNOT_DELIMITER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return [];
  }

  const block = fileContent.slice(startIdx, endIdx);
  const lines = block.split(/\r?\n/);
  const mutations: RuleDiffMutation[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("- ")) continue;

    const bulletBody = trimmed.slice(2).trim();
    const match = ANCHOR_REGEX.exec(bulletBody);
    if (match) {
      const id = match[1]!;
      const version = Number(match[2]!) || 1;
      const recordedSha = match[3];
      const cleanStatement = bulletBody.replace(ANCHOR_REGEX, "").trim();
      if (!cleanStatement) continue;

      const currentSha = computeRuleSha(cleanStatement);
      if (recordedSha && currentSha !== recordedSha) {
        mutations.push({
          type: "supersede",
          supersedesId: id,
          previousVersion: version,
          nextVersion: version + 1,
          newStatement: cleanStatement,
        });
      }
    } else if (bulletBody.length >= 8 && !bulletBody.startsWith("<!--")) {
      mutations.push({
        type: "create",
        nextVersion: 1,
        newStatement: bulletBody,
      });
    }
  }

  return mutations;
}

/**
 * Forward & Two-Way Compiler:
 * Idempotently injects or updates a delimited Knot context block in a rules file (.cursorrules, CLAUDE.md, AGENTS.md)
 * with cryptographic <!-- knot:id="..." v="1" sha="..." --> anchors while preserving surrounding user instructions.
 */
export function injectRules(options: RuleInjectionOptions): {
  updated: boolean;
  content: string;
  mutations: RuleDiffMutation[];
} {
  const {
    filePath,
    invariants,
    branchName = "unknown",
    commitHash = "latest",
    preserveLocalEdits = false,
  } = options;

  let existingContent = "";
  if (fs.existsSync(filePath)) {
    existingContent = fs.readFileSync(filePath, "utf-8");
  }

  const mutations = extractTwoWayRuleDiffs(existingContent);
  const supersededByLocalEdit = new Map<string, RuleDiffMutation>();
  for (const m of mutations) {
    if (m.type === "supersede" && m.supersedesId) {
      supersededByLocalEdit.set(m.supersedesId, m);
    }
  }

  const renderedBullets = invariants.map((inv) => {
    const item: AnchoredInvariant = typeof inv === "string" ? { text: inv } : inv;
    const cleanText = item.text.replace(ANCHOR_REGEX, "").trim();
    const id = item.id || deterministicAnchorId(cleanText);
    const localEdit = preserveLocalEdits ? supersededByLocalEdit.get(id) : undefined;
    const effectiveText = localEdit ? localEdit.newStatement : cleanText;
    const version = localEdit ? localEdit.nextVersion : (item.version ?? 1);
    const sha = computeRuleSha(effectiveText);
    return `- ${effectiveText} <!-- knot:id="${id}" v="${version}" sha="${sha}" -->`;
  });

  if (preserveLocalEdits) {
    for (const m of mutations) {
      if (m.type === "create") {
        const id = deterministicAnchorId(m.newStatement);
        const sha = computeRuleSha(m.newStatement);
        renderedBullets.push(`- ${m.newStatement} <!-- knot:id="${id}" v="1" sha="${sha}" -->`);
      }
    }
  }

  const timestamp = new Date().toISOString();
  const header = `${KNOT_DELIMITER_START} (branch: ${branchName}, commit: ${commitHash.slice(0, 7)}, updated: ${timestamp}) -->`;

  const blockLines = [
    header,
    "### Active Project Invariants & Decisions (via Knot)",
    ...renderedBullets,
    KNOT_DELIMITER_END,
  ];
  const newBlock = blockLines.join("\n");

  const startIdx = existingContent.indexOf(KNOT_DELIMITER_START);
  const endIdx = existingContent.indexOf(KNOT_DELIMITER_END);

  let finalContent: string;
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, startIdx).trimEnd();
    const after = existingContent.slice(endIdx + KNOT_DELIMITER_END.length).trimStart();
    finalContent = [before, newBlock, after].filter(Boolean).join("\n\n") + "\n";
  } else {
    finalContent = newBlock + (existingContent ? "\n\n" + existingContent.trim() : "") + "\n";
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, finalContent, "utf-8");

  return { updated: true, content: finalContent, mutations };
}
