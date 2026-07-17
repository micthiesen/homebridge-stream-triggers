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

      if (!(await this.atv.run(`launch_app=${uri}`, prefix))) return;
      this.log.info(`${prefix} Launched ${uri}`);
    } catch (error) {
      this.log.error(`${prefix} Launch failed unexpectedly: ${String(error)}`);
    }
  }

  private async resolveUri(
    channel: ChannelConfig,
    prefix: string,
  ): Promise<string | undefined> {
    if (channel.type === "twitch") {
      // The tvOS Twitch app has no deep links; opening the app is the intended behavior.
      return "tv.twitch";
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
