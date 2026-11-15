import { parseArgs } from "node:util";
import { AuthStore, secret } from "./auth-store.js";
import { readConfig } from "./config.js";
import { projectIdSchema, projectNameSchema } from "./projects.js";
import { SourceStore } from "./store.js";

const usage = "Usage: context init [--project <id> --name <name>]";
const clientName = "admin";
const alreadyIssued = "Bearer <already issued>";
const tokenLifetime = 90 * 86400;

function flag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Prints a new owner password and admin token once. A later run keeps the
// same records and does not print those secrets again.
export async function initCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let projectFlag: string | undefined;
  let nameFlag: string | undefined;
  try {
    const values = parseArgs({
      args,
      options: { project: { type: "string" }, name: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }).values;
    projectFlag = flag(values.project);
    nameFlag = flag(values.name);
  } catch {
    throw new Error(usage);
  }
  if (nameFlag !== undefined && projectFlag === undefined)
    throw new Error(usage);
  if (
    projectFlag !== undefined &&
    !projectIdSchema.safeParse(projectFlag).success
  )
    throw new Error("Invalid project id");
  if (nameFlag !== undefined && !projectNameSchema.safeParse(nameFlag).success)
    throw new Error("Invalid project name");
  const config = readConfig(env);
  if (!config.oauth) throw new Error("CLI requires CONTEXT_PUBLIC_URL");
  const home = config.oauth.areas[0];
  if (!home) throw new Error("Configure 1–8 distinct areas");
  const areas = [...config.oauth.areas];
  const store = new AuthStore(config.databasePath, areas);
  const sources = new SourceStore(config.databasePath);
  try {
    const wanted = projectFlag ?? null;
    const existingProject = projectFlag
      ? sources.findProject(projectFlag)
      : undefined;
    if (projectFlag && !existingProject && nameFlag === undefined)
      throw new Error("Project name is required to create a project");
    if (existingProject && nameFlag && existingProject.name !== nameFlag)
      throw new Error("Project already exists");
    const client = store
      .listClients()
      .find((item) => item.kind === "cli" && item.name === clientName);
    if (client?.revoked) throw new Error("Revoked client");
    const now = store.time();
    const live = client
      ? store
          .listTokens()
          .filter(
            (item) =>
              item.clientId === client.id &&
              item.kind === "cli" &&
              !item.revoked &&
              item.expires > now,
          )
      : [];
    if (live.length) {
      const bindings = new Set(live.map((item) => item.grants.project ?? null));
      if (bindings.size !== 1 || !bindings.has(wanted))
        throw new Error(
          "Admin token already exists for a different project; it was not reprinted",
        );
    }
    let project:
      | { id: string; name: string; home: string; created: boolean }
      | undefined;
    if (projectFlag) {
      if (existingProject) {
        project = {
          id: existingProject.id,
          name: existingProject.name,
          home: existingProject.homeArea,
          created: false,
        };
      } else if (nameFlag) {
        const created = sources.createProject({
          id: projectFlag,
          name: nameFlag,
          homeArea: home,
        });
        project = {
          id: created.id,
          name: created.name,
          home: created.homeArea,
          created: true,
        };
      }
    }
    let password: string | undefined;
    if (!store.hasOwner()) {
      const generated = secret();
      try {
        await store.initOwner(generated);
        password = generated;
      } catch (error) {
        if (!store.hasOwner()) throw error;
      }
    }
    const issued = live.length
      ? undefined
      : store.createCliToken(
          clientName,
          {
            read: areas,
            write: areas,
            process: [],
            ...(wanted ? { project: wanted } : {}),
          },
          home,
          tokenLifetime,
          config.oauth.resource,
        );
    const authorization = issued ? `Bearer ${issued.token}` : alreadyIssued;
    const endpoint = {
      url: config.oauth.resource,
      headers: { Authorization: authorization },
    };
    process.stdout.write(
      `${JSON.stringify(
        {
          mcpUrl: config.oauth.resource,
          owner: password ? { created: true, password } : { created: false },
          admin: {
            created: Boolean(issued),
            client: clientName,
            project: wanted,
            ...(issued ? { token: issued.token } : {}),
          },
          ...(project ? { project } : {}),
          mcp: endpoint,
          cursor: { mcpServers: { context: endpoint } },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    sources.close();
    store.close();
  }
}
