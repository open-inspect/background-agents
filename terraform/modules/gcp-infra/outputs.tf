output "image_build_id" {
  description = "ID of the image build resource (for depends_on references)"
  value       = null_resource.gcp_image.id
}

output "image_reference" {
  description = "Verified image (projects/<project>/global/images/<name>); only switch traffic after the build succeeds"
  value       = local.image_reference
  depends_on  = [null_resource.gcp_image]
}
