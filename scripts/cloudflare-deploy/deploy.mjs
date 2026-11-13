#!/usr/bin/env node
// Deploy Open-Inspect's Cloudflare Workers with Wrangler.
//
// Terraform provisions the Worker scripts, D1, KV, R2, Queues and sandbox
// artifacts; this uploads the code and configuration for one environment:
//
//   1. validate the settings (environment variables, see deploy.env.example)
//   2. look up the IDs of the resources Terraform created
//   3. apply D1 migrations
//   4. `wrangler deploy` the control plane, the enabled bots and, when
//      WEB_PLATFORM=cloudflare, the web app
//   5. prune Boat base snapshots the control plane no longer serves
//   6. delete secrets the configuration no longer binds
//
// Usage: node scripts/cloudflare-deploy/deploy.mjs [--dry-run] [--skip-build]
//   --dry-run     validate and print the plan; no Cloudflare calls, placeholder
//                 resource IDs, and `wrangler deploy --dry-run`
//   --skip-build  reuse existing dist/ bundles (the web app is always built,
//                 because its NEXT_PUBLIC_* values are inlined at build time)
//
// Requires CLOUDFLARE_API_TOKEN (except with --dry-run) plus the settings.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createCloudflareApi } from "./cloudflare-api.mjs";
import {
  ConfigError,
  planWeb,
  planWorkers,
  readSettings,
  requiredKvTitles,
  resourceNames,
  sandboxHashProvider,
  secretActions,
  webBuildEnv,
} from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Generated next to each package's sources so `main` and asset paths resolve;
// gitignored.
export const GENERATED_CONFIG = "wrangler.deploy.json";
const PLACEHOLDER_ID = "00000000000000000000000000000000";

function run(command, args, { cwd = ROOT, env = {} } = {}) {
  console.log(
    `$ ${[command, ...args].join(" ")}${cwd === ROOT ? "" : `  (in ${cwd.slice(ROOT.length + 1)})`}`
  );
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}`);
  }
}

function sandboxHash(provider) {
  const result = spawnSync(
    "python3",
    ["packages/sandbox-images/cli.py", "hash", "--root", ROOT, "--provider", provider],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`Sandbox source hash failed:\n${result.stderr}`);
  return JSON.parse(result.stdout).hash;
}

async function lookUpResources(settings, api, dryRun) {
  const names = resourceNames(settings);
  const hashProvider = sandboxHashProvider(settings);
  const sandbox = hashProvider === null ? null : sandboxHash(hashProvider);
  if (dryRun) {
    return {
      kvIds: Object.fromEntries(requiredKvTitles(settings).map((title) => [title, PLACEHOLDER_ID])),
      d1DatabaseId: "00000000-0000-0000-0000-000000000000",
      controlPlaneMigrationTag: null,
      sandboxHash: sandbox,
    };
  }
  const titles = requiredKvTitles(settings);
  const kvIds = await api.kvNamespaceIds(titles);
  const missing = titles.filter((title) => !kvIds[title]);
  if (missing.length > 0) {
    throw new Error(
      `KV namespaces not found: ${missing.join(", ")}. Run the Terraform apply for this environment first.`
    );
  }
  return {
    kvIds,
    d1DatabaseId: await api.d1DatabaseId(names.d1Database),
    controlPlaneMigrationTag: await api.migrationTag(names.controlPlane),
    sandboxHash: sandbox,
  };
}

/** Fail before uploading anything when a Terraform-generated secret is neither supplied nor already bound. */
async function checkPreservedSecrets(targets, api) {
  const problems = [];
  for (const target of targets) {
    const { mustExist } = secretActions(target);
    if (mustExist.length === 0) continue;
    const existing = new Set(await api.secretNames(target.wrangler.name));
    const absent = mustExist.filter((name) => !existing.has(name));
    if (absent.length > 0) problems.push(`${target.wrangler.name}: ${absent.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "These Terraform-generated secrets are not in the environment and not yet on the Worker:",
        ...problems.map((p) => `  - ${p}`),
        "Copy them from Terraform state into the GitHub Environment once:",
        "  node scripts/cloudflare-deploy/sync-generated-secrets.mjs --environment <name>",
      ].join("\n")
    );
  }
}

