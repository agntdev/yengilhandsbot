import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";

registerMainMenuItem({ label: "🗓 Onlayn yozilish", data: "booking:start", order: 10 });

const composer = new Composer<Ctx>();
const CLINIC = { address: "Termiz shahri", phone: "+998 90 000 00 00", doctor: "Javohir" };
const SERVICES = [
  ["consult", "Ko'rik va maslahat"], ["treat", "Tishni davolash"], ["clean", "Tish tozalash"],
  ["extract", "Tish sug'urish"], ["fill", "Plomba qo'yish"], ["prosthetic", "Protezlash"],
] as const;
const serviceTitle = (id: string | undefined) => SERVICES.find(([key]) => key === id)?.[1] ?? "Xizmat";
let clock: () => number = () => Date.now();
export const now = () => clock();
export function setBookingClockForTests(value?: () => number): void { clock = value ?? (() => Date.now()); }

type Booking = { booking_id: string; service_id: string; date: string; start_time: string; end_time: string; patient_name: string; patient_phone: string; doctor: string; clinic_address: string; clinic_phone: string; status: "confirmed" | "cancelled"; created_at: string };
type StoreReply = { ok: boolean; booking?: Booking; bookings?: Booking[] };
type BookingDO = { fetch(input: string, init?: { method?: string; body?: string }): Promise<Response> };
function store(ctx: Ctx): BookingDO | undefined {
  const env = (ctx as Ctx & { env?: { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): BookingDO } } }).env;
  return env?.CHAT_DO ? env.CHAT_DO.get(env.CHAT_DO.idFromName("booking-store")) : undefined;
}
async function request(ctx: Ctx, path: string, body: unknown): Promise<StoreReply | undefined> {
  const target = store(ctx);
  if (!target) return undefined;
  const response = await target.fetch(`https://do${path}`, { method: "POST", body: JSON.stringify(body) });
  return response.json() as Promise<StoreReply>;
}
function dateValue(date: Date): string { return date.toISOString().slice(0, 10); }
function eligibleDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00+05:00`);
  return !Number.isNaN(parsed.valueOf()) && parsed.getDay() !== 0 && value >= dateValue(new Date(now() + 5 * 60 * 60 * 1000));
}
function dateButtons() {
  const rows = []; const start = new Date(now() + 5 * 60 * 60 * 1000);
  for (let offset = 0; offset < 14; offset++) { const d = new Date(start.valueOf() + offset * 86400000); const value = dateValue(d); if (eligibleDate(value)) rows.push([inlineButton(value, `booking:date:${value}`)]); }
  return inlineKeyboard(rows.slice(0, 8));
}
function slots() { const out: string[] = []; for (let minutes = 510; minutes < 1320; minutes += 30) out.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`); return out; }
function clear(ctx: Ctx) { Object.assign(ctx.session, { step: undefined, serviceId: undefined, date: undefined, startTime: undefined, endTime: undefined, patientName: undefined, patientPhone: undefined, lockToken: undefined, flowExpiresAt: undefined }); }
function flowExpired(ctx: Ctx) { return Boolean(ctx.session.flowExpiresAt && now() > ctx.session.flowExpiresAt); }
function ticket(b: Booking) { return `Yoziluvingiz tasdiqlandi.\nKod: ${b.booking_id}\nXizmat: ${serviceTitle(b.service_id)}\nSana: ${b.date}\nVaqt: ${b.start_time} (Termiz vaqti)\nShifokor: ${b.doctor}\nManzil: ${b.clinic_address}\nTelefon: ${b.clinic_phone}`; }

