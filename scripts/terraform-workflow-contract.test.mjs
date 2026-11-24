import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEPLOY_PATHS, TERRAFORM_PATHS } from "./cloudflare-deploy/changes.mjs";
import { DEFAULTS } from "./cloudflare-deploy/config.mjs";

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

for (const root of ["production"]) {
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

for (const env of ["production"]) {
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

// A setting both workflows read must resolve to the same value in each. The
// Terraform workflow builds sandbox artifacts from some of them and the deploy
// binds the control plane to artifact names derived from the same inputs, so a
// setting read from different sources (`vars` only vs `vars || secrets`) or with
// a different fallback names an artifact that was never built. The deploy
// workflow carries no fallbacks: config.mjs DEFAULTS apply, so each Terraform
// fallback is held equal to the matching default instead.
function expressions(text, pattern) {
  const found = new Map();
  for (const match of text.matchAll(pattern)) {
    const expression = match[2];
    const refs = [...expression.matchAll(/\b(?:vars|secrets)\.([A-Z0-9_]+)/g)].map((ref) => ref[0]);
    const fallback = /\|\|\s*'([^']*)'/.exec(expression)?.[1] ?? null;
    for (const ref of refs) {
      const name = ref.split(".")[1];
      if (!found.has(name)) found.set(name, { refs, fallback });
    }
  }
  return found;
}

test("settings shared by the Terraform and deploy workflows resolve identically", () => {
  const terraform = expressions(terraformWorkflow, /^ {10}TF_VAR_([a-z0-9_]+): (.*)$/gm);
  const deployStep = deployWorkflow.slice(deployWorkflow.indexOf("- name: Deploy Workers"));
  const deploy = expressions(deployStep, /^ {10}([A-Z0-9_]+): (.*)$/gm);
  const shared = [...terraform.keys()].filter((name) => deploy.has(name));
  assert.ok(shared.length > 15, "expected many settings shared by both workflows");
  const mismatched = shared.filter((name) => {
    const a = terraform.get(name);
    const b = deploy.get(name);
    return a.refs.join(",") !== b.refs.join(",");
  });
  assert.deepEqual(
    mismatched.map((name) => ({ name, terraform: terraform.get(name), deploy: deploy.get(name) })),
    []
  );

  const differingDefaults = shared.filter((name) => {
    const fallback = terraform.get(name).fallback;
    return fallback !== null && fallback !== (DEFAULTS[name] ?? null);
  });
  assert.deepEqual(
    differingDefaults,
    [],
    "Terraform workflow fallbacks must equal config.mjs DEFAULTS"
  );
});

test("the deploy gate waits only for an applying Terraform run, and deploys anyway if none starts", () => {
  assert.match(deployWorkflow, /--sandbox-provider "\$SANDBOX_PROVIDER"/);
  assert.match(deployWorkflow, /sed -n 's\/\^terraform=\/\/p'/);
  assert.match(
    deployWorkflow,
    /workflows\/terraform-\$ENVIRONMENT\.yml\/runs\?head_sha=\$GITHUB_SHA/
  );
  assert.match(
    deployWorkflow,
    /No Terraform run started for this commit; deploying without waiting/
  );
  assert.match(deployWorkflow, /endswith\("Apply"\)/);
  assert.match(deployWorkflow, /\[ "\$apply" = "success" \]/);
});

test("pushes classify with the apply Environment, pull requests with the plan Environment", () => {
  assert.match(
    terraformWorkflow,
    /environment: \$\{\{ github\.event_name == 'pull_request' && inputs\.plan-environment \|\| \(github\.event_name != 'pull_request' && inputs\.environment\) \|\| '' \}\}/
  );
  assert.match(
    deployWorkflow,
    /environment: \$\{\{ github\.event_name == 'push' && inputs\.environment \|\| '' \}\}/
  );
});

// ---------------------------------------------------------------------------
// Staging: github/branch-deploy
// ---------------------------------------------------------------------------

const branchDeploy = await read(".github/workflows/branch-deploy-staging.yml");

