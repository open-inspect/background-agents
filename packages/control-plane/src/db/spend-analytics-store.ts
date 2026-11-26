import type {
  AnalyticsDailySpendPoint,
  AnalyticsSpendResponse,
  AnalyticsSpendSourceEntry,
} from "@open-inspect/shared/types/analytics";
import { ANALYTICS_SPEND_SOURCES } from "@open-inspect/shared/types/analytics";
import { z } from "zod";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { parseRows, scopePredicate, type AnalyticsFilters } from "./analytics-store";
import { analyticsVisibilityPredicate, type SessionReadScope } from "./session-visibility";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { MS_PER_DAY, utcDateFromDayIndex } from "./utc-day";

const spendSourceSchema = z.enum(ANALYTICS_SPEND_SOURCES);

const dailyRowSchema = z.object({
  day_index: z.number(),
  source: spendSourceSchema,
  cost: z.number(),
});

const sourceRowSchema = z.object({
  source: spendSourceSchema,
  automation_id: z.string().nullable(),
  automation_name: z.string().nullable(),
  runs: z.number(),
  cost: z.number(),
  previous_cost: z.number(),
});

/** The root decides the source; a sub-session whose root row is gone falls back to its own. */
const SPEND_FROM = `session_usage_daily d
  JOIN sessions s ON s.id = d.session_id
  LEFT JOIN sessions r ON r.id = s.root_session_id`;

const ROOT_SPAWN_SOURCE = "COALESCE(r.spawn_source, s.spawn_source)";

const SPEND_SOURCE_EXPRESSION = `CASE
  WHEN ${ROOT_SPAWN_SOURCE} = 'github-bot'
    THEN CASE WHEN COALESCE(r.github_review, s.github_review) = 1
      THEN 'github-review' ELSE 'github-mention' END
  ELSE ${ROOT_SPAWN_SOURCE}
END`;

/** The UTC days a window touches, and the equally long run of days before them. */
function getSpendWindowDays(filters: Pick<AnalyticsFilters, "startAt" | "endAt">) {
  const firstDay = Math.floor(filters.startAt / MS_PER_DAY);
  const lastDay = Math.floor((filters.endAt - 1) / MS_PER_DAY);
  const dayCount = lastDay - firstDay + 1;
  return { firstDay, lastDay, previousFirstDay: firstDay - dayCount };
}

export class SpendAnalyticsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly readScope: SessionReadScope,
    private readonly mode: TeamsEnforcementMode
  ) {}

  prepare(filters: AnalyticsFilters): [SqlStatement, SqlStatement] {
    const { firstDay, lastDay, previousFirstDay } = getSpendWindowDays(filters);
    const scope = scopePredicate(filters.scope, "s.spawn_source");
    const visible = analyticsVisibilityPredicate("s", this.readScope, this.mode);
    const filtersSql = `${scope.sql} ${visible.sql ? `AND ${visible.sql}` : ""}`;

    const daily = this.db
      .prepare(
        `SELECT d.day_index, ${SPEND_SOURCE_EXPRESSION} AS source, SUM(d.cost_usd) AS cost
         FROM ${SPEND_FROM}
         WHERE d.day_index BETWEEN ? AND ? ${filtersSql}
         GROUP BY d.day_index, source
         ORDER BY d.day_index ASC, source ASC`
      )
      .bind(firstDay, lastDay, ...scope.binds, ...visible.params);

    const sources = this.db
      .prepare(
        `WITH attributed AS (
           SELECT ${SPEND_SOURCE_EXPRESSION} AS source,
                  CASE WHEN ${ROOT_SPAWN_SOURCE} = 'automation'
                    THEN COALESCE(r.automation_id, s.automation_id) END AS automation_id,
                  COALESCE(s.root_session_id, s.id) AS run_id,
                  d.day_index,
                  d.cost_usd
           FROM ${SPEND_FROM}
           WHERE d.day_index BETWEEN ? AND ? ${filtersSql}
         )
         SELECT attributed.source,
                attributed.automation_id,
                MAX(a.name) AS automation_name,
                COUNT(DISTINCT CASE WHEN attributed.day_index >= ? THEN attributed.run_id END) AS runs,
                COALESCE(SUM(CASE WHEN attributed.day_index >= ? THEN attributed.cost_usd END), 0) AS cost,
                COALESCE(SUM(CASE WHEN attributed.day_index < ? THEN attributed.cost_usd END), 0)
                  AS previous_cost
         FROM attributed
         LEFT JOIN automations a ON a.id = attributed.automation_id
         GROUP BY attributed.source, attributed.automation_id
         ORDER BY cost DESC, previous_cost DESC, attributed.source ASC, attributed.automation_id ASC`
      )
      .bind(
        previousFirstDay,
        lastDay,
        ...scope.binds,
        ...visible.params,
        firstDay,
        firstDay,
        firstDay
      );

    return [daily, sources];
  }

  decode([daily, sources]: SqlResult[]): AnalyticsSpendResponse {
    return { daily: this.decodeDaily(daily), sources: this.decodeSources(sources) };
  }

  private decodeDaily(result: SqlResult | undefined): AnalyticsDailySpendPoint[] {
    const points: AnalyticsDailySpendPoint[] = [];
    for (const row of parseRows(result?.results, dailyRowSchema, "analytics daily spend row")) {
      const date = utcDateFromDayIndex(row.day_index);
      const last = points[points.length - 1];
      if (last?.date === date) {
        last.sources[row.source] = row.cost;
      } else {
        points.push({ date, sources: { [row.source]: row.cost } });
      }
    }
    return points;
  }

  private decodeSources(result: SqlResult | undefined): AnalyticsSpendSourceEntry[] {
    return parseRows(result?.results, sourceRowSchema, "analytics spend source row").map((row) => {
      const totals = { runs: row.runs, cost: row.cost, previousCost: row.previous_cost };
      if (row.source === "automation") {
        return {
          ...totals,
          source: row.source,
          automationId: row.automation_id,
          automationName: row.automation_name,
        };
      }
      return { ...totals, source: row.source };
    });
  }
}
