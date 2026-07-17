import type { API, PlatformAccessory, PlatformConfig } from "homebridge";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StreamTriggersPlatform } from "../src/platform.js";
import {
  ATVREMOTE_STUB,
  type CapturedLog,
  makeCredentialsDir,
  makeLog,
  makeStubEnv,
  readStubLog,
  YTDLP_STUB,
} from "./helpers.js";

class FakeCharacteristic {
  updates: unknown[] = [];
  private setHandler: ((value: unknown) => unknown) | undefined;

  onGet(): this {
    return this;
  }
  onSet(handler: (value: unknown) => unknown): this {
    this.setHandler = handler;
    return this;
  }
  updateValue(value: unknown): void {
    this.updates.push(value);
  }
  /** Simulate a HomeKit write. */
  async triggerSet(value: unknown): Promise<void> {
    await this.setHandler?.(value);
  }
}

class FakeService {
  private readonly characteristics = new Map<unknown, FakeCharacteristic>();

  constructor(public readonly type: unknown) {}

  setCharacteristic(): this {
    return this;
  }
  getCharacteristic(type: unknown): FakeCharacteristic {
    let characteristic = this.characteristics.get(type);
    if (!characteristic) {
      characteristic = new FakeCharacteristic();
      this.characteristics.set(type, characteristic);
    }
    return characteristic;
  }
}

class FakeAccessory {
  services: FakeService[] = [];
  context: Record<string, unknown> = {};

  constructor(
    public displayName: string,
    public readonly UUID: string,
  ) {}

  getService(type: unknown): FakeService | undefined {
    return this.services.find((service) => service.type === type);
  }
  addService(type: unknown): FakeService {
    const service = new FakeService(type);
    this.services.push(service);
    return service;
  }
  onCharacteristic(): FakeCharacteristic {
    const service = this.getService("Switch");
    if (!service) throw new Error("no Switch service");
    return service.getCharacteristic("On");
  }
}

interface Harness {
  platform: StreamTriggersPlatform;
  captured: CapturedLog;
  registered: FakeAccessory[];
  unregistered: FakeAccessory[];
  updated: FakeAccessory[];
  cache: (accessory: FakeAccessory) => void;
  boot: () => void;
}

function makeHarness(storageDir: string, config: Record<string, unknown>): Harness {
  const listeners = new Map<string, () => void>();
  const registered: FakeAccessory[] = [];
  const unregistered: FakeAccessory[] = [];
  const updated: FakeAccessory[] = [];

  const api = {
    hap: {
      Service: { Switch: "Switch" },
      Characteristic: { Name: "Name", On: "On" },
      uuid: { generate: (seed: string) => `uuid-${seed}` },
    },
    platformAccessory: FakeAccessory,
    user: { storagePath: () => storageDir },
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    registerPlatformAccessories: (
      _p: string,
      _n: string,
      accessories: FakeAccessory[],
    ) => registered.push(...accessories),
    unregisterPlatformAccessories: (
      _p: string,
      _n: string,
      accessories: FakeAccessory[],
    ) => unregistered.push(...accessories),
    updatePlatformAccessories: (accessories: FakeAccessory[]) =>
      updated.push(...accessories),
  } as unknown as API;

  const captured = makeLog();
  const platform = new StreamTriggersPlatform(
    captured.log,
    { platform: "StreamTriggers", ...config } as PlatformConfig,
    api,
  );
  return {
    platform,
    captured,
    registered,
    unregistered,
    updated,
    cache: (accessory) =>
      platform.configureAccessory(accessory as unknown as PlatformAccessory),
    boot: () => listeners.get("didFinishLaunching")?.(),
  };
}

let dir: string;
let stubLog: string;
let credentialsDir: string;

function channelConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credentialsDir,
    atvremotePath: ATVREMOTE_STUB,
    ytDlpPath: YTDLP_STUB,
    resetDelay: 25,
    ...extra,
  };
}

