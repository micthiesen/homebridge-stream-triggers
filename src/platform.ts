import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import {
  type ChannelConfig,
  configSchema,
  displayNameFor,
  type StreamTriggersConfig,
} from "./config.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

export class StreamTriggersPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly config: StreamTriggersConfig;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly launchesInFlight = new Set<string>();

  constructor(
    public readonly log: Logging,
    rawConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const parsed = configSchema.safeParse(rawConfig);
    if (parsed.success) {
      this.config = parsed.data;
    } else {
      this.log.error(
        `Invalid config, running with no channels: ${parsed.error.message}`,
      );
      this.config = configSchema.parse({});
    }

    api.on("didFinishLaunching", () => {
      try {
        this.syncAccessories();
      } catch (error) {
        this.log.error(`Failed to sync accessories: ${String(error)}`);
      }
    });
  }

  /** Called by Homebridge for each accessory restored from cache at startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Register switches for configured channels; unregister ones no longer configured. */
  private syncAccessories(): void {
    const configuredUuids = new Set<string>();

    for (const channel of this.config.channels) {
      if (channel.type === "youtube" && !channel.url) {
        this.log.error(`[${channel.key}] YouTube channel is missing "url"; skipping`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}.${channel.key}`);
      configuredUuids.add(uuid);
      const name = `${displayNameFor(channel)}${this.config.suffix}`;

      const existing = this.accessories.get(uuid);
      if (existing) {
        existing.displayName = name;
        this.setUpSwitch(existing, channel, name);
        this.api.updatePlatformAccessories([existing]);
        this.log.info(`[${channel.key}] Updated switch "${name}"`);
      } else {
        const accessory = new this.api.platformAccessory(name, uuid);
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

  private setUpSwitch(
    accessory: PlatformAccessory,
    channel: ChannelConfig,
    name: string,
  ): void {
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
    // TODO(build-out): wake Apple TV, prime app_list, resolve stream, launch_app.
    this.log.info(`[${channel.key}] Triggered (launch flow not implemented yet)`);
    this.launchesInFlight.delete(channel.key);
  }
}
