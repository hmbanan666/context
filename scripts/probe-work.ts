import { writeFile } from "node:fs/promises";
import { workFixture } from "../fixtures/synthetic-work.js";
import { githubTargetSchema } from "../src/github-evidence.js";
import { applyWorkAuthorization } from "../src/work.js";

// This public-read protocol probe cannot supply real owner approval or publish anything.
const [mode, repository, branch, pull, outputPath, ...extra] =
  process.argv.slice(2);
if (
  mode !== "--synthetic" ||
  !repository ||
  !branch ||
  !pull ||
  !/^[1-9][0-9]*$/.test(pull) ||
  extra.length
) {
  console.error(
    "Expected --synthetic REPOSITORY BRANCH PR_NUMBER [NEW_CONTEXT_OUTPUT_FILE]",
  );
  process.exitCode = 1;
} else {
  const fixture = await workFixture();
  try {
    const target = githubTargetSchema.parse({
      repository,
      branch,
      baseBranch: "main",
      pullNumber: Number(pull),
      requiredChecks: ["check"],
    });
    const authorization = {
      ...fixture.authorization,
      repository: target.repository,
      branch: target.branch,
    };
    const work = applyWorkAuthorization(
      fixture.work,
      fixture.receipt(authorization),
      fixture.publicKey,
    ).work;
    const observation = await fixture.work.refresh(
      work.id,
      work.scope,
      target.pullNumber,
      "live-read",
    );
    if (observation.observation.error)
      throw new Error("Independent GitHub read failed");
    const context = fixture.work.context(work.id, work.scope);
    const repeated = await fixture.work.refresh(
      work.id,
      work.scope,
      target.pullNumber,
      "live-read",
      async () => {
        throw new Error("Retry must not refetch");
      },
    );
    const originalUnchanged =
      JSON.stringify(
        fixture.sources.find(fixture.source.id, fixture.source.scope),
      ) === JSON.stringify(fixture.source);
    if (!originalUnchanged || !repeated.duplicate)
      throw new Error("Protocol invariant failed");
    if (outputPath)
      await writeFile(outputPath, JSON.stringify(context), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    console.log(
      JSON.stringify({
        synthetic: true,
        authorization: "ephemeral_fixture_key_not_human_approval",
        url: context.latest?.evidence?.url,
        head: context.latest?.evidence?.headSha,
        ci: context.latest?.evidence?.checks.state,
        merge: context.latest?.evidence?.merge,
        result: context.result,
        resultReason: context.resultReason,
        deployment: context.deployment,
        originalUnchanged,
        retrySame: repeated.observation.id === observation.observation.id,
        ...(outputPath ? { contextOutput: outputPath } : {}),
      }),
    );
  } catch {
    console.error(
      "Synthetic public GitHub work probe failed; no verified result claimed",
    );
    process.exitCode = 1;
  } finally {
    await fixture.close();
  }
}
