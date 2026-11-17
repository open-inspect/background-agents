variable "service_account_json" {
  description = "Service account JSON key gcloud uses for the build; empty uses gcloud's existing credentials"
  type        = string
  sensitive   = true
  default     = ""
}

variable "project" {
  description = "GCP project the build VMs and the image are created in"
  type        = string
}

variable "zone" {
  description = "Zone of the build and verification VMs"
  type        = string
}

variable "image_family" {
  description = "Image family the image is added to; also the image name prefix"
  type        = string
  default     = "open-inspect-sandbox"

  validation {
    condition     = can(regex("^[a-z][-a-z0-9]{0,44}$", var.image_family))
    error_message = "image_family must be 1-45 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "build_machine_type" {
  description = "Machine type of the build and verification VMs"
  type        = string
  default     = "e2-standard-4"
}

variable "boot_disk_size_gb" {
  description = "Boot disk size of the image in GB; session disks cannot be smaller"
  type        = number
  default     = 80
}

variable "network" {
  description = "Optional VPC network for the build VMs"
  type        = string
  default     = ""
}

variable "subnet" {
  description = "Optional subnetwork for the build VMs"
  type        = string
  default     = ""
}

variable "use_iap" {
  description = "Give the build VMs no external IP and SSH to them through IAP"
  type        = bool
  default     = false
}

variable "deploy_path" {
  description = "Path to packages/gcp-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
