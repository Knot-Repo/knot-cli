import * as fs from "node:fs";
import * as path from "node:path";

export interface EditorConfigResult {
  editor: "cursor" | "claude" | "vscode";
  configPath: string;
  configured: boolean;
  gitignoreProtected: boolean;
}

/**
 * Ensures a sensitive or credential file path is covered by .gitignore.
 */
export function ensureGitignored(rootDir: string, relativePath: string): boolean {
  const gitignorePath = path.join(rootDir, ".gitignore");
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf-8");
  }

  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(relativePath) || lines.includes(`/${relativePath}`)) {
    return true; // Already protected
  }

  const updatedContent = content ? `${content.trimEnd()}\n\n# Knot sensitive configs\n${relativePath}\n` : `${relativePath}\n`;
  fs.writeFileSync(gitignorePath, updatedContent, "utf-8");
  return true;
}

/**
 * Automatically configures local editor MCP settings (.cursor/mcp.json, claude_desktop_config.json)
 */
export function configureEditorMcp(rootDir: string, mcpEndpoint: string, bearerToken?: string): EditorConfigResult[] {
  const results: EditorConfigResult[] = [];

  // 1. Cursor: .cursor/mcp.json
  const cursorDir = path.join(rootDir, ".cursor");
  const cursorConfigPath = path.join(cursorDir, "mcp.json");
  
  let cursorConfig: any = { mcpServers: {} };
  if (fs.existsSync(cursorConfigPath)) {
    try {
      cursorConfig = JSON.parse(fs.readFileSync(cursorConfigPath, "utf-8"));
    } catch {}
  }
  if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {};

  cursorConfig.mcpServers.knot = {
    url: mcpEndpoint,
    ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {}),
  };

  fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(cursorConfigPath, JSON.stringify(cursorConfig, null, 2), "utf-8");

  // Protect with .gitignore
  const protectedGit = ensureGitignored(rootDir, ".cursor/mcp.json");

  results.push({
    editor: "cursor",
    configPath: cursorConfigPath,
    configured: true,
    gitignoreProtected: protectedGit,
  });

  return results;
}
