# google-as-backend

Bun workspace monorepo for using Google services as a backend from static browser apps — no server required.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@cyftec/google-oauth`](packages/google-oauth) | 0.1.0 | GIS OAuth client, token persistence, `authorizedFetch` |
| [`@cyftec/google-drive-folder`](packages/google-drive-folder) | 0.1.0 | Drive folder path resolution and CRUD |
| [`@cyftec/google-drive-socket`](packages/google-drive-socket) | 0.1.0 | PWA messaging over Drive `appDataFolder` — see [package README](packages/google-drive-socket/README.md) |

Packages depend on each other via `workspace:*` and ship TypeScript source directly (no build step).

## Development

```bash
bun install
bun run tests
```

### Scripts

| Script | Description |
|--------|-------------|
| `bun run tests` | All runtime tests + typecheck |
| `bun run test:runtime` | Runtime tests for every package |
| `bun run test:runtime:oauth` | OAuth package tests only |
| `bun run test:runtime:folder` | Drive folder package tests only |
| `bun run test:runtime:socket` | Drive socket package tests only |
| `bun run test:types` | Typecheck all packages (src + tests) |
| `bun run test:types:oauth` | Typecheck oauth package only |
| `bun run test:types:folder` | Typecheck drive-folder package only |
| `bun run test:types:socket` | Typecheck drive-socket package only |

## Install (consumers)

For the full messaging API:

```bash
npm install @cyftec/google-drive-socket
```

Or install `@cyftec/google-oauth` and `@cyftec/google-drive-folder` independently for lower-level use.

## License

MIT
