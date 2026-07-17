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
  refusedUrl,
  serveJson,
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

  it("goes inert on a completely invalid config (no fetch, no yt-dlp, no sync)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const harness = makeHarness(dir, {
      channels: "not-an-array",
      ytDlpPath: YTDLP_STUB,
    });
    const cached = new FakeAccessory(
      "Jerma Trigger",
      "uuid-homebridge-stream-triggers.jerma",
    );
    harness.cache(cached);
    harness.boot();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.registered).toEqual([]);
    expect(harness.unregistered).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.captured.messages.join("\n")).toContain("Invalid config");
    fetchSpy.mockRestore();
  });

  it("retains an existing switch when its youtube channel loses the url", () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channels: [{ key: "destiny", type: "youtube" }] }),
    );
    const cached = new FakeAccessory(
      "Destiny Trigger",
      "uuid-homebridge-stream-triggers.destiny",
    );
    cached.context.channel = { key: "destiny", type: "youtube", url: "https://x/live" };
    harness.cache(cached);
    harness.boot();

    expect(harness.unregistered).toEqual([]);
    expect(harness.captured.messages.join("\n")).toContain('missing "url"');
  });
});

describe("channel fetching", () => {
  it("fetches channels from the endpoint and registers switches", async () => {
    const server = await serveJson(() => ({
      body: { channels: [{ key: "jerma", displayName: "Jerma", type: "twitch" }] },
    }));
    const harness = makeHarness(
      dir,
      channelConfig({ channelsUrl: server.url, channelsRefreshInterval: 0 }),
    );
    harness.boot();

    await vi.waitFor(() => {
      expect(harness.registered.map((a) => a.displayName)).toEqual(["Jerma Trigger"]);
    });
    expect(harness.registered[0]?.context.channel).toMatchObject({ key: "jerma" });
    await server.close();
  });

  it("falls back to cached accessories (still functional) when unreachable", async () => {
    const harness = makeHarness(
      dir,
      channelConfig({ channelsUrl: refusedUrl(), channelsRefreshInterval: 0 }),
    );
    const cached = new FakeAccessory(
      "Jerma Trigger",
      "uuid-homebridge-stream-triggers.jerma",
    );
    cached.context.channel = { key: "jerma", type: "twitch" };
    harness.cache(cached);
    harness.boot();

    await vi.waitFor(() => {
      expect(harness.captured.messages.join("\n")).toContain(
        "Channel list unavailable; running with 1 cached switch(es)",
      );
    });
    expect(harness.registered).toEqual([]);
    expect(harness.unregistered).toEqual([]);

    // The cached switch still launches.
    await cached.onCharacteristic().triggerSet(true);
    await vi.waitFor(async () => {
      expect((await readStubLog(stubLog)).join("\n")).toContain("launch_app=tv.twitch");
    });
  });

  it("retries after a failed startup fetch and recovers", async () => {
    const server = await serveJson((requestCount) =>
      requestCount === 1
        ? { status: 500, body: { error: "still booting" } }
        : {
            body: {
              channels: [{ key: "jerma", displayName: "Jerma", type: "twitch" }],
            },
          },
    );
    const harness = makeHarness(
      dir,
      channelConfig({
        channelsUrl: server.url,
        channelsRefreshInterval: 3_600_000,
        channelsRetryDelay: 25,
      }),
    );
    harness.boot();

    await vi.waitFor(() => {
      expect(harness.captured.messages.join("\n")).toContain(
        "Channel list unavailable",
      );
    });
    await vi.waitFor(() => {
      expect(harness.registered.map((a) => a.displayName)).toEqual(["Jerma Trigger"]);
    });
    await server.close();
  });

  it("propagates a channel type change to an existing switch", async () => {
    const server = await serveJson(() => ({
      body: {
        channels: [
          {
            key: "jerma",
            displayName: "Jerma",
            type: "youtube",
            url: "https://www.youtube.com/@jerma/live",
          },
        ],
      },
    }));
    const harness = makeHarness(
      dir,
      channelConfig({ channelsUrl: server.url, channelsRefreshInterval: 0 }),
    );
    const cached = new FakeAccessory(
      "Jerma Trigger",
      "uuid-homebridge-stream-triggers.jerma",
    );
    cached.context.channel = { key: "jerma", type: "twitch" };
    harness.cache(cached);
    harness.boot();

    await vi.waitFor(() => {
      expect(harness.updated).toContain(cached);
    });
    expect(cached.context.channel).toMatchObject({ type: "youtube" });

    // The rewired switch now runs the youtube flow, not the stale twitch one.
    await cached.onCharacteristic().triggerSet(true);
    await vi.waitFor(async () => {
      const lines = (await readStubLog(stubLog)).join("\n");
      expect(lines).toContain(
        "yt-dlp --print id --no-warnings https://www.youtube.com/@jerma/live",
      );
      expect(lines).toContain(
        "launch_app=youtube://www.youtube.com/watch?v=fakeVideoId123",
      );
    });
    expect((await readStubLog(stubLog)).join("\n")).not.toContain("tv.twitch");
    await server.close();
  });

  it("re-syncs on the refresh interval, picking up new channels", async () => {
    const server = await serveJson((requestCount) => ({
      body: {
        channels:
          requestCount === 1
            ? [{ key: "jerma", displayName: "Jerma", type: "twitch" }]
            : [
                { key: "jerma", displayName: "Jerma", type: "twitch" },
                { key: "vinesauce", displayName: "Vinesauce", type: "twitch" },
              ],
      },
    }));
    const harness = makeHarness(
      dir,
      channelConfig({ channelsUrl: server.url, channelsRefreshInterval: 50 }),
    );
    harness.boot();

    await vi.waitFor(() => {
      expect(harness.registered.map((a) => a.displayName)).toContain(
        "Vinesauce Trigger",
      );
    });
    await server.close();
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
