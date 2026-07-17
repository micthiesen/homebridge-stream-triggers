import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Logging } from "homebridge";
import { onTestFinished } from "vitest";

export interface CapturedLog {
  log: Logging;
  messages: string[];
}

/** Fake Homebridge Logging that captures "<level> <message>" lines. */
export function makeLog(): CapturedLog {
  const messages: string[] = [];
  const push =
    (level: string) =>
    (message: string, ...parameters: unknown[]) => {
      messages.push(
        [`${level} ${message}`, ...parameters.map(String)].join(" ").trimEnd(),
      );
    };
  const log = Object.assign(push("info"), {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
    log: push("log"),
    success: push("success"),
    prefix: "test",
  });
  return { log: log as unknown as Logging, messages };
}

export const STUBS_DIR = path.join(import.meta.dirname, "stubs");
export const ATVREMOTE_STUB = path.join(STUBS_DIR, "atvremote");
export const YTDLP_STUB = path.join(STUBS_DIR, "yt-dlp");

/** Fresh temp dir (removed after the test) + stub log file; sets STUB_LOG for the stubs. */
export async function makeStubEnv(): Promise<{ dir: string; stubLog: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-triggers-test-"));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const stubLog = path.join(dir, "stub.log");
  process.env.STUB_LOG = stubLog;
  delete process.env.ATV_STUB_MODE;
  delete process.env.YTDLP_STUB_MODE;
  return { dir, stubLog };
}

export async function readStubLog(stubLog: string): Promise<string[]> {
  try {
    const content = await fs.readFile(stubLog, "utf8");
    return content.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export interface TestJsonServer {
  url: string;
  close: () => Promise<void>;
}

/** Throwaway local HTTP server; the handler gets the 1-based request count. */
export async function serveJson(
  handler: (requestCount: number) => { status?: number; body: unknown },
): Promise<TestJsonServer> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    const { status = 200, body } = handler(count);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/trigger-channels`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A URL that refuses connections immediately (port 1 is never listened on). */
export function refusedUrl(): string {
  return "http://127.0.0.1:1/api/trigger-channels";
}

/** Create <dir>/credentials/<id>/credentials.txt and return the credentials dir. */
export async function makeCredentialsDir(
  dir: string,
  ids: string[],
  firstLine = "COMPANION-CREDS",
): Promise<string> {
  const credentialsDir = path.join(dir, "credentials");
  for (const id of ids) {
    await fs.mkdir(path.join(credentialsDir, id), { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, id, "credentials.txt"),
      `${firstLine}\nsecond-line-ignored\n`,
    );
  }
  await fs.mkdir(credentialsDir, { recursive: true });
  return credentialsDir;
}