beforeEach(async () => {
  ({ dir, stubLog } = await makeStubEnv());
  credentialsDir = await makeCredentialsDir(dir, ["AA:BB"], "SECRET123");
});

describe("accessory sync", () => {
  it("registers a switch per channel with the suffixed name", () => {
    const harness = makeHarness(
      dir,
      channelConfig({
        channels: [
          { key: "destiny", type: "youtube", url: "https://x/live" },
          { key: "jerma", type: "twitch" },
        ],
      }),
    );
    harness.boot();

    expect(harness.registered.map((a) => a.displayName)).toEqual([
      "Destiny Trigger",
      "Jerma Trigger",
    ]);
    expect(harness.unregistered).toEqual([]);
  });

  it("reuses cached accessories instead of re-registering", () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "jerma", type: "twitch" }] }),
    );
    const cached = new FakeAccessory(
      "Old Name",
      "uuid-homebridge-stream-triggers.jerma",
    );
    harness.cache(cached);
    harness.boot();

    expect(harness.registered).toEqual([]);
    expect(harness.updated).toEqual([cached]);
    expect(cached.displayName).toBe("Jerma Trigger");
  });

  it("unregisters cached accessories whose channel was removed", () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "jerma", type: "twitch" }] }),
    );
    const stale = new FakeAccessory(
      "Destiny Trigger",
      "uuid-homebridge-stream-triggers.destiny",
    );
    harness.cache(stale);
    harness.boot();

    expect(harness.unregistered).toEqual([stale]);
    expect(harness.registered.map((a) => a.displayName)).toEqual(["Jerma Trigger"]);
  });

  it("skips a youtube channel without a url (error log, no crash)", () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "destiny", type: "youtube" }] }),
    );
    harness.boot();

    expect(harness.registered).toEqual([]);
    expect(harness.captured.messages.join("\n")).toContain('missing "url"');
  });

  it("survives a completely invalid config", () => {
    const harness = makeHarness(dir, {
      channels: "not-an-array",
      ytDlpPath: YTDLP_STUB,
    });
    harness.boot();

    expect(harness.registered).toEqual([]);
    expect(harness.captured.messages.join("\n")).toContain("Invalid config");
  });
});

describe("momentary switch semantics", () => {
  it("launches on ON and auto-resets to OFF after resetDelay", async () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "jerma", type: "twitch" }] }),
    );
    harness.boot();
    const on = harness.registered[0]?.onCharacteristic();
    if (!on) throw new Error("switch not registered");

    await on.triggerSet(true);
    await vi.waitFor(async () => {
      expect((await readStubLog(stubLog)).join("\n")).toContain("launch_app=tv.twitch");
    });
    await vi.waitFor(() => {
      expect(on.updates).toContain(false);
    });
  });

  it("treats OFF as a no-op", async () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "jerma", type: "twitch" }] }),
    );
    harness.boot();
    const on = harness.registered[0]?.onCharacteristic();
    if (!on) throw new Error("switch not registered");

    await on.triggerSet(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readStubLog(stubLog)).toEqual([]);
    expect(harness.captured.messages.join("\n")).not.toContain("Launch requested");
  });

  it("ignores flips while a launch is already in flight", async () => {
    process.env.ATV_STUB_MODE = "slow";
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "jerma", type: "twitch" }] }),
    );
    harness.boot();
    const on = harness.registered[0]?.onCharacteristic();
    if (!on) throw new Error("switch not registered");

    await on.triggerSet(true);
    await on.triggerSet(true);
    expect(harness.captured.messages.join("\n")).toContain(
      "[jerma] Launch already in flight; ignoring",
    );

    // Let the slow launch finish so nothing leaks past the test.
    await vi.waitFor(
      () => {
        expect(harness.captured.messages.join("\n")).toContain("Launched tv.twitch");
      },
      { timeout: 5000 },
    );
    const lines = await readStubLog(stubLog);
    expect(lines.filter((line) => line.includes("turn_on"))).toHaveLength(1);
  }, 10_000);
});