composer.callbackQuery("booking:start", async (ctx) => { await ctx.answerCallbackQuery(); clear(ctx); await ctx.reply("Qaysi xizmat kerak?", { reply_markup: inlineKeyboard(SERVICES.map(([id, title]) => [inlineButton(title, `booking:service:${id}`)])) }); });
composer.callbackQuery(/^booking:service:(.+)$/, async (ctx) => { const id = ctx.match[1]; await ctx.answerCallbackQuery(); if (!SERVICES.some(([key]) => key === id)) return; ctx.session.serviceId = id; await ctx.reply("Qabul kunini tanlang. Yakshanba kuni klinika yopiq.", { reply_markup: dateButtons() }); });
composer.callbackQuery(/^booking:date:(\d{4}-\d{2}-\d{2})$/, async (ctx) => { const date = ctx.match[1]; await ctx.answerCallbackQuery(); if (!ctx.session.serviceId || !eligibleDate(date)) { await ctx.reply("Bu kunni tanlab bo'lmaydi. Boshqa kunni tanlang."); return; } ctx.session.date = date; const rows = slots().map((time) => [inlineButton(time, `booking:time:${time.replace(":", "")}`)]); await ctx.reply("Bo'sh vaqtni tanlang.", { reply_markup: inlineKeyboard(rows) }); });
composer.callbackQuery(/^booking:time:(\d{2})(\d{2})$/, async (ctx) => { const start = `${ctx.match[1]}:${ctx.match[2]}`; await ctx.answerCallbackQuery(); if (!ctx.session.date || !ctx.session.serviceId || !slots().includes(start)) return; const endMinutes = Number(ctx.match[1]) * 60 + Number(ctx.match[2]) + 30; const end = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`; const token = `${ctx.from?.id ?? ctx.chat?.id}:${ctx.session.date}:${start}`; const result = await request(ctx, "/booking/lock", { date: ctx.session.date, start, token, expiresAt: now() + 10 * 60 * 1000 }); if (result && !result.ok) { await ctx.reply("Bu vaqt band bo'lib qoldi. Boshqa vaqtni tanlang."); return; } ctx.session.startTime = start; ctx.session.endTime = end; ctx.session.lockToken = token; ctx.session.step = "name"; ctx.session.flowExpiresAt = now() + 10 * 60 * 1000; await ctx.reply("Ism-familiyangizni yozing.", { reply_markup: { force_reply: true, input_field_placeholder: "Masalan: Dilnoza Karimova" } }); });
composer.on("message:text", async (ctx, next) => { if (!ctx.session.step) return next(); if (flowExpired(ctx)) { clear(ctx); await ctx.reply("Yozilish vaqti tugadi. Qaytadan vaqt tanlang."); return; } const value = ctx.message.text.trim(); if (ctx.session.step === "name") { if (value.length < 2 || value.length > 80) { await ctx.reply("Ismni to'liqroq yozing."); return; } ctx.session.patientName = value; ctx.session.step = "phone"; await ctx.reply("Telefon raqamingizni yuboring yoki yozing.", { reply_markup: { keyboard: [[{ text: "Nomerni yuborish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: "+998 90 123 45 67" } }); return; } if (ctx.session.step === "phone") { await acceptPhone(ctx, value); } });
composer.on("message:contact", async (ctx, next) => { if (ctx.session.step !== "phone") return next(); const contact = ctx.message.contact; if (contact.user_id && ctx.from && contact.user_id !== ctx.from.id) { await ctx.reply("O'zingizning raqamingizni yuboring yoki qo'lda yozing."); return; } await acceptPhone(ctx, contact.phone_number); });
async function acceptPhone(ctx: Ctx, raw: string) { const phone = raw.replace(/[\s()-]/g, ""); if (!/^\+?\d{9,15}$/.test(phone)) { await ctx.reply("Telefon raqami noto'g'ri. Masalan: +998901234567."); return; } ctx.session.patientPhone = phone.startsWith("+") ? phone : `+${phone}`; ctx.session.step = "confirm"; await ctx.reply(`Tekshirib oling:\nXizmat: ${serviceTitle(ctx.session.serviceId)}\nSana: ${ctx.session.date}\nVaqt: ${ctx.session.startTime} (Termiz vaqti)\nShifokor: ${CLINIC.doctor}\nManzil: ${CLINIC.address}\nTelefon: ${CLINIC.phone}`, { reply_markup: inlineKeyboard([[inlineButton("Tasdiqlash", "booking:confirm"), inlineButton("Bekor qilish", "booking:cancel")]]) }); }
composer.callbackQuery("booking:cancel", async (ctx) => { await ctx.answerCallbackQuery(); if (ctx.session.lockToken) await request(ctx, "/booking/release", { token: ctx.session.lockToken }); clear(ctx); await ctx.reply("Yozilish bekor qilindi.", { reply_markup: { remove_keyboard: true } }); });
composer.callbackQuery("booking:confirm", async (ctx) => { await ctx.answerCallbackQuery(); if (ctx.session.step !== "confirm" || flowExpired(ctx) || !ctx.session.serviceId || !ctx.session.date || !ctx.session.startTime || !ctx.session.endTime || !ctx.session.patientName || !ctx.session.patientPhone) { clear(ctx); await ctx.reply("Yozilish vaqti tugadi. Qaytadan boshlang."); return; } const draft = { service_id: ctx.session.serviceId, date: ctx.session.date, start_time: ctx.session.startTime, end_time: ctx.session.endTime, patient_name: ctx.session.patientName, patient_phone: ctx.session.patientPhone, doctor: CLINIC.doctor, clinic_address: CLINIC.address, clinic_phone: CLINIC.phone, created_at: new Date(now()).toISOString() }; const result = await request(ctx, "/booking/confirm", { token: ctx.session.lockToken, booking: draft }); const booking = result?.booking ?? { ...draft, booking_id: `YH-${ctx.session.date.replaceAll("-", "")}-${ctx.session.startTime.replace(":", "")}`, status: "confirmed" as const }; if (result && !result.ok) { clear(ctx); await ctx.reply("Bu vaqt band bo'lib qoldi. Boshqa vaqtni tanlang."); return; } const admin = adminChatId(ctx as Ctx & { env?: Record<string, unknown> }); if (admin) { try { await ctx.api.sendMessage(admin, `Yangi yozilish\n${ticket(booking)}\nIchki yozuv: booking:${booking.booking_id}`); } catch { await request(ctx, "/booking/queue", { booking }); } } else { await request(ctx, "/booking/queue", { booking }); } clear(ctx); await ctx.reply(ticket(booking), { reply_markup: { remove_keyboard: true } }); });
composer.callbackQuery("booking:admin", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; const result = await request(ctx, "/booking/list", {}); const list = result?.bookings ?? []; await ctx.reply(list.length ? list.map((b) => `${b.booking_id} — ${b.date} ${b.start_time}, ${b.patient_name}`).join("\n") : "Tasdiqlangan yozilishlar hali yo'q."); });
composer.callbackQuery(/^booking:admin:cancel:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx as never))) return; await request(ctx, "/booking/cancel", { bookingId: ctx.match[1] }); await ctx.reply("Yozilish bekor qilindi."); });
export default composer;
