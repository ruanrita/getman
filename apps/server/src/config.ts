export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** 32-byte key for AES-256-GCM (2FA secrets at rest). */
  encryptionKey: Buffer;
  sessionTtlDays: number;
  corsOrigins: string[];
  trustProxy: boolean;
  /** Max attempts per minute per IP on login/register/2FA endpoints. */
  authRateLimit: number;
  /** Root for "local folder" backup targets. Undefined disables that target kind. */
  backupDir?: string;
  /**
   * Whether backup targets and AI endpoints may point at private/loopback
   * addresses. Off by default: any user can create a workspace and configure
   * them, so this blocks using the server to reach internal services (SSRF).
   */
  allowPrivateNetworks: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const encryptionKey = Buffer.from(env.GETMAN_ENCRYPTION_KEY ?? "", "base64");
  if (encryptionKey.length !== 32) {
    throw new Error(
      "GETMAN_ENCRYPTION_KEY must be 32 random bytes in base64. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl,
    encryptionKey,
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:1420,http://tauri.localhost,tauri://localhost")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY === "true",
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 10),
    backupDir: env.GETMAN_BACKUP_DIR || undefined,
    allowPrivateNetworks: env.GETMAN_ALLOW_PRIVATE_NETWORKS === "true",
  };
}
