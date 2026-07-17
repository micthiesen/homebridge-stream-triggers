import { tryCatch } from "@micthiesen/mitools/async";
import type { Logging } from "homebridge";
import { z } from "zod";
import { type ChannelConfig, channelSchema } from "./config.js";

const responseSchema = z.object({ channels: z.array(channelSchema) });
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch the channel list from omni-notify's /api/trigger-channels endpoint.
 * Returns undefined on any failure (logged); callers fall back to the
 * accessory cache so previously-known switches keep working.
 */
export async function fetchChannels(
  url: string,
  log: Logging,
): Promise<ChannelConfig[] | undefined> {
  const result = await tryCatch(async () => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return responseSchema.parse(await response.json());
  });
  if (!result.ok) {
    log.error(`Failed to fetch channels from ${url}: ${result.error.message}`);
    return undefined;
  }
  return result.value.channels;
}
