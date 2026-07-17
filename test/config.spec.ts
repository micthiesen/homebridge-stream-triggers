import { describe, expect, it } from "vitest";
import { displayNameFor, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("applies defaults to an empty config", () => {
    const config = parseConfig({});
    expect(config.channels).toEqual([]);
    expect(config.credentialsDir).toBe("/var/lib/homebridge/appletv-enhanced");
    expect(config.atvremotePath).toBe(
      "/var/lib/homebridge/appletv-enhanced/.venv/bin/atvremote",
    );
    expect(config.suffix).toBe(" Trigger");
    expect(config.resetDelay).toBe(2000);
    expect(config.appleTvId).toBeUndefined();
    expect(config.ytDlpPath).toBeUndefined();
  });

  it("parses channels and ignores extra platform keys", () => {
    const config = parseConfig({
      platform: "StreamTriggers",
      name: "Stream Triggers",
      channels: [
        {
          key: "destiny",
          type: "youtube",
          url: "https://www.youtube.com/@destiny/live",
        },
        { key: "jerma", type: "twitch" },
      ],
    });
    expect(config.channels).toHaveLength(2);
    expect(config.channels[0]?.type).toBe("youtube");
    expect(config.channels[1]?.url).toBeUndefined();
  });

  it("rejects an unknown channel type", () => {
    expect(() =>
      parseConfig({ channels: [{ key: "x", type: "kick" }] }),
    ).toThrowError();
  });
});

describe("displayNameFor", () => {
  it("defaults to the capitalized key", () => {
    expect(displayNameFor({ key: "destiny", type: "youtube" })).toBe("Destiny");
  });

  it("prefers an explicit displayName", () => {
    expect(
      displayNameFor({ key: "jerma", displayName: "Jerma985", type: "twitch" }),
    ).toBe("Jerma985");
  });
});
