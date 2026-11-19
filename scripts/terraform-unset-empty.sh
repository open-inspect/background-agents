# Sourced by Terraform plan/apply. Actions renders missing inputs as empty
# strings; leave them unset so Terraform remains the only default authority.
# Do not trim nonempty overrides: Terraform must reject malformed values.
for name in "$@"; do
  if [[ -z "${!name:-}" ]]; then
    unset "$name"
  fi
done
