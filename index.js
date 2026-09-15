require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  StringSelectMenuBuilder
} = require('discord.js');

// This is a standalone strike module/bot entry point. If your existing index.js already
// creates a Discord Client, merge the marked STRIKE SYSTEM sections into that file and
// reuse its existing client instead of creating a second login with the same token.

const TOKEN = process.env.DISCORD_TOKEN;
const API_SECRET = process.env.STRIKES_API_SECRET;
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.STRIKES_DB_PATH || './data/strikes.db';
const GUILD_ID = '1543363950262100118';
const STRIKE_LOG_CHANNEL_ID = '1549360413446115338';
const STRIKE_MANAGEMENT_CHANNEL_ID = '1549361842005221396';
const STAFF_ROLE_ID = '1543367669385011302';
const BEDROCK_PREFIX = '.';

if (!TOKEN) throw new Error('DISCORD_TOKEN is required');
if (!API_SECRET || API_SECRET.length < 32) throw new Error('STRIKES_API_SECRET must be at least 32 characters');

const fs = require('fs'); const path = require('path'); fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS players (uuid TEXT PRIMARY KEY, username TEXT NOT NULL, normalized_username TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name ON players(normalized_username);
CREATE TABLE IF NOT EXISTS strike_totals (player_uuid TEXT PRIMARY KEY REFERENCES players(uuid) ON DELETE CASCADE, total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0));
CREATE TABLE IF NOT EXISTS strike_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL UNIQUE, player_uuid TEXT NOT NULL, username_at_time TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('add','remove')), requested_amount INTEGER NOT NULL, applied_amount INTEGER NOT NULL,
 previous_total INTEGER NOT NULL, new_total INTEGER NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL,
 staff_identity TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_requests (action_id TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discord_active_messages (player_uuid TEXT PRIMARY KEY, message_id TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const normalizeName = n => n.trim().toLowerCase();
const validAmount = n => Number.isSafeInteger(n) && n > 0 && n <= 1000000;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const upsertPlayer = db.prepare(`INSERT INTO players(uuid,username,normalized_username,updated_at) VALUES(?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET username=excluded.username, normalized_username=excluded.normalized_username, updated_at=excluded.updated_at`);
const ensureTotal = db.prepare(`INSERT OR IGNORE INTO strike_totals(player_uuid,total) VALUES(?,0)`);
const getPlayerByName = db.prepare(`SELECT p.uuid,p.username,COALESCE(s.total,0) total FROM players p LEFT JOIN strike_totals s ON s.player_uuid=p.uuid WHERE p.normalized_username=?`);
const getTotal = db.prepare(`SELECT total FROM strike_totals WHERE player_uuid=?`);
const getProcessed = db.prepare(`SELECT response_json FROM processed_requests WHERE action_id=?`);
const setProcessed = db.prepare(`INSERT INTO processed_requests(action_id,response_json,created_at) VALUES(?,?,?)`);
const insertAction = db.prepare(`INSERT INTO strike_actions(action_id,player_uuid,username_at_time,action,requested_amount,applied_amount,previous_total,new_total,reason,source,staff_identity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
const updateTotal = db.prepare(`UPDATE strike_totals SET total=? WHERE player_uuid=?`);

const applyActionTx = db.transaction(input => {
  const cached = getProcessed.get(input.actionId); if (cached) return JSON.parse(cached.response_json);
  if (!['add','remove'].includes(input.action)) throw new Error('Invalid action');
  if (!validAmount(input.amount)) throw new Error('Amount must be a whole number from 1 to 1000000');
  if (!input.reason || !input.reason.trim()) throw new Error('Reason is required');
  if (!input.playerUuid || !input.username) throw new Error('Player UUID and username are required');
  const now = new Date().toISOString(); upsertPlayer.run(input.playerUuid,input.username,normalizeName(input.username),now); ensureTotal.run(input.playerUuid);
  const previous = getTotal.get(input.playerUuid).total;
  const applied = input.action === 'add' ? input.amount : Math.min(previous,input.amount);
  const next = input.action === 'add' ? previous + applied : previous - applied;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Strike total overflow');
  updateTotal.run(next,input.playerUuid);
  insertAction.run(input.actionId,input.playerUuid,input.username,input.action,input.amount,applied,previous,next,input.reason.trim(),input.source,input.staffIdentity||'Unknown',now);
  const result={ok:true,username:input.username,requestedAmount:input.amount,appliedAmount:applied,previousTotal:previous,newTotal:next};
  setProcessed.run(input.actionId,JSON.stringify(result),now); return result;
});

function latestFor(uuid){return db.prepare(`SELECT * FROM strike_actions WHERE player_uuid=? ORDER BY id DESC LIMIT 1`).get(uuid);}
function activePlayers(){return db.prepare(`SELECT p.uuid,p.username,s.total FROM strike_totals s JOIN players p ON p.uuid=s.player_uuid WHERE s.total>0 ORDER BY s.total DESC,p.username COLLATE NOCASE`).all();}
function activeEmbed(p){
 const a=latestFor(p.uuid); const e=new EmbedBuilder().setTitle(`⚠️ ${p.username}`).setDescription(`**Current strikes:** ${p.total}`).setTimestamp(a?new Date(a.created_at):new Date());
 if(a)e.addFields({name:'Most recent change',value:`${a.action==='add'?'+':'-'}${a.applied_amount}`,inline:true},{name:'Reason',value:a.reason.slice(0,1024),inline:false},{name:'Staff',value:(a.staff_identity||'Unknown').slice(0,1024),inline:true},{name:'Source',value:a.source,inline:true}); return e;
}
async function syncActiveEntry(uuid){
 if(!client.isReady())return; const p=db.prepare(`SELECT p.uuid,p.username,s.total FROM players p JOIN strike_totals s ON s.player_uuid=p.uuid WHERE p.uuid=?`).get(uuid); if(!p)return;
 const channel=await client.channels.fetch(STRIKE_LOG_CHANNEL_ID).catch(()=>null); if(!channel?.isTextBased())return;
 const map=db.prepare(`SELECT message_id FROM discord_active_messages WHERE player_uuid=?`).get(uuid);
 if(p.total<=0){if(map){const m=await channel.messages.fetch(map.message_id).catch(()=>null);if(m)await m.delete().catch(()=>{});db.prepare(`DELETE FROM discord_active_messages WHERE player_uuid=?`).run(uuid);}return;}
 let m=map?await channel.messages.fetch(map.message_id).catch(()=>null):null; if(m)await m.edit({embeds:[activeEmbed(p)]}); else {m=await channel.send({embeds:[activeEmbed(p)]});db.prepare(`INSERT INTO discord_active_messages(player_uuid,message_id,updated_at) VALUES(?,?,?) ON CONFLICT(player_uuid) DO UPDATE SET message_id=excluded.message_id,updated_at=excluded.updated_at`).run(uuid,m.id,new Date().toISOString());}
}
async function syncAll(){for(const p of activePlayers())await syncActiveEntry(p.uuid); const rows=db.prepare(`SELECT player_uuid FROM discord_active_messages`).all();for(const r of rows){const t=getTotal.get(r.player_uuid);if(!t||t.total<=0)await syncActiveEntry(r.player_uuid);}}

const app=express(); app.use(express.json({limit:'32kb'}));
function auth(req,res,next){const h=req.get('authorization')||'';const expected=`Bearer ${API_SECRET}`;const a=Buffer.from(h),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Unauthorized'});next();}
app.get('/health',(req,res)=>res.json({ok:true}));
app.use('/api/v1',auth);
app.post('/api/v1/players/upsert',(req,res)=>{try{const {uuid,username}=req.body;if(!uuid||!username)return res.status(400).json({error:'uuid and username required'});upsertPlayer.run(uuid,username.trim(),normalizeName(username),new Date().toISOString());ensureTotal.run(uuid);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/v1/players/resolve',(req,res)=>{const p=getPlayerByName.get(normalizeName(String(req.query.username||'')));if(!p)return res.status(404).json({error:'Unknown player'});res.json(p);});
app.get('/api/v1/strikes/active',(req,res)=>res.json({players:activePlayers()}));
app.post('/api/v1/strikes/action',async(req,res)=>{try{const r=applyActionTx(req.body);res.json(r);await syncActiveEntry(req.body.playerUuid).catch(console.error);}catch(e){res.status(400).json({error:e.message});}});
app.listen(PORT,'0.0.0.0',()=>console.log(`Crafted Strikes API listening on ${PORT}`));

function managementEmbed(){return new EmbedBuilder().setTitle('Crafted SMP Strike Management').setDescription('Staff can add strikes, remove strikes, or view the current active-strike list. Minecraft and Discord use the same Railway database.');}
function managementRows(){return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('strike:add').setLabel('Add Strikes').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('strike:remove').setLabel('Remove Strikes').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('strike:view').setLabel('View Active Strikes').setStyle(ButtonStyle.Secondary))];}
async function ensurePanel(){const ch=await client.channels.fetch(STRIKE_MANAGEMENT_CHANNEL_ID);if(!ch?.isTextBased())throw new Error('Management channel unavailable');let id=db.prepare(`SELECT value FROM app_state WHERE key='panel_message_id'`).get()?.value;let m=id?await ch.messages.fetch(id).catch(()=>null):null;if(!m){m=await ch.send({embeds:[managementEmbed()],components:managementRows()});db.prepare(`INSERT INTO app_state(key,value) VALUES('panel_message_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(m.id);}else await m.edit({embeds:[managementEmbed()],components:managementRows()});}
function allowed(i){return i.guildId===GUILD_ID && i.member?.roles?.cache?.has(STAFF_ROLE_ID);}
const PAGE_SIZE = 25;
const allPlayers = () => db.prepare(`
  SELECT p.uuid, p.username, COALESCE(s.total, 0) AS total
  FROM players p
  LEFT JOIN strike_totals s ON s.player_uuid = p.uuid
  ORDER BY p.username COLLATE NOCASE
`).all();
const getPlayerByUuid = db.prepare(`
  SELECT p.uuid, p.username, COALESCE(s.total, 0) AS total
  FROM players p
  LEFT JOIN strike_totals s ON s.player_uuid = p.uuid
  WHERE p.uuid = ?
`);

function playerPicker(kind, page = 0) {
  const players = allPlayers();
  const pageCount = Math.max(1, Math.ceil(players.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, pageCount - 1));
  const shown = players.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (!shown.length) {
    return {
      content: 'No SMP players have been synced yet. A player will appear here after the Paper plugin has synced their UUID and username.',
      components: []
    };
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`strike:player:${kind}:${page}`)
    .setPlaceholder('Select an SMP member...')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(shown.map(p => ({
      label: p.username.slice(0, 100),
      description: `Current strikes: ${p.total}`.slice(0, 100),
      value: p.uuid
    })));

  const rows = [new ActionRowBuilder().addComponents(menu)];

  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`strike:players:${kind}:${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`strike:players:${kind}:${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1)
    ));
  }

  return {
    content: `Select an SMP member. Showing page **${page + 1}/${pageCount}** (${players.length} synced player${players.length === 1 ? '' : 's'}).`,
    components: rows
  };
}

function actionModal(kind, player) {
  const modal = new ModalBuilder()
    .setCustomId(`strike:modal:${kind}:${player.uuid}`)
    .setTitle(`${kind === 'add' ? 'Add Strikes' : 'Remove Strikes'} — ${player.username}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(kind === 'add' ? 'Number of strikes' : 'Number to remove')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(7)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
    )
  );

  return modal;
}

client.once(Events.ClientReady, async () => {
  console.log(`Strike system logged in as ${client.user.tag}`);
  await ensurePanel();
  await syncAll();
});

client.on(Events.InteractionCreate, async i => {
  try {
    if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return;

    if (!allowed(i)) {
      return i.reply({
        content: 'You do not have permission to use the strike management panel.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (i.isButton() && i.customId === 'strike:add') {
      return i.reply({ ...playerPicker('add', 0), flags: MessageFlags.Ephemeral });
    }

    if (i.isButton() && i.customId === 'strike:remove') {
      return i.reply({ ...playerPicker('remove', 0), flags: MessageFlags.Ephemeral });
    }

    if (i.isButton() && i.customId.startsWith('strike:players:')) {
      const [, , kind, pageRaw] = i.customId.split(':');
      const page = Number(pageRaw);
      if (!['add', 'remove'].includes(kind) || !Number.isInteger(page)) {
        return i.reply({ content: 'Invalid player-list request.', flags: MessageFlags.Ephemeral });
      }
      return i.update(playerPicker(kind, page));
    }

    if (i.isStringSelectMenu() && i.customId.startsWith('strike:player:')) {
      const [, , kind] = i.customId.split(':');
      if (!['add', 'remove'].includes(kind)) {
        return i.reply({ content: 'Invalid strike action.', flags: MessageFlags.Ephemeral });
      }

      const uuid = i.values[0];
      const player = getPlayerByUuid.get(uuid);
      if (!player) {
        return i.reply({
          content: 'That SMP player is no longer available in the strike database.',
          flags: MessageFlags.Ephemeral
        });
      }

      return i.showModal(actionModal(kind, player));
    }

    if (i.isButton() && i.customId === 'strike:view') {
      const list = activePlayers();
      const text = list.length
        ? list.map(p => `**${p.username}** — ${p.total}`).join('\n')
        : 'No players currently have active strikes.';
      return i.reply({ content: text.slice(0, 1900), flags: MessageFlags.Ephemeral });
    }

    if (i.isModalSubmit() && i.customId.startsWith('strike:modal:')) {
      const parts = i.customId.split(':');
      const action = parts[2];
      const uuid = parts.slice(3).join(':');

      if (!['add', 'remove'].includes(action)) {
        return i.reply({ content: 'Invalid strike action.', flags: MessageFlags.Ephemeral });
      }

      const player = getPlayerByUuid.get(uuid);
      if (!player) {
        return i.reply({
          content: 'That SMP player could not be found in the strike database.',
          flags: MessageFlags.Ephemeral
        });
      }

      const amountText = i.fields.getTextInputValue('amount').trim();
      if (!/^\d+$/.test(amountText)) {
        return i.reply({
          content: 'Amount must be a positive whole number.',
          flags: MessageFlags.Ephemeral
        });
      }

      const amount = Number(amountText);
      const reason = i.fields.getTextInputValue('reason').trim();

      if (!validAmount(amount)) {
        return i.reply({
          content: 'Amount must be a whole number from 1 to 1,000,000.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!reason) {
        return i.reply({ content: 'A reason is required.', flags: MessageFlags.Ephemeral });
      }

      const r = applyActionTx({
        actionId: crypto.randomUUID(),
        playerUuid: player.uuid,
        username: player.username,
        action,
        amount,
        reason,
        source: 'discord',
        staffIdentity: `${i.user.tag} (${i.user.id})`
      });

      await syncActiveEntry(player.uuid);

      return i.reply({
        content: `${action === 'add' ? 'Added' : 'Removed'} **${r.appliedAmount}** strike(s) ${action === 'add' ? 'to' : 'from'} **${r.username}**. New total: **${r.newTotal}**.`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({
        content: 'The strike action failed. Check the Railway logs.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

client.login(TOKEN);
