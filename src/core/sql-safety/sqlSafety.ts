import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;

import type { Catalog } from "../catalog/index.js";
import { hasColumn, tableNames } from "../catalog/index.js";

export type SafetyViolation = Readonly<{
  code:
    | "parse_error"
    | "single_statement"
    | "select_only"
    | "select_into"
    | "select_star"
    | "denied_schema"
    | "unknown_table"
    | "unknown_column"
    | "denied_function"
    | "missing_limit"
    | "invalid_limit"
    | "limit_too_large";
  message: string;
}>;

export type SqlSafetyPolicy = Readonly<{
  maxLimit: number;
  deniedFunctions: ReadonlySet<string>;
  deniedSchemas: ReadonlySet<string>;
}>;

export const defaultSqlSafetyPolicy: SqlSafetyPolicy = Object.freeze({
  maxLimit: 1000,
  deniedFunctions: new Set(["benchmark", "sleep", "load_file", "into_outfile", "into_dumpfile", "get_lock"]),
  deniedSchemas: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
});

export type SqlSafetyGate = Readonly<{
  validate(sql: string): SafetyViolation[];
  enforceLimit(sql: string): string;
}>;

type SqlAst = Record<string, unknown>;

type ParseOptions = { database: "MySQL" };

const parseOptions: ParseOptions = { database: "MySQL" };

export function createSqlSafetyGate(
  catalog: Catalog,
  policy: SqlSafetyPolicy = defaultSqlSafetyPolicy,
): SqlSafetyGate {
  const parser = new Parser();

  return {
    validate(sql: string): SafetyViolation[] {
      const parsed = parseSingleStatement(parser, sql);
      if ("violation" in parsed) {
        return [parsed.violation];
      }

      const ast = parsed.ast;
      const violations: SafetyViolation[] = [];

      if (ast.type !== "select") {
        violations.push({ code: "select_only", message: "SELECT 쿼리만 실행할 수 있습니다." });
      }

      if (hasSelectInto(ast)) {
        violations.push({ code: "select_into", message: "SELECT ... INTO 구문은 허용하지 않습니다." });
      }

      violations.push(...validateTables(ast, catalog, policy));
      violations.push(...validateColumns(ast, catalog));
      violations.push(...validateFunctions(ast, policy));
      violations.push(...validateLimit(ast, policy));
      return violations;
    },

    enforceLimit(sql: string): string {
      const parsed = parseSingleStatement(parser, sql);
      if ("violation" in parsed) {
        throw new Error(parsed.violation.message);
      }

      const ast = parsed.ast;
      const limit = getLimit(ast);
      if (limit === undefined) {
        ast.limit = { seperator: "", value: [{ type: "number", value: policy.maxLimit }] };
      } else if (limit.value === undefined || limit.value > policy.maxLimit) {
        const limitNode = ast.limit as SqlAst;
        limitNode.value = [{ type: "number", value: policy.maxLimit }];
      }

      return parser.sqlify(ast as never, parseOptions);
    },
  };
}

