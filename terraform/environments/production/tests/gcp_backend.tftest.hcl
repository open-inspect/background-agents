# The GCP backend builds a verified sandbox image and pins the control plane to
# it, unless the operator opts out and manages images through gcp_image_family;
# a deployment on another backend builds nothing GCP.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "gcp-backend-test"

  sandbox_provider         = "gcp"
  gcp_service_account_json = "{\"client_email\":\"sa@test-proj.iam.gserviceaccount.com\"}"
  gcp_project              = "test-proj"
  gcp_zones                = "us-east1-b, us-east1-c"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "gcp_builds_an_image_and_pins_the_worker_to_it" {
  command = plan

  assert {
    condition     = length(module.gcp_infra) == 1 && length(data.external.gcp_source_hash) == 1
    error_message = "The GCP backend must hash its build inputs and build the image."
  }

  assert {
    condition     = module.gcp_infra[0].image_reference == "projects/test-proj/global/images/open-inspect-sandbox-0123456789abcdef"
    error_message = "The image must be the family plus the first 16 characters of the source hash, in gcp_project."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "GCP_IMAGE_FAMILY") &&
      contains(module.control_plane_worker.secret_binding_names, "GCP_SERVICE_ACCOUNT_JSON")
    )
    error_message = "The control plane must receive the built image and the service account key."
  }

  assert {
    condition     = length(module.boat_infra) == 0 && length(module.e2b_infra) == 0 && length(module.modal_app) == 0
    error_message = "The GCP backend must not provision another backend's infrastructure."
  }
}

run "gcp_image_build_can_be_disabled" {
  command = plan

  variables {
    gcp_build_image = false
  }

  assert {
    condition     = length(module.gcp_infra) == 0 && length(data.external.gcp_source_hash) == 0
    error_message = "Disabling the image build must build nothing."
  }

  assert {
    condition     = !contains(module.control_plane_worker.plain_text_binding_names, "GCP_IMAGE_FAMILY")
    error_message = "Without a build or gcp_image_family, the provider default family must apply."
  }
}

run "other_backends_build_nothing_gcp" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "test-token"
    modal_token_secret = "test-secret"
    modal_workspace    = "test-workspace"
    modal_api_secret   = "test-api-secret"
  }

  assert {
    condition     = length(module.gcp_infra) == 0 && length(data.external.gcp_source_hash) == 0
    error_message = "A non-GCP backend must not build a GCP image."
  }
}
