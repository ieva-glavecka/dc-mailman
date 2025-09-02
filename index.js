import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Routes, REST, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { DateTime, Interval } from 'luxon';

// ---------- ENV ----------
const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  TEAMUP_API_KEY,
  TEAMUP_CAL_KEY_OR_ID_birthday,
  TEAMUP_CAL_KEY_OR_ID_event,
  TEAMUP_CAL_KEY_OR_ID_timeoff,
  REMINDER_LOOKAHEAD_MIN = '15',
  REMINDER_SCAN_INTERVAL_SEC = '120',
  TZ_PREF = 'Europe/Riga',
} = process.env;

// Map logical names -> Teamup calendar key
const CALENDARS = {
  birthday: TEAMUP_CAL_KEY_OR_ID_birthday,
  event: TEAMUP_CAL_KEY_OR_ID_event,
  timeoff: TEAMUP_CAL_KEY_OR_ID_timeoff,
};

// Basic validation
for (const [name, key] of Object.entries(CALENDARS)) {
  if (!key) delete CALENDARS[name];
}
if (!Object.keys(CALENDARS).length) {
  console.error('No Teamup calendars configured in .env. Exiting.');
  process.exit(1);
}

// ---------- DISCORD ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Slash commands
const calendarChoices = Object.keys(CALENDARS).map(c => ({ name: c, value: c }));
const commands = [
  new SlashCommandBuilder()
    .setName('addevent')
    .setDescription('Create a Teamup event')
    .addStringOption(o => o.setName('calendar')
      .setDescription('Which calendar?')
      .setRequired(true)
      .addChoices(...calendarChoices))
    .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
    .addStringOption(o => o.setName('start').setDescription('Start ISO (e.g., 2025-09-02T14:00)').setRequired(true))
    .addStringOption(o => o.setName('end').setDescription('End ISO (e.g., 2025-09-02T15:00)').setRequired(true))
    .addStringOption(o => o.setName('notes').setDescription('Notes / Description').setRequired(false))
    .addIntegerOption(o => o.setName('subcalendar_id').setDescription('Optional numeric subcalendar id').setRequired(false)),
  new SlashCommandBuilder()
    .setName('upcoming')
    .setDescription('List upcoming Teamup events')
    .addIntegerOption(o => o.setName('hours').setDescription('Hours ahead (default 24)').setRequired(false))
    .addStringOption(o => o.setName('calendar')
      .setDescription('calendar (or "all")')
      .setRequired(false)
      .addChoices({ name: 'all', value: 'all' }, ...calendarChoices))
].map(c => c.toJSON());

// register globally so it works in any server you invite it to
async function registerCommandsGlobally() {
  const appData = await client.application?.fetch();
  await rest.put(Routes.applicationCommands(appData.id), { body: commands });
  console.log('Slash commands registered (global).');
}

// ---------- TEAMUP API ----------
const TU_BASE = 'https://api.teamup.com';

