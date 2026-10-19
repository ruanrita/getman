import { keyValue, newCollection, newEnvironment, newFolder, newRequest, newWorkspace, variable, type Workspace } from "@getman/core";

export const LOCAL_USER = { userId: "local", email: "you@localhost" };

/** First-run workspace showing request chaining via scripts. */
export function seedWorkspace(): Workspace {
  const ws = newWorkspace("My workspace", LOCAL_USER);

  const env = newEnvironment("httpbin");
  env.variables.push(variable("baseUrl", "https://httpbin.org"), variable("apiPassword", "", { secret: true, localValue: "change-me" }));
  ws.environments.push(env);
  ws.activeEnvironmentId = env.id;

  const col = newCollection("Getman tour");
  col.description = "Shows how a test script stores a value that the next request uses.";
  col.auth = { type: "bearer", token: "{{token}}" };

  const auth = newFolder("1. Auth flow");

  const login = newRequest("Login (stores token)", "POST", "{{baseUrl}}/post");
  login.auth = { type: "none" };
  login.body = { mode: "json", raw: JSON.stringify({ username: "demo", token: "token-{{$timestamp}}" }, null, 2), form: [] };
  login.scripts.test = [
    'pm.test("status is 200", () => pm.response.to.have.status(200));',
    "",
    "// httpbin echoes the body back under `json`",
    "const token = pm.response.json().json.token;",
    'pm.environment.set("token", token);',
    'console.log("token saved:", token);',
  ].join("\n");

  const me = newRequest("Who am I (uses token)", "GET", "{{baseUrl}}/bearer");
  me.scripts.test = [
    'pm.test("authenticated", () => pm.response.to.have.status(200));',
    'pm.test("token matches", () => {',
    '  pm.expect(pm.response.json().token).to.eql(pm.environment.get("token"));',
    "});",
  ].join("\n");

  auth.items.push(login, me);

  const query = newRequest("Query params + headers", "GET", "{{baseUrl}}/get");
  query.auth = { type: "none" };
  query.params.push(keyValue("page", "1"), keyValue("debug", "true", false));
  query.headers.push(keyValue("X-Correlation-Id", "{{$guid}}"));
  query.scripts.preRequest = 'pm.request.headers.add({ key: "X-Sent-At", value: new Date().toISOString() });';

  col.items.push(auth, query);
  ws.collections.push(col);
  return ws;
}
