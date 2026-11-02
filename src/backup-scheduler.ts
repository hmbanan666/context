export interface BackupClock {
  now(): Date;
  later(callback: () => void, delayMs: number): () => void;
}
const systemClock: BackupClock = {
  now: () => new Date(),
  later(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export function startBackupScheduler(
  schedule: { readonly at: string; readonly timeZone: string },
  run: (scheduledDate: string) => Promise<boolean>,
  lastScheduledDate?: string,
  clock: BackupClock = systemClock,
) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let stopped = false;
  let cancel: (() => void) | undefined;
  let active: Promise<void> | undefined;
  let last = lastScheduledDate;
  async function tick() {
    const parts = Object.fromEntries(
      format.formatToParts(clock.now()).map((part) => [part.type, part.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}`;
    if (time >= schedule.at && (!last || date > last)) {
      try {
        if (await run(date)) last = date;
      } catch {
        // A failed attempt must not create a tight retry loop or stop the timer.
        last = date;
      }
    }
    if (!stopped) cancel = clock.later(poll, 30000);
  }
  function poll() {
    active = tick();
  }
  if (schedule.at !== "off") poll();
  return {
    async stop() {
      stopped = true;
      cancel?.();
      await active;
    },
  };
}
