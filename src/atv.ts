import fs from "node:fs/promises";
import path from "node:path";
import { tryCatch } from "@micthiesen/mitools/async";
import type { Logging } from "homebridge";
import type { StreamTriggersConfig } from "./config.js";
import { describeExecError, runCommand } from "./exec.js";

const ATVREMOTE_TIMEOUT_MS = 30_000;

/**
 * Thin wrapper around the atvremote binary from homebridge-appletv-enhanced's venv,
 * reusing that plugin's Companion pairing credentials.
 */
export class AppleTv {
  private discoveredId: string | undefined;

  constructor(
    private readonly log: Logging,
    private readonly config: Pick<
      StreamTriggersConfig,
      "appleTvId" | "atvremotePath" | "credentialsDir"
    >,
  ) {}

  /** Run one atvremote command (e.g. "turn_on"). Logs failures; never throws. */
  async run(command: string, prefix: string): Promise<boolean> {
    const id = await this.resolveId(prefix);
    if (!id) return false;
    const credentials = await this.readCredentials(id, prefix);
    if (!credentials) return false;

    this.log.debug(`${prefix} atvremote ${command}`);
    const result = await runCommand(
      this.config.atvremotePath,
      ["--id", id, "--companion-credentials", credentials, command],
      ATVREMOTE_TIMEOUT_MS,
    );
    if (!result.ok) {
      this.log.error(
        `${prefix} atvremote ${command} failed: ${describeExecError(result.error)}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Explicit appleTvId, or auto-discovery: the single subdirectory of credentialsDir
   * containing a credentials.txt. Logs an error (never crashes) on zero or multiple.
   */
  async resolveId(prefix: string): Promise<string | undefined> {
    if (this.config.appleTvId) return this.config.appleTvId;
    if (this.discoveredId) return this.discoveredId;

    const dir = this.config.credentialsDir;
    const candidates = await tryCatch(async () => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const hasCredentials = await tryCatch(() =>
          fs.access(path.join(dir, entry.name, "credentials.txt")),
        );
        if (hasCredentials.ok) found.push(entry.name);
      }
      return found;
    });

    if (!candidates.ok) {
      this.log.error(
        `${prefix} Cannot read credentials dir ${dir}: ${candidates.error.message}`,
      );
      return undefined;
    }
    if (candidates.value.length !== 1) {
      this.log.error(
        `${prefix} Expected exactly one Apple TV pairing in ${dir}, found ` +
          `${candidates.value.length} (${candidates.value.join(", ") || "none"}). ` +
          `Set "appleTvId" explicitly.`,
      );
      return undefined;
    }

    this.discoveredId = candidates.value[0];
    this.log.info(`${prefix} Auto-discovered Apple TV id ${this.discoveredId}`);
    return this.discoveredId;
  }

  /** Companion credentials = first line of <credentialsDir>/<id>/credentials.txt. */
  private async readCredentials(
    id: string,
    prefix: string,
  ): Promise<string | undefined> {
    const file = path.join(this.config.credentialsDir, id, "credentials.txt");
    const result = await tryCatch(() => fs.readFile(file, "utf8"));
    if (!result.ok) {
      this.log.error(`${prefix} Cannot read ${file}: ${result.error.message}`);
      return undefined;
    }
    const credentials = result.value.split("\n")[0]?.trim();
    if (!credentials) {
      this.log.error(`${prefix} ${file} is empty`);
      return undefined;
    }
    return credentials;
  }
}
