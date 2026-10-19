<p align="center"><img src="apps/desktop/public/getman.svg" width="72" alt="Getman logo"></p>

# Getman

Open source API client. Postman-compatible, self-hostable, Git-friendly, documented for humans and AI.

- **Postman-compatible**: import collections and environments, keep your `pm.*` scripts.
- **Chain requests** with pre-request and test scripts.
- **Environments** with shared vs device-local values and secret variables that never leave your machine.
- **Import** Postman, OpenAPI 3 / Swagger 2, cURL. **Export** Postman v2.1 and Git-friendly YAML.
- **Own your data**: local today; self-hosted server and Git workspaces on the roadmap.
- **Bring your own AI** (planned): an assistant that answers from these docs using your own LLM key.

## Quick start

```bash
pnpm install
pnpm dev     # http://localhost:1420
pnpm test
```

Desktop build and requirements: [docs/guides/getting-started.md](docs/guides/getting-started.md).

## Docs

Start at [docs/llms.txt](docs/llms.txt). Product scope and roadmap: [docs/SPEC.md](docs/SPEC.md). What doesn't work yet: [docs/limitations.md](docs/limitations.md).

## License

MIT
