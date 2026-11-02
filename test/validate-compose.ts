// Daemon-free integration check, run explicitly in CI after the TypeScript build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readBackupConfig } from "../src/backup-config.js";

interface Compose {
  services: {
    context: {
      environment: Record<string, string>;
      ports?: { host_ip: string; published: string; target: number }[];
      networks: Record<string, unknown>;
      labels?: Record<string, string>;
      volumes: {
        source: string;
        target: string;
        read_only?: boolean;
        bind?: { create_host_path?: boolean };
      }[];
      user?: string;
      read_only: boolean;
      cap_drop: string[];
      security_opt: string[];
    };
  };
  networks: Record<string, { name: string; external?: boolean }>;
  volumes: Record<string, { name: string }>;
}
function render(
  overlay: boolean,
  env: Record<string, string> = {},
  codex = false,
): Compose {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        "fictional-context",
        "--env-file",
        "/dev/null",
        "-f",
        "deploy/compose.yaml",
        ...(overlay ? ["-f", "deploy/dokploy.yaml"] : []),
        ...(codex ? ["-f", "deploy/codex.yaml"] : []),
        "config",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CONTEXT_PUBLIC_URL: "https://context.example/mcp",
          ...(overlay
            ? {
                CONTEXT_HOST: "context.example",
                CONTEXT_PROXY_NETWORK: "fictional-proxy",
              }
            : {}),
          ...env,
        },
      },
    ),
  );
}
const base = render(false);
assert.deepEqual(
  base.services.context.volumes.map((v) => v.target),
  ["/app/data"],
);
assert.equal(base.services.context.ports?.[0]?.host_ip, "127.0.0.1");
assert.equal(base.services.context.ports?.[0]?.published, "3000");
assert.equal(base.services.context.environment.TZ, "UTC");
assert.equal(
  readBackupConfig(base.services.context.environment).directory,
  "/app/data/backups",
);

const hosted = render(true, {
  TZ: "Europe/Berlin",
  CONTEXT_AREAS: "personal,projects,inbox",
  CONTEXT_BACKUP_AT: "04:15",
  CONTEXT_BACKUP_KEEP: "14",
});
const service = hosted.services.context;
assert.equal(
  service.ports?.length ?? 0,
  0,
  "proxy deployment must publish no host port",
);
assert.deepEqual(Object.keys(service.networks), ["dokploy"]);
assert.equal(hosted.networks.dokploy?.name, "fictional-proxy");
assert.equal(hosted.networks.dokploy?.external, true);
assert.deepEqual(
  service.volumes.map((v) => [v.source, v.target]),
  [
    ["sources", "/app/data"],
    ["backups", "/app/backups"],
  ],
);
assert.equal(hosted.volumes.sources?.name, "fictional-context_sources");
assert.equal(hosted.volumes.backups?.name, "fictional-context_backups");
assert.equal(
  service.environment.CONTEXT_PUBLIC_URL,
  "https://context.example/mcp",
);
assert.equal(service.environment.CONTEXT_AREAS, "personal,projects,inbox");
assert.deepEqual(service.labels, {
  "traefik.enable": "true",
  "traefik.docker.network": "fictional-proxy",
  "traefik.http.routers.context.rule": "Host(`context.example`)",
  "traefik.http.routers.context.priority": "10",
  "traefik.http.routers.context.entrypoints": "websecure",
  "traefik.http.routers.context.middlewares": "context-security,context-rate",
  "traefik.http.routers.context.tls.certresolver": "letsencrypt",
  "traefik.http.routers.context-http.rule": "Host(`context.example`)",
  "traefik.http.routers.context-http.entrypoints": "web",
  "traefik.http.routers.context-http.middlewares": "context-https",
  "traefik.http.middlewares.context-https.redirectscheme.scheme": "https",
  "traefik.http.middlewares.context-security.headers.stsseconds": "31536000",
  "traefik.http.middlewares.context-rate.ratelimit.average": "20",
  "traefik.http.middlewares.context-rate.ratelimit.burst": "40",
  "traefik.http.services.context.loadbalancer.server.port": "3000",
});
const backup = readBackupConfig(service.environment);
assert.equal(backup.directory, "/app/backups");
assert.equal(backup.timeZone, "Europe/Berlin");
assert.equal(backup.at, "04:15");
assert.equal(backup.keep, 14);
assert.equal(backup.target.kind, "none");

