import { beforeEach, describe, expect, it } from "vitest";
import { AppleTv } from "../src/atv.js";
import { StreamLauncher } from "../src/launcher.js";
import { YtDlp } from "../src/ytdlp.js";
import {
  ATVREMOTE_STUB,
  type CapturedLog,
  makeCredentialsDir,
  makeLog,
  makeStubEnv,
  readStubLog,
  YTDLP_STUB,
} from "./helpers.js";

let dir: string;
let stubLog: string;
let captured: CapturedLog;

async function makeLauncher(atvremotePath = ATVREMOTE_STUB): Promise<StreamLauncher> {
  const credentialsDir = await makeCredentialsDir(dir, ["AA:BB"], "SECRET123");
  captured = makeLog();
  const atv = new AppleTv(captured.log, {
    appleTvId: undefined,
    atvremotePath,
    credentialsDir,
  });
  const ytDlp = new YtDlp(captured.log, dir, YTDLP_STUB);
  return new StreamLauncher(captured.log, atv, ytDlp);
}

beforeEach(async () => {
  ({ dir, stubLog } = await makeStubEnv());
});

describe("StreamLauncher", () => {
  it("runs the full youtube flow: turn_on, app_list prime, resolve, deep link", async () => {
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "destiny",
      type: "youtube",
      url: "https://www.youtube.com/@destiny/live",
    });

    const lines = await readStubLog(stubLog);
    expect(lines).toEqual([
      "atvremote --id AA:BB --companion-credentials SECRET123 turn_on",
      "atvremote --id AA:BB --companion-credentials SECRET123 app_list",
      "yt-dlp --print id --no-warnings https://www.youtube.com/@destiny/live",
      "atvremote --id AA:BB --companion-credentials SECRET123 launch_app=youtube://www.youtube.com/watch?v=fakeVideoId123",
    ]);
    expect(captured.messages.join("\n")).toContain(
      "[destiny] Launched youtube://www.youtube.com/watch?v=fakeVideoId123",
    );
  });

  it("launches the twitch app without touching yt-dlp", async () => {
    const launcher = await makeLauncher();
    await launcher.launch({ key: "jerma", type: "twitch" });

    const lines = await readStubLog(stubLog);
    expect(lines).toEqual([
      "atvremote --id AA:BB --companion-credentials SECRET123 turn_on",
      "atvremote --id AA:BB --companion-credentials SECRET123 app_list",
      "atvremote --id AA:BB --companion-credentials SECRET123 launch_app=tv.twitch",
    ]);
  });

  it("tries a twitch url as a deep link when one is provided", async () => {
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "jerma",
      type: "twitch",
      url: "https://www.twitch.tv/jerma985",
    });

    const lines = await readStubLog(stubLog);
    expect(lines.at(-1)).toContain("launch_app=https://www.twitch.tv/jerma985");
  });

  it("falls back to the Twitch app when the deep link is rejected", async () => {
    process.env.ATV_STUB_MODE = "fail_deeplink";
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "jerma",
      type: "twitch",
      url: "https://www.twitch.tv/jerma985",
    });

    const lines = await readStubLog(stubLog);
    expect(lines.at(-2)).toContain("launch_app=https://www.twitch.tv/jerma985");
    expect(lines.at(-1)).toContain("launch_app=tv.twitch");
    expect(captured.messages.join("\n")).toContain("Deep link rejected");
  });

  it("launches a kick channel via its universal link", async () => {
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "vinesauce",
      type: "kick",
      url: "https://kick.com/vinesauce",
    });

    const lines = await readStubLog(stubLog);
    expect(lines).toEqual([
      "atvremote --id AA:BB --companion-credentials SECRET123 turn_on",
      "atvremote --id AA:BB --companion-credentials SECRET123 app_list",
      "atvremote --id AA:BB --companion-credentials SECRET123 launch_app=https://kick.com/vinesauce",
    ]);
  });

  it("falls back to opening the Kick app when the deep link is rejected", async () => {
    process.env.ATV_STUB_MODE = "fail_deeplink";
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "vinesauce",
      type: "kick",
      url: "https://kick.com/vinesauce",
    });

    const lines = await readStubLog(stubLog);
    expect(lines.at(-2)).toContain("launch_app=https://kick.com/vinesauce");
    expect(lines.at(-1)).toContain("launch_app=com.kick.mobile");
    expect(captured.messages.join("\n")).toContain("Deep link rejected");
  });

  it("opens the Kick app directly when a kick channel has no url", async () => {
    const launcher = await makeLauncher();
    await launcher.launch({ key: "vinesauce", type: "kick" });

    const lines = await readStubLog(stubLog);
    expect(lines.at(-1)).toContain("launch_app=com.kick.mobile");
  });

  it("stops cleanly after the prime when the channel is not live", async () => {
    process.env.YTDLP_STUB_MODE = "notlive";
    const launcher = await makeLauncher();
    await launcher.launch({
      key: "destiny",
      type: "youtube",
      url: "https://www.youtube.com/@destiny/live",
    });

    const lines = await readStubLog(stubLog);
    expect(lines.filter((l) => l.includes("launch_app"))).toEqual([]);
    expect(captured.messages.join("\n")).toContain("[destiny] Not live");
    expect(captured.messages.filter((m) => m.startsWith("error"))).toEqual([]);
  });

  it("stops (with an error log, without throwing) when atvremote is missing", async () => {
    const launcher = await makeLauncher(`${dir}/no-such-atvremote`);
    await launcher.launch({ key: "jerma", type: "twitch" });

    expect(await readStubLog(stubLog)).toEqual([]);
    expect(captured.messages.join("\n")).toContain("binary not found");
  });

  it("stops after turn_on when atvremote starts failing", async () => {
    process.env.ATV_STUB_MODE = "fail";
    const launcher = await makeLauncher();
    await launcher.launch({ key: "jerma", type: "twitch" });

    const lines = await readStubLog(stubLog);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("turn_on");
    expect(captured.messages.join("\n")).toContain("atvremote turn_on failed");
  });
});
