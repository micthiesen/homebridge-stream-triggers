import { describe, expect, it } from "vitest";
import { fetchChannels } from "../src/channels.js";
import { makeLog, refusedUrl, serveJson } from "./helpers.js";

describe("fetchChannels", () => {
  it("returns the parsed channel list", async () => {
    const server = await serveJson(() => ({
      body: {
        channels: [
          {
            key: "destiny",
            displayName: "Destiny",
            type: "youtube",
            url: "https://x/live",
          },
          { key: "jerma", displayName: "Jerma", type: "twitch" },
        ],
      },
    }));
    const { log } = makeLog();

    const channels = await fetchChannels(server.url, log);
    expect(channels).toHaveLength(2);
    expect(channels?.[0]?.key).toBe("destiny");
    expect(channels?.[1]?.url).toBeUndefined();
    await server.close();
  });

  it("returns undefined and logs on an HTTP error", async () => {
    const server = await serveJson(() => ({ status: 500, body: { error: "boom" } }));
    const { log, messages } = makeLog();

    expect(await fetchChannels(server.url, log)).toBeUndefined();
    expect(messages.join("\n")).toContain("error Failed to fetch channels");
    expect(messages.join("\n")).toContain("HTTP 500");
    await server.close();
  });

  it("returns undefined on a malformed response body", async () => {
    const server = await serveJson(() => ({
      body: { channels: [{ key: 42, type: "kick" }] },
    }));
    const { log, messages } = makeLog();

    expect(await fetchChannels(server.url, log)).toBeUndefined();
    expect(messages.join("\n")).toContain("error Failed to fetch channels");
    await server.close();
  });

  it("returns undefined when the server is unreachable", async () => {
    const { log, messages } = makeLog();
    expect(await fetchChannels(await refusedUrl(), log)).toBeUndefined();
    expect(messages.join("\n")).toContain("error Failed to fetch channels");
  });
});
