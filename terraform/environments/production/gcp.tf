# =============================================================================
# GCP Sandbox Infrastructure
# =============================================================================

locals {
  build_gcp_image = local.use_gcp_backend && var.gcp_build_image
}

# Shared build-input hash: the runtime, the image package, the GCP builder and
# its module. A change to any of them builds a new image under a new name; the
# Worker switches to it only after the build has verified it.
data "external" "gcp_source_hash" {
  count = local.build_gcp_image ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "gcp"]
}

module "gcp_infra" {
  count  = local.build_gcp_image ? 1 : 0
  source = "../../modules/gcp-infra"

  service_account_json = var.gcp_image_build_service_account_json
  project              = var.gcp_project
  zone                 = split(",", replace(var.gcp_zones, " ", ""))[0]
  boot_disk_size_gb    = var.gcp_boot_disk_size_gb
  network              = var.gcp_network
  subnet               = var.gcp_subnet
  use_iap              = var.gcp_image_build_use_iap
  deploy_path          = "${var.project_root}/packages/gcp-infra"
  source_hash          = data.external.gcp_source_hash[0].result.hash
}
