import { db } from "../server/db";
import { apmCredentials } from "../shared/schema";
import { encryptSecret } from "../server/services/credentialCrypto";
import { eq } from "drizzle-orm";

const PREFIX = "enc:";

function needsEncryption(value?: string | null): boolean {
  return !!value && !value.startsWith(PREFIX);
}

async function run(): Promise<void> {
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is required to re-encrypt credentials.");
  }

  const rows = await db.select().from(apmCredentials);
  let updated = 0;

  for (const row of rows) {
    const updates: Partial<typeof apmCredentials.$inferInsert> = {};

    if (needsEncryption(row.passwordHash)) {
      updates.passwordHash = encryptSecret(row.passwordHash);
    }
    if (needsEncryption(row.apiToken)) {
      updates.apiToken = encryptSecret(row.apiToken);
    }
    if (needsEncryption(row.clientSecret)) {
      updates.clientSecret = encryptSecret(row.clientSecret);
    }

    if (Object.keys(updates).length > 0) {
      await db.update(apmCredentials).set(updates).where(eq(apmCredentials.id, row.id));
      updated++;
    }
  }

  console.log(`[reencrypt-credentials] Updated ${updated} credential record(s).`);
}

run().catch((err) => {
  console.error("[reencrypt-credentials] Failed:", err);
  process.exit(1);
});