function deployTarget(target, { accountId, dryRun }) {
  const cwd = join(ROOT, target.packageDir);
  const config = { account_id: accountId, ...target.wrangler };
  writeFileSync(join(cwd, GENERATED_CONFIG), `${JSON.stringify(config, null, 2)}\n`);
  const { upload } = secretActions(target);
  const secretsDir = mkdtempSync(join(tmpdir(), "open-inspect-secrets-"));
  const secretsFile = join(secretsDir, "secrets.json");
  try {
    writeFileSync(secretsFile, JSON.stringify(upload), { mode: 0o600 });
    run(
      "npx",
      [
        "wrangler",
        "deploy",
        "--config",
        GENERATED_CONFIG,
        "--secrets-file",
        secretsFile,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { cwd }
    );
  } finally {
    rmSync(secretsDir, { recursive: true, force: true });
  }
}

async function removeStaleSecrets(target, api) {
  const { remove } = secretActions(target);
  if (remove.length === 0) return;
  const existing = new Set(await api.secretNames(target.wrangler.name));
  for (const name of remove.filter((n) => existing.has(n))) {
    console.log(`Deleting secret ${name} from ${target.wrangler.name} (no longer configured)`);
    await api.deleteSecret(target.wrangler.name, name);
  }
}

async function pruneBoatSnapshots(settings, api, sandboxArtifact) {
  const worker = resourceNames(settings).controlPlane;
  run("uv", ["sync", "--frozen"], { cwd: join(ROOT, "packages/boat-infra") });
  run("uv", ["run", "--frozen", "python", "prune-deployed-snapshots.py"], {
    cwd: join(ROOT, "packages/boat-infra"),
    env: {
      BOAT_API_KEY: settings.boatApiKey,
      BOAT_API_URL: settings.boatApiUrl,
      BOAT_ORG: settings.boatOrg,
      BOAT_BASE_SNAPSHOT: settings.boatBaseSnapshot,
      BOAT_DEPLOYED_SNAPSHOT: sandboxArtifact,
      CLOUDFLARE_ACCOUNT_ID: settings.accountId,
      CLOUDFLARE_WORKER_NAME: worker,
      CLOUDFLARE_DEPLOYMENT_ID: await api.latestDeploymentId(worker),
    },
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values: flags } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean" }, "skip-build": { type: "boolean" } },
  });
  const dryRun = flags["dry-run"] === true;
  const settings = readSettings(env);
  if (!dryRun && !env.CLOUDFLARE_API_TOKEN)
    throw new ConfigError(["CLOUDFLARE_API_TOKEN must be set."]);
  const api = dryRun
    ? null
    : createCloudflareApi({ accountId: settings.accountId, apiToken: env.CLOUDFLARE_API_TOKEN });

  const resources = await lookUpResources(settings, api, dryRun);
  const { workers, sandboxArtifact } = planWorkers(settings, resources);
  const web = planWeb(settings);
  const targets = web ? [...workers, web] : workers;

  console.log(`Deploying ${targets.map((t) => t.wrangler.name).join(", ")}`);
  if (sandboxArtifact) console.log(`Sandbox artifact: ${sandboxArtifact}`);
  if (!dryRun) await checkPreservedSecrets(targets, api);

  if (!flags["skip-build"]) {
    run("npm", ["run", "build", "-w", "@open-inspect/shared"]);
    for (const worker of workers)
      run("npm", ["run", "build"], { cwd: join(ROOT, worker.packageDir) });
  }

  if (!dryRun) {
    run(
      "bash",
      ["scripts/d1-migrate.sh", resourceNames(settings).d1Database, "terraform/d1/migrations"],
      {
        env: { CLOUDFLARE_ACCOUNT_ID: settings.accountId },
      }
    );
  }

  for (const worker of workers) deployTarget(worker, { accountId: settings.accountId, dryRun });

  if (!dryRun && settings.sandboxProvider === "boat") {
    await pruneBoatSnapshots(settings, api, sandboxArtifact);
  }

  if (web) {
    run("npm", ["run", "build", "-w", "@open-inspect/shared"]);
    run("npm", ["run", "build:cloudflare", "-w", "@open-inspect/web"], {
      env: webBuildEnv(settings),
    });
    deployTarget(web, { accountId: settings.accountId, dryRun });
  }

  if (!dryRun) {
    for (const target of targets) await removeStaleSecrets(target, api);
  }
  console.log(dryRun ? "Dry run complete." : "Cloudflare deploy complete.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  });
}
