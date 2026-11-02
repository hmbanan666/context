#!/usr/bin/env node
import { AuthStore } from "../src/auth-store.js";
import { readConfig } from "../src/config.js";
import { runImport } from "./import-jsonl.js";

async function passwordInput() {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk;
      if (Buffer.byteLength(value) > 4096)
        throw new Error("Password input too large");
    }
    return value.replace(/\r?\n$/, "");
  }
  process.stderr.write("New owner password (12–1024 characters): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === "\u0003") {
            cleanup();
            reject(new Error("Cancelled"));
            return;
          }
          if (char === "\r" || char === "\n") {
            cleanup();
            resolve(value);
            return;
          }
          if (char === "\u007f") value = value.slice(0, -1);
          else value += char;
          if (value.length > 1024) {
            cleanup();
            reject(new Error("Password too long"));
            return;
          }
        }
      };
      const cleanup = () => process.stdin.off("data", onData);
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}
async function main() {
  const [kind, action, name, ...args] = process.argv.slice(2);
  if (kind === "import" && action === "jsonl") {
    await runImport(process.argv.slice(4));
    return;
  }
  const config = readConfig(process.env);
  if (!config.oauth)
    throw new Error("CLI requires CONTEXT_AUTH=oauth and CONTEXT_PUBLIC_URL");
  const store = new AuthStore(config.databasePath, config.oauth.areas);
  try {
    if (kind === "owner" && action === "init" && !name) {
      if (store.hasOwner()) throw new Error("Owner is already initialized");
      const password = await passwordInput();
      if (process.stdin.isTTY) {
        const confirm = await passwordInput();
        if (password !== confirm) throw new Error("Passwords do not match");
      }
      await store.initOwner(password);
      process.stdout.write(
        "Owner initialized. Register a passkey at the first OAuth login.\n",
      );
      return;
    }
    if (kind === "client" && action === "list" && !name) {
      process.stdout.write(`${JSON.stringify(store.listClients(), null, 2)}\n`);
      return;
    }
    if (kind === "token" && action === "list" && !name) {
      process.stdout.write(`${JSON.stringify(store.listTokens(), null, 2)}\n`);
      return;
    }
    if (
      action === "revoke" &&
      name &&
      !args.length &&
      (kind === "client" || kind === "token")
    ) {
      if (kind === "client") store.revokeClient(name);
      else store.revokeToken(name);
      process.stdout.write("Revoked.\n");
      return;
    }
    if (kind === "token" && action === "create" && name) {
      const options = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i],
          value = args[i + 1];
        if (
          !key ||
          value === undefined ||
          ![
            "--read",
            "--write",
            "--process",
            "--default-write",
            "--expires",
          ].includes(key) ||
          options.has(key)
        )
          throw new Error("Invalid token options");
        options.set(key, value);
      }
      const list = (key: string) =>
        (options.get(key) ?? "").split(",").filter(Boolean);
      const expiry = options.get("--expires") ?? "90d";
      const match = /^([1-9]\d{0,3})([dhm])$/.exec(expiry);
      if (!match)
        throw new Error("Expiry must be a bounded duration such as 90d");
      const seconds =
        Number(match[1]) * ({ d: 86400, h: 3600, m: 60 }[match[2] ?? ""] ?? 0);
      const result = store.createCliToken(
        name,
        {
          read: list("--read"),
          write: list("--write"),
          process: list("--process"),
        },
        options.get("--default-write") ?? null,
        seconds,
        config.oauth.resource,
      );
      process.stdout.write(`${result.token}\n`);
      return;
    }
    throw new Error(
      "Usage: context owner init | client list|revoke <id> | token create <name> --read a,b --write a --default-write a [--expires 90d] | token list|revoke <id>",
    );
  } finally {
    store.close();
  }
}
// Do not serialize raw errors: they may contain credentials or request data.
void main().catch(() => {
  if (process.argv[2] === "import") {
    process.stderr.write(
      '{"type":"error","reason":"import_failed_check_arguments_configuration_or_io"}\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    "Context command failed; check arguments, protected configuration and owner state.\n",
  );
  process.exitCode = 1;
});
