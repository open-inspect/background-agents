import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEPLOY_PATHS, TERRAFORM_PATHS } from "./cloudflare-deploy/changes.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const terraformWorkflow = await read(".github/workflows/terraform-cloudflare.yml");
const deployWorkflow = await read(".github/workflows/deploy-cloudflare.yml");

function assertInPlanAndApply(assignment, label) {
  const planStart = terraformWorkflow.indexOf("\n  plan:\n");
  const applyStart = terraformWorkflow.indexOf("\n  apply:\n");

  assert.notEqual(planStart, -1, "expected the Terraform plan job");
  assert.notEqual(applyStart, -1, "expected the Terraform apply job");

  const jobs = {
    plan: terraformWorkflow.slice(planStart, applyStart),
    apply: terraformWorkflow.slice(applyStart),
  };

  for (const [name, job] of Object.entries(jobs)) {
    const occurrences = job.split(assignment).length - 1;
    assert.equal(occurrences, 1, `expected one ${label} input in the ${name} job`);
  }
}

test("Daytona base snapshot memory reaches Terraform plan and apply", () => {
  assertInPlanAndApply(
    "TF_VAR_daytona_base_snapshot_memory_gib: \"${{ vars.DAYTONA_BASE_SNAPSHOT_MEMORY_GIB || '2' }}\"",
    "Daytona memory"
  );
});

test("web function region reaches Terraform plan and apply with the default", () => {
  assertInPlanAndApply(
    "TF_VAR_web_serverless_region: \"${{ vars.WEB_SERVERLESS_REGION || 'iad1' }}\"",
    "web function region"
  );
});

// project_root is a path inside the checkout.
const NOT_FROM_ENVIRONMENT = new Set(["project_root"]);

for (const root of ["production", "staging"]) {
  test(`Every ${root} Terraform variable reaches plan and apply`, async () => {
    const variables = await read(`terraform/environments/${root}/variables.tf`);
    const declared = [...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((match) => match[1]);
    assert.ok(declared.length > 0, "expected variables in variables.tf");

    const missing = declared.filter((name) => {
      if (NOT_FROM_ENVIRONMENT.has(name)) return false;
      try {
        assertInPlanAndApply(`TF_VAR_${name}:`, name);
        return false;
      } catch {
        return true;
      }
    });
    assert.deepEqual(missing, [], "each variable needs exactly one TF_VAR_ input per job");
  });
}

test("the environment roots and the shared module declare identical variables", async () => {
  const module = await read("terraform/modules/cloudflare-environment/variables.tf");
  assert.equal(await read("terraform/environments/production/variables.tf"), module);
  assert.equal(await read("terraform/environments/staging/variables.tf"), module);
});

test("production keeps its existing Terraform state key", async () => {
  assert.match(
    await read("terraform/environments/production/backend.tf"),
    /key\s+= "production\/terraform\.tfstate"/
  );
  assert.match(
    await read("terraform/environments/staging/backend.tf"),
    /key\s+= "staging\/terraform\.tfstate"/
  );
});

test("production applies in the existing GitHub Environment and plans on repository settings", async () => {
  const caller = await read(".github/workflows/terraform-production.yml");
  assert.match(caller, /^name: Terraform Production$/m);
  assert.match(caller, /environment: production\n/);
  assert.match(caller, /working-directory: terraform\/environments\/production\n/);
  assert.match(caller, /plan-environment: ""\n/);
});

test("Terraform no longer builds or uploads Worker code", () => {
  assert.doesNotMatch(
    terraformWorkflow,
    /npm run build -w @open-inspect\/(control-plane|slack-bot|github-bot|linear-bot)/
  );
  assert.doesNotMatch(terraformWorkflow, /SchedulerDO/);
});

function triggerPaths(workflow, event) {
  const lines = workflow
    .split(`\n  ${event}:\n`)[1]
    .split(/\n {4}paths:\n/)[1]
    .split("\n");
  const entries = [];
  for (const line of lines) {
    const match = /^ {6}- "([^"]+)"$/.exec(line);
    if (!match) break;
    entries.push(match[1]);
  }
  return entries;
}

for (const env of ["production", "staging"]) {
  test(`terraform-${env} triggers on exactly TERRAFORM_PATHS`, async () => {
    const workflow = await read(`.github/workflows/terraform-${env}.yml`);
    assert.deepEqual(triggerPaths(workflow, "push"), [...TERRAFORM_PATHS]);
    assert.deepEqual(triggerPaths(workflow, "pull_request"), [...TERRAFORM_PATHS]);
  });

  test(`deploy-${env} triggers on DEPLOY_PATHS and after Terraform ${env}`, async () => {
    const workflow = await read(`.github/workflows/deploy-${env}.yml`);
    assert.deepEqual(triggerPaths(workflow, "push"), [...DEPLOY_PATHS]);
    const title = `Terraform ${env[0].toUpperCase()}${env.slice(1)}`;
    assert.match(
      await read(`.github/workflows/terraform-${env}.yml`),
      new RegExp(`^name: ${title}$`, "m")
    );
    assert.match(workflow, new RegExp(`workflows: \\["${title}"\\]`));
    assert.match(workflow, new RegExp(`environment: ${env}\\n`));
  });
}

test("deploys follow only successful Terraform runs from main pushes", () => {
  assert.match(deployWorkflow, /\[ "\$RUN_CONCLUSION" = "success" \]/);
  assert.match(
    deployWorkflow,
    /\[ "\$RUN_EVENT" = "push" \] \|\| \[ "\$RUN_EVENT" = "workflow_dispatch" \]/
  );
  assert.match(
    deployWorkflow,
    /if: needs\.gate\.outputs\.deploy == 'true' && github\.ref == 'refs\/heads\/main'/
  );
});

test("every deploy setting reaches the deploy step", async () => {
  const config = await read("scripts/cloudflare-deploy/config.mjs");
  const body = config.slice(config.indexOf("const s = {"), config.indexOf("validate(s, errors);"));
  const names = [...body.matchAll(/(?:str|trimmed|bool|int|required)\("([A-Z0-9_]+)"\)/g)].map(
    (m) => m[1]
  );
  assert.ok(names.length > 50);
  const step = deployWorkflow.slice(deployWorkflow.indexOf("- name: Deploy Workers"));
  const missing = names.filter((name) => step.split(`\n          ${name}: `).length - 1 !== 1);
  assert.deepEqual(
    missing,
    [],
    "each setting needs exactly one env entry in the Deploy Workers step"
  );
});
