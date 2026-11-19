# =============================================================================
# Discord Bot
# =============================================================================

variable "enable_discord_bot" {
  description = "Enable the Discord bot worker (/task slash command). Requires discord_application_id, discord_public_key, discord_bot_token, and discord_allowed_role_ids."
  type        = bool
  default     = false

  validation {
    condition = var.enable_discord_bot == false || (
      trimspace(var.discord_application_id) != "" &&
      trimspace(var.discord_public_key) != "" &&
      trimspace(var.discord_bot_token) != "" &&
      length(compact([for id in split(",", var.discord_allowed_role_ids) : trimspace(id)])) > 0
    )
    error_message = "When enable_discord_bot is true, discord_application_id, discord_public_key, and discord_bot_token must be non-empty, and discord_allowed_role_ids must name at least one role ID."
  }
}

variable "discord_application_id" {
  description = "Discord application ID (Developer Portal → General Information)"
  type        = string
  default     = ""

  # Anything but a snowflake breaks every interaction callback URL at runtime.
  validation {
    condition     = var.discord_application_id == "" || can(regex("^[0-9]{17,20}$", var.discord_application_id))
    error_message = "discord_application_id must be the application's numeric snowflake ID."
  }
}

variable "discord_public_key" {
  description = "Discord application public key, hex (Developer Portal → General Information)"
  type        = string
  default     = ""

  # Anything but a 32-byte Ed25519 key fails every signature check at runtime.
  validation {
    condition     = var.discord_public_key == "" || can(regex("^[0-9a-fA-F]{64}$", var.discord_public_key))
    error_message = "discord_public_key must be the application's 64-character hex public key."
  }
}

variable "discord_bot_token" {
  description = "Discord bot token (Developer Portal → Bot → Reset Token)"
  type        = string
  default     = ""
  sensitive   = true

  # Stray whitespace from a paste fails every Discord API call at runtime.
  validation {
    condition     = var.discord_bot_token == "" || can(regex("^[^[:space:]]+$", var.discord_bot_token))
    error_message = "discord_bot_token must not contain whitespace."
  }
}

variable "discord_allowed_role_ids" {
  description = "Comma-separated Discord role IDs allowed to submit tasks. Anyone with one of these roles can start sessions as a workspace Member."
  type        = string
  default     = ""
}

variable "discord_allowed_channel_ids" {
  description = "Comma-separated Discord channel IDs where /task is accepted (threads under them included). Empty accepts any channel."
  type        = string
  default     = ""
}

variable "discord_bot_default_model" {
  description = "Model for sessions started from Discord, as a canonical \"provider/model\" id. Must be an Anthropic model while discord_bot_harness is \"claude\"."
  type        = string
  default     = "anthropic/claude-opus-5"
  nullable    = false

  validation {
    condition = can(regex(
      "^(?:[^/[:space:]]+/[^/[:space:]]+|(?:claude-|gpt-)[^/[:space:]]+)$",
      var.discord_bot_default_model
    ))
    error_message = "discord_bot_default_model must be a canonical \"provider/model\" id such as \"anthropic/claude-opus-5\"."
  }

  # Discord's deployment-level v1 shortcut supports Claude and OpenCode only.
  # Keep this pairing rule aligned with HARNESS_CATALOG.claude.modelFamilies;
  # runtime launch validation also checks the shared catalog before /task.
  validation {
    condition = var.discord_bot_harness != "claude" || can(regex(
      "^(?:anthropic/|claude-)",
      var.discord_bot_default_model
    ))
    error_message = "discord_bot_default_model must be an Anthropic model (\"anthropic/...\") while discord_bot_harness is \"claude\"."
  }
}

variable "discord_bot_harness" {
  description = "Deployment-level v1 harness for Discord (not integration-settings). Only claude and opencode are supported. Claude can use a connected subscription (the Automated sessions default account); OpenCode needs an API key."
  type        = string
  default     = "claude"

  validation {
    condition     = contains(["claude", "opencode"], var.discord_bot_harness)
    error_message = "discord_bot_harness must be \"claude\" or \"opencode\"."
  }
}
