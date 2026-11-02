import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic CLI boundary: never uses the host's Codex login or network.
export async function fakeCodex(body: string, loginBody = "process.exit(0);") {
  const directory = await mkdtemp(join(process.cwd(), ".output-codex-"));
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}');
  await writeFile(
    join(directory, "codex"),
    `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login') {
  assert.deepEqual(args, ['login', 'status']);
  ${loginBody}
  return;
}
const prompt = fs.readFileSync(0, 'utf8');
const data = JSON.parse(prompt.trim().split('\\n').at(-1));
function respond(value) {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));
  console.log(JSON.stringify({type:'turn.completed'}));
}
${body}
`,
    { mode: 0o700 },
  );
  return {
    directory,
    env: {
      PATH: directory,
      HOME: directory,
      CODEX_HOME: join(directory, "login"),
      CONTEXT_PROCESSOR: "codex",
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
