# GCP Infrastructure Module
# Builds and verifies the Compute Engine image GCP sandbox VMs boot from.
# Mirrors terraform/modules/boat-infra/ for the GCP backend.

locals {
  image_name      = "${var.image_family}-${substr(var.source_hash, 0, 16)}"
  image_reference = "projects/${var.project}/global/images/${local.image_name}"
}

resource "null_resource" "gcp_image" {
  triggers = {
    source_hash  = var.source_hash
    image_name   = local.image_name
    project      = var.project
    zone         = var.zone
    machine_type = var.build_machine_type
    disk_size_gb = var.boot_disk_size_gb
    network      = var.network
    subnet       = var.subnet
    use_iap      = var.use_iap
    script_hash  = filesha256("${path.module}/scripts/build-image.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-image.sh"
    interpreter = ["bash"]

    environment = {
      GCP_BUILD_SERVICE_ACCOUNT_JSON = var.service_account_json
      GCP_PROJECT                    = var.project
      GCP_ZONE                       = var.zone
      GCP_IMAGE_FAMILY               = var.image_family
      GCP_BUILD_MACHINE_TYPE         = var.build_machine_type
      GCP_BOOT_DISK_SIZE_GB          = tostring(var.boot_disk_size_gb)
      GCP_NETWORK                    = var.network
      GCP_SUBNET                     = var.subnet
      GCP_BUILD_USE_IAP              = tostring(var.use_iap)
      OPENINSPECT_IMAGE_CANDIDATE    = local.image_name
      DEPLOY_PATH                    = var.deploy_path
    }
  }
}
