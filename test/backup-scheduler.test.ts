import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BackupClock,
  startBackupScheduler,
} from "../src/backup-scheduler.js";

class FakeClock implements BackupClock {
  date = new Date("2026-11-02T02:29:00Z");
  pending: (() => void) | undefined;
  now() {
    return this.date;
  }
  later(callback: () => void) {
    this.pending = callback;
    return () => {
      this.pending = undefined;
    };
  }
  async advance(iso: string) {
    this.date = new Date(iso);
    const callback = this.pending;
    this.pending = undefined;
    callback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("nightly wall-clock scheduling catches up once, survives restart, and stops", async () => {
  const clock = new FakeClock();
  const dates: string[] = [];
  const schedule = { at: "03:30", timeZone: "Europe/Berlin" };
  const run = async (day: string) => {
    dates.push(day);
    return true;
  };
  let scheduler = startBackupScheduler(schedule, run, undefined, clock);
  await clock.advance("2026-11-02T02:30:00Z");
  assert.deepEqual(dates, ["2026-11-02"]);
  await clock.advance("2026-11-02T02:31:00Z");
  assert.equal(dates.length, 1);
  await scheduler.stop();
  scheduler = startBackupScheduler(schedule, run, "2026-11-02", clock);
  await clock.advance("2026-11-02T10:00:00Z");
  assert.equal(dates.length, 1);
  await clock.advance("2026-11-03T05:00:00Z");
  assert.deepEqual(dates, ["2026-11-02", "2026-11-03"]);
  await scheduler.stop();
  await clock.advance("2026-11-04T05:00:00Z");
  assert.equal(dates.length, 2);
});

test("DST gaps run at first later local minute; repeated hours do not run twice", async () => {
  const clock = new FakeClock();
  clock.date = new Date("2026-03-29T00:59:00Z");
  const dates: string[] = [];
  const scheduler = startBackupScheduler(
    { at: "02:30", timeZone: "Europe/Berlin" },
    async (day) => {
      dates.push(day);
      return true;
    },
    undefined,
    clock,
  );
  await clock.advance("2026-03-29T01:00:00Z");
  assert.deepEqual(dates, ["2026-03-29"]);
  await clock.advance("2026-10-25T00:30:00Z");
  await clock.advance("2026-10-25T01:30:00Z");
  assert.deepEqual(dates, ["2026-03-29", "2026-10-25"]);
  await scheduler.stop();
});

test("slow runs do not overlap, busy runs retry, failures do not stop tomorrow's run", async () => {
  const clock = new FakeClock();
  clock.date = new Date("2026-11-02T04:00:00Z");
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = startBackupScheduler(
    { at: "03:30", timeZone: "UTC" },
    async () => {
      calls++;
      if (calls === 1) {
        await gate;
        return false;
      }
      if (calls === 2) throw new Error("fictional failed attempt");
      return true;
    },
    undefined,
    clock,
  );
  await clock.advance("2026-11-02T04:01:00Z");
  assert.equal(calls, 1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await clock.advance("2026-11-02T04:02:00Z");
  assert.equal(calls, 2);
  await clock.advance("2026-11-02T04:03:00Z");
  assert.equal(calls, 2);
  await clock.advance("2026-11-03T04:00:00Z");
  assert.equal(calls, 3);
  await scheduler.stop();
});
