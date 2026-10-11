# Development

```bash
pnpm install && pnpm db:generate
pnpm test            # vitest (packages, CLI, e2e) + desktop tests
pnpm typecheck
pnpm dev             # runtime :4317 + UI :1420
```

- Packages are consumed from source (`exports` points at `src/index.ts`); there is no build step for them.
- Schema changes: edit `prisma/schema.prisma`, then `pnpm db:generate && pnpm db:sql` (regenerates `packages/database/src/init-sql.ts`).
- Tests use a scripted model double or a local SSE server, never a real model, but tools, filesystem, processes and git are real.
- `tests/e2e-health.test.ts` is the reference end-to-end flow.
- The Tauri shell lives in `apps/desktop/src-tauri` (`pnpm --filter @betacode/desktop tauri dev`).
