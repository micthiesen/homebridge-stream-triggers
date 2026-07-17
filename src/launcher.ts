import type { Logging } from "homebridge";
import type { AppleTv } from "./atv.js";
import type { ChannelConfig } from "./config.js";
import type { YtDlp } from "./ytdlp.js";

/**
 * The launch flow: wake -> app_list prime -> resolve -> launch_app.
 *
 * The app_list prime is REQUIRED: after an Apple TV reboot (e.g. a tvOS auto-update),
 * tvOS silently drops app-launch requests with a Companion protocol timeout until some
 * client has requested the app list once (documented pyatv FAQ behavior). Priming on
 * every launch keeps the system self-healing across tvOS updates.
 */
/**
 * App to open when a channel has no deep-link url, and the fallback when a
 * deep link is rejected. Twitch's tvOS client almost certainly ignores deep
 * links (see CLAUDE.md), so omni-notify sends twitch channels without a url;
 * a url can be supplied to experiment.
 */
const FALLBACK_APP_IDS = { twitch: "tv.twitch", kick: "com.kick.mobile" } as const;

export class StreamLauncher {
  constructor(
    private readonly log: Logging,
    private readonly atv: AppleTv,
    private readonly ytDlp: YtDlp,
  ) {}

  /** Run the full launch flow for a channel. Logs every step; never throws. */
  async launch(channel: ChannelConfig): Promise<void> {
    const prefix = `[${channel.key}]`;
    try {
      this.log.info(`${prefix} Launch requested (${channel.type})`);

      if (!(await this.atv.run("turn_on", prefix))) return;
      this.log.info(`${prefix} Apple TV awake`);

      if (!(await this.atv.run("app_list", prefix))) return;
      this.log.info(`${prefix} App list primed`);

      const uri = await this.resolveUri(channel, prefix);
      if (!uri) return;

      if (!(await this.atv.run(`launch_app=${uri}`, prefix))) {
        // Twitch/Kick deep links are unverified on tvOS; if one is rejected,
        // opening the app still beats doing nothing.
        const fallbackApp =
          channel.type === "youtube" ? undefined : FALLBACK_APP_IDS[channel.type];
        if (fallbackApp && uri !== fallbackApp) {
          this.log.warn(`${prefix} Deep link rejected; opening the app instead`);
          if (!(await this.atv.run(`launch_app=${fallbackApp}`, prefix))) return;
          this.log.info(`${prefix} Launched ${fallbackApp}`);
        }
        return;
      }
      this.log.info(`${prefix} Launched ${uri}`);
    } catch (error) {
      this.log.error(`${prefix} Launch failed unexpectedly: ${String(error)}`);
    }
  }

  private async resolveUri(
    channel: ChannelConfig,
    prefix: string,
  ): Promise<string | undefined> {
    if (channel.type === "twitch" || channel.type === "kick") {
      // With a url, try it as a deep link (falls back to the app if rejected);
      // without one, just open the app.
      return channel.url ?? FALLBACK_APP_IDS[channel.type];
    }
    if (!channel.url) {
      this.log.error(`${prefix} YouTube channel is missing "url"`);
      return undefined;
    }
    const videoId = await this.ytDlp.resolveLiveVideoId(channel.url, prefix);
    if (!videoId) return undefined; // not live or yt-dlp unavailable; already logged
    this.log.info(`${prefix} Live video id: ${videoId}`);
    return `youtube://www.youtube.com/watch?v=${videoId}`;
  }
}
