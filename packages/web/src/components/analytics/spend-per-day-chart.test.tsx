// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { analyticsDashboard } from "@/lib/analytics.test-fixture";
import { AnalyticsSpendPerDayChart } from "./spend-per-day-chart";

expect.extend(matchers);
afterEach(cleanup);

describe("AnalyticsSpendPerDayChart", () => {
  it("keys only the sources that spent in the window", () => {
    render(<AnalyticsSpendPerDayChart dashboard={analyticsDashboard()} />);

    const legend = screen.getByRole("list", { name: "Sources" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["User / app", "Code review", "Automations"]);
  });

  it("says so when nothing was spent", () => {
    const dashboard = analyticsDashboard();
    render(
      <AnalyticsSpendPerDayChart dashboard={{ ...dashboard, spend: { daily: [], sources: [] } }} />
    );

    expect(screen.queryByRole("list", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.getByText("No spend recorded for this range.")).toBeInTheDocument();
  });
});
