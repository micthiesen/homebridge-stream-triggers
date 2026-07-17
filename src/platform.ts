import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import { AppleTv } from "./atv.js";
import { fetchChannels } from "./channels.js";
import {
  type ChannelConfig,
  channelSchema,
  configSchema,
  displayNameFor,
  type StreamTriggersConfig,
} from "./config.js";
import { StreamLauncher } from "./launcher.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { YtDlp } from "./ytdlp.js";

export class StreamTriggersPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly config: StreamTriggersConfig;
  private readonly configValid: boolean;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly launchesInFlight = new Set<string>();
  private readonly ytDlp: YtDlp;
  private readonly launcher: StreamLauncher;

  constructor(
    public readonly log: Logging,
    rawConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const parsed = configSchema.safeParse(rawConfig);
    this.configValid = parsed.success;
    if (parsed.success) {
      this.config = parsed.data;
    } else {
      // Going inert (not falling back to defaults) is deliberate: default paths
      // could hit the wrong binaries/endpoints, and syncing with a guessed config
      // could unregister working accessories. Cached accessories stay registered.
      this.log.error(
        `Invalid config; plugin is inactive until it is fixed: ${parsed.error.message}`,
      );
      this.config = configSchema.parse({});
    }

    this.ytDlp = new YtDlp(log, api.user.storagePath(), this.config.ytDlpPath);
    this.launcher = new StreamLauncher(log, new AppleTv(log, this.config), this.ytDlp);

    api.on("didFinishLaunching", () => {
      void this.startup();
    });
  }

  private async startup(): Promise<void> {
    if (!this.configValid) return;
    if (this.config.channels.length > 0) {
      // Static config override (mainly for testing); no fetching involved.
      this.trySync(this.config.channels);
    } else {
      const channels = await fetchChannels(this.config.channelsUrl, this.log);
      if (channels) {
        this.trySync(channels);
      } else {
        this.wireCachedAccessories();
      }
      // Outside any fallible region: a sync failure must not kill the refresh chain.
      this.scheduleRefresh(
        channels ? this.config.channelsRefreshInterval : this.config.channelsRetryDelay,
      );
    }
    // Non-blocking: download/refresh the managed yt-dlp binary in the background.
    void this.ytDlp.ensureFresh();
  }

  private trySync(channels: ChannelConfig[]): void {
    try {
      this.syncAccessories(channels);
    } catch (error) {
      this.log.error(`Failed to sync accessories: ${String(error)}`);
    }
  }

  /**
   * Background re-sync so channel changes in omni-notify appear without a
   * Homebridge restart. Failures retry sooner (covers omni-notify still
   * booting after a host reboot) but never touch the current accessories.
   */
  private scheduleRefresh(delayMs: number): void {
    if (this.config.channelsRefreshInterval <= 0) return;
    const timer = setTimeout(async () => {
      let nextDelayMs = this.config.channelsRetryDelay;
      try {
        const channels = await fetchChannels(this.config.channelsUrl, this.log);
        if (channels) {
          this.syncAccessories(channels);
          nextDelayMs = this.config.channelsRefreshInterval;
        }
      } catch (error) {
        this.log.error(`Channel refresh failed: ${String(error)}`);
      }
      this.scheduleRefresh(nextDelayMs);
    }, delayMs);
    timer.unref?.();
  }

  /** Called by Homebridge for each accessory restored from cache at startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Register switches for the given channels; unregister ones no longer present. */
  private syncAccessories(channels: ChannelConfig[]): void {
    const configuredUuids = new Set<string>();

    for (const channel of channels) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}.${channel.key}`);
      // Marked as configured even when skipped below, so a transiently broken
      // channel entry never unregisters a working accessory (which would strip
      // its HomeKit room/scene/automation assignments).
      configuredUuids.add(uuid);

      if (channel.type === "youtube" && !channel.url) {
        this.log.error(
          `[${channel.key}] YouTube channel is missing "url"; skipping (existing switch retained)`,
        );
        continue;
      }

      const name = `${displayNameFor(channel)}${this.config.suffix}`;

      const existing = this.accessories.get(uuid);
      if (existing) {
        existing.displayName = name;
        existing.context.channel = channel;
        this.setUpSwitch(existing, channel, name);
        this.api.updatePlatformAccessories([existing]);
        this.log.debug(`[${channel.key}] Updated switch "${name}"`);
      } else {
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.channel = channel;
        this.setUpSwitch(accessory, channel, name);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`[${channel.key}] Registered switch "${name}"`);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (configuredUuids.has(uuid)) continue;
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.log.info(`Unregistered switch "${accessory.displayName}" (channel removed)`);
    }
  }

  /**
   * Fallback when the channel list is unreachable at startup: wire switches
   * from the channel stored in each cached accessory's context, so everything
   * previously known keeps working. Nothing is registered or unregistered.
   */
  private wireCachedAccessories(): void {
    let wired = 0;
    for (const accessory of this.accessories.values()) {
      const channel = channelSchema.safeParse(accessory.context.channel);
      if (!channel.success) {
        this.log.warn(
          `Cached accessory "${accessory.displayName}" has no stored channel; ` +
            `it stays inert until the channel list is reachable`,
        );
        continue;
      }
      this.setUpSwitch(accessory, channel.data, accessory.displayName);
      wired++;
    }
    this.log.warn(`Channel list unavailable; running with ${wired} cached switch(es)`);
  }

  private setUpSwitch(
    accessory: PlatformAccessory,
    channel: ChannelConfig,
    name: string,
  ): void {
    accessory
      .getService(this.Service.AccessoryInformation)
      ?.setCharacteristic(this.Characteristic.Name, name)
      .setCharacteristic(this.Characteristic.Manufacturer, "micthiesen")
      .setCharacteristic(this.Characteristic.Model, "Stream Trigger")
      .setCharacteristic(this.Characteristic.SerialNumber, channel.key);

    const service =
      accessory.getService(this.Service.Switch) ??
      accessory.addService(this.Service.Switch);
    service.setCharacteristic(this.Characteristic.Name, name);

    const on = service.getCharacteristic(this.Characteristic.On);
    on.onGet(() => false);
    on.onSet((value) => {
      try {
        if (!value) return; // OFF is a no-op; the switch is momentary
        this.handleTrigger(channel);
      } catch (error) {
        this.log.error(`[${channel.key}] Trigger handler failed: ${String(error)}`);
      } finally {
        // Momentary semantics: flip back to OFF after resetDelay.
        setTimeout(() => {
          on.updateValue(false);
        }, this.config.resetDelay);
      }
    });
  }

  /** Fire-and-forget launch; never throws, never awaited by the set handler. */
  private handleTrigger(channel: ChannelConfig): void {
    if (this.launchesInFlight.has(channel.key)) {
      this.log.info(`[${channel.key}] Launch already in flight; ignoring`);
      return;
    }
    this.launchesInFlight.add(channel.key);
    this.launcher
      .launch(channel)
      .catch((error) => {
        this.log.error(
          `[${channel.key}] Launch rejected unexpectedly: ${String(error)}`,
        );
      })
      .finally(() => {
        this.launchesInFlight.delete(channel.key);
      });
  }
}
