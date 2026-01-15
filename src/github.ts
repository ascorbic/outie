/**
 * GitHub App Authentication
 * 
 * Generates installation access tokens for the Scout bot.
 * Tokens are short-lived (1 hour) and scoped to the app's installation.
 */

import { SignJWT, importPKCS8 } from "jose";

export interface GitHubAppCredentials {
  clientId: string;      // Client ID (recommended over App ID)
  privateKey: string;
  installationId: string;
}

/**
 * Generate a JWT for GitHub App authentication
 * Valid for 10 minutes (GitHub's maximum)
 * Uses Client ID as issuer (recommended by GitHub)
 */
async function generateAppJWT(clientId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  // Import the private key
  const key = await importPKCS8(privateKey, "RS256");
  
  // Create and sign the JWT
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60) // 60 seconds in the past to allow for clock drift
    .setExpirationTime(now + 600) // 10 minutes
    .setIssuer(clientId) // Use Client ID as issuer
    .sign(key);
  
  return jwt;
}

/**
 * Exchange a JWT for an installation access token
 * The token is valid for 1 hour and can be used for git operations
 */
export async function getInstallationToken(
  credentials: GitHubAppCredentials
): Promise<string> {
  const { clientId, privateKey, installationId } = credentials;
  
  // Generate JWT
  const jwt = await generateAppJWT(clientId, privateKey);
  
  // Exchange for installation token
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Scout-Bot/1.0",
      },
    }
  );
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }
  
  const data = await response.json() as { token: string; expires_at: string };
  
  console.log(`[GITHUB] Got installation token, expires at ${data.expires_at}`);
  
  return data.token;
}

/**
 * Get credentials from environment
 */
export function getGitHubAppCredentials(env: Record<string, unknown>): GitHubAppCredentials | null {
  const clientId = env.GITHUB_APP_CLIENT_ID as string | undefined;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY as string | undefined;
  const installationId = env.GITHUB_APP_INSTALLATION_ID as string | undefined;
  
  if (!clientId || !privateKey || !installationId) {
    return null;
  }
  
  return { clientId, privateKey, installationId };
}
