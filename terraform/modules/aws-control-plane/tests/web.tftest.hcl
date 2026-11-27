mock_provider "aws" {}
mock_provider "cloudinit" {}

variables {
  name     = "open-inspect-test"
  hostname = "control-plane.example.com"
}

override_data {
  target = data.aws_ec2_instance_type.this
  values = { supported_architectures = ["arm64"] }
}

override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
}

override_data {
  target = data.aws_iam_policy_document.ec2_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
}

override_data {
  target = data.aws_iam_policy_document.dlm_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
}

override_data {
  target = data.aws_iam_policy_document.instance
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
}

run "no_web_by_default" {
  command = plan

  assert {
    condition     = length(aws_ecr_repository.web) == 0 && length(aws_ssm_parameter.deployed_web_image) == 0 && length(aws_ssm_parameter.web_build_args) == 0
    error_message = "A deployment that does not opt in must get no web resources."
  }

  assert {
    condition     = length(setintersection(keys(aws_ssm_parameter.config), ["COMPOSE_PROFILES", "WEB_DOMAIN", "WEB_APP_URL"])) == 0
    error_message = "Without `web`, the stack must keep its control-plane-only compose profile and Caddy config."
  }
}

run "web_on_the_instance" {
  command = plan

  variables {
    web = { hostname = "app.example.com" }
    config = {
      APP_NAME         = "Open-Inspect Test"
      SANDBOX_PROVIDER = "modal"
      SCM_PROVIDER     = "gitlab"
    }
    route53_zone_id = "Z123EXAMPLE"
  }

  assert {
    condition = (
      aws_ssm_parameter.config["COMPOSE_PROFILES"].value == "web" &&
      aws_ssm_parameter.config["WEB_DOMAIN"].value == "app.example.com" &&
      aws_ssm_parameter.config["WEB_APP_URL"].value == "https://app.example.com"
    )
    error_message = "`web` must switch on the compose profile and Caddy site, and derive WEB_APP_URL."
  }

  assert {
    condition     = aws_ssm_parameter.deployed_web_image[0].name == "/open-inspect-test/env/WEB_IMAGE"
    error_message = "WEB_IMAGE must live under the `.env` prefix, where docker-compose.aws.yml reads it."
  }

  assert {
    condition = nonsensitive(jsondecode(aws_ssm_parameter.web_build_args[0].value)) == {
      NEXT_PUBLIC_WS_URL           = "wss://control-plane.example.com"
      NEXT_PUBLIC_APP_NAME         = "Open-Inspect Test"
      NEXT_PUBLIC_SANDBOX_PROVIDER = "modal"
      NEXT_PUBLIC_SCM_PROVIDER     = "gitlab"
    }
    error_message = "Build arguments must come from the control plane's own settings and its hostname."
  }

  assert {
    condition     = !startswith(aws_ssm_parameter.web_build_args[0].name, "/open-inspect-test/env/")
    error_message = "The build arguments must stay out of `.env`."
  }

  assert {
    condition     = aws_route53_record.web[0].name == "app.example.com"
    error_message = "With a zone, the web hostname gets its own record."
  }
}

run "rejects_web_on_the_control_plane_hostname" {
  command = plan

  variables {
    web = { hostname = "Control-Plane.Example.com" }
  }

  expect_failures = [var.web]
}

run "rejects_web_image_in_config" {
  command = plan

  variables {
    config = { WEB_IMAGE = "example.invalid/web:pinned" }
  }

  expect_failures = [var.config]
}

run "rejects_web_with_a_control_plane_image_outside_the_account_registry" {
  command = plan

  variables {
    web                 = { hostname = "app.example.com" }
    control_plane_image = "ghcr.io/example/control-plane:1.0.0"
  }

  expect_failures = [aws_ssm_parameter.deployed_web_image]
}

run "accepts_web_with_a_control_plane_image_in_the_account_registry" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }

  override_data {
    target = data.aws_region.current
    values = { region = "us-west-2" }
  }

  variables {
    web                 = { hostname = "app.example.com" }
    control_plane_image = "123456789012.dkr.ecr.us-west-2.amazonaws.com/other-repository:1.0.0"
  }

  assert {
    condition     = length(aws_ssm_parameter.deployed_web_image) == 1
    error_message = "An image elsewhere in this account's ECR is covered by the instance's registry login."
  }
}
