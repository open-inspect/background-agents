locals {
  web_enabled = var.web != null

  web_hostname = try(var.web.hostname, null)

  # The instance logs in only to the registry CONTROL_PLANE_IMAGE names
  # (templates/user-data.sh.tftpl), and the web image is in this account's.
  account_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.region}.amazonaws.com"

  # COMPOSE_PROFILES and WEB_DOMAIN are what docker-compose.yml switches the web
  # service and Caddy's second site on.
  web_config = local.web_enabled ? {
    COMPOSE_PROFILES = "web"
    WEB_DOMAIN       = local.web_hostname
    WEB_APP_URL      = "https://${local.web_hostname}"
  } : {}

  # The same mapping docker-compose.yml's web build arguments use.
  web_build_arg_sources = {
    NEXT_PUBLIC_APP_NAME         = "APP_NAME"
    NEXT_PUBLIC_SANDBOX_PROVIDER = "SANDBOX_PROVIDER"
    NEXT_PUBLIC_SCM_PROVIDER     = "SCM_PROVIDER"
  }

  web_build_args = merge(
    { NEXT_PUBLIC_WS_URL = "wss://${var.hostname}" },
    { for arg, key in local.web_build_arg_sources : arg => local.env_config[key] if contains(keys(local.env_config), key) },
  )
}

resource "aws_ecr_repository" "web" {
  count = local.web_enabled ? 1 : 0

  name                 = "${var.name}-web"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.force_destroy_storage

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.tags, { Name = "${var.name}-web" })
}

resource "aws_ecr_lifecycle_policy" "web" {
  count = local.web_enabled ? 1 : 0

  repository = aws_ecr_repository.web[0].name
  policy     = local.ecr_lifecycle_policy
}

# Owned like CONTROL_PLANE_IMAGE (config.tf): Terraform sets the first boot's
# value and CI moves it after that.
resource "aws_ssm_parameter" "deployed_web_image" {
  count = local.web_enabled ? 1 : 0

  name  = "${local.ssm_env_prefix}/WEB_IMAGE"
  type  = "String"
  value = "${aws_ecr_repository.web[0].repository_url}:latest"
  tags  = local.tags

  lifecycle {
    ignore_changes = [value]

    precondition {
      condition     = var.control_plane_image == null || split("/", coalesce(var.control_plane_image, "-"))[0] == local.account_registry
      error_message = "`web` needs control_plane_image in this account's ECR (${local.account_registry}): the instance logs in only to the control-plane image's registry, so it could not pull the web image."
    }
  }
}

# Outside the `.env` prefix, which the deploy role must not be able to read.
resource "aws_ssm_parameter" "web_build_args" {
  count = local.web_enabled ? 1 : 0

  name  = "/${var.name}/web/build-args"
  type  = "String"
  value = jsonencode(local.web_build_args)
  tags  = local.tags
}

resource "aws_route53_record" "web" {
  count = local.web_enabled && var.route53_zone_id != null ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.web_hostname
  type    = "A"
  ttl     = 60
  records = [aws_eip.this.public_ip]
}
