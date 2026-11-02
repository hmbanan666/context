import { z } from "zod";

const text = z.string().trim().min(1);
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("s3"),
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    region: text,
    bucket: text,
    prefix: z.string().default("context/"),
    accessKeyId: text,
    secretAccessKey: text,
  }),
  z.object({
    kind: z.literal("sftp"),
    host: text,
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: text,
    privateKeyPath: text,
    remoteDirectory: text.refine((value) => value.startsWith("/")),
    hostKeySha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }),
]);
export type BackupTargetConfig = z.infer<typeof targetSchema>;

const configSchema = z.object({
  directory: text.default("./backups"),
  at: z
    .string()
    .regex(/^(?:off|(?:[01]\d|2[0-3]):[0-5]\d)$/)
    .default("03:30"),
  timeZone: text.refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  keep: z.coerce.number().int().min(1).max(3650).default(7),
  timeoutMs: z.coerce.number().int().min(1000).max(3600000).default(300000),
  target: targetSchema,
});
export type BackupConfig = z.infer<typeof configSchema>;

export function readBackupConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const kind = env.CONTEXT_BACKUP_TARGET ?? "none";
  const target =
    kind === "s3"
      ? {
          kind,
          endpoint: env.CONTEXT_BACKUP_S3_ENDPOINT,
          region: env.CONTEXT_BACKUP_S3_REGION,
          bucket: env.CONTEXT_BACKUP_S3_BUCKET,
          prefix: env.CONTEXT_BACKUP_S3_PREFIX,
          accessKeyId: env.CONTEXT_BACKUP_S3_ACCESS_KEY,
          secretAccessKey: env.CONTEXT_BACKUP_S3_SECRET_KEY,
        }
      : kind === "sftp"
        ? {
            kind,
            host: env.CONTEXT_BACKUP_SFTP_HOST,
            port: env.CONTEXT_BACKUP_SFTP_PORT || undefined,
            username: env.CONTEXT_BACKUP_SFTP_USER,
            privateKeyPath: env.CONTEXT_BACKUP_SFTP_PRIVATE_KEY_PATH,
            remoteDirectory: env.CONTEXT_BACKUP_SFTP_REMOTE_DIR,
            hostKeySha256: env.CONTEXT_BACKUP_SFTP_HOST_KEY_SHA256,
          }
        : { kind };
  const parsed = configSchema.safeParse({
    directory: env.CONTEXT_BACKUP_DIR,
    at: env.CONTEXT_BACKUP_AT,
    timeZone:
      env.CONTEXT_BACKUP_TIMEZONE ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    keep: env.CONTEXT_BACKUP_KEEP,
    timeoutMs: env.CONTEXT_BACKUP_TIMEOUT_MS,
    target,
  });
  if (!parsed.success)
    throw new Error(
      "Invalid backup configuration; check CONTEXT_BACKUP settings",
    );
  return parsed.data;
}
