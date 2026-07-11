import PgBoss from "pg-boss";

/**
 * Queue policy fields shared by the small number of queues this service owns.
 * Keeping this narrower than pg-boss's full options surface makes each queue's
 * retry/expiry posture explicit at its call site.
 */
export interface QueuePolicy {
  retryLimit: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __pgBoss: PgBoss | undefined;
  // eslint-disable-next-line no-var
  var __pgBossInit: Promise<PgBoss> | undefined;
}

/**
 * Register a queue before every send/work path. pg-boss v10 silently drops a
 * send to an unregistered queue, so callers must not assume another process
 * (or even another module in this process) registered it first.
 */
export async function ensureQueue(
  boss: PgBoss,
  name: string,
  policy: QueuePolicy
): Promise<void> {
  try {
    await boss.createQueue(name, { name, ...policy });
  } catch (error) {
    // api-server and worker can race on first boot. The SQL operation is
    // idempotent, but some pg-boss versions still surface the unique error.
    if (!/already exists|duplicate|unique constraint/i.test(String(error))) {
      throw error;
    }
  }
}

/**
 * One pg-boss client per process. The initialization promise is cached before
 * awaiting start(), closing the race where two simultaneous queue users each
 * constructed and started their own client.
 */
export async function getBoss(): Promise<PgBoss> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  if (globalThis.__pgBoss) return globalThis.__pgBoss;
  if (globalThis.__pgBossInit) return globalThis.__pgBossInit;

  const pending = (async (): Promise<PgBoss> => {
    const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
    await boss.start();
    globalThis.__pgBoss = boss;
    return boss;
  })();
  globalThis.__pgBossInit = pending;

  try {
    return await pending;
  } catch (error) {
    // A rejected promise must not poison every later retry in this process.
    if (globalThis.__pgBossInit === pending) {
      globalThis.__pgBossInit = undefined;
    }
    throw error;
  }
}

/** Stop the shared client after all registered workers have begun draining. */
export async function stopBoss(): Promise<void> {
  let boss = globalThis.__pgBoss;
  if (!boss && globalThis.__pgBossInit) {
    boss = await globalThis.__pgBossInit.catch(() => undefined);
  }
  globalThis.__pgBoss = undefined;
  globalThis.__pgBossInit = undefined;
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
  }
}