async function tuFetch(calKey, path, init = {}) {
  const headers = { 'Teamup-Token': TEAMUP_API_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) };
  const res = await fetch(`${TU_BASE}/${calKey}${path}`, { ...init, headers });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Teamup API ${path} failed: ${res.status} ${res.statusText} ${t}`);
  }
  return res.json();
}

async function getSubcalendars(calKey) {
  // Teamup returns subcalendars from /subcalendars
  const data = await tuFetch(calKey, `/subcalendars`, { method: 'GET' });
  return data.subcalendars || [];
}

// If subcalendar_id not provided, pick the first available subcalendar id
async function pickSubcalendarId(calKey) {
  const subs = await getSubcalendars(calKey);
  if (!subs.length) throw new Error('No subcalendars available; specify subcalendar_id.');
  return subs[0].id;
}

async function createEvent(calKey, { title, startISO, endISO, notes, subcalendarId }) {
  const body = {
    event: {
      title,
      start_dt: startISO,
      end_dt: endISO,
      subcalendar_id: Number(subcalendarId),
      notes: notes || ''
    }
  };
  return tuFetch(calKey, `/events`, { method: 'POST', body: JSON.stringify(body) });
}

async function listEvents(calKey, { startISO, endISO }) {
  const params = new URLSearchParams({ startDate: startISO, endDate: endISO });
  const data = await tuFetch(calKey, `/events?${params.toString()}`, { method: 'GET' });
  return data.events || [];
}

// ---------- DISCORD HELPERS ----------
function dtFmt(dt) {
  return dt.setZone(TZ_PREF).toFormat('yyyy-LL-dd HH:mm');
}
function eventEmbed(e, calName) {
  const start = DateTime.fromISO(e.start_dt);
  const end = DateTime.fromISO(e.end_dt);
  const when = `${dtFmt(start)} → ${dtFmt(end)} (${start.toRelative({ base: DateTime.now() })})`;

  const embed = new EmbedBuilder()
    .setTitle(e.title || 'Untitled')
    .setDescription(e.notes || '')
    .addFields({ name: 'When', value: when, inline: false })
    .setTimestamp(new Date());

  if (calName) embed.addFields({ name: 'Calendar', value: calName, inline: true });
  if (e.url || e.permalink) embed.setURL(e.url || e.permalink);
  return embed;
}

async function postToDiscord(content, embed) {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (!channel) throw new Error('DISCORD_CHANNEL_ID not found or inaccessible.');
  return channel.send({ content, embeds: embed ? [embed] : [] });
}

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'addevent') {
      const calName = interaction.options.getString('calendar', true);
      const calKey = CALENDARS[calName];
      const title = interaction.options.getString('title', true);
      const start = interaction.options.getString('start', true);
      const end = interaction.options.getString('end', true);
      const notes = interaction.options.getString('notes') || '';
      const forcedSubId = interaction.options.getInteger('subcalendar_id') ?? null;

      const startDT = DateTime.fromISO(start, { zone: TZ_PREF });
      const endDT = DateTime.fromISO(end, { zone: TZ_PREF });
      if (!startDT.isValid || !endDT.isValid || endDT <= startDT) {
        await interaction.reply({ ephemeral: true, content: '⚠️ Invalid dates. Use ISO like 2025-09-02T14:00; end must be after start.' });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const subId = forcedSubId ?? await pickSubcalendarId(calKey);
      const created = await createEvent(calKey, {
        title,
        startISO: startDT.toISO(),
        endISO: endDT.toISO(),
        notes,
        subcalendarId: subId
      });

      const embed = eventEmbed(created.event || created, calName);
      await postToDiscord(`🆕 **Event created** (${calName})`, embed);
      await interaction.editReply('✅ Event created and announced.');
      return;
    }

    if (interaction.commandName === 'upcoming') {
      const hours = interaction.options.getInteger('hours') ?? 24;
      const calReq = interaction.options.getString('calendar') ?? 'all';

      const now = DateTime.now().setZone(TZ_PREF);
      const end = now.plus({ hours });

      await interaction.deferReply({ ephemeral: true });

      const targetCalendars = calReq === 'all' ? Object.entries(CALENDARS) : [[calReq, CALENDARS[calReq]]];
      let all = [];
      for (const [name, key] of targetCalendars) {
        const events = await listEvents(key, { startISO: now.toISO(), endISO: end.toISO() });
        all.push(...events.map(e => ({ ...e, __calName: name })));
      }

      all.sort((a, b) => (a.start_dt < b.start_dt ? -1 : 1));
      if (!all.length) {
        await interaction.editReply(`No events in the next ${hours}h (${calReq}).`);
        return;
      }

      const lines = all.slice(0, 12).map(e => {
        const s = DateTime.fromISO(e.start_dt).setZone(TZ_PREF);
        return `• [${e.__calName}] ${dtFmt(s)} — ${e.title || 'Untitled'}`;
      });

      await interaction.editReply(`**Upcoming (next ${hours}h, ${calReq}):**\n${lines.join('\n')}${all.length > 12 ? `\n… and ${all.length - 12} more` : ''}`);
      return;
    }
  } catch (err) {
    console.error(err);
    try { await interaction.reply({ ephemeral: true, content: '❌ Error. Check logs.' }); } catch {}
  }
});

// ---------- OPTIONAL: webhook server (unused if you don’t configure Teamup webhooks) ----------
const app = express();
app.use(express.json());
app.post('/teamup/webhook', async (req, res) => {
  try {
    // If you later add Teamup webhooks, you can inspect req.body and post updates here.
    // For now, just acknowledge.
    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook error', e);
    res.status(500).send('error');
  }
});
app.listen(3000, () => console.log('Webhook server listening on :3000 (optional).'));

// ---------- REMINDER SCANNER ----------
const reminded = new Set();

async function scanAllCalendars() {
  try {
    const now = DateTime.now().setZone(TZ_PREF);
    const lookahead = now.plus({ minutes: Number(REMINDER_LOOKAHEAD_MIN) });
    const window = Interval.fromDateTimes(now.minus({ minutes: 1 }), lookahead);

    for (const [name, key] of Object.entries(CALENDARS)) {
      const events = await listEvents(key, { startISO: now.toISO(), endISO: lookahead.toISO() });
      for (const e of events) {
        const start = DateTime.fromISO(e.start_dt);
        if (!start.isValid || !window.contains(start)) continue;
        const unique = `${name}:${e.id || e.series_id || e.title}:${e.start_dt}`;
        if (reminded.has(unique)) continue;

        await postToDiscord(`⏰ **Starting soon** (${name})`, eventEmbed(e, name));
        reminded.add(unique);
      }
    }
    // occasional cleanup
    if (reminded.size > 2000) reminded.clear();
  } catch (err) {
    console.error('Reminder scan failed:', err);
  }
}

// ---------- BOOT ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommandsGlobally();
  const intervalMs = Number(REMINDER_SCAN_INTERVAL_SEC) * 1000;
  if (intervalMs > 0) {
    setInterval(scanAllCalendars, intervalMs);
    console.log(`Reminder scanner every ${REMINDER_SCAN_INTERVAL_SEC}s; lookahead ${REMINDER_LOOKAHEAD_MIN}m; calendars: ${Object.keys(CALENDARS).join(', ')}`);
  }
});
client.login(DISCORD_TOKEN);
