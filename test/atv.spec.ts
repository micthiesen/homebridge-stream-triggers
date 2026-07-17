import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AppleTv } from "../src/atv.js";
import {
  ATVREMOTE_STUB,
  makeCredentialsDir,
  makeLog,
  makeStubEnv,
  readStubLog,
} from "./helpers.js";

let dir: string;
let stubLog: string;

beforeEach(async () => {
  ({ dir, stubLog } = await makeStubEnv());
});

describe("AppleTv.resolveId", () => {
  it("returns the explicit appleTvId without discovery", async () => {
    const { log } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: "explicit-id",
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir: "/nonexistent",
    });
    expect(await atv.resolveId("[t]")).toBe("explicit-id");
  });

  it("auto-discovers the single pairing directory", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["AA:BB:CC"]);
    const { log } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });
    expect(await atv.resolveId("[t]")).toBe("AA:BB:CC");
  });

  it("errors (without throwing) on zero candidates", async () => {
    const credentialsDir = await makeCredentialsDir(dir, []);
    const { log, messages } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });
    expect(await atv.resolveId("[t]")).toBeUndefined();
    expect(messages.join("\n")).toContain("error");
    expect(messages.join("\n")).toContain("found 0");
  });

  it("errors (without throwing) on multiple candidates", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["one", "two"]);
    const { log, messages } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });
    expect(await atv.resolveId("[t]")).toBeUndefined();
    expect(messages.join("\n")).toContain("found 2");
  });

  it("ignores subdirectories without credentials.txt", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["real-atv"]);
    await fs.mkdir(path.join(credentialsDir, "not-a-pairing"));
    const { log } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });
    expect(await atv.resolveId("[t]")).toBe("real-atv");
  });
});

describe("AppleTv.run", () => {
  it("invokes atvremote with id, credentials, and the command", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["AA:BB"], "SECRET123");
    const { log } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });

    expect(await atv.run("turn_on", "[t]")).toBe(true);
    const lines = await readStubLog(stubLog);
    expect(lines).toEqual([
      "atvremote --id AA:BB --companion-credentials SECRET123 turn_on",
    ]);
  });

  it("returns false and logs on non-zero exit", async () => {
    process.env.ATV_STUB_MODE = "fail";
    const credentialsDir = await makeCredentialsDir(dir, ["AA:BB"]);
    const { log, messages } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });

    expect(await atv.run("turn_on", "[t]")).toBe(false);
    expect(messages.join("\n")).toContain("atvremote turn_on failed");
    expect(messages.join("\n")).toContain("pyatv: something went wrong");
  });

  it("returns false and logs when the binary is missing", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["AA:BB"]);
    const { log, messages } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: path.join(dir, "no-such-binary"),
      credentialsDir,
    });

    expect(await atv.run("turn_on", "[t]")).toBe(false);
    expect(messages.join("\n")).toContain("binary not found");
  });

  it("returns false and logs when credentials.txt is empty", async () => {
    const credentialsDir = await makeCredentialsDir(dir, ["AA:BB"], "");
    const { log, messages } = makeLog();
    const atv = new AppleTv(log, {
      appleTvId: undefined,
      atvremotePath: ATVREMOTE_STUB,
      credentialsDir,
    });

    expect(await atv.run("turn_on", "[t]")).toBe(false);
    expect(messages.join("\n")).toContain("is empty");
  });
});
