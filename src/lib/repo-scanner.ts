import * as fs from "node:fs";
import * as path from "node:path";
import { scrubObject, scrubString } from "./scrubber.js";
import { KNOT_DELIMITER_START, KNOT_DELIMITER_END } from "./rule-injector.js";

export interface RepoContextAtom {
  kind: "project_state" | "constraint" | "fact" | "decision" | "preference";
  entity_hint: string;
  statement: string;
}

const RULE_FILES = [
  ".cursorrules",
  "CLAUDE.md",
  "GEMINI.md",
  "AGENTS.md",
  ".windsurfrules",
];

function classifyBullet(text: string): RepoContextAtom["kind"] {
  const lower = text.toLowerCase();
  if (/\b(never|must|strictly|do not|don't|prohibited|always|mandatory)\b/.test(lower)) {
    return "constraint";
  }
  if (/\b(decided|migrated|chose|switched|selected|standardized|adopted)\b/.test(lower)) {
    return "decision";
  }
  if (/\b(prefer|preference|style|tone|concise)\b/.test(lower)) {
    return "preference";
  }
  return "fact";
}

/**
 * Extracts atomic rule bullets from developer instruction files (.cursorrules, CLAUDE.md, etc.)
 * while skipping Knot's own injected delimiter blocks.
 */
export function extractRuleFileAtoms(rawContent: string, fileName: string, maxAtoms = 12): RepoContextAtom[] {
  // Strip any existing Knot-managed block so we don't re-ingest our own synced output
  let withoutKnotBlock = rawContent;
  const startIdx = withoutKnotBlock.indexOf(KNOT_DELIMITER_START);
  const endIdx = withoutKnotBlock.indexOf(KNOT_DELIMITER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    withoutKnotBlock =
      withoutKnotBlock.slice(0, startIdx) +
      withoutKnotBlock.slice(endIdx + KNOT_DELIMITER_END.length);
  }
  const lines = withoutKnotBlock.split(/\r?\n/);
  const extracted: RepoContextAtom[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !trimmed) continue;
    const bulletMatch = trimmed.match(/^(?:[-*•+]|\d+[.)])\s+(.+)$/);
    if (!bulletMatch) continue;

    const cleanBullet = scrubString(bulletMatch[1]!.trim());
    if (cleanBullet.length < 12 || cleanBullet.length > 500) continue;

    extracted.push({
      kind: classifyBullet(cleanBullet),
      entity_hint: fileName,
      statement: cleanBullet,
    });
    if (extracted.length >= maxAtoms) break;
  }

  return extracted;
}

/**
 * Inspects the repository and generates scrubbed context atoms.
 */
export function inspectRepository(rootDir: string): RepoContextAtom[] {
  const atoms: RepoContextAtom[] = [];

  // 1. package.json
  const pkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scrubbed = scrubObject({
        name: raw.name,
        version: raw.version,
        description: raw.description,
        scripts: raw.scripts,
        dependencies: Object.keys(raw.dependencies || {}),
        devDependencies: Object.keys(raw.devDependencies || {}),
      });

      atoms.push({
        kind: "project_state",
        entity_hint: "package.json",
        statement: `Project ${scrubbed.name || "workspace"} stack and dependencies: ${JSON.stringify(scrubbed)}`,
      });
    } catch {
      // Skip invalid JSON
    }
  }

  // 2. pyproject.toml (for Python / ML repos)
  const pyprojectPath = path.join(rootDir, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    try {
      const rawPy = fs.readFileSync(pyprojectPath, "utf-8").slice(0, 1200);
      atoms.push({
        kind: "project_state",
        entity_hint: "pyproject.toml",
        statement: `Python project configuration from pyproject.toml:\n${scrubString(rawPy)}`,
      });
    } catch {
      // Skip on error
    }
  }

  // 3. README.md (bounded to 2,000 characters to stay within budget)
  const readmePath = path.join(rootDir, "README.md");
  if (fs.existsSync(readmePath)) {
    try {
      const rawReadme = fs.readFileSync(readmePath, "utf-8").slice(0, 2000);
      atoms.push({
        kind: "fact",
        entity_hint: "README.md",
        statement: `Project overview from README.md:\n${scrubString(rawReadme)}`,
      });
    } catch {
      // Skip on error
    }
  }

  // 4. AI & Developer Rule Files (.cursorrules, CLAUDE.md, GEMINI.md, AGENTS.md, .windsurfrules)
  for (const ruleFile of RULE_FILES) {
    const fullPath = path.join(rootDir, ruleFile);
    if (fs.existsSync(fullPath)) {
      try {
        const rawRules = fs.readFileSync(fullPath, "utf-8");
        atoms.push(...extractRuleFileAtoms(rawRules, ruleFile));
      } catch {
        // Skip unreadable file
      }
    }
  }

  // 5. Git branch/commit metadata
  const gitHeadPath = path.join(rootDir, ".git", "HEAD");
  if (fs.existsSync(gitHeadPath)) {
    try {
      const headContent = fs.readFileSync(gitHeadPath, "utf-8").trim();
      const branch = headContent.startsWith("ref: refs/heads/")
        ? headContent.replace("ref: refs/heads/", "")
        : headContent;

      atoms.push({
        kind: "project_state",
        entity_hint: "git",
        statement: `Current active git branch: ${branch}`,
      });
    } catch {
      // Skip on error
    }
  }

  return atoms;
}
