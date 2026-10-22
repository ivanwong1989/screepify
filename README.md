# screepify (v2)

Screeps bot built around a small CPU-aware kernel and plug-in processes.
Architecture and roadmap: [`docs/v2/DESIGN.md`](docs/v2/DESIGN.md).
What the economy does and how it differs from v1: [`docs/v2/ECONOMY.md`](docs/v2/ECONOMY.md).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dev tooling (esbuild, TypeScript for checking, Screeps types) |
| `npm run check` | Type-check `src/` (JSDoc + `@ts-check`, no emit) |
| `npm test` | Unit tests, simulator runs of a fresh colony, and a bundle smoke test (`node --test`) |
| `npm run build` | Bundle `src/main.js` → `dist/main.js` |
| `npm run deploy` | check + test + build, then upload to Screeps code branch `v2` (`-- --branch <name>` / `-- --ptr` to change). Never activates the branch |

The deploy token comes from `SCREEPS_TOKEN` or `token` in `.screeps.json`.

## Layout

```
src/main.js          entry: memhack + kernel.tick()
src/kernel/          scheduler, registry, ctx, telemetry, memory schema
src/contracts/       JSDoc types shared by all plugins
src/services/        stateless helpers (cache, log, segments, roomData, movement, body, pos)
src/processes/       plugins, by phase (sense / plan / act / report)
src/missions/        one module per mission type + shared gather/state helpers
src/actions/         creep action executors (harvest, transfer, build, ...)
src/console/         console commands: help(), stats(), proc.*, config.*
test/                node:test suites, Game mock, single-room simulator (helpers/sim.js)
scripts/             build.js, deploy.js
gui_data/            dashboard.py (v1 Memory view + v2 stats segment tab)
```

## Adding a mission type

1. Create `src/missions/<name>.js` with `generate(plan, out)` and `nextTask(creep, mission, rc)`.
2. Add it to `generators` (and `executors`) in `src/missions/index.js`.

## Adding a process

1. Create `src/processes/<phase>/<name>.js` exporting a `Process` (see `src/contracts/process.js`).
2. Add one `require` line to `src/kernel/registry.js`.
3. Toggle it live with `proc.disable('<id>')` / `proc.enable('<id>')`.

v1 lives on `master` and stays deployable there until v2 replaces it.
