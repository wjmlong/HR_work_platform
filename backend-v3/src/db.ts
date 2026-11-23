import pg, { type PoolClient, type QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { isolatedDatabaseUrl, isolatedSchema, type Config } from "./config.js";
import { AsyncLocalStorage } from "node:async_hooks";
// SQL DATE is a calendar value, not an instant in the local timezone.
pg.types.setTypeParser(1082, (value) => value);
export type Sql = Pick<PoolClient, "query">;
export class Database {
  private context = new AsyncLocalStorage<PoolClient>();
  private requestContext = new AsyncLocalStorage<string>();
  get requestId() {
    return this.requestContext.getStore() || "";
  }
  withRequest<T>(id: string, fn: () => T): T {
    return this.requestContext.run(id, fn);
  }
  readonly pool: pg.Pool;
  get sql(): Sql {
    return this.context.getStore() || this.pool;
  }
  constructor(readonly config: Config) {
    const url = isolatedDatabaseUrl(config.databaseUrl);
    isolatedSchema(config.schema);
    this.pool = new pg.Pool({
      // Never give pg a connection string: its query options override explicit
      // fields, including a copy's search_path. No environment destination defaults.
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      max: 6,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      query_timeout: 15000,
      options: `-c search_path=${config.schema},public -c statement_timeout=15000 -c lock_timeout=5000`,
    });
    this.pool.on("error", () =>
      console.error("V4 database connection unavailable"),
    );
  }
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) {
    return (this.context.getStore() || this.pool).query<T>(text, values);
  }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const current = this.context.getStore();
    if (current) return fn(current);
    const c = await this.pool.connect();
    const ignore = () => {};
    c.on("error", ignore);
    let broken: Error | undefined;
    try {
      await c.query("BEGIN");
      if (this.requestId)
        await c.query(
          "SET LOCAL recruit.request_id TO " + pg.escapeLiteral(this.requestId),
        );
      const value = await this.context.run(c, () => fn(c));
      await c.query("COMMIT");
      return value;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
        broken = e instanceof Error ? e : new Error("connection_failed");
      }
      throw e;
    } finally {
      c.removeListener("error", ignore);
      c.release(broken);
    }
  }
  async migrate() {
    const directory = new URL("../migrations/", import.meta.url),
      files = (await readdir(directory))
        .filter((f) => /^\d+\.sql$/.test(f))
        .sort(),
      migrations = await Promise.all(
        files.map(async (f) => ({
          version: Number(f.replace(".sql", "")),
          sql: await readFile(new URL(f, directory), "utf8"),
        })),
      );
    await this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        this.config.schema,
      ]);
      await c.query(`CREATE SCHEMA IF NOT EXISTS "${this.config.schema}"`);
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const applied = new Set(
        (await c.query("SELECT version FROM schema_migrations")).rows.map(
          (r) => r.version,
        ),
      );
      const supported = Math.max(0, ...migrations.map(m => m.version));
      if ([...applied].some(v => v < 1000 && v > supported))
        throw Error('database_schema_newer_than_release');
      for (const migration of migrations)
        if (!applied.has(migration.version)) {
          await c.query(migration.sql);
          await c.query(
            "INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING",
            [migration.version],
          );
        }
    });
  }
  async close() {
    await this.pool.end();
  }
}
