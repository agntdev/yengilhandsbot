import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

// SCAFFOLD — generated from the bot blueprint BEFORE the agent runs.
// Keep a LIVE registration (.command / .callbackQuery / …) so this feature is
// never an empty stub. Replace the reply body with real logic + copy; if you
// change the user-facing text, update tests/specs to match EXACTLY.
// Do NOT rewrite src/bot.ts — buildBot() already auto-loads this module.
// Menu: wire this into /start via registerMainMenuItem({ label: "☎️ Kontaktlar", data: "clinic:contacts" }) if the toolkit exposes it.

registerMainMenuItem({ label: "☎️ Kontaktlar", data: "clinic:contacts", order: 30 });
const composer = new Composer<Ctx>();

composer.callbackQuery("clinic:contacts", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Klinika telefoni: +998 90 000 00 00.\nIsh vaqti: dushanba–shanba, 08:30–22:00.",
    { reply_markup: inlineKeyboard([[inlineButton("🗓 Yozilish", "booking:start")]]) },
  );
});

export default composer;