function stepEnv(workflow, stepName, endMarker) {
  const start = workflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `expected the ${stepName} step`);
  const body = workflow.slice(start);
  const envStart = body.indexOf("        env:\n") + "        env:\n".length;
  const end = body.indexOf(endMarker, envStart);
  return body.slice(envStart, end === -1 ? undefined : end).trimEnd();
}

test("staging is deployed by a maintainer's .deploy comment, not by pushes", () => {
  assert.match(branchDeploy, /^on:\n {2}issue_comment:\n {4}types: \[created\]\n/m);
  assert.doesNotMatch(branchDeploy, /^ {2}(push|pull_request|pull_request_target|workflow_run):/m);
  assert.match(branchDeploy, /uses: github\/branch-deploy@v\d+\.\d+\.\d+\n/);
  assert.match(branchDeploy, /vars\.CLOUDFLARE_STAGING_ENABLED == 'true'/);
  assert.match(branchDeploy, /github\.event\.issue\.pull_request/);
  assert.match(branchDeploy, /environment: staging\n {4}steps:/);
});

test("branch-deploy is scoped to the maintainers and refuses forks", () => {
  assert.match(branchDeploy, /allow_forks: "false"/);
  assert.match(
    branchDeploy,
    /admins: \$\{\{ vars\.BRANCH_DEPLOY_ADMINS \|\| format\('\{0\}\/maintainers', github\.repository_owner\) \}\}/
  );
  assert.match(
    branchDeploy,
    /admins_pat: \$\{\{ secrets\.BRANCH_DEPLOY_ADMINS_PAT \|\| 'false' \}\}/
  );
  assert.match(branchDeploy, /environment_targets: staging\n/);
});

test("the pull request's code is checked out at the commit branch-deploy approved", () => {
  assert.match(branchDeploy, /ref: \$\{\{ steps\.branch-deploy\.outputs\.sha \}\}/);
  assert.match(branchDeploy, /persist-credentials: false/);
  const gated = branchDeploy.split("if: steps.branch-deploy.outputs.continue == 'true'").length - 1;
  const steps = branchDeploy.split("\n      - name: ").length - 1;
  assert.equal(gated, steps - 1, "every step after branch-deploy waits for its approval");
});

test("terraform and the deploy are steps of the job that started branch-deploy", () => {
  // Its post step completes the deployment status, reaction and lock when that job ends.
  assert.doesNotMatch(branchDeploy, /^ {4}uses: \.\/\.github\/workflows\//m);
  assert.match(branchDeploy, /terraform plan -no-color/);
  assert.match(branchDeploy, /--dry-run/);
  assert.match(branchDeploy, /working-directory: terraform\/environments\/staging/);
  assert.match(branchDeploy, /group: branch-deploy-staging\n {2}cancel-in-progress: false/);
});

test("staging gets the same Terraform and deploy settings as production", () => {
  const stagingTerraform = stepEnv(branchDeploy, "Terraform Apply", "\n\n      - name");
  const productionTerraform = stepEnv(terraformWorkflow, "Terraform Apply", "\n\n      - name");
  assert.equal(
    stagingTerraform
      .split("\n")
      .filter((line) => !line.includes("NOOP:"))
      .join("\n"),
    productionTerraform
  );
  const stagingDeploy = stepEnv(branchDeploy, "Deploy Workers", "\n\n      - name");
  const productionDeploy = stepEnv(deployWorkflow, "Deploy Workers", "\n\n      - name");
  assert.equal(
    stagingDeploy
      .split("\n")
      .filter((line) => !line.includes("DEPLOY_FLAGS:"))
      .join("\n"),
    productionDeploy
  );
});

test("every staging Terraform variable reaches its apply", async () => {
  const variables = await read("terraform/environments/staging/variables.tf");
  const declared = [...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((match) => match[1]);
  const missing = declared.filter(
    (name) =>
      !NOT_FROM_ENVIRONMENT.has(name) && branchDeploy.split(`TF_VAR_${name}:`).length - 1 !== 1
  );
  assert.deepEqual(missing, []);
});
