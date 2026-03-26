import { db } from '../server/db';
import { apmCredentials } from '../shared/schema';
import { and, eq } from 'drizzle-orm';
import { AppDynamicsClient } from '../server/services/appDynamics';
import { decryptSecret } from '../server/services/credentialCrypto';

const appId = Number(process.env.APP_ID ?? '45172');

const creds = await db.select().from(apmCredentials).where(and(eq(apmCredentials.source, 'appdynamics'), eq(apmCredentials.isActive, true))).limit(1);
if (!creds.length) {
  console.log('No active cred');
  process.exit(0);
}
const cred = creds[0];
const client = new AppDynamicsClient({
  controllerUrl: cred.controllerUrl,
  account: cred.account ?? '',
  username: cred.username ?? '',
  password: decryptSecret(cred.passwordHash) ?? '',
});

const paths = [
  'Business Transaction Performance|*|Errors per Minute',
  'Business Transaction Performance|*|Calls per Minute',
  'Business Transaction Performance|*|Average Response Time (ms)',
  'Business Transaction Performance|Business Transactions|*|Errors per Minute',
  'Business Transaction Performance|Business Transactions|*|Calls per Minute',
  'Business Transaction Performance|Business Transactions|*|Average Response Time (ms)',
];

for (const p of paths) {
  try {
    const s = await client.getMetricData(appId, p, 1440);
    console.log('PATH:', p);
    console.log('SERIES:', s.length);
    console.log('FIRST:', s[0]?.metricPath ?? s[0]?.metricName ?? null);
    const firstPoint = s[0]?.metricValues?.find((v: any) => v?.value != null);
    console.log('FIRST_VALUE:', firstPoint?.value ?? null);
  } catch (e: any) {
    console.log('PATH:', p);
    console.log('ERROR:', e.message);
  }
  console.log('---');
}
process.exit(0);