function parseSingleStatement(
  parser: InstanceType<typeof Parser>,
  sql: string,
): { ast: SqlAst } | { violation: SafetyViolation } {
  let parsed: unknown;
  try {
    parsed = parser.astify(sql, parseOptions);
  } catch (error) {
    return {
      violation: {
        code: "parse_error",
        message: `SQL 파싱에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      return { violation: { code: "single_statement", message: "SQL은 단일 문장이어야 합니다." } };
    }
    return { ast: parsed[0] as SqlAst };
  }

  return { ast: parsed as SqlAst };
}

function validateTables(ast: SqlAst, catalog: Catalog, policy: SqlSafetyPolicy): SafetyViolation[] {
  const allowedTableNames = tableNames(catalog);
  const violations: SafetyViolation[] = [];

  for (const table of tableReferences(ast)) {
    if (table.db !== undefined && policy.deniedSchemas.has(table.db.toLowerCase())) {
      violations.push({ code: "denied_schema", message: `금지된 스키마입니다: ${table.db}` });
    }
    if (!allowedTableNames.has(table.table)) {
      violations.push({ code: "unknown_table", message: `카탈로그에 없는 테이블/뷰입니다: ${table.table}` });
    }
  }

  return violations;
}

function validateColumns(ast: SqlAst, catalog: Catalog): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  const aliases = tableAliasMap(ast);

  for (const column of columnReferences(ast)) {
    if (column.column === "*") {
      violations.push({ code: "select_star", message: "SELECT * 는 허용하지 않습니다." });
      continue;
    }

    const tableName = column.table === undefined ? undefined : aliases.get(column.table) ?? column.table;
    if (!hasColumn(catalog, column.column, tableName)) {
      violations.push({
        code: "unknown_column",
        message: `카탈로그에 없는 컬럼입니다: ${column.table === undefined ? column.column : `${column.table}.${column.column}`}`,
      });
    }
  }

  return violations;
}

function validateFunctions(ast: SqlAst, policy: SqlSafetyPolicy): SafetyViolation[] {
  return functionNames(ast)
    .filter((name) => policy.deniedFunctions.has(name.toLowerCase()))
    .map((name) => ({ code: "denied_function", message: `금지된 함수입니다: ${name}` }) satisfies SafetyViolation);
}

function validateLimit(ast: SqlAst, policy: SqlSafetyPolicy): SafetyViolation[] {
  const limit = getLimit(ast);
  if (limit === undefined) {
    return [{ code: "missing_limit", message: "LIMIT이 필요합니다." }];
  }
  if (limit.value === undefined) {
    return [{ code: "invalid_limit", message: "LIMIT은 정수 리터럴이어야 합니다." }];
  }
  if (limit.value > policy.maxLimit) {
    return [{ code: "limit_too_large", message: `LIMIT은 ${policy.maxLimit} 이하여야 합니다.` }];
  }
  return [];
}

function hasSelectInto(ast: SqlAst): boolean {
  const into = ast.into as SqlAst | undefined;
  return into !== undefined && into.position !== null && into.position !== undefined;
}

function getLimit(ast: SqlAst): { value: number | undefined } | undefined {
  const limit = ast.limit as SqlAst | null | undefined;
  const values = limit?.value;
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  const lastValue = values[values.length - 1] as SqlAst;
  if (lastValue.type !== "number") {
    return { value: undefined };
  }

  const value = typeof lastValue.value === "number" ? lastValue.value : Number(lastValue.value);
  return Number.isInteger(value) ? { value } : { value: undefined };
}

function tableReferences(ast: SqlAst): Array<{ db?: string; table: string; as?: string }> {
  return collectObjects(ast)
    .filter((node) => typeof node.table === "string" && (node.db === null || typeof node.db === "string"))
    .map((node) => ({
      ...(typeof node.db === "string" ? { db: node.db } : {}),
      table: node.table as string,
      ...(typeof node.as === "string" ? { as: node.as } : {}),
    }));
}

function tableAliasMap(ast: SqlAst): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const table of tableReferences(ast)) {
    aliases.set(table.table, table.table);
    if (table.as !== undefined) {
      aliases.set(table.as, table.table);
    }
  }
  return aliases;
}

function columnReferences(ast: SqlAst): Array<{ table?: string; column: string }> {
  return collectObjects(ast)
    .filter((node) => node.type === "column_ref" && typeof node.column === "string")
    .map((node) => ({
      ...(typeof node.table === "string" ? { table: node.table } : {}),
      column: node.column as string,
    }));
}

function functionNames(ast: SqlAst): string[] {
  return collectObjects(ast)
    .filter((node) => node.type === "function")
    .map((node) => functionName(node.name as unknown))
    .filter((name): name is string => name !== undefined);
}

function functionName(nameNode: unknown): string | undefined {
  if (!isRecord(nameNode) || !Array.isArray(nameNode.name)) {
    return undefined;
  }

  const parts = nameNode.name
    .map((part) => (isRecord(part) && typeof part.value === "string" ? part.value : undefined))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(".");
}

function collectObjects(root: unknown): SqlAst[] {
  const collected: SqlAst[] = [];
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }

    collected.push(current);
    for (const value of Object.values(current)) {
      if (isRecord(value) || Array.isArray(value)) {
        stack.push(value);
      }
    }
  }

  return collected;
}

function isRecord(value: unknown): value is SqlAst {
  return typeof value === "object" && value !== null;
}
