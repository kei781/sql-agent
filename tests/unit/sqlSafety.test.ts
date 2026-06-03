import assert from "node:assert/strict";
import test from "node:test";

import { loadCatalog } from "../../src/core/catalog/index.js";
import { createSqlSafetyGate, type SqlSafetyGate } from "../../src/core/sql-safety/index.js";

async function gate(): Promise<SqlSafetyGate> {
  const catalog = await loadCatalog("config/catalog.example.json");
  return createSqlSafetyGate(catalog, {
    maxLimit: 100,
    deniedFunctions: new Set(["benchmark", "sleep", "load_file", "into_outfile", "into_dumpfile", "get_lock"]),
    deniedSchemas: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  });
}

async function codes(sql: string): Promise<string[]> {
  return (await gate()).validate(sql).map((violation) => violation.code);
}

test("accepts catalog select with limit", async () => {
  assert.deepEqual(await codes("SELECT order_id, amount FROM v_orders_masked WHERE status = 'paid' LIMIT 50"), []);
});

test("accepts catalog table aliases", async () => {
  assert.deepEqual(await codes("SELECT o.order_id FROM v_orders_masked AS o LIMIT 10"), []);
});

test("rejects non-select and multiple statements", async () => {
  assert.deepEqual(await codes("UPDATE v_orders_masked SET status = 'x'"), ["select_only", "missing_limit"]);
  assert.deepEqual(await codes("SELECT order_id FROM v_orders_masked LIMIT 1; SELECT amount FROM v_orders_masked LIMIT 1"), [
    "single_statement",
  ]);
});

test("rejects unknown table, unknown column, and denied schema", async () => {
  const violations = await codes("SELECT secret FROM mysql.user LIMIT 1");

  assert.ok(violations.includes("denied_schema"));
  assert.ok(violations.includes("unknown_table"));
  assert.ok(violations.includes("unknown_column"));
});

test("rejects missing or excessive limit", async () => {
  assert.deepEqual(await codes("SELECT order_id FROM v_orders_masked"), ["missing_limit"]);
  assert.deepEqual(await codes("SELECT order_id FROM v_orders_masked LIMIT 101"), ["limit_too_large"]);
});

test("rejects select star, parse errors, and denied functions", async () => {
  assert.deepEqual(await codes("SELECT * FROM v_orders_masked LIMIT 1"), ["select_star"]);
  assert.deepEqual(await codes("SELECT FROM"), ["parse_error"]);
  assert.deepEqual(await codes("SELECT SLEEP(1) FROM v_orders_masked LIMIT 1"), ["denied_function"]);
});

test("enforceLimit adds or caps limit", async () => {
  const safetyGate = await gate();

  assert.equal(safetyGate.enforceLimit("SELECT order_id FROM v_orders_masked"), "SELECT `order_id` FROM `v_orders_masked` LIMIT 100");
  assert.equal(
    safetyGate.enforceLimit("SELECT order_id FROM v_orders_masked LIMIT 1000"),
    "SELECT `order_id` FROM `v_orders_masked` LIMIT 100",
  );
});
