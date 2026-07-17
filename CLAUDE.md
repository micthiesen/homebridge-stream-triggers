# CLAUDE.md

Homebridge dynamic platform plugin (`homebridge-stream-triggers`): one HomeKit switch per
streaming channel; flipping it launches that channel's live stream on an Apple TV via
`atvremote` (from homebridge-appletv-enhanced's venv) and a self-managed `yt-dlp`.
Personal plugin — zero-setup and robustness are the goals, reusability is a non-goal.

This is a living document — update it as conventions emerge; don't ask, just update.

## Workflow

- **Always commit and push.** Personal project, work directly on `main`, no PRs, no asking
  first. Commit and push whenever something is finished, bundling any pending doc/data
  changes into the same push. Note: pushes to `main` publish to npm if `version` was bumped.
- **Gate after any change:** `pnpm run check:write && pnpm run typecheck && pnpm run test`.
- When unsure about tooling/structure/versions, check sibling projects under `~/Code`
  (`homebridge-kasa` is the closest sibling; `omni-notify`, `condo`, `mitools` for newer
  house conventions) and match the house style.

## Commands

```bash
pnpm run build         # tsc -> lib/ (tsconfig.source.json)
pnpm run check:write   # Biome lint + format, auto-fix
pnpm run lint          # Biome check
pnpm run typecheck     # tsc --noEmit
pnpm run test          # lint + typecheck + vitest
pnpm run test:only     # vitest only
```

## Architecture

- `src/index.ts` — registers the platform with Homebridge
- `src/settings.ts` — `PLATFORM_NAME` ("StreamTriggers", must match `pluginAlias` in
  config.schema.json) and `PLUGIN_NAME`
- `src/platform.ts` — `StreamTriggersPlatform` (DynamicPlatformPlugin): caches restored
  accessories in `configureAccessory`, syncs switches to config on `didFinishLaunching`
  (register new / update existing / unregister removed), momentary switch semantics
- `src/config.ts` — Zod schema + `parseConfig` (safeParse'd in the platform: invalid
  config logs an error and runs with no channels, never crashes)
- `config.schema.json` — Homebridge UI form (per-property `"required": true` inside array
  items is the UI convention, unlike standard JSON Schema)
- `test/` — vitest specs

## Robustness rules (the entire point of this plugin)

The predecessor (homebridge-cmdswitch2) crashed its child bridge on every flip. Therefore:

- Never throw out of a HAP handler; no unhandled rejections. Launches are fire-and-forget
  (do NOT await in the `onSet` handler); auto-reset the switch after `resetDelay` via
  `updateValue(false)`; ignore flips while a launch for that channel is in flight.
- Subprocesses via `execFile` with timeouts (~60s yt-dlp, ~30s atvremote); catch
  everything, log with `[<channel key>]` prefix.
- Current HAP APIs only: no `updateReachability`, no `Characteristic.getValue()`.
- Prefer mitools helpers (`withTimeout`, `withRetry`, `tryCatch`/`Result`) over hand-rolled
  equivalents; check `../mitools/src/` before reinventing.

## Launch flow (build-out reference)

Companion credentials = first line of `<credentialsDir>/<appleTvId>/credentials.txt`.
Every atvremote call: `atvremote --id <appleTvId> --companion-credentials <creds> <cmd>`.

1. `turn_on` — wake the Apple TV
2. `app_list` (discard output) — REQUIRED priming step: after an Apple TV reboot, tvOS
   silently drops `launch_app` with a Companion timeout until some client requests the app
   list once (pyatv FAQ). Prime on every launch; do not skip.
3. youtube: `yt-dlp --print id --no-warnings <url>`; non-zero exit or empty output = not
   live → log and stop (expected, not an error). Else
   `launch_app=youtube://www.youtube.com/watch?v=<id>`.
   twitch: `launch_app=tv.twitch` (no deep links on tvOS).

### Self-managed yt-dlp

Unless `ytDlpPath` is set: on startup (non-blocking) ensure
`<storagePath>/stream-triggers/yt-dlp` exists and is < 30 days old, else download latest
standalone binary and `chmod +x`. Missing at launch time → log error, continue. Assets:
`https://github.com/yt-dlp/yt-dlp/releases/latest/download/<asset>` with `yt-dlp_linux`
(x86_64, production target), `yt-dlp_linux_aarch64`, `yt-dlp_macos` (universal2).

## Tooling

- **Package manager:** pnpm. **Runtime target:** Node in the official homebridge Docker
  image (Homebridge 2.1.1, Node 24, Debian 12, child bridge).
- **TypeScript:** strict, NodeNext-style `.js` import specifiers, builds to `lib/` for
  publishing (`tsconfig.source.json`); `tsconfig.json` includes tests for typecheck.
- **Biome** extends `@micthiesen/mitools/biome.shared.json`; **vitest** via mitools
  `baseVitestConfig`.
- Strong types (discriminated unions, explicit returns), no debug leftovers, small modules.

## Releases

Kasa-style: bump `version` in `package.json`, commit `chore: release vX.Y.Z`, tag `vX.Y.Z`,
`git push && git push --tags`, `gh release create`. CI publishes to npm on the `main` push
(idempotent: skips if the version already exists).

## Open questions / later ideas

- Optionally source the channel list from a new endpoint on `../omni-notify` (sibling
  compose service on the same host) instead of hardcoding channels in config. Not decided.
- Local smoke test before v1.0.0: `npx homebridge -D -U <scratch dir>` with stub
  `atvremotePath`/`ytDlpPath` scripts (see spec in git history / README).
