import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { organizations, people } from "@/domains/identity/schema";
import { taskLinks, tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The continuity the audit called out: a task written by the domain is the
 * task the Work screen reads, and completing it twice completes it once. These
 * run against real Postgres because the status guard lives in the WHERE
 * clause — a mock would only prove the mock.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let work: typeof import("@/domains/work/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  work = await import("@/domains/work/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("work tasks", () => {
  it("a created task appears in the open list and completes once", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-open-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);

    const { id } = await work.createOwnerTask(a, { title: "Send the status update" });
    const open = await work.listOpenTasks(a);
    expect(open.map((t) => t.id)).toContain(id);
    expect(open[0].status).toBe("inbox");

    expect(await work.completeTask(a, { taskId: id })).toEqual({ id, quartzEarned: true });
    expect(await work.listOpenTasks(a)).toHaveLength(0);

    // A second click is a no-op, not a second completion — and writes no
    // second audit row.
    expect(await work.completeTask(a, { taskId: id })).toBeNull();

    const completions = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "task.completed")));
    expect(completions).toHaveLength(1);

    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
    expect(row.version).toBe(2);
  });

  it("carries why the task is on the list: set at create, edited, cleared, never invented", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-rationale-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const taskCommands = await import("@/domains/work/task-commands");

    // No rationale at create means null - the surface shows nothing, never a placeholder.
    const plain = await work.createOwnerTask(a, { title: "Plain task" });
    const readRationale = async (taskId: string) =>
      (await db.select({ rationale: tasks.rationale }).from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.rationale;
    expect(await readRationale(plain.id)).toBeNull();

    const { id } = await work.createOwnerTask(a, {
      title: "Renew the passport",
      rationale: "Expires in March and the trip is in May",
    });
    expect(await readRationale(id)).toBe("Expires in March and the trip is in May");

    // An unrelated patch leaves the rationale untouched (the !== undefined guard).
    const untouched = await taskCommands.updateTask(a, { taskId: id, expectedVersion: 1, patch: { priority: "high" } });
    expect(await readRationale(id)).toBe("Expires in March and the trip is in May");

    // Edit, then clear with null.
    const edited = await taskCommands.updateTask(a, { taskId: id, expectedVersion: untouched.version, patch: { rationale: "Trip moved to September; renewal window is tighter" } });
    expect(await readRationale(id)).toBe("Trip moved to September; renewal window is tighter");
    await taskCommands.updateTask(a, { taskId: id, expectedVersion: edited.version, patch: { rationale: null } });
    expect(await readRationale(id)).toBeNull();
  });

  it("links a task to a person and an organization", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-links-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const [person] = await db
      .insert(people)
      .values({ workspaceId, displayName: "Ada Lovelace" })
      .returning();

    const { id } = await work.createOwnerTask(a, {
      title: "Follow up",
      personId: person.id,
    });

    const links = await db
      .select({ targetType: taskLinks.targetType, targetId: taskLinks.targetId })
      .from(taskLinks)
      .where(eq(taskLinks.taskId, id));
    expect(links).toEqual([{ targetType: "person", targetId: person.id }]);

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectType, "task"), eq(auditEvents.subjectId, id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("task.created");
  });


  it("links a task to a person and an organization in one insert", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-links-org-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const [person] = await db
      .insert(people)
      .values({ workspaceId, displayName: "Ada Lovelace" })
      .returning();
    const [organization] = await db
      .insert(organizations)
      .values({ workspaceId, name: "Analytical Engines" })
      .returning();

    const { id } = await work.createOwnerTask(a, {
      title: "Send the invoice",
      personId: person.id,
      organizationId: organization.id,
    });

    // The two-link branch: a bug that dropped either entry would still pass
    // the single-link tests above.
    const links = await db
      .select({ targetType: taskLinks.targetType, targetId: taskLinks.targetId })
      .from(taskLinks)
      .where(eq(taskLinks.taskId, id));
    expect(links).toHaveLength(2);
    expect(links).toEqual(
      expect.arrayContaining([
        { targetType: "person", targetId: person.id },
        { targetType: "organization", targetId: organization.id },
      ]),
    );
  });

  it("cannot complete a cancelled task", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-cancelled-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const { id } = await work.createOwnerTask(a, { title: "Dropped" });
    await db
      .update(tasks)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(tasks.id, id));

    // A cancelled task is terminal: completing it would resurrect work the
    // owner explicitly dropped.
    expect(await work.completeTask(a, { taskId: id })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("cancelled");
  });

  it("orders open tasks by due date, undated last", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `task-order-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    await work.createOwnerTask(a, { title: "No date" });
    await work.createOwnerTask(a, { title: "Later", dueAt: new Date("2026-12-01T00:00:00Z") });
    await work.createOwnerTask(a, { title: "Sooner", dueAt: new Date("2026-11-01T00:00:00Z") });

    expect((await work.listOpenTasks(a)).map((t) => t.title)).toEqual([
      "Sooner",
      "Later",
      "No date",
    ]);
  });

  it("refuses a link to a person in another workspace", async () => {
    const one = await seedWorkspace(db, `task-link-a-${Date.now()}`);
    const two = await seedWorkspace(db, `task-link-b-${Date.now()}`);
    const [foreign] = await db
      .insert(people)
      .values({ workspaceId: two.workspaceId, displayName: "Not Mine" })
      .returning();

    await expect(
      work.createOwnerTask(ownerAuth(one.userId, one.workspaceId), {
        title: "Cross-tenant",
        personId: foreign.id,
      }),
    ).rejects.toThrow(/not found in workspace/);
    // The transaction rolled back: no task and no link survived.
    expect(await work.listOpenTasks(ownerAuth(one.userId, one.workspaceId))).toHaveLength(0);
  });
  it("cannot complete a task from another workspace", async () => {
    const one = await seedWorkspace(db, `task-ws-a-${Date.now()}`);
    const two = await seedWorkspace(db, `task-ws-b-${Date.now()}`);
    const { id } = await work.createOwnerTask(ownerAuth(one.userId, one.workspaceId), {
      title: "Mine",
    });

    expect(await work.completeTask(ownerAuth(two.userId, two.workspaceId), { taskId: id })).toBeNull();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.status).toBe("inbox");
  });
});
