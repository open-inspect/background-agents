import { describe, expect, it } from "vitest";
import { PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES } from "@open-inspect/shared/types/personal-access-tokens";
import { PERSONAL_ACCESS_TOKEN_PERMISSION_COPY } from "./personal-access-token-permissions";

describe("token permission copy", () => {
  it("names every permission a choice brings with it, since the picker selects it silently", () => {
    for (const [permission, prerequisites] of Object.entries(
      PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES
    )) {
      const { description } =
        PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[
          permission as keyof typeof PERSONAL_ACCESS_TOKEN_PERMISSION_COPY
        ];
      for (const prerequisite of prerequisites ?? []) {
        const { label } =
          PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[
            prerequisite as keyof typeof PERSONAL_ACCESS_TOKEN_PERMISSION_COPY
          ];
        expect(description, permission).toContain(`Includes ${label}.`);
      }
    }
  });
});
