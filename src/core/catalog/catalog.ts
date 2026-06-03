import { readFile } from "node:fs/promises";

export type CatalogColumn = Readonly<{
  name: string;
  description: string;
  dataType: string;
  pii: boolean;
}>;

export type CatalogTable = Readonly<{
  name: string;
  description: string;
  columns: readonly CatalogColumn[];
  timeColumn?: string;
  defaultWindowDays?: number;
  maxWindowDays?: number;
  joins: readonly string[];
}>;

export type Catalog = Readonly<{
  version: string;
  tables: readonly CatalogTable[];
  metrics: Readonly<Record<string, string>>;
}>;

type RawCatalog = {
  version?: string;
  metrics?: Record<string, string>;
  tables?: Array<{
    name: string;
    description?: string;
    time_column?: string;
    default_window_days?: number;
    max_window_days?: number;
    joins?: string[];
    columns?: Array<{
      name: string;
      description?: string;
      data_type?: string;
      pii?: boolean;
    }>;
  }>;
};

export async function loadCatalog(path: string): Promise<Catalog> {
  const content = await readFile(path, "utf8");
  return parseCatalog(JSON.parse(content) as RawCatalog);
}

export function parseCatalog(raw: RawCatalog): Catalog {
  return {
    version: raw.version ?? "unknown",
    metrics: Object.freeze({ ...(raw.metrics ?? {}) }),
    tables: Object.freeze(
      (raw.tables ?? []).map((table) =>
        Object.freeze({
          name: table.name,
          description: table.description ?? "",
          columns: Object.freeze(
            (table.columns ?? []).map((column) =>
              Object.freeze({
                name: column.name,
                description: column.description ?? "",
                dataType: column.data_type ?? "unknown",
                pii: column.pii ?? false,
              }),
            ),
          ),
          ...(table.time_column === undefined ? {} : { timeColumn: table.time_column }),
          ...(table.default_window_days === undefined ? {} : { defaultWindowDays: table.default_window_days }),
          ...(table.max_window_days === undefined ? {} : { maxWindowDays: table.max_window_days }),
          joins: Object.freeze([...(table.joins ?? [])]),
        }),
      ),
    ),
  };
}

export function tableNames(catalog: Catalog): ReadonlySet<string> {
  return new Set(catalog.tables.map((table) => table.name));
}

export function findTable(catalog: Catalog, tableName: string): CatalogTable | undefined {
  return catalog.tables.find((table) => table.name === tableName);
}

export function hasColumn(catalog: Catalog, columnName: string, tableName?: string): boolean {
  if (tableName !== undefined) {
    return findTable(catalog, tableName)?.columns.some((column) => column.name === columnName) ?? false;
  }

  return catalog.tables.some((table) => table.columns.some((column) => column.name === columnName));
}

export function piiColumns(catalog: Catalog): Array<Readonly<{ table: string; column: string }>> {
  return catalog.tables.flatMap((table) =>
    table.columns
      .filter((column) => column.pii)
      .map((column) => Object.freeze({ table: table.name, column: column.name })),
  );
}
