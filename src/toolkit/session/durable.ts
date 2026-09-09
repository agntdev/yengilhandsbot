/**
 * Durable Object session storage + exact-time reminders for the Cloudflare
 * Workers runtime (docs/cloudflare/new-projects-on-cf.md §1, §10).
 *
 * One ChatDO instance per chat (addressed by idFromName("chat:<chatId>")). It
 * holds:
 *   - the grammY session (strongly consistent, serialized per chat for free);
 *   - that chat's reminders, with a single Durable Object ALARM armed to the
 *     earliest due one. The alarm fires at the wall-clock time even when nothing
 *     is running — this is what replaces per-bot cron + Redis (PoC: 0–1 ms).
 *
 * NONE of this is imported by the Node/long-poll entry or the test harness, so
 * `node:fs`, Redis, and this file's Workers-only globals never load there.
 */

import type { StorageAdapter } from "grammy";

// Minimal shapes so this file type-checks without pulling @cloudflare/workers-types
// into the Node build. The real bindings are provided by the Workers runtime.
export interface DOState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
export interface DOStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}
export interface WorkerEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CHAT_DO: DONamespace;
  DB?: unknown; // D1 binding (app data); see AGENTS.md
  BOT_TELEMETRY_URL?: string;
  BOT_TELEMETRY_SECRET?: string;
  BOT_TELEMETRY_SALT?: string;
}

interface Reminder {
  at: number; // epoch ms
  chatId: number | string;
  text: string;
}

interface StoredBooking {
  booking_id: string;
  service_id: string;
  date: string;
  start_time: string;
  end_time: string;
  patient_name: string;
  patient_phone: string;
  doctor: string;
  clinic_address: string;
  clinic_phone: string;
  status: "confirmed" | "cancelled";
  created_at: string;
}
interface SlotLock { token: string; expiresAt: number; }

/**
 * createDurableSessionStorage — a grammY StorageAdapter that routes each session
 * key to its own ChatDO instance. Pass to buildBot({ storage }) in the Worker.
 */
export function createDurableSessionStorage<T>(env: WorkerEnv): StorageAdapter<T> {
  const stub = (key: string): DOStub => {
    // A missing binding otherwise surfaces as the opaque "Cannot read
    // properties of undefined (reading 'get')" — live: canary #2 shipped with
    // the binding misnamed CHATDO and every update threw exactly that.
    if (!env.CHAT_DO) {
      throw new Error(
        "CHAT_DO Durable Object binding is missing — the deploy must bind class ChatDO as CHAT_DO (see cf.meta.json)",
      );
    }
    return env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + key));
  };
  return {
    async read(key: string): Promise<T | undefined> {
      const r = await stub(key).fetch("https://do/session", { method: "GET" });
      if (r.status === 204) return undefined;
      return (await r.json()) as T;
    },
    async write(key: string, value: T): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "PUT", body: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "DELETE" });
    },
  };
}

/**
 * remindAt — schedule a one-shot reminder DM for `chatId` at `whenEpochMs`.
 * Backed by the chat's ChatDO alarm; fires within a millisecond of the target
 * even if the Worker was idle. Call from a handler under the Workers runtime
 * (via ctx.env). No-op-safe: a scheduling failure never throws into the update.
 */
export async function remindAt(
  env: WorkerEnv,
  chatId: number | string,
  whenEpochMs: number,
  text: string,
): Promise<void> {
  try {
    const stub = env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + chatId));
    await stub.fetch("https://do/remind", {
      method: "POST",
      body: JSON.stringify({ at: whenEpochMs, chatId, text } satisfies Reminder),
    });
  } catch {
    /* best-effort: a reminder we couldn't schedule must not break the reply */
  }
}

