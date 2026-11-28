import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { MS_PER_DAY } from "../db/utc-day";
import { initSchema } from "./schema";
import { SessionCoreRepository } from "./session-core-repository";

const DAY = 20_000;

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function sessionWithStorage() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const storage = createNodeSqlStorage(db);
  initSchema(storage.sql);
  const repository = new SessionCoreRepository(storage.sql, storage.transactionSync);
  repository.upsertSession({
    id: "do-id",
    sessionName: "session",
    title: null,
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    status: "active",
    createdAt: DAY * MS_PER_DAY,
    updatedAt: DAY * MS_PER_DAY,
  });
  return repository;
}

describe("SessionCoreRepository daily cost", () => {
  it("books each cost increment on the UTC day it arrives", () => {
    const repository = sessionWithStorage();

    repository.addSessionCost(1.5, DAY * MS_PER_DAY + 10);
    repository.addSessionCost(0.25, (DAY + 1) * MS_PER_DAY - 1);
    const total = repository.addSessionCost(2, (DAY + 2) * MS_PER_DAY);

    expect(total).toBe(3.75);
    expect(repository.listDailyCosts()).toEqual([
      { dayIndex: DAY, costUsd: 1.75 },
      { dayIndex: DAY + 2, costUsd: 2 },
    ]);
  });

  it("lists no days for a session that has incurred no cost", () => {
    expect(sessionWithStorage().listDailyCosts()).toEqual([]);
  });
});
