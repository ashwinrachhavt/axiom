import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { memberships, users, workspaces } from "@/domains/identity/schema";

/*
 * The scaffolding every integration suite repeats: point DATABASE_URL at the
 * scratch database, open one client, and seed an owner workspace. Extracted so
 * a fix here is a fix everywhere.
 *
 * No equality guard between TEST_DATABASE_URL and DATABASE_URL: the brief ruled
 * it out and the suites insert fresh unique slugs rather than truncating, so
 * pointing both at the same database is not the data-loss mistake it is in
 * reliability.test.ts (which still owns its own truncating beforeAll).
 */

export function makeTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  const client = postgres(url, { max: 3 });
  return { client, db: drizzle(client) };
}

export async function truncateAll(client: ReturnType<typeof postgres>) {
  await client.unsafe(`do $$ declare t text; begin for t in
    select tablename from pg_tables where schemaname = 'public'
    loop execute format('truncate table %I cascade', t); end loop; end $$;`);
}
void truncateAll; // exported for suites that opt into truncation; reliability.test.ts owns its own
export async function seedWorkspace(
  db: ReturnType<typeof drizzle>,
  slug: string,
): Promise<{ userId: string; workspaceId: string }> {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId: `tw_${slug}` })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name: slug, slug: `${slug}-${Date.now()}`, isPersonal: true })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: user.id, role: "owner", status: "active" });
  return { userId: user.id, workspaceId: ws.id };
}
