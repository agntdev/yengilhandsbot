import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, urlButton } from "../toolkit/index.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.
// Menu: wire this into /start via registerMainMenuItem({ label: "📍 Manzil", data: "clinic:address" }) if the toolkit exposes it.

registerMainMenuItem({ label: "📍 Manzil", data: "clinic:address", order: 20 });
const composer = new Composer<Ctx>();

composer.callbackQuery("clinic:address", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Klinikamiz Termiz shahrida joylashgan.\nIsh vaqti: dushanba–shanba, 08:30–22:00.\n\nQabulga yozilish uchun tugmani bosing.",
    { reply_markup: inlineKeyboard([[urlButton("Xaritada ochish", "https://maps.google.com/?q=Termiz")], [inlineButton("🗓 Yozilish", "booking:start")]]) },
  );
});

export default composer;
