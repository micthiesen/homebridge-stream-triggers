import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isStale, YtDlp, ytDlpAssetName } from "../src/ytdlp.js";
import { makeLog, makeStubEnv, YTDLP_STUB } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  ({ dir } = await makeStubEnv());
});

describe("ytDlpAssetName", () => {
  it("picks the right asset per platform", () => {
    expect(ytDlpAssetName("linux", "x64")).toBe("yt-dlp_linux");
    expect(ytDlpAssetName("linux", "arm64")).toBe("yt-dlp_linux_aarch64");
    expect(ytDlpAssetName("darwin", "arm64")).toBe("yt-dlp_macos");
    expect(ytDlpAssetName("darwin", "x64")).toBe("yt-dlp_macos");
    expect(ytDlpAssetName("win32", "x64")).toBeUndefined();
  });
});

describe("isStale", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("is fresh under 30 days and stale over it", () => {
    const now = 1_000_000_000_000;
    expect(isStale(now - 29 * DAY_MS, now)).toBe(false);
    expect(isStale(now - 31 * DAY_MS, now)).toBe(true);
  });
});

describe("YtDlp.resolveLiveVideoId", () => {
  it("returns the printed video id when live", async () => {
    const { log } = makeLog();
    const ytDlp = new YtDlp(log, dir, YTDLP_STUB);
    const id = await ytDlp.resolveLiveVideoId("https://example.com/@chan/live", "[t]");
    expect(id).toBe("fakeVideoId123");
  });

  it("returns undefined and logs info (not error) when not live", async () => {
    process.env.YTDLP_STUB_MODE = "notlive";
    const { log, messages } = makeLog();
    const ytDlp = new YtDlp(log, dir, YTDLP_STUB);
    const id = await ytDlp.resolveLiveVideoId("https://example.com/@chan/live", "[t]");
    expect(id).toBeUndefined();
    expect(messages.join("\n")).toContain("info [t] Not live");
    expect(messages.filter((m) => m.startsWith("error"))).toEqual([]);
  });

  it("returns undefined when yt-dlp prints nothing", async () => {
    process.env.YTDLP_STUB_MODE = "empty";
    const { log, messages } = makeLog();
    const ytDlp = new YtDlp(log, dir, YTDLP_STUB);
    const id = await ytDlp.resolveLiveVideoId("https://example.com/@chan/live", "[t]");
    expect(id).toBeUndefined();
    expect(messages.join("\n")).toContain("printed no id");
  });

  it("logs an error (without crashing) when the override binary is missing", async () => {
    const { log, messages } = makeLog();
    const ytDlp = new YtDlp(log, dir, path.join(dir, "no-such-yt-dlp"));
    const id = await ytDlp.resolveLiveVideoId("https://example.com/@chan/live", "[t]");
    expect(id).toBeUndefined();
    expect(messages.join("\n")).toContain("error [t] yt-dlp binary missing");
  });
});

describe("YtDlp.ensureFresh", () => {
  it("is a no-op when ytDlpPath is overridden", async () => {
    const { log, messages } = makeLog();
    const ytDlp = new YtDlp(log, dir, YTDLP_STUB);
    await ytDlp.ensureFresh();
    expect(messages).toEqual([]);
  });

  it("computes the managed path under the storage dir", () => {
    const { log } = makeLog();
    const ytDlp = new YtDlp(log, "/var/lib/homebridge", undefined);
    expect(ytDlp.managedPath).toBe("/var/lib/homebridge/stream-triggers/yt-dlp");
  });
});
