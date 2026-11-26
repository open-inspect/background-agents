"use client";

import type { TooltipContentProps } from "recharts";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ANALYTICS_SPEND_SOURCES,
  type AnalyticsDashboardResponse,
  type AnalyticsSpendSource,
} from "@open-inspect/shared/types/analytics";
import {
  ANALYTICS_SPEND_SOURCE_COLORS,
  ANALYTICS_SPEND_SOURCE_LABELS,
  formatAnalyticsCost,
  formatAnalyticsDate,
  formatAnalyticsLongDate,
  getDailySpendBySource,
  getDaySpend,
  type DailySpend,
} from "@/lib/analytics";
import { AnalyticsEmptyNote } from "./analytics-panel";

const CHART_HEIGHT_PX = 260;

export function SourceSwatch({ source }: { source: AnalyticsSpendSource }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: ANALYTICS_SPEND_SOURCE_COLORS[source] }}
    />
  );
}

function SpendTooltip({
  active,
  payload,
  sources,
}: TooltipContentProps & { sources: AnalyticsSpendSource[] }) {
  const day = payload?.[0]?.payload as DailySpend | undefined;
  if (!active || !day) return null;
  // oxlint-disable-next-line react/purity -- the tooltip renders on hover, so reading the clock here cannot cause unstable re-renders.
  const partial = day.date === new Date().toISOString().slice(0, 10);
  return (
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 flex justify-between gap-3 text-muted-foreground">
        <span>
          {formatAnalyticsLongDate(day.date)}
          {partial ? " · today so far" : null}
        </span>
        <span className="font-semibold tabular-nums text-foreground">
          {formatAnalyticsCost(getDaySpend(day))}
        </span>
      </div>
      <div className="space-y-1">
        {sources
          .filter((source) => day[source] > 0)
          .reverse()
          .map((source) => (
            <div key={source} className="flex items-center gap-2">
              <SourceSwatch source={source} />
              <span className="text-muted-foreground">{ANALYTICS_SPEND_SOURCE_LABELS[source]}</span>
              <span className="ml-auto font-semibold tabular-nums text-foreground">
                {formatAnalyticsCost(day[source])}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

export function AnalyticsSpendPerDayChart({
  dashboard,
}: {
  dashboard: AnalyticsDashboardResponse;
}) {
  const days = getDailySpendBySource(dashboard);
  const sources = ANALYTICS_SPEND_SOURCES.filter((source) => days.some((day) => day[source] > 0));
  if (sources.length === 0) {
    return <AnalyticsEmptyNote>No spend recorded for this range.</AnalyticsEmptyNote>;
  }

  return (
    <div className="space-y-3">
      <ul aria-label="Sources" className="flex flex-wrap gap-x-4 gap-y-1">
        {sources.map((source) => (
          <li key={source} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SourceSwatch source={source} />
            {ANALYTICS_SPEND_SOURCE_LABELS[source]}
          </li>
        ))}
      </ul>
      <div style={{ height: CHART_HEIGHT_PX }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border-muted)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatAnalyticsDate}
              axisLine={false}
              tickLine={false}
              minTickGap={36}
              interval="preserveStartEnd"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              width={56}
              tickFormatter={formatAnalyticsCost}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={(props) => <SpendTooltip {...props} sources={sources} />}
            />
            {sources.map((source) => (
              <Bar
                key={source}
                dataKey={source}
                name={ANALYTICS_SPEND_SOURCE_LABELS[source]}
                stackId="spend"
                fill={ANALYTICS_SPEND_SOURCE_COLORS[source]}
                stroke="var(--background)"
                strokeWidth={1}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
