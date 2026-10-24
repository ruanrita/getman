import { buildApp } from "./app";
import { startScheduler } from "./backup/service";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";

const config = loadConfig();
const sql = connect(config.databaseUrl);
await migrate(sql);

const { app } = await buildApp(sql, config, { logger: true });
const stopScheduler = startScheduler(sql, config, app.log);

const shutdown = async () => {
  stopScheduler();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
