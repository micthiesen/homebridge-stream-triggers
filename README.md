# homebridge-stream-triggers

A personal Homebridge dynamic platform plugin that exposes one HomeKit switch per
streaming channel. Flipping a switch launches that channel's live stream on an Apple TV:
YouTube channels deep-link straight into the live video, Twitch channels open the Twitch
app. Built to be zero-setup and robust; reusability by others is a non-goal.

It piggybacks on [homebridge-appletv-enhanced](https://github.com/maxileith/homebridge-appletv-enhanced)
for Apple TV pairing credentials and its bundled `atvremote` (pyatv) binary, and manages
its own `yt-dlp` binary for resolving YouTube live streams.

## How it works

When a switch flips on (e.g. via a "Stream Destiny" HomeKit scene):

1. **Wake** — `atvremote turn_on` wakes the Apple TV.
2. **Prime** — `atvremote app_list` (output discarded). This is required: after an Apple TV
   reboot (e.g. a tvOS auto-update), tvOS silently drops app-launch requests with a
   Companion protocol timeout until some client has requested the app list once
   (documented pyatv FAQ behavior). Priming on every launch keeps the system self-healing
   across tvOS updates.
3. **Resolve** — for YouTube channels, `yt-dlp --print id <url>` resolves the current live
   video id. If the channel isn't live, the launch stops there (TV awake, nothing playing).
4. **Launch** — `atvremote launch_app=youtube://www.youtube.com/watch?v=<id>` for YouTube,
   or `launch_app=tv.twitch` for Twitch (the tvOS Twitch app has no deep links; opening
   the app is the intended behavior). For Kick, the channel's universal link
   (`https://kick.com/<user>`) is tried as a deep link — kick.com's app-site-association
   claims all its URLs for the app, but tvOS handling is unverified — and if the command
   is rejected the plugin falls back to just opening the Kick app (`com.kick.mobile`,
   requires tvOS 18+).

The switch is momentary: it auto-resets to off after `resetDelay` ms, and the launch runs
fire-and-forget in the background. Repeat flips while a launch is in flight are ignored.

## Configuration

Zero-config by default: the channel list is fetched from
[omni-notify](https://github.com/micthiesen/omni-notify)'s `/api/trigger-channels`
endpoint (one channel per monitored streamer, YouTube preferred over Twitch, Kick-only
streamers skipped), so adding a streamer there is all it takes.

```json
{
  "platform": "StreamTriggers"
}
```

The list re-syncs hourly (`channelsRefreshInterval`), so new streamers appear without a
restart. If omni-notify is unreachable at startup, previously-known switches keep working
from the accessory cache (the channel is stored in each accessory's context) and fetching
retries every minute until it succeeds. Setting `channelsRefreshInterval` to `0` disables
all background fetching, including that startup retry.

A static list can be set instead (mainly for testing; it disables fetching entirely):

```json
{
  "platform": "StreamTriggers",
  "channels": [
    { "key": "destiny", "type": "youtube", "url": "https://www.youtube.com/@destiny/live" },
    { "key": "jerma",   "type": "twitch" }
  ]
}
```

### Channels

| Field | Required | Description |
| --- | --- | --- |
| `key` | yes | Short unique id (e.g. `destiny`). Seeds the accessory UUID, so it's stable across restarts. |
| `type` | yes | `youtube`, `twitch`, or `kick`. |
| `url` | youtube | YouTube: the channel's live page, e.g. `https://www.youtube.com/@destiny/live` (required). Twitch/Kick: optional; when set it is tried as a deep link, falling back to opening the app if the command is rejected. |
| `displayName` | no | Defaults to the capitalized key. The switch is named `<displayName><suffix>` (e.g. `Destiny Trigger`). |

### Platform options

| Field | Default | Description |
| --- | --- | --- |
| `channelsUrl` | `http://omni.boris/api/trigger-channels` | Endpoint serving the channel list; used when `channels` is empty. |
| `channelsRefreshInterval` | `3600000` (1h) | How often (ms) to re-fetch the list and re-sync switches. `0` disables background refresh. |
| `credentialsDir` | `/var/lib/homebridge/appletv-enhanced` | Where homebridge-appletv-enhanced stores Apple TV pairings. |
| `appleTvId` | auto | Apple TV identifier. Auto-discovered as the single subdirectory of `credentialsDir` containing a `credentials.txt`; set explicitly if there are multiple. |
| `atvremotePath` | `/var/lib/homebridge/appletv-enhanced/.venv/bin/atvremote` | `atvremote` binary from appletv-enhanced's venv (that plugin keeps pyatv updated). |
| `ytDlpPath` | self-managed | Override for testing. By default the plugin downloads the latest standalone `yt-dlp` into Homebridge's storage dir and refreshes it when older than 30 days (stale copies break against YouTube within months). |
| `suffix` | `" Trigger"` | Appended to switch names, avoiding collisions with the "Stream X" scene names. |
| `resetDelay` | `2000` | How long (ms) a switch reads "on" before auto-resetting. |

## Development

```bash
pnpm install
pnpm run check:write   # Biome lint + format (auto-fix)
pnpm run typecheck
pnpm run test          # lint + typecheck + vitest
pnpm run build         # tsc -> lib/
```

Pushes to `main` publish to npm via GitHub Actions (skipped if the version is already
published; bump `version` in `package.json` to release).
