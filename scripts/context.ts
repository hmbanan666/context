#!/usr/bin/env node
import { AuthStore } from "../src/auth-store.js";
import { readConfig } from "../src/config.js";
import { evalCommand } from "../src/eval-cli.js";
import { groundingCommand } from "../src/grounding-cli.js";
import { runIndexCommand } from "../src/index-command.js";
import { initCommand } from "../src/init-command.js";
import { runReindexCommand } from "../src/reindex-command.js";
import { projectCommand } from "../src/project-cli.js";
import { projectIdSchema } from "../src/projects.js";
import { searchCommand } from "../src/search-cli.js";
import { SourceStore } from "../src/store.js";
import { tidyCommand } from "../src/tidy-cli.js";
import { docCommand } from "../src/doc-cli.js";
import { rememberCommand } from "../src/remember-cli.js";
import { statusCommand } from "../src/status-cli.js";
import { runImport } from "./import-jsonl.js";
import { runMarkdownImport } from "./import-markdown.js";

const tokenUsage = `Usage: context token <command>

  token create <name> --read a,b --write a --default-write a [--project <id>] [--create-projects] [--may-approve] [--expires 90d]
  token list
  token revoke <id>
  token revoke --name <name>

The token name cannot start with -. --create-projects lets that area token create a missing project on remember. It cannot be combined with --project. --may-approve is a separate capability and defaults to off.`;

const usage = `Usage: context <command>

  init [--project <id> --name <name>]
  owner init
  client list
  client revoke <id>
  token create <name> --read a,b --write a --default-write a [--project <id>] [--create-projects] [--may-approve] [--expires 90d]
  token list
  token revoke <id>
  token revoke --name <name>
  remember [--area <area>] [--project <id>] [--kind note] [--idempotency-key <key>] [text]
  import jsonl --source <name> [--area <a>] [--file <path>]
  import markdown <dir> [--area <a>] [--project <id>] [--prune] [--prune-legacy] [--force]
  doc remove <doc:project:type:key or source id>
  doc restore <doc:project:type:key or source id>
  source restore <source id>
  project create|rename|list|map|unmap|backfill|profile|glossary|review
  reindex --embeddings [--batch N]
  search --query <text> --scope <area> [--project <id>] [--mode pack] [--budget-bytes <n>]
  grounding explain (--query <text> | --file <questions.yaml>) [--area <a>] [--project <id>] [--json]
  status
  index rebuild
  tidy [--dry-run] [--json]
  eval`;

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
  const command = process.argv[2];
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (command === "tidy") {
    await tidyCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "eval") {
    await evalCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "project") {
    projectCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "search") {
    searchCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "grounding") {
    await groundingCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "reindex") {
    await runReindexCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "init") {
    await initCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "remember") {
    await rememberCommand(process.argv.slice(3), process.env);
    return;
  }
  if (command === "status") {
    statusCommand(process.env);
    return;
  }
  const [kind, action, name, ...args] = process.argv.slice(2);
  if (
    kind === "token" &&
    (action === "--help" ||
      action === "-h" ||
      name === "--help" ||
      name === "-h")
  ) {
    process.stdout.write(`${tokenUsage}\n`);
    return;
  }
  if (kind === "token" && action === "create" && name?.startsWith("-"))
    throw new Error("Invalid token name");
  if (kind === "import" && action === "jsonl") {
    await runImport(process.argv.slice(4));
    return;
  }
  if (kind === "import" && action === "markdown") {
    await runMarkdownImport(process.argv.slice(4));
    return;
  }
  if (kind === "doc" || (kind === "source" && action === "restore")) {
    docCommand(
      [kind === "source" ? "restore" : action, name, ...args].filter(
        (part): part is string => part !== undefined,
      ),
      process.env,
    );
    return;
  }
  if (kind === "index") {
    if (name || args.length) throw new Error("Unexpected index arguments");
    await runIndexCommand(action, process.env);
    return;
  }
  if (kind !== "owner" && kind !== "client" && kind !== "token")
    throw new Error(usage);
  const config = readConfig(process.env);
  if (!config.oauth) throw new Error("CLI requires CONTEXT_PUBLIC_URL");
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
      kind === "token" &&
      action === "revoke" &&
      name === "--name" &&
      args.length === 1 &&
      args[0]
    ) {
      store.revokeTokensByName(args[0]);
      process.stdout.write("Revoked.\n");
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
      // Capabilities are separate flags and separate booleans on the credential.
      const booleanFlags = new Set(["--create-projects", "--may-approve"]);
      const valued = new Set([
        "--read",
        "--write",
        "--process",
        "--default-write",
        "--expires",
        "--project",
      ]);
      const options = new Map<string, string>();
      const flags = new Set<string>();
      for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (!key?.startsWith("--")) throw new Error("Invalid token options");
        if (booleanFlags.has(key)) {
          if (flags.has(key)) throw new Error("Invalid token options");
          flags.add(key);
          continue;
        }
        const value = args[++i];
        if (value === undefined || !valued.has(key) || options.has(key))
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
      const project = options.get("--project");
      if (project !== undefined && !projectIdSchema.safeParse(project).success)
        throw new Error("Invalid token options");
      const createProjects = flags.has("--create-projects");
      if (createProjects && project)
        throw new Error("--create-projects cannot be combined with --project");
      if (project) {
        const sources = new SourceStore(config.databasePath);
        let known = false;
        try {
          known = sources.hasProject(project);
        } finally {
          sources.close();
        }
        if (!known) {
          process.stderr.write("Unknown project\n");
          process.exitCode = 1;
          return;
        }
      }
      const result = store.createCliToken(
        name,
        {
          read: list("--read"),
          write: list("--write"),
          process: list("--process"),
          ...(project ? { project } : {}),
        },
        options.get("--default-write") ?? null,
        seconds,
        config.oauth.resource,
        createProjects,
        flags.has("--may-approve"),
      );
      process.stdout.write(`${result.token}\n`);
      return;
    }
    throw new Error(usage);
  } finally {
    store.close();
  }
}
// Do not serialize raw errors: they may contain credentials or request data.
void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Command failed";
  if (process.argv[2] === "import") {
    const safe =
      /^(Usage:|Refusing to prune|Folder not found|Not a directory|Unknown area|Unknown project|Area is required|Persistent database required|Invalid configured areas)/.test(
        message,
      );
    process.stderr.write(
      safe
        ? `${message}\n`
        : '{"type":"error","reason":"import_failed_check_arguments_configuration_or_io"}\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
