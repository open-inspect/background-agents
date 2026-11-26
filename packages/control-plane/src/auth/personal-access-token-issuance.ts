/**
 * The rules every personal access token is issued under, whether a user creates it in Settings or
 * approves an app's OAuth sign-in: tokens must be enabled, the lifetime within the policy's cap,
 * and each permission grantable, allowed by the policy, held by the user now, and accompanied by
 * its prerequisites.
 */

import type { PermissionId } from "@open-inspect/shared/rbac";
import {
  isPersonalAccessTokenGrantable,
  PERSONAL_ACCESS_TOKEN_ERROR_CODES,
  PERSONAL_ACCESS_TOKEN_MAX_PER_USER,
  personalAccessTokenMaxLifetimeDays,
  personalAccessTokenPolicyAllows,
  type PersonalAccessTokenPolicy,
  unmetGrantPrerequisite,
} from "@open-inspect/shared/types/personal-access-tokens";

/** Why a token cannot be issued: a status and the JSON body that explains it. */
export interface TokenIssuanceRefusal {
  readonly status: 400 | 403 | 409;
  readonly body: { readonly error: string; readonly code: string } & Record<string, unknown>;
}

/** The first rule a requested grant breaks, or null when it may be issued. */
export function refuseTokenGrant(
  policy: PersonalAccessTokenPolicy,
  held: ReadonlySet<PermissionId>,
  permissions: readonly PermissionId[],
  expiresInDays: number
): TokenIssuanceRefusal | null {
  if (!policy.enabled) {
    return {
      status: 403,
      body: {
        error: "Personal access tokens are disabled for this workspace",
        code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.disabled,
      },
    };
  }
  const maxLifetimeDays = personalAccessTokenMaxLifetimeDays(policy);
  if (expiresInDays > maxLifetimeDays) {
    return {
      status: 400,
      body: {
        error: `This workspace allows tokens to live at most ${maxLifetimeDays} days`,
        code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.lifetimeExceedsPolicy,
        maxLifetimeDays,
      },
    };
  }
  for (const permission of permissions) {
    if (!isPersonalAccessTokenGrantable(permission)) {
      return {
        status: 400,
        body: {
          error: `Personal access tokens cannot be granted ${permission}`,
          code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.permissionNotGrantable,
          permission,
        },
      };
    }
    if (!personalAccessTokenPolicyAllows(policy, permission)) {
      return {
        status: 400,
        body: {
          error: `This workspace does not allow tokens to be granted ${permission}`,
          code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.permissionNotAllowed,
          permission,
        },
      };
    }
    if (!held.has(permission)) {
      return {
        status: 403,
        body: {
          error: `You do not hold ${permission}, so a token cannot be granted it`,
          code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.permissionNotHeld,
          permission,
        },
      };
    }
  }
  const unmet = unmetGrantPrerequisite(permissions);
  if (unmet) {
    return {
      status: 400,
      body: {
        error: `A token granted ${unmet.permission} must also be granted ${unmet.requires}`,
        code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.prerequisiteMissing,
        permission: unmet.permission,
        requires: unmet.requires,
      },
    };
  }
  return null;
}

/** The refusal for a token the user already holds the most of. */
export const TOKEN_LIMIT_REACHED: TokenIssuanceRefusal = {
  status: 409,
  body: {
    error: `You already hold ${PERSONAL_ACCESS_TOKEN_MAX_PER_USER} personal access tokens; revoke one first`,
    code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.limitReached,
  },
};

/** The refusal for an issue the policy changed under. */
export const TOKEN_POLICY_CHANGED: TokenIssuanceRefusal = {
  status: 409,
  body: {
    error: "The workspace token policy changed while this token was being issued; try again",
    code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.policyChanged,
  },
};