for (const overlay of [false, true]) {
  const s3 = readBackupConfig(
    render(overlay, {
      CONTEXT_BACKUP_TARGET: "s3",
      CONTEXT_BACKUP_S3_ENDPOINT: "https://s3.example.invalid",
      CONTEXT_BACKUP_S3_REGION: "fictional-region",
      CONTEXT_BACKUP_S3_BUCKET: "fictional-bucket",
      CONTEXT_BACKUP_S3_PREFIX: "",
      CONTEXT_BACKUP_S3_ACCESS_KEY: "fictional-access",
      CONTEXT_BACKUP_S3_SECRET_KEY: "fictional-secret",
    }).services.context.environment,
  ).target;
  assert.deepEqual(s3, {
    kind: "s3",
    endpoint: "https://s3.example.invalid",
    region: "fictional-region",
    bucket: "fictional-bucket",
    prefix: "",
    accessKeyId: "fictional-access",
    secretAccessKey: "fictional-secret",
  });
  const sftp = readBackupConfig(
    render(overlay, {
      CONTEXT_BACKUP_TARGET: "sftp",
      CONTEXT_BACKUP_SFTP_HOST: "sftp.example.invalid",
      CONTEXT_BACKUP_SFTP_PORT: "2222",
      CONTEXT_BACKUP_SFTP_USER: "fictional-owner",
      CONTEXT_BACKUP_SFTP_PRIVATE_KEY_PATH: "/run/secrets/backup_key",
      CONTEXT_BACKUP_SFTP_REMOTE_DIR: "/private/context",
      CONTEXT_BACKUP_SFTP_HOST_KEY_SHA256: "a".repeat(64),
    }).services.context.environment,
  ).target;
  assert.deepEqual(sftp, {
    kind: "sftp",
    host: "sftp.example.invalid",
    port: 2222,
    username: "fictional-owner",
    privateKeyPath: "/run/secrets/backup_key",
    remoteDirectory: "/private/context",
    hostKeySha256: "a".repeat(64),
  });
}
console.log(
  "Compose base and Traefik overlay: ports, routing, volumes, timezone and backup targets passed",
);

for (const overlay of [false, true]) {
  const codex = render(
    overlay,
    {
      CONTEXT_CODEX_BIN: "/opt/synthetic/codex",
      CONTEXT_CODEX_HOME: "/opt/synthetic/context-login",
    },
    true,
  ).services.context;
  assert.equal(codex.environment.CONTEXT_PROCESSOR, "codex");
  assert.equal(codex.environment.CODEX_HOME, "/app/codex");
  assert.equal(codex.user, "1000:1000");
  assert.equal(codex.read_only, true);
  assert.deepEqual(codex.cap_drop, ["ALL"]);
  assert.deepEqual(codex.security_opt, ["no-new-privileges:true"]);
  assert.equal(codex.volumes.length, overlay ? 5 : 4);
  const binary = codex.volumes.find((v) => v.target === "/usr/local/bin/codex");
  assert.equal(binary?.source, "/opt/synthetic/codex");
  assert.equal(binary?.read_only, true);
  assert.equal(binary?.bind?.create_host_path ?? false, false);
  const caBundle = codex.volumes.find(
    (v) => v.target === "/etc/ssl/certs/ca-certificates.crt",
  );
  assert.equal(caBundle?.source, "/etc/ssl/certs/ca-certificates.crt");
  assert.equal(caBundle?.read_only, true);
  assert.equal(caBundle?.bind?.create_host_path ?? false, false);
  const customCaBundle = render(
    overlay,
    {
      CONTEXT_CODEX_BIN: "/opt/synthetic/codex",
      CONTEXT_CODEX_HOME: "/opt/synthetic/context-login",
      CONTEXT_CODEX_CA_BUNDLE: "/opt/synthetic/ca-certificates.crt",
    },
    true,
  ).services.context.volumes.find((v) => v.target === caBundle?.target);
  assert.equal(customCaBundle?.source, "/opt/synthetic/ca-certificates.crt");
  assert.equal(customCaBundle?.read_only, true);
  assert.equal(customCaBundle?.bind?.create_host_path ?? false, false);
  const login = codex.volumes.find((v) => v.target === "/app/codex");
  assert.equal(login?.source, "/opt/synthetic/context-login");
  assert.equal(login?.read_only ?? false, false);
  assert.equal(login?.bind?.create_host_path ?? false, false);
}
console.log(
  "Optional Codex overlay: isolated mounts and inherited hardening passed",
);
