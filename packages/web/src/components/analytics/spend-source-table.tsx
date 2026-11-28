"use client";

import type {
  AnalyticsDashboardResponse,
  AnalyticsSpendSourceEntry,
} from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatAnalyticsRatio,
  getSpendChange,
  getSpendSourceLabel,
} from "@/lib/analytics";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";
import { SourceSwatch } from "./spend-per-day-chart";

function spendSourceKey(entry: AnalyticsSpendSourceEntry): string {
  return entry.source === "automation"
    ? `automation:${entry.automationId ?? "deleted"}`
    : entry.source;
}

function formatSpendChange(change: number | null): string {
  if (change === null) return "New";
  const percent = Math.round(change * 100);
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}

export function AnalyticsSpendSourceTable({
  dashboard,
}: {
  dashboard: AnalyticsDashboardResponse;
}) {
  const entries = dashboard.spend.sources.filter((entry) => entry.cost > 0);
  const total = entries.reduce((sum, entry) => sum + entry.cost, 0);
  const columns: AnalyticsTableColumn<AnalyticsSpendSourceEntry>[] = [
    {
      id: "source",
      header: "Source",
      sortValue: getSpendSourceLabel,
      cell: (entry) => (
        <span className="flex items-center gap-2 font-medium">
          <SourceSwatch source={entry.source} />
          {getSpendSourceLabel(entry)}
        </span>
      ),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      sortValue: (entry) => entry.runs,
      cell: (entry) => formatAnalyticsCount(entry.runs),
    },
    {
      id: "cost",
      header: "Spend",
      align: "right",
      sortValue: (entry) => entry.cost,
      barValue: (entry) => entry.cost,
      cell: (entry) => formatAnalyticsCost(entry.cost),
    },
    {
      id: "share",
      header: "Share",
      align: "right",
      hideBelow: "md",
      sortValue: (entry) => entry.cost,
      cell: (entry) => formatAnalyticsRatio(entry.cost / total),
    },
    {
      id: "costPerRun",
      header: "Per run",
      align: "right",
      sortValue: (entry) => entry.cost / entry.runs,
      cell: (entry) => formatAnalyticsCost(entry.cost / entry.runs),
    },
    {
      id: "change",
      header: "vs previous",
      align: "right",
      hideBelow: "lg",
      sortValue: (entry) => getSpendChange(entry),
      cell: (entry) => formatSpendChange(getSpendChange(entry)),
    },
  ];
  return (
    <AnalyticsTable
      label="Spend by source"
      rows={entries}
      columns={columns}
      rowKey={spendSourceKey}
      initialSort={{ columnId: "cost", direction: "desc" }}
      emptyMessage="No spend recorded for this range."
    />
  );
}
