import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { configureEditorMcp } from "./editor-config.js";

export interface StoredCredentials {
  access_token: string;
  domain: string;
  client_id?: string;
  created_at: string;
  token_type?: string;
}

export function getCredentialsDir(): string {
  return path.join(os.homedir(), ".knot");
}

export function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), "credentials.json");
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const credPath = getCredentialsPath();
    if (fs.existsSync(credPath)) {
      const parsed = JSON.parse(fs.readFileSync(credPath, "utf-8"));
      if (parsed && typeof parsed.access_token === "string" && parsed.access_token.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore corrupt or unreadable file
  }
  return null;
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credPath = getCredentialsPath();
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function clearCredentials(): boolean {
  try {
    const credPath = getCredentialsPath();
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
      return true;
    }
  } catch {
    // Ignore error
  }
  return false;
}

export function generatePkce(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  return { codeVerifier, codeChallenge, state };
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd = "";
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {
    // Non-blocking browser launch
  });
}

function renderCallbackHtml(success: boolean, message: string, detail?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${success ? "Connected to Knot" : "Connection Failed"}</title>
  <style>
    body {
      background-color: #FAF8F5;
      color: #151714;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1.5rem;
    }
    .card {
      background: #FFFFFF;
      border: 1px solid rgba(21, 23, 20, 0.12);
      border-radius: 12px;
      max-width: 480px;
      width: 100%;
      padding: 2.25rem;
      box-shadow: 0 4px 20px -2px rgba(21, 23, 20, 0.05);
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      padding: 4px 10px;
      border-radius: 9999px;
      background: ${success ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)"};
      color: ${success ? "#059669" : "#DC2626"};
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin: 0 0 0.75rem;
    }
    p {
      font-size: 14px;
      line-height: 1.55;
      color: #6B6D6A;
      margin: 0 0 1.25rem;
    }
    .mono-box {
      font-family: ui-monospace, Menlo, Monaco, monospace;
      font-size: 12px;
      background: #F4F2EE;
      border: 1px solid rgba(21, 23, 20, 0.08);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      color: #151714;
      word-break: break-all;
      margin-bottom: 1.25rem;
    }
    .btn {
      display: inline-block;
      width: 100%;
      text-align: center;
      background: #151714;
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 0;
      border-radius: 8px;
      border: none;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${success ? "Knot Connected" : "Authentication Error"}</div>
    <h1>${success ? "You're connected to Knot" : "Authorization Declined"}</h1>
    <p>${message}</p>
    ${detail ? `<div class="mono-box">${detail}</div>` : ""}
    <p style="font-size: 12px; margin-bottom: 1.5rem;">You can now safely close this browser window and return to your terminal.</p>
    <button class="btn" onclick="window.close()">Close Window</button>
  </div>
</body>
</html>`;
}

export interface OAuthLoginOptions {
  domain?: string;
  port?: number;
  clientName?: string;
  openBrowserUrl?: boolean;
}

export interface OAuthLoginResult {
  access_token: string;
  domain: string;
  client_id: string;
}

export async function loginWithOAuth(options: OAuthLoginOptions = {}): Promise<OAuthLoginResult> {
  const domain = options.domain || process.env.KNOT_DOMAIN || "production.connectknot.com";
  const port = options.port || 8080;
  const clientName = options.clientName || "Knot CLI";
  const redirectUri = `http://localhost:${port}/callback`;

  const registrationEndpoint = `https://${domain}/api/oauth/register`;
  const authorizeEndpoint = `https://${domain}/api/oauth/authorize`;
  const tokenEndpoint = `https://${domain}/api/oauth/token`;
  const scopes = "knot:connect context:read active_state:read active_state:contribute context:contribute:project context:propose";

  // 1. Dynamic client registration
  let clientId = "knot-cli-client";
  try {
    const regRes = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (regRes.ok) {
      const regData = (await regRes.json()) as { client_id?: string };
      if (regData.client_id) {
        clientId = regData.client_id;
      }
    }
  } catch {
    // Fall back to default clientId if registration endpoint is non-responsive
  }

  // 2. PKCE setup
  const { codeVerifier, codeChallenge, state } = generatePkce();
  const authUrl = `${authorizeEndpoint}?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=${encodeURIComponent(state)}`;

  return new Promise<OAuthLoginResult>((resolve, reject) => {
    let server: http.Server;

    const cleanup = () => {
      try {
        server?.close();
      } catch {
        // Ignore
      }
    };

    server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);

        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const receivedState = reqUrl.searchParams.get("state");
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");
        const errorDesc = reqUrl.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml(false, "Authorization request was cancelled or declined.", errorDesc || error));
          cleanup();
          reject(new Error(`OAuth authorization error: ${error} - ${errorDesc || ""}`));
          return;
        }

        if (receivedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml(false, "State parameter mismatch. Security verification failed."));
          cleanup();
          reject(new Error("State parameter mismatch during OAuth callback."));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml(false, "Missing authorization code in callback URL."));
          cleanup();
          reject(new Error("Missing authorization code."));
          return;
        }

        // Exchange code for token
        let tokenRes = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
          signal: AbortSignal.timeout(8000),
        });

        if (!tokenRes.ok) {
          // Fall back to x-www-form-urlencoded
          const params = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          });
          tokenRes = await fetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
            signal: AbortSignal.timeout(8000),
          });
        }

        const tokenBody = await tokenRes.text();
        let tokenData: { access_token?: string; token_type?: string };
        try {
          tokenData = JSON.parse(tokenBody);
        } catch {
          throw new Error(`Token endpoint returned non-JSON response: ${tokenBody}`);
        }

        if (!tokenRes.ok || !tokenData.access_token) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCallbackHtml(false, "Failed to exchange authorization code for an access token."));
          cleanup();
          reject(new Error(`Token exchange failed: ${tokenBody}`));
          return;
        }

        // Save credentials
        const credentials: StoredCredentials = {
          access_token: tokenData.access_token,
          domain,
          client_id: clientId,
          token_type: tokenData.token_type || "Bearer",
          created_at: new Date().toISOString(),
        };
        saveCredentials(credentials);

        // Auto-configure current project Cursor MCP if in repo
        try {
          const rootDir = process.cwd();
          const endpoint = `https://${domain}/api/mcp`;
          configureEditorMcp(rootDir, endpoint, credentials.access_token);
        } catch {
          // Non-critical if outside repo
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCallbackHtml(true, "Your Knot credentials were saved locally and your editor MCP is ready."));

        cleanup();
        resolve({
          access_token: credentials.access_token,
          domain,
          client_id: clientId,
        });
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.listen(port, () => {
      if (options.openBrowserUrl !== false) {
        openBrowser(authUrl);
      }
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // 2-minute safety timeout
    setTimeout(() => {
      cleanup();
      reject(new Error("Login timed out after 2 minutes."));
    }, 120000).unref();
  });
}
