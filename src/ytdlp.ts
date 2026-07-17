import fs from "node:fs/promises";
import path from "node:path";
import { tryCatch } from "@micthiesen/mitools/async";
import type { Logging } from "homebridge";
import { describeExecError, isMissingBinaryError, runCommand } from "./exec.js";

const YTDLP_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** GitHub release asset name for the standalone yt-dlp binary, per platform. */
export function ytDlpAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  if (platform === "linux" && arch === "x64") return "yt-dlp_linux";
  if (platform === "linux" && arch === "arm64") return "yt-dlp_linux_aarch64";
  if (platform === "darwin") return "yt-dlp_macos";
  return undefined;
}

/** A binary older than this is considered stale and gets re-downloaded. */
export function isStale(mtimeMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - mtimeMs > MAX_AGE_MS;
}

/**
 * Self-managed yt-dlp binary: downloaded into Homebridge's storage dir and refreshed
 * when older than 30 days (stale copies break against YouTube within months).
 * An explicit ytDlpPath override disables all self-management.
 */
export class YtDlp {
  public readonly managedPath: string;
  private refreshInFlight: Promise<void> | undefined;

  constructor(
    private readonly log: Logging,
    storagePath: string,
    private readonly overridePath: string | undefined,
  ) {
    this.managedPath = path.join(storagePath, "stream-triggers", "yt-dlp");
  }

  /** Download/refresh the managed binary if missing or stale. Never rejects. */
  ensureFresh(): Promise<void> {
    if (this.overridePath) return Promise.resolve();
    this.refreshInFlight ??= this.refresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /**
   * Resolve the currently-live video id for a channel live page.
   * Returns undefined when the channel is not live or yt-dlp is unavailable
   * (both logged; neither throws).
   */
  async resolveLiveVideoId(url: string, prefix: string): Promise<string | undefined> {
    const binary = await this.binaryPath(prefix);
    if (!binary) return undefined;

    this.log.debug(`${prefix} yt-dlp --print id ${url}`);
    const result = await runCommand(
      binary,
      ["--print", "id", "--no-warnings", url],
      YTDLP_TIMEOUT_MS,
    );
    if (!result.ok) {
      if (isMissingBinaryError(result.error)) {
        this.log.error(`${prefix} yt-dlp binary missing at ${binary}`);
        void this.ensureFresh();
      } else {
        // Non-zero exit = channel not live. Expected, not an error.
        this.log.info(
          `${prefix} Not live (yt-dlp: ${describeExecError(result.error)})`,
        );
      }
      return undefined;
    }

    const id = result.value.stdout.trim().split("\n").at(-1)?.trim();
    if (!id) {
      this.log.info(`${prefix} Not live (yt-dlp printed no id)`);
      return undefined;
    }
    return id;
  }

  /** Path to a usable binary, or undefined (logged) if none exists yet. */
  private async binaryPath(prefix: string): Promise<string | undefined> {
    if (this.overridePath) return this.overridePath;
    const stat = await tryCatch(() => fs.stat(this.managedPath));
    if (stat.ok) return this.managedPath;
    this.log.error(
      `${prefix} yt-dlp not downloaded yet (${this.managedPath}); retrying download in the background`,
    );
    void this.ensureFresh();
    return undefined;
  }

  private async refresh(): Promise<void> {
    const stat = await tryCatch(() => fs.stat(this.managedPath));
    if (stat.ok && !isStale(stat.value.mtimeMs)) {
      this.log.debug(`yt-dlp binary is fresh (${this.managedPath})`);
      return;
    }

    const downloaded = await tryCatch(() => this.download());
    if (!downloaded.ok) {
      this.log.error(`Failed to download yt-dlp: ${downloaded.error.message}`);
    }
  }

  private async download(): Promise<void> {
    const asset = ytDlpAssetName();
    if (!asset) {
      throw new Error(`No yt-dlp asset for ${process.platform}/${process.arch}`);
    }
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    this.log.info(`Downloading ${url}`);

    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const body = Buffer.from(await response.arrayBuffer());

    await fs.mkdir(path.dirname(this.managedPath), { recursive: true });
    const tmpPath = `${this.managedPath}.tmp`;
    await fs.writeFile(tmpPath, body, { mode: 0o755 });
    await fs.rename(tmpPath, this.managedPath);
    this.log.info(
      `Downloaded yt-dlp (${(body.length / 1024 / 1024).toFixed(1)} MB) to ${this.managedPath}`,
    );
  }
}
