import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/admin.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  clean: true,
  // Workspace packages ship TypeScript source, so they are bundled in.
  noExternal: [/^@getman\//],
});
