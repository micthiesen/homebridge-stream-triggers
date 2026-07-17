import { z } from "zod";

export const channelSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1).optional(),
  type: z.enum(["youtube", "twitch"]),
  url: z.string().min(1).optional(),
});

export type ChannelConfig = z.infer<typeof channelSchema>;

export const configSchema = z.object({
  /** Static override; when empty the list is fetched from channelsUrl. */
  channels: z.array(channelSchema).default([]),
  channelsUrl: z.string().default("http://omni.boris/api/trigger-channels"),
  /** How often to re-fetch the channel list and re-sync switches. 0 disables. */
  channelsRefreshInterval: z.number().int().nonnegative().default(3_600_000),
  credentialsDir: z.string().default("/var/lib/homebridge/appletv-enhanced"),
  appleTvId: z.string().optional(),
  atvremotePath: z
    .string()
    .default("/var/lib/homebridge/appletv-enhanced/.venv/bin/atvremote"),
  ytDlpPath: z.string().optional(),
  suffix: z.string().default(" Trigger"),
  resetDelay: z.number().int().positive().default(2000),
});

export type StreamTriggersConfig = z.infer<typeof configSchema>;

/** Pure parse of the raw platform config; throws ZodError on invalid input. */
export function parseConfig(raw: unknown): StreamTriggersConfig {
  return configSchema.parse(raw);
}

/** Display name defaults to the capitalized key. */
export function displayNameFor(channel: ChannelConfig): string {
  if (channel.displayName) return channel.displayName;
  return channel.key.charAt(0).toUpperCase() + channel.key.slice(1);
}
