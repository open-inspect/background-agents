#!/usr/bin/env node
// Which Cloudflare workflows a set of changed files needs.
//
// The terraform-<environment> workflows trigger on TERRAFORM_PATHS and the
// deploy-<environment> workflows on DEPLOY_PATHS (workflow-contract.test.mjs
// holds the `on.paths` lists to these). A push that touches TERRAFORM_PATHS
// is deployed after the Terraform workflow finishes (`workflow_run`), so the
// control plane never points at a sandbox artifact Terraform has not built;
// the deploy's own push run then stands down.
//
// Usage (prints key=value lines for $GITHUB_OUTPUT):
//   node scripts/cloudflare-deploy/changes.mjs --base <sha> --head <sha> [--sandbox-provider <name>]

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Inputs only the Vercel sandbox snapshot hashes (packages/sandbox-images
// plan_image), beyond the sandbox packages every provider hashes.
export const VERCEL_SNAPSHOT_PATHS = Object.freeze([
  "package-lock.json",
  "packages/control-plane/scripts/build-vercel-base-snapshot.ts",
  "packages/control-plane/src/**",
  "packages/shared/package.json",
  "packages/shared/src/**",
  "packages/shared/tsconfig.json",
]);

export const TERRAFORM_PATHS = Object.freeze([
  "terraform/**",
  "!terraform/d1/**",
  "packages/boat-infra/**",
  "packages/daytona-infra/**",
  "packages/e2b-infra/**",
  "packages/modal-infra/**",
  "packages/sandbox-images/**",
  "packages/sandbox-runtime/**",
  "packages/vercel-infra/**",
  ...VERCEL_SNAPSHOT_PATHS,
  ".github/workflows/terraform-cloudflare.yml",
  ".github/workflows/terraform-production.yml",
  ".github/workflows/terraform-staging.yml",
]);

export const DEPLOY_PATHS = Object.freeze([
  ".nvmrc",
  "package-lock.json",
  "package.json",
  "packages/control-plane/**",
  "packages/github-bot/**",
  "packages/linear-bot/**",
  "packages/shared/**",
  "packages/slack-bot/**",
  "packages/web/**",
  "scripts/cloudflare-deploy/**",
  "scripts/d1-migrate.sh",
  "terraform/d1/migrations/**",
  ".github/workflows/deploy-cloudflare.yml",
  ".github/workflows/deploy-production.yml",
  ".github/workflows/deploy-staging.yml",
]);

function matchesPattern(file, pattern) {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

/** GitHub `paths` semantics: the last matching pattern wins; `!` excludes. */
export function matchesPaths(file, patterns) {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (matchesPattern(file, negated ? pattern.slice(1) : pattern)) matched = !negated;
  }
  return matched;
}

/**
 * @param files changed paths, or null when unknown (treated as everything)
 * @param sandboxProvider the deployment's SANDBOX_PROVIDER, or "" when unknown
 */
export function classify(files, sandboxProvider = "") {
  if (files === null) return { terraform: true, deploy: true, terraformTriggered: true };
  const terraformTriggered = files.some((file) => matchesPaths(file, TERRAFORM_PATHS));
  // A Vercel-only input matters to Terraform only when Vercel builds the
  // snapshot, or when the provider is unknown.
  const vercelMatters = sandboxProvider === "" || sandboxProvider === "vercel";
  const nonVercel = TERRAFORM_PATHS.filter((p) => !VERCEL_SNAPSHOT_PATHS.includes(p));
  const terraform = files.some(
    (file) =>
      matchesPaths(file, nonVercel) || (vercelMatters && matchesPaths(file, VERCEL_SNAPSHOT_PATHS))
  );
  return {
    terraform,
    deploy: files.some((file) => matchesPaths(file, DEPLOY_PATHS)),
    terraformTriggered,
  };
}

function changedFiles(base, head) {
  if (!base || /^0+$/.test(base)) return null;
  const result = spawnSync("git", ["diff", "--name-only", "--no-renames", base, head], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null; // unknown history: assume everything changed
  return result.stdout.split("\n").filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      "sandbox-provider": { type: "string" },
    },
  });
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const result = classify(
    changedFiles(values.base, values.head ?? "HEAD"),
    values["sandbox-provider"] ?? ""
  );
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${value}`);
  }
}
