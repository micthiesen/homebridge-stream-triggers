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
  (register new / update existing / unregister removed), momentary switch semantics,
  fire-and-forget trigger dispatch with per-channel in-flight dedup
- `src/config.ts` — Zod schema (`configSchema.safeParse` in the platform: an invalid
  config logs an error and the plugin goes inert — no fetch, no yt-dlp download, no
  accessory sync/unregister — until the config is fixed; never crashes).
  `channelsRetryDelay` (default 60s) is the failed-fetch retry cadence, deliberately
  absent from config.schema.json; it exists so tests can exercise the retry path.
- `src/channels.ts` — fetches the channel list from omni-notify's
  `/api/trigger-channels` (see `../omni-notify/src/live-check/triggerChannels.ts`).
  Zero-config default: no `channels` in config → fetch from `channelsUrl`
  (`http://omni.boris/api/trigger-channels`), re-sync every `channelsRefreshInterval`
  (1h; failures retry every 60s). Unreachable at startup → cached accessories are wired
  from `accessory.context.channel` so known switches keep working. A non-empty
  `channels` config is a static override that disables fetching (used by tests/smoke).
- `src/launcher.ts` — the launch flow (wake -> app_list prime -> resolve -> launch_app)
- `src/atv.ts` — `AppleTv`: atvremote wrapper, Apple TV id auto-discovery, companion
  credentials from appletv-enhanced's pairing files
- `src/ytdlp.ts` — `YtDlp`: self-managed binary (download/refresh) + live-video-id resolve
- `src/exec.ts` — `runCommand` (execFile + timeout returning `Result`) and error describers
- `config.schema.json` — Homebridge UI form (per-property `"required": true` inside array
  items is the UI convention, unlike standard JSON Schema)
- `test/` — vitest specs; `test/stubs/` has executable `atvremote`/`yt-dlp` shell stubs
  that record argv to `$STUB_LOG` (behavior via `ATV_STUB_MODE`/`YTDLP_STUB_MODE`), so
  integration tests exercise real subprocess spawning end to end

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
   kick: `launch_app=<https://kick.com/user>` (universal link; kick.com's AASA claims
   `https://kick.com/*` for `com.kick.mobile`, but no public `kick://` scheme exists and
   tvOS deep-link handling is UNVERIFIED — needs on-device testing). If the deep link
   command fails, falls back to `launch_app=com.kick.mobile` (tvOS 18+). If on-device
   testing shows the deep link "succeeds" but does nothing, drop the url in omni-notify's
   `toTriggerChannels` so kick channels just open the app.

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

## Smoke testing against real Homebridge

Run the real thing against a scratch storage dir (no HomeKit pairing needed to verify
startup, registration, and cache sync — flip semantics are covered by the vitest
integration tests, which spawn the real stub subprocesses):

```bash
pnpm run build
# scratch dir needs config.json with a bridge section + this platform, pointing
# atvremotePath at test/stubs/atvremote and credentialsDir at a fake pairing dir
pnpm exec homebridge -D -U <scratch-dir> -P .
```

Omit `ytDlpPath` in that config to exercise the real self-managed download (~36 MB).

## Open questions / later ideas

(none currently)
