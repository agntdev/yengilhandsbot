# YengilHandsBot — Onlayn yozilish — Bot specification

**Archetype:** booking

**Voice:** warm and concise — write every user-facing message, button label, error, and empty state in this voice.

Telegram-bot for Yengil qo'llar dental clinic (Termiz) that lets Uzbek-speaking patients book appointments (service + date + time + name + phone), sends an immediate user confirmation (ticket) and notifies the clinic administrator in Telegram. Working days: Mon–Sat; hours: 08:30–22:00; single doctor (Javohir); offline payment only.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Mobile Telegram users in Termiz seeking quick dental appointments
- Patients preferring Uzbek-language interaction
- Clinic staff (admin) who receive and manage new bookings

## Success criteria

- A patient can complete a full booking flow and immediately receive a formatted confirmation ticket in Uzbek
- The ADMIN_CHAT_ID receives a notification message for every new booking including an internal booking id
- The system prevents double-booking the same slot across concurrent users
- Bookings are persisted and retrievable for administrative review

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu (three buttons: Onlayn yozilish / Manzil / Kontaktlar)
- **/help** (command, actor: user, command: /help) — Show brief usage help and contact info
- **🗓 Onlayn yozilish** (button, actor: user, callback: booking:start) — Start the booking flow: choose service → date → time → name → phone → confirm
  - inputs: service selection (callback), date selection (calendar via callbacks), time slot selection (callback), name (typed), phone (contact share button or typed)
  - outputs: temporary reservation of chosen slot until confirmation, persistent Booking record on confirmation, booking confirmation ticket message to user, admin notification message to ADMIN_CHAT_ID
- **📍 Manzil** (button, actor: user, callback: clinic:address) — Show clinic address, map link and opening hours
  - outputs: clinic address text (Uzbek), optional deep link to maps
- **☎️ Kontaktlar** (button, actor: user, callback: clinic:contacts) — Show phone number(s) and a button to share user's contact
  - outputs: clinic phone number(s) and working hours, keyboard button 'Nomerni yuborish' to share contact

## Flows

### New booking (happy path)
_Trigger:_ callback booking:start

1. Show services list (inline buttons) — six fixed options
2. User selects service (callback)
3. Show date picker calendar limited to Mon–Sat; disabled Sundays and past dates
4. User selects date (callback)
5. Generate available time slots for date (08:30–22:00, default 30-min slots) and show free slots (inline buttons)
6. User selects time slot (callback) → system tentatively reserves slot for session
7. Ask for name (ForceReply) — user types name
8. Ask for phone (offer 'Nomerni yuborish' contact-share button OR allow manual entry via ForceReply)
9. Show booking summary (service, date, time, doctor: Javohir, clinic address, clinic phone) and Confirm / Cancel buttons
10. On Confirm: persist Booking (status: confirmed), finalize reservation, send confirmation ticket to user, notify ADMIN_CHAT_ID with booking details and internal booking id

_Data touched:_ Service, Booking, Slot, UserProfile, ClinicProfile

### Slot reservation and conflict prevention
_Trigger:_ time slot selected

1. Atomically check slot availability in datastore
2. If free, write a temporary reservation lock tied to user's session (short TTL) and show next step to collect name/phone
3. If another user holds lock or booking exists, show 'slot taken' error and prompt to pick another slot

_Data touched:_ Slot, Booking

### Admin notification
_Trigger:_ booking confirmed

1. Format admin message with booking id, service, date, time, patient's name, phone, link to internal booking record
2. Send message to ADMIN_CHAT_ID via Telegram
3. If ADMIN_CHAT_ID missing or send fails, queue notification and surface error to owner control log

_Data touched:_ Booking, AdminInbox

### Show address & contacts
_Trigger:_ callback clinic:address or clinic:contacts

1. Return static clinic info (address, map link, working days/hours, phone)
2. Offer quick action to start booking

_Data touched:_ ClinicProfile

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat id where new bookings are sent (owner/admin inbox)
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Service** _(retention: persistent)_ — One of the six fixed service types the clinic offers
  - fields: id, title (e.g., 'Lеchenie zubov'), default_duration_minutes (30 default), display_order
- **Slot** _(retention: session)_ — A specific time interval on a given date available for booking
  - fields: date (YYYY-MM-DD), start_time (HH:MM), end_time (HH:MM), status (free|locked|booked), locked_by_session_id (nullable), lock_expires_at (nullable)
- **Booking** _(retention: persistent)_ — Persisted booking record created when a user confirms
  - fields: booking_id (internal unique id), service_id, date, start_time, end_time, patient_name, patient_phone, doctor (Javohir), clinic_address, clinic_phone, status (confirmed|cancelled), created_at
- **UserProfile** _(retention: persistent)_ — Optional persistent profile for returning users (name and phone)
  - fields: telegram_user_id, name, phone, last_booking_id (nullable)
- **ClinicProfile** _(retention: persistent)_ — Static clinic info displayed in UI
  - fields: name, address, map_link, phone, working_days (Mon-Sat), working_hours (08:30-22:00), doctor_name (Javohir)

## Integrations

- **Telegram** (required) — Bot API messaging for user interaction and admin notifications
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Set ADMIN_CHAT_ID (Telegram chat id to receive admin notifications)
- Update the displayed clinic contact info and address (static content)
- View list of confirmed bookings and booking details
- Manually cancel a booking (change booking.status)
- Export bookings (CSV) for a date range — implementation optional

## Notifications

- User booking confirmation ticket (immediate, contains booking id, service, date, time, doctor, clinic address and phone) in Uzbek
- Admin notification for each new booking (same info plus internal booking id and link)
- Inline ephemeral messages for slot-lock success or 'slot already taken' errors during selection

## Permissions & privacy

- Store patient name and phone in persistent Booking and optional UserProfile for clinic administration
- Only ADMIN_CHAT_ID recipients receive booking details; do not broadcast bookings publicly
- No third-party APIs are called by default; no online payments or external SMS/email by default
- Owner is responsible for lawful processing and retention of patient contact data

## Edge cases

- Concurrent users attempting to book the same slot — must use atomic check + short lock TTL to avoid double-booking
- User abandons flow after slot lock — lock must expire and slot return to free state
- User sends invalid phone format or refuses to share contact — allow manual entry and validate minimal length
- Sundays and past dates must be non-selectable in the calendar UI
- ADMIN_CHAT_ID not set or invalid — notifications fail and should be queued or surfaced to owner controls
- Time zone mismatch — assume clinic local timezone (Uzbekistan) and display times explicitly with timezone when helpful

## Required tests

- Dialog-level acceptance test: complete booking happy path (service → date → time → name → phone → confirm) results in user ticket and admin notification
- Race condition test: two simulated users attempt to book same slot; only one succeeds, other receives 'slot taken' prompt
- Phone capture test: sharing contact via 'Nomerni yuborish' and manual phone entry both persist valid phone in Booking
- Calendar constraints test: Sundays and past dates are not selectable; slots outside 08:30–22:00 are not offered
- Admin notification test: message delivered to ADMIN_CHAT_ID with booking id and booking link; behavior when ADMIN_CHAT_ID missing

## Assumptions

- Default slot duration is 30 minutes across all services unless owner later requests variable durations
- Only one doctor (Javohir) and a single shared schedule; no per-doctor calendars needed
- Language for UI and messages is Uzbek; brief uses Uzbek labels for buttons and messages
- Clinic works Mon–Sat by default; owner will later provide exceptions (holidays) if needed
- Bookings are 'confirmed' immediately when user confirms in bot (no additional admin approval step)
