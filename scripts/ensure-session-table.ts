import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const tableName = process.env.SESSION_TABLE_NAME?.trim() || "session";
  const schemaName = process.env.SESSION_TABLE_SCHEMA?.trim() || "public";
  const grantee = process.env.SESSION_TABLE_GRANTEE?.trim();
  const qualifiedTable = `"${schemaName}"."${tableName}"`;

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
        "sid" varchar NOT NULL PRIMARY KEY,
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS "IDX_${tableName}_expire"
      ON ${qualifiedTable} ("expire");
    `);

    if (grantee) {
      await pool.query(`
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLE ${qualifiedTable}
        TO "${grantee}";
      `);
      console.log(`[session-table] granted DML permissions to "${grantee}" on ${schemaName}.${tableName}`);
    }

    console.log(`[session-table] ready: ${schemaName}.${tableName}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[session-table] failed:", err?.message ?? err);
  process.exit(1);
});

