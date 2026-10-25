/**
 * Operator commands, run on the server host:
 *   node dist/admin.js reset-password <email>   prints a temporary password, signs the user out everywhere
 *   node dist/admin.js verify-email <email>     marks the address verified and accepts its pending invitations
 * In Docker: docker compose exec server node dist/admin.js reset-password ana@example.com
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config";
import { hashPassword } from "./crypto";
import { connect, migrate } from "./db";
import { emailService } from "./emailService";
import { Hub } from "./realtime";

const [command, rawEmail] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (!command || !email || !["reset-password", "verify-email"].includes(command)) {
  console.error("Usage: node dist/admin.js reset-password|verify-email <email>");
  process.exit(2);
}

const sql = connect(loadConfig().databaseUrl);
try {
  await migrate(sql);
  const [user] = await sql<{ id: string; email: string }[]>`select id, email from users where email = ${email}`;
  if (!user) throw new Error(`No account uses ${email}`);
  if (command === "reset-password") {
    const temporary = randomBytes(12).toString("base64url");
    await sql`update users set password_hash = ${await hashPassword(temporary)} where id = ${user.id}`;
    const revoked = await sql`delete from sessions where user_id = ${user.id} returning id`;
    console.log(`Temporary password for ${email}: ${temporary}`);
    console.log(`${revoked.length} session(s) signed out. Ask the user to change it under Account → Change password.`);
  } else {
    await sql`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${user.id}`;
    const joined = await emailService(sql, undefined, new Hub()).acceptPendingInvites(user);
    console.log(`${email} verified.${joined.length ? ` Joined: ${joined.map((j) => j.name).join(", ")}.` : ""}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
