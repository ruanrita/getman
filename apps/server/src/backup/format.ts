import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Collection, Environment, Role, Variable } from "@getman/core";
import { badRequest } from "../errors";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/**
 * Backup file layout (".getman-backup"):
 *   "GMBK" | version (1 byte) | salt (16) | iv (12) | GCM tag (16) | ciphertext
 * Plaintext is gzip(JSON BackupPayload). Key = scrypt(passphrase, salt).
 * The passphrase never appears in the file; without it the file is unreadable.
 */
const MAGIC = Buffer.from("GMBK");
const VERSION = 1;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface BackupPayload {
  getmanBackup: 1;
  createdAt: string;
  workspace: { id: string; name: string; require2fa: boolean };
  members: { email: string; role: Role }[];
  globals: Variable[];
  collections: Collection[];
  environments: Environment[];
}

export async function sealBackup(payload: BackupPayload, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scryptAsync(passphrase, salt, 32, SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(payload))), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), body]);
}

export async function openBackup(file: Buffer, passphrase: string): Promise<BackupPayload> {
  if (file.length < 49 || !file.subarray(0, 4).equals(MAGIC)) throw badRequest("This is not a Getman backup file", "invalid_backup");
  if (file[4] !== VERSION) throw badRequest(`Unsupported backup version ${file[4]}. Update the server.`, "invalid_backup");
  const salt = file.subarray(5, 21);
  const iv = file.subarray(21, 33);
  const tag = file.subarray(33, 49);
  const key = await scryptAsync(passphrase, salt, 32, SCRYPT);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(file.subarray(49)), decipher.final()]);
  } catch {
    throw badRequest("Wrong passphrase, or the file is damaged", "wrong_passphrase");
  }
  const payload = JSON.parse(gunzipSync(plain).toString("utf8")) as BackupPayload;
  if (payload.getmanBackup !== 1) throw badRequest("Unsupported backup content", "invalid_backup");
  return payload;
}