async function tg(token: string, method: string, payload: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * ChatDO — the per-chat Durable Object. Its class name is referenced in
 * cf.meta.json (new_sqlite_classes) so the deployer registers the migration.
 * Constructed by the runtime with (state, env).
 */
export class ChatDO {
  constructor(
    private readonly state: DOState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Session storage (routed here by createDurableSessionStorage).
    if (url.pathname === "/session") {
      if (request.method === "GET") {
        const v = await this.state.storage.get<unknown>("session");
        if (v === undefined) return new Response(null, { status: 204 });
        return Response.json(v);
      }
      if (request.method === "PUT") {
        await this.state.storage.put("session", await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await this.state.storage.delete("session");
        return new Response(null, { status: 204 });
      }
    }

    // Schedule a reminder + (re)arm the alarm to the earliest due one.
    if (url.pathname === "/remind" && request.method === "POST") {
      const rem = (await request.json()) as Reminder;
      const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
      list.push(rem);
      await this.state.storage.put("reminders", list);
      await this.rearm(list);
      return new Response(null, { status: 204 });
    }

    // The global "booking-store" instance is deliberately addressed by every
    // handler with the same name. Durable Objects serialize requests to one
    // instance, making the check-and-lock operation atomic across patients.
    if (url.pathname.startsWith("/booking/") && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const locks = (await this.state.storage.get<Record<string, SlotLock>>("booking-locks")) ?? {};
      const bookings = (await this.state.storage.get<Record<string, StoredBooking>>("bookings")) ?? {};
      const index = (await this.state.storage.get<string[]>("booking-index")) ?? [];
      const slot = typeof body.date === "string" && typeof body.start === "string" ? `${body.date}:${body.start}` : "";
      const live = slot ? locks[slot] : undefined;
      if (live && live.expiresAt <= Date.now()) delete locks[slot];

      if (url.pathname === "/booking/lock") {
        const token = typeof body.token === "string" ? body.token : "";
        const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : 0;
        const booked = Object.values(bookings).some((b) => b.status === "confirmed" && `${b.date}:${b.start_time}` === slot);
        if (!slot || !token || expiresAt <= Date.now() || booked || (locks[slot] && locks[slot].token !== token)) {
          await this.state.storage.put("booking-locks", locks);
          return Response.json({ ok: false });
        }
        locks[slot] = { token, expiresAt };
        await this.state.storage.put("booking-locks", locks);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/booking/release") {
        const token = typeof body.token === "string" ? body.token : "";
        for (const key of Object.keys(locks)) if (locks[key].token === token) delete locks[key];
        await this.state.storage.put("booking-locks", locks);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/booking/confirm") {
        const token = typeof body.token === "string" ? body.token : "";
        const draft = body.booking as Omit<StoredBooking, "booking_id" | "status"> | undefined;
        const key = draft ? `${draft.date}:${draft.start_time}` : "";
        const lock = locks[key];
        const alreadyBooked = Object.values(bookings).some((b) => b.status === "confirmed" && `${b.date}:${b.start_time}` === key);
        if (!draft || !lock || lock.token !== token || lock.expiresAt <= Date.now() || alreadyBooked) return Response.json({ ok: false });
        const bookingId = `YH-${String(index.length + 1).padStart(6, "0")}`;
        const booking: StoredBooking = { ...draft, booking_id: bookingId, status: "confirmed" };
        bookings[bookingId] = booking;
        index.push(bookingId);
        delete locks[key];
        await this.state.storage.put({ "booking-locks": locks, bookings, "booking-index": index });
        return Response.json({ ok: true, booking });
      }
      if (url.pathname === "/booking/list") {
        return Response.json({ ok: true, bookings: index.map((id) => bookings[id]).filter(Boolean) });
      }
      if (url.pathname === "/booking/cancel") {
        const id = typeof body.bookingId === "string" ? body.bookingId : "";
        if (bookings[id]) { bookings[id].status = "cancelled"; await this.state.storage.put("bookings", bookings); }
        return Response.json({ ok: Boolean(bookings[id]) });
      }
      if (url.pathname === "/booking/queue") {
        const queued = (await this.state.storage.get<unknown[]>("admin-inbox")) ?? [];
        queued.push(body.booking);
        await this.state.storage.put("admin-inbox", queued);
        return Response.json({ ok: true });
      }
    }

    return new Response("not found", { status: 404 });
  }

  // Fires at the earliest reminder's wall-clock time. Sends every due reminder,
  // drops them, and re-arms for whatever remains.
  async alarm(): Promise<void> {
    const now = Date.now();
    const list = (await this.state.storage.get<Reminder[]>("reminders")) ?? [];
    const due = list.filter((r) => r.at <= now);
    const rest = list.filter((r) => r.at > now);
    for (const r of due) {
      await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: r.text });
    }
    await this.state.storage.put("reminders", rest);
    await this.rearm(rest);
  }

  private async rearm(list: Reminder[]): Promise<void> {
    if (list.length === 0) return;
    const next = Math.min(...list.map((r) => r.at));
    const current = await this.state.storage.getAlarm();
    if (current === null || next < current) {
      await this.state.storage.setAlarm(next);
    }
  }
}
