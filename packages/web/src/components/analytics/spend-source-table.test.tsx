// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { analyticsDashboard } from "@/lib/analytics.test-fixture";
import { AnalyticsSpendSourceTable } from "./spend-source-table";

expect.extend(matchers);
afterEach(cleanup);

describe("AnalyticsSpendSourceTable", () => {
  it("lists sources by spend with share, cost per run and change from the previous window", () => {
    const dashboard = analyticsDashboard();
    render(
      <AnalyticsSpendSourceTable
        dashboard={{
          ...dashboard,
          spend: {
            ...dashboard.spend,
            sources: [
              ...dashboard.spend.sources,
              { source: "slack-bot", runs: 0, cost: 0, previousCost: 3 },
            ],
          },
        }}
      />
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "User / app",
      "Code review",
      "Nightly bump",
    ]);
    const cells = (index: number) =>
      within(rows[index])
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells(0)).toEqual(["User / app", "4", "$109.00", "96%", "$27.25", "+9%"]);
    expect(cells(1).at(-1)).toBe("New");
    expect(cells(2).at(-1)).toBe("-50%");
  });
});
