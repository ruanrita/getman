import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { z } from "zod";
import type { Config } from "../config";
import { badRequest } from "../errors";
import { assertReachableUrl } from "../net";

/** Where backup files go. Each driver stores opaque bytes under a key. */
export interface TargetDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export const targetSchemas = {
  s3: {
    config: z.object({
      endpoint: z.string().url().optional().or(z.literal("").transform(() => undefined)),
      region: z.string().min(1).default("us-east-1"),
      bucket: z.string().min(1),
      prefix: z.string().default("getman/"),
      forcePathStyle: z.boolean().default(true),
    }),
    secrets: z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  },
  local: {
    config: z.object({
      // Sub-folder of GETMAN_BACKUP_DIR; never an absolute path.
      folder: z
        .string()
        .regex(/^[\w.-]+(\/[\w.-]+)*$/, "Use a relative folder name (letters, numbers, - _ . /)")
        .refine((f) => f.split("/").every((seg) => seg !== "." && seg !== ".."), "Folder cannot contain . or .. segments")
        .default("backups"),
    }),
    secrets: z.object({}).default({}),
  },
  postgres: {
    config: z.object({ table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default("getman_backups") }),
    secrets: z.object({ connectionString: z.string().min(1) }),
  },
} as const;

export type TargetKind = keyof typeof targetSchemas;

export async function createDriver(kind: TargetKind, rawConfig: unknown, rawSecrets: unknown, config: Config): Promise<TargetDriver> {
  switch (kind) {
    case "s3": {
      const c = targetSchemas.s3.config.parse(rawConfig);
      const s = targetSchemas.s3.secrets.parse(rawSecrets);
      if (c.endpoint) await assertReachableUrl(c.endpoint, config.allowPrivateNetworks);
      const client = new S3Client({
        region: c.region,
        endpoint: c.endpoint,
        forcePathStyle: c.forcePathStyle,
        credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
      });
      const k = (key: string) => `${c.prefix}${key}`;
      return {
        put: async (key, data) => void (await client.send(new PutObjectCommand({ Bucket: c.bucket, Key: k(key), Body: data, ContentType: "application/octet-stream" }))),
        get: async (key) => Buffer.from(await (await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: k(key) }))).Body!.transformToByteArray()),
        remove: async (key) => void (await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: k(key) }))),
      };
    }
    case "local": {
      if (!config.backupDir) throw badRequest("Local folder backups are disabled on this server. The administrator can enable them with GETMAN_BACKUP_DIR.", "local_backups_disabled");
      const c = targetSchemas.local.config.parse(rawConfig);
      const root = resolve(config.backupDir);
      const dir = resolve(root, c.folder);
      // Defence in depth on top of the regex: never leave the backup root.
      if (dir !== root && !dir.startsWith(root + sep)) throw badRequest("Folder must stay inside the server backup directory");
      const path = (key: string) => join(dir, key);
      return {
        put: async (key, data) => {
          await mkdir(dir, { recursive: true });
          await writeFile(path(key), data, { mode: 0o600 });
        },
        get: (key) => readFile(path(key)),
        remove: (key) => rm(path(key), { force: true }),
      };
    }
    case "postgres": {
      const c = targetSchemas.postgres.config.parse(rawConfig);
      const s = targetSchemas.postgres.secrets.parse(rawSecrets);
      await assertReachableUrl(s.connectionString, config.allowPrivateNetworks);
      const withDb = async <T>(fn: (sql: postgres.Sql) => Promise<T>) => {
        const sql = postgres(s.connectionString, { max: 1, onnotice: () => {}, connect_timeout: 10 });
        try {
          await sql`create table if not exists ${sql(c.table)} (key text primary key, created_at timestamptz not null default now(), data bytea not null)`;
          return await fn(sql);
        } finally {
          await sql.end({ timeout: 5 });
        }
      };
      return {
        put: (key, data) => withDb(async (sql) => void (await sql`insert into ${sql(c.table)} (key, data) values (${key}, ${data})`)),
        get: (key) =>
          withDb(async (sql) => {
            const [row] = await sql<{ data: Buffer }[]>`select data from ${sql(c.table)} where key = ${key}`;
            if (!row) throw new Error("Backup not found in the database");
            return row.data;
          }),
        remove: (key) => withDb(async (sql) => void (await sql`delete from ${sql(c.table)} where key = ${key}`)),
      };
    }
  }
}

/** Writes, reads back and deletes a small object, so misconfiguration fails at setup time. */
export async function testDriver(driver: TargetDriver): Promise<void> {
  const key = `.getman-connection-test-${Date.now()}`;
  const probe = Buffer.from("getman");
  await driver.put(key, probe);
  const back = await driver.get(key);
  await driver.remove(key);
  if (!back.equals(probe)) throw new Error("Read back different data than was written");
}
