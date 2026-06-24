require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf, session } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

// --- Configuración básica y rutas de datos ---
const DATA_DIR = process.env.DATA_DIR || '/data_cadenero';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'federacion_corvus.db');
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PASSWORD = process.env.BOT_PASSWORD || ''; 
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || 'corvus_secret';

// --- Inicializar bot ---
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN no definido en variables de entorno.');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// --- Inicializar DB ---
const db = new sqlite3.Database(DB_PATH);
function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS name_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, 
      pattern TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS groups (
      idx INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL UNIQUE,
      title TEXT,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS purposes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
      chat_id INTEGER PRIMARY KEY,
      require_photo INTEGER DEFAULT 0,
      purpose_id INTEGER DEFAULT NULL,
      paused INTEGER DEFAULT 0,
      processed INTEGER DEFAULT 0,
      rejected INTEGER DEFAULT 0,
      FOREIGN KEY(purpose_id) REFERENCES purposes(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      chat_id INTEGER,
      action TEXT,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    )`);

    db.run(`INSERT OR IGNORE INTO stats(key, value) VALUES('processed', 0), ('rejected', 0)`);

    db.get(`SELECT COUNT(*) as c FROM groups`, (err, row) => {
      if (!err && row && row.c === 0) {
        db.run(`INSERT INTO groups(chat_id, title, password) VALUES(?, ?, ?)`, [-1000000000000, 'GRUPO_FICTICIO_CORVUS', ''], () => {
          console.log('Grupo ficticio inicializado.');
        });
      }
    });

    db.get(`SELECT COUNT(*) as c FROM purposes`, (err, row) => {
      if (!err && row && row.c === 0) {
        const stm = db.prepare(`INSERT INTO purposes(purpose) VALUES(?)`);
        stm.run('Pláticas y cotorreo, NO XXX ni encuentros. Evita BAN.');
        stm.run('Cotorreo HOT y XXX, NO morbo. Conoce gente, disfruta.');
        stm.finalize();
        console.log('Propósitos iniciales creados.');
      }
    });

    db.get(`SELECT COUNT(*) as c FROM name_rules`, (err, row) => {
      if (!err && row && row.c === 0) {
        const insert = db.prepare(`INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`);
        insert.run('forbidden', '^\\p{Punct}+$', 'Solo símbolos de puntuación');
        insert.run('forbidden', '^[\\p{Emoji}]+$', 'Solo emoji');
        insert.run('forbidden', '^(.)\\1{7,}$', 'Repetición exagerada de un mismo caracter (spam)');
        insert.run('forbidden', '^[A-Za-z]$', 'Una sola letra');
        insert.run('forbidden', '^[A-Za-z]\\p{Emoji}$', 'Una letra + emoji');
        insert.run('forbidden', '[\\p{Script=Cyrl}]', 'Bloquear alfabeto cirílico (ruso)');
        insert.run('forbidden', '[\\p{Script=Hani}]', 'Bloquear chino/japonés');
        insert.run('forbidden', '[\\p{Script=Arabic}]', 'Bloquear árabe');
        insert.run('allowed', '^[A-Za-zÀ-ÖØ-öø-ÿ\\-\\s]{2,}$', 'Nombres latinos con espacios o guiones');
        insert.run('allowed', '^[A-Za-z]{2,}\\p{Emoji}$', 'Nombre >3 letras + emoji válido');
        insert.finalize();
        console.log('Reglas de nombres iniciales creadas.');
      }
    });
  });
}
initDb();

// --- Utilidades ---
const runQuery = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});
const getQuery = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});
const allQuery = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

async function isAdmin(ctx, userId = null) {
  try {
    const uid = userId || ctx.from.id;
    const chatId = ctx.chat ? ctx.chat.id : ctx.message ? ctx.message.chat.id : null;
    if (!chatId) return false;
    const member = await ctx.telegram.getChatMember(chatId, uid);
    return ['creator', 'administrator'].includes(member.status);
  } catch (e) {
    return false;
  }
}

function incrStat(key, amount = 1) {
  db.run(`INSERT INTO stats(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = value + ?`, [key, amount, amount]);
}

async function validateName(name) {
  if (!name || typeof name !== 'string') return { ok: false, reason: 'Nombre vacío' };
  const trimmed = name.trim();
  const rules = await allQuery(`SELECT * FROM name_rules ORDER BY id ASC`);
  
  for (const r of rules.filter(x => x.type === 'forbidden')) {
    try {
      const re = new RegExp(r.pattern, 'u');
      if (re.test(trimmed)) return { ok: false, reason: r.description || 'Nombre no permitido' };
    } catch (e) {
      console.warn('Invalid regex in name_rules:', r.pattern);
    }
  }
  
  const allowedRules = rules.filter(x => x.type === 'allowed');
  if (allowedRules.length > 0) {
    for (const r of allowedRules) {
      try {
        const re = new RegExp(r.pattern, 'u');
        if (re.test(trimmed)) return { ok: true, reason: null };
      } catch (e) { }
    }
    return { ok: false, reason: 'No cumple reglas de nombres latinos válidos' };
  }
  return { ok: true, reason: null };
}

// --- Manejo de chat_join_request ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const req = ctx.update.chat_join_request;
    const chatId = req.chat.id;
    const user = req.from;
    const fullName = `${user.first_name || ''}${user.last_name ? ' ' + user.last_name : ''}`.trim();

    const s = await getQuery(`SELECT paused FROM settings WHERE chat_id = ?`, [chatId]);
    if (s && s.paused === 1) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Bot pausado']);
      incrStat('rejected', 1);
      return;
    }

    const banned = await getQuery(`SELECT * FROM banned_users WHERE user_id = ?`, [user.id]);
    if (banned) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Usuario en lista negra']);
      incrStat('rejected', 1);
      return;
    }

    const validation = await validateName(fullName || user.username || '');
    if (!validation.ok) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', validation.reason]);
      incrStat('rejected', 1);
      return;
    }

    const setting = await getQuery(`SELECT require_photo FROM settings WHERE chat_id = ?`, [chatId]);
    if (setting && setting.require_photo === 1) {
      const photos = await ctx.telegram.getUserProfilePhotos(user.id, 0, 1).catch(() => null);
      if (!photos || photos.total_count === 0) {
        await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
        await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Requiere foto de perfil']);
        incrStat('rejected', 1);
        return;
      }
    }

    await ctx.telegram.approveChatJoinRequest(chatId, user.id).catch(() => {});
    await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_approved', 'Validación OK']);
    incrStat('processed', 1);

    const purposeRow = await getQuery(`SELECT p.purpose FROM settings s LEFT JOIN purposes p ON s.purpose_id = p.id WHERE s.chat_id = ?`, [chatId]);
    const purposeText = purposeRow && purposeRow.purpose ? purposeRow.purpose : null;
    const welcomeText = `Bienvenido ${user.first_name || user.username || ''} a ${req.chat.title}\n\n` +
      (purposeText ? `Propósito: ${purposeText}` : 'Propósito: No definido');

    const keyboard = [
      [{ text: 'Propósito', callback_data: `popup_purpose_${chatId}` }],
      [{ text: 'Rechazo 🚫', callback_data: `manual_reject_${user.id}_${chatId}` }]
    ];

    const sent = await ctx.telegram.sendMessage(chatId, welcomeText, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'HTML'
    });

    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
      } catch (e) { }
    }, 5 * 60 * 1000);

  } catch (e) {
    console.error('Error en chat_join_request:', e);
  }
});

// --- Callbacks ---
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.from.id;
    if (data.startsWith('popup_purpose_')) {
      const chatId = Number(data.split('_').pop());
      const purposeRow = await getQuery(`SELECT p.purpose FROM settings s LEFT JOIN purposes p ON s.purpose_id = p.id WHERE s.chat_id = ?`, [chatId]);
      const purposeText = purposeRow && purposeRow.purpose ? purposeRow.purpose : 'No definido';
      await ctx.answerCbQuery(purposeText, { show_alert: true });
      return;
    }
    if (data.startsWith('manual_reject_')) {
      const parts = data.split('_');
      const targetUserId = Number(parts[2]);
      const chatId = Number(parts[3]);
      const member = await ctx.telegram.getChatMember(chatId, fromId).catch(() => null);
      if (!member || !['creator', 'administrator'].includes(member.status)) {
        await ctx.answerCbQuery('Solo administradores pueden usar Rechazo.', { show_alert: true });
        return;
      }
      await ctx.telegram.banChatMember(chatId, targetUserId).catch(() => {});
      await runQuery(`INSERT OR IGNORE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`, [targetUserId, '', '', '', 'Manual rejection by admin']);
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [targetUserId, chatId, 'manual_ban', 'Rechazo manual por admin']);
      await ctx.editMessageText('Usuario rechazado y baneado por administrador.');
      await ctx.answerCbQuery('Usuario rechazado.', { show_alert: false });
      return;
    }
  } catch (e) {
    console.error('Error en callback_query:', e);
  }
});

// --- Comandos públicos ---
bot.start(async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const s = await getQuery(`SELECT require_photo, purpose_id, paused, processed, rejected FROM settings WHERE chat_id = ?`, [chatId]);
    const purposeRow = s && s.purpose_id ? await getQuery(`SELECT purpose FROM purposes WHERE id = ?`, [s.purpose_id]) : null;
    const purposeText = purposeRow ? purposeRow.purpose : 'No definido';
    const status = s && s.paused === 1 ? 'Pausado' : 'Activo';
    const processed = s ? s.processed || 0 : 0;
    const rejected = s ? s.rejected || 0 : 0;

    const message = `Bot activo en ${ctx.chat.title || 'chat privado'}\n` +
      `🛡️ Estado: ${status}\n` +
      `📊 Procesados: ${processed} | 🚫 Rechazados: ${rejected}\n` +
      `⚙️ Propósito del grupo ID: ${s && s.purpose_id ? s.purpose_id : 'No definido'}`;

    if (ctx.chat.type === 'private') {
      await ctx.reply(`Bot FEDERACIÓN CORVUS - ${status}\n\n${message}`);
    } else {
      await ctx.reply(message);
    }
  } catch (e) {
    console.error('/start error', e);
  }
});

bot.command('help', async (ctx) => {
  const helpText = `
FEDERACIÓN CORVUS - Comandos

Comandos públicos:
/start - Resumen del estado del bot en este chat
/help - Mostrar esta ayuda

Comandos administradores:
/addnamerule - Agregar regla de nombre
/listnamerules - Ver reglas de nombres
/delnamerule <id> - Borrar regla de nombre

/requirephoto on|off - Requisito de foto para ingresar
/config - Modificar configuración rápida del grupo

/addgroup - Agregar grupo a la federación
/delgroup <nombre> - Borrar grupo autorizado por nombre
/listgroups - Ver grupos autorizados

/gban <reply o user_id> <motivo> - Aplicar GBAN federación
/addinfo <motivo> - Extrae y guarda datos respondiendo a un mensaje de bot
/addblacklist - Agregar usuario a blacklist desde mensaje de bot
/fedmsg - Enviar mensaje de federación a todos los grupos

/addpurpose - Agregar propósito
/listpurposes - Listar propósitos
/delpurpose <id> - Borrar propósito
/setpurpose - Seleccionar propósito del grupo

/userinfo <user_id o reply> - Ver información de usuario
/userhistory <user_id o reply> - Ver últimos 5 registros

/resetdb - Resetear bases de datos
/rawcounts - Mostrar conteo crudo de registros por tabla

/pausebot - Pausar bot en este chat
/resumebot - Reanudar funciones del bot
  `;
  await ctx.reply(helpText);
});

bot.command('addgroup', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'addgroup_confirm', chat_id: ctx.chat.id };
  
  // 'force_reply: true' es lo que abre el cuadro de respuesta como en la imagen
  await ctx.reply('Escribe la contraseña para agregar el grupo:', {
    reply_markup: { force_reply: true }
  });
});

// --- NUEVO COMANDO: EXTRACTOR DESDE RESPUESTA DE BOTS ---
bot.command('addinfo', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('Debes usar este comando respondiendo al mensaje de información del otro bot.');
  }

  const replyText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
  if (!replyText) {
    return ctx.reply('El mensaje al que respondiste no contiene texto legible.');
  }

  // Extrae solo si existe el prefijo ID: o Id:
  const idMatch = replyText.match(/(?:ID|Id|id):\s*`?(\d+)`?/i);
  const userMatch = replyText.match(/(?:Username|Usuario|User):\s*@?([A-Za-z0-9_]+)/i);
  const nameMatch = replyText.match(/(?:Nombre|Name|First Name):\s*([^\n]+)/i);

  if (!idMatch) {
    return ctx.reply('No se encontró un ID válido (debe tener formato "ID: 12345").');
  }

  const targetId = Number(idMatch[1]);
  const extractedUsername = userMatch ? userMatch[1] : '';
  const extractedName = nameMatch ? nameMatch[1].trim() : 'Extracted User';

  const parts = ctx.message.text.split(' ').filter(Boolean);
  const reason = parts.length >= 2 ? parts.slice(1).join(' ') : 'Agregado vía extracción de bot de info';

  try {
    await runQuery(
      `INSERT OR REPLACE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`,
      [targetId, extractedName, '', extractedUsername, reason]
    );

    await runQuery(
      `INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`,
      [targetId, ctx.chat.id, 'extracted_save', `Guardado desde mensaje de bot remoto. Motivo: ${reason}`]
    );

    await ctx.reply(`✅ Datos guardados con éxito en la base de datos de la Federación:\n\n🆔 ID: ${targetId}\n👤 Nombre: ${extractedName}\n🌐 @${extractedUsername || 'No tiene'}\n📝 Motivo: ${reason}`);
  } catch (e) {
    console.error('Error en addinfo:', e);
    await ctx.reply('Ocurrió un error al intentar registrar los datos en la base de datos.');
  }
});

bot.command('addblacklist', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  if (!ctx.message.reply_to_message) {
    return ctx.reply('Debes usar este comando respondiendo al mensaje del otro bot.');
  }

  const replyText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || '';
  if (!replyText) {
    return ctx.reply('El mensaje al que respondiste no contiene texto legible.');
  }

  // Extrae solo si existe el prefijo ID: o Id:
  const idMatch = replyText.match(/(?:ID|Id|id):\s*`?(\d+)`?/i);
  const userMatch = replyText.match(/(?:Username|Usuario|User):\s*@?([A-Za-z0-9_]+)/i);
  const nameMatch = replyText.match(/(?:Nombre|Name|First Name):\s*([^\n]+)/i);

  if (!idMatch) {
    return ctx.reply('No se encontró un ID válido (debe tener formato "ID: 12345").');
  }

  const targetId = Number(idMatch[1]);
  const extractedUsername = userMatch ? userMatch[1] : '';
  const extractedName = nameMatch ? nameMatch[1].trim() : 'Extracted User';

  try {
    await runQuery(
      `INSERT OR REPLACE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`,
      [targetId, extractedName, '', extractedUsername, 'Agregado vía addblacklist (extracción)']
    );

    await runQuery(
      `INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`,
      [targetId, ctx.chat.id, 'add_blacklist', 'Usuario agregado a la blacklist desde mensaje de bot remoto.']
    );

    await ctx.reply(`✅ Usuario ${targetId} añadido a la BLACKLIST correctamente.\n\n👤 Nombre: ${extractedName}\n🌐 @${extractedUsername || 'No tiene'}`);
  } catch (e) {
    console.error('Error en addblacklist:', e);
    await ctx.reply('Ocurrió un error al intentar registrar al usuario en la blacklist.');
  }
});

// --- Comandos administrativos ---
bot.command('addnamerule', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'add_name_rule', chat_id: ctx.chat.id };
  await ctx.reply('Envíame la regla en formato JSON:\n{"type":"forbidden","pattern":"<regex>","description":"texto"}');
});

bot.command('listnamerules', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT id, type, description, pattern, created_at FROM name_rules ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay reglas de nombres definidas.');
  const lines = rows.map(r => `${r.id} | ${r.type.toUpperCase()} | ${r.description || ''} | ${r.pattern}`);
  await ctx.reply(lines.join('\n'));
});

bot.command('delnamerule', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /delnamerule <id>');
  const id = Number(parts[1]);
  await runQuery(`DELETE FROM name_rules WHERE id = ?`, [id]);
  await ctx.reply(`Regla ${id} eliminada si existía.`);
});

bot.command('requirephoto', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /requirephoto on|off');
  const val = parts[1].toLowerCase() === 'on' ? 1 : 0;
  await runQuery(`INSERT OR REPLACE INTO settings(chat_id, require_photo) VALUES(?, ?)`, [ctx.chat.id, val]);
  await ctx.reply(`Requisito de foto para ingresar: ${val ? 'Activado' : 'Desactivado'}`);
});

bot.command('config', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'config', chat_id: ctx.chat.id };
  await ctx.reply('Envíame las configuraciones en líneas separadas, por ejemplo:\nrequire_photo=on\npaused=off\npurpose_id=2');
});

bot.command('listgroups', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT idx, chat_id, title, created_at FROM groups ORDER BY idx ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay grupos autorizados.');
  const lines = rows.map(r => `${r.idx}. ${r.title} (chat_id: ${r.chat_id})`);
  await ctx.reply(lines.join('\n'));
});

bot.command('delgroup', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length === 0) return ctx.reply('Uso: /delgroup <nombre del grupo>');
  const name = parts.join(' ');
  await runQuery(`DELETE FROM groups WHERE title = ?`, [name]);
  await ctx.reply(`Grupo "${name}" eliminado de la federación.`);
});

bot.command('gban', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');

  let userInfo = { id: null, first_name: '', last_name: '', username: '' };
  let reason = 'GBAN federación';
  const parts = ctx.message.text.split(' ').filter(Boolean);

  if (ctx.message.reply_to_message) {
    const u = ctx.message.reply_to_message.from;
    userInfo.id = u.id;
    userInfo.first_name = u.first_name || '';
    userInfo.last_name = u.last_name || '';
    userInfo.username = u.username || '';
    if (parts.length >= 2) reason = parts.slice(1).join(' ');
  } else {
    if (parts.length < 2) return ctx.reply('Indica el usuario (responde a su mensaje o usa /gban <id o @username> <motivo>)');
    const target = parts[1];
    if (parts.length >= 3) reason = parts.slice(2).join(' ');

    if (/^\d+$/.test(target)) {
      userInfo.id = Number(target);
    } else {
      const username = target.startsWith('@') ? target : '@' + target;
      try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, username);
        userInfo.id = member.user.id;
        userInfo.first_name = member.user.first_name || '';
        userInfo.last_name = member.user.last_name || '';
        userInfo.username = member.user.username || '';
      } catch (e) {
        return ctx.reply('No se pudo encontrar al usuario con ese username en este chat.');
      }
    }
  }

  if (!userInfo.id) return ctx.reply('Error al identificar al usuario.');

  await runQuery(`INSERT OR IGNORE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`, [userInfo.id, userInfo.first_name, userInfo.last_name, userInfo.username, reason]);

  const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
  const gbantxt = `🚨GBAN DE FEDERACION CORVUS🚨\n=================\n👤 ${userInfo.id}\n👦🏻 ${userInfo.first_name || '-'}\n👪 ${userInfo.last_name || '-'}\n🌐 ${userInfo.username ? '@' + userInfo.username : '-'}\n==============================\n⌛️Auto borrado en 5 min ⌛️`;

  for (const g of groups) {
    try {
      const sent = await ctx.telegram.sendMessage(g.chat_id, gbantxt);
      setTimeout(async () => {
        try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch (e) {}
      }, 5 * 60 * 1000);
      await ctx.telegram.banChatMember(g.chat_id, userInfo.id).catch(() => {});
    } catch (e) { }
  }
  await ctx.reply('GBAN aplicado y notificación distribuida.');
});

bot.command('fedmsg', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'fedmsg', chat_id: ctx.chat.id };
  await ctx.reply('Envíame el comunicado oficial que se enviará a todos los grupos afiliados.');
});

bot.command('addpurpose', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'addpurpose' };
  await ctx.reply('Envíame el texto del propósito (máx 60 caracteres).');
});

bot.command('listpurposes', async (ctx) => {
  const rows = await allQuery(`SELECT id, purpose FROM purposes ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay propósitos definidos.');
  const lines = rows.map(r => `${r.id}.- ${r.purpose}`);
  await ctx.reply(lines.join('\n'));
});

bot.command('delpurpose', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /delpurpose <id>');
  const id = Number(parts[1]);
  await runQuery(`DELETE FROM purposes WHERE id = ?`, [id]);
  await ctx.reply(`Propósito ${id} eliminado si existía.`);
});

bot.command('setpurpose', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT id, purpose FROM purposes ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay propósitos definidos.');
  const lines = rows.map(r => `${r.id}.- ${r.purpose}`);
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'setpurpose', chat_id: ctx.chat.id };
  await ctx.reply('Propósitos disponibles:\n' + lines.join('\n') + '\n\nEnvíame el número para asignarlo al grupo.');
});

bot.command('resetdb', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (BOT_PASSWORD) {
    if (!ctx.session) ctx.session = {};
    ctx.session.awaiting = { action: 'resetdb_confirm' };
    await ctx.reply('Envíame la contraseña de verificación para ejecutar el reseteo.');
    return;
  }
  await runQuery(`DELETE FROM name_rules`);
  await runQuery(`DELETE FROM banned_users`);
  await runQuery(`DELETE FROM groups`);
  await runQuery(`DELETE FROM settings`);
  await runQuery(`DELETE FROM user_history`);
  await runQuery(`DELETE FROM stats`);
  initDb();
  await ctx.reply('Bases de datos reseteadas.');
});

bot.command('userinfo', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  let targetId = null;
  const parts = ctx.message.text.split(' ').filter(Boolean);

  // 1. Identificar el targetId
  if (ctx.message.reply_to_message) {
    targetId = ctx.message.reply_to_message.from.id;
  } else if (parts.length >= 2) {
    const input = parts[1].replace('@', ''); // Limpiamos el @
    
    if (/^\d+$/.test(input)) {
      // Si es numérico, es un ID
      targetId = Number(input);
    } else {
      // Si es texto, buscamos primero en la base de datos (banned_users)
      const dbUser = await getQuery(`SELECT user_id FROM banned_users WHERE username = ? OR username = ?`, [input, '@' + input]);
      if (dbUser) {
        targetId = dbUser.user_id;
      } else {
        // Fallback: intentar resolver vía Telegram (solo funciona si está en el chat)
        try {
          const username = input.startsWith('@') ? input : '@' + input;
          const member = await ctx.telegram.getChatMember(ctx.chat.id, username);
          targetId = member.user.id;
        } catch (e) {
          return ctx.reply('No se pudo encontrar al usuario. No está en la base de datos ni en este chat.');
        }
      }
    }
  }

  if (!targetId) return ctx.reply('Uso: /userinfo <user_id o @username> o responde a su mensaje.');

  // 2. Obtener info de Telegram (si es posible) y de la DB
  let tgInfo = null;
  try {
    tgInfo = await ctx.telegram.getChatMember(ctx.chat.id, targetId).catch(() => null);
  } catch (e) { }

  const dbUser = await getQuery(`SELECT * FROM banned_users WHERE user_id = ?`, [targetId]);
  const history = await allQuery(`SELECT action, note, created_at FROM user_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [targetId]);

  // 3. Formatear y enviar respuesta
  const lines = [
    `👤 ID: ${targetId}`,
    `👦🏻 Nombre: ${tgInfo?.user?.first_name || dbUser?.first_name || '-'}`,
    `👪 Apellido: ${tgInfo?.user?.last_name || dbUser?.last_name || '-'}`,
    `🌐 Username: ${tgInfo?.user?.username ? '@' + tgInfo.user.username : (dbUser?.username ? '@' + dbUser.username : '-')}`,
    `📅 Último registro: ${history?.[0]?.created_at || '-'}`,
    `📝 Motivo (DB): ${dbUser?.reason || '-'}`,
    `Alertas/Bloqueos: ${dbUser ? 'Sí' : 'No'}`
  ];
  
  await ctx.reply(lines.join('\n'));

  if (history && history.length > 0) {
    const histLines = history.map(h => `${h.created_at} | ${h.action} | ${h.note}`);
    await ctx.reply('Historial (últimos 5):\n' + histLines.join('\n'));
  }
});

bot.command('userhistory', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  let targetId = null;
  const parts = ctx.message.text.split(' ').filter(Boolean);

  if (ctx.message.reply_to_message) {
    targetId = ctx.message.reply_to_message.from.id;
  } else if (parts.length >= 2) {
    const input = parts[1];
    // Si es numérico lo tomamos como ID, si no intentamos resolver el username
    if (/^\d+$/.test(input)) {
      targetId = Number(input);
    } else {
      try {
        const username = input.startsWith('@') ? input : '@' + input;
        const member = await ctx.telegram.getChatMember(ctx.chat.id, username);
        targetId = member.user.id;
      } catch (e) {
        return ctx.reply('No se pudo encontrar al usuario. Verifica el ID o el @username.');
      }
    }
  }

  if (!targetId) return ctx.reply('Uso: /userhistory <user_id o @username> o responde a su mensaje.');

  const history = await allQuery(`SELECT action, note, created_at FROM user_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [targetId]);
  if (!history || history.length === 0) return ctx.reply('No hay historial.');
  const histLines = history.map(h => `${h.created_at} | ${h.action} | ${h.note}`);
  await ctx.reply('Historial (últimos 5):\n' + histLines.join('\n'));
});

bot.command('pausebot', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [ctx.chat.id, 1]);
  await ctx.reply('Bot pausado en este chat.');
});

bot.command('resumebot', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [ctx.chat.id, 0]);
  await ctx.reply('Bot reanudado.');
});

bot.command('rawcounts', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const tables = ['name_rules', 'banned_users', 'groups', 'purposes', 'settings', 'user_history', 'stats'];
  const results = [];
  for (const t of tables) {
    const r = await getQuery(`SELECT COUNT(*) as c FROM ${t}`);
    results.push(`${t}: ${r ? r.c : 0}`);
  }
  await ctx.reply('Conteo:\n' + results.join('\n'));
});

bot.command('addvalidname', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'add_name_rule', chat_id: ctx.chat.id };
  await ctx.reply('Envía la regla permitida en JSON: {"type":"allowed","pattern":"<regex>","description":"texto"}');
});

bot.command('listvalidnames', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT id, pattern, description FROM name_rules WHERE type = 'allowed' ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay reglas de nombres válidos.');
  const lines = rows.map(r => `${r.id} | ${r.pattern} | ${r.description || ''}`);
  await ctx.reply(lines.join('\n'));
});

bot.command('delvalidname', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /delvalidname <id>');
  const id = Number(parts[1]);
  await runQuery(`DELETE FROM name_rules WHERE id = ? AND type = 'allowed'`, [id]);
  await ctx.reply(`Regla válida ${id} eliminada.`);
});

bot.command('pauseall', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Este comando debe ejecutarse en privado.');
  if (!BOT_PASSWORD) return ctx.reply('No hay contraseña configurada.');
  if (!ctx.session) ctx.session = {};
  ctx.session.awaiting = { action: 'pauseall_confirm' };
  await ctx.reply('Envía la contraseña para pausar todas las funciones del bot.');
});

// --- Unificación exclusiva de entradas de texto ---
bot.on('message', async (ctx) => {
  try {
    const text = ctx.message.text || '';
    if (!ctx.session) ctx.session = {};
    if (!ctx.session.awaiting) return;

    const awaiting = ctx.session.awaiting;

    // 1. Lógica para procesar la contraseña de addgroup (BORRA MENSAJE)
    if (awaiting.action === 'addgroup_confirm') {
      await ctx.deleteMessage().catch(() => {}); // Borra la contraseña del usuario
      
      if (!(await isAdmin(ctx))) {
        ctx.session.awaiting = null;
        return;
      }

      if (text === BOT_PASSWORD) {
        await runQuery(`INSERT OR REPLACE INTO groups(chat_id, title) VALUES(?, ?)`, [ctx.chat.id, ctx.chat.title || 'Grupo']);
        await ctx.reply('✅ Grupo autorizado exitosamente.');
      } else {
        await ctx.reply('❌ Contraseña incorrecta.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 2. Lógica para procesar add_name_rule
    if (awaiting.action === 'add_name_rule') {
      try {
        const obj = JSON.parse(text);
        if (!obj.type || !obj.pattern) {
          await ctx.reply('❌ JSON inválido.');
        } else {
          await runQuery(`INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`, [obj.type, obj.pattern, obj.description || '']);
          await ctx.reply('✅ Regla agregada correctamente.');
        }
      } catch (e) {
        await ctx.reply('❌ Error al parsear JSON.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 3. Lógica para addpurpose
    if (awaiting.action === 'addpurpose') {
      const purpose = text.trim();
      if (purpose.length === 0 || purpose.length > 60) {
        await ctx.reply('❌ Propósito inválido (máx 60 caracteres).');
      } else {
        await runQuery(`INSERT INTO purposes(purpose) VALUES(?)`, [purpose]);
        await ctx.reply('✅ Propósito agregado.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 4. Lógica para setpurpose
    if (awaiting.action === 'setpurpose') {
      const chatId = awaiting.chat_id;
      const num = Number(text.trim());
      if (isNaN(num)) {
        await ctx.reply('❌ Envía el número del propósito.');
      } else {
        const p = await getQuery(`SELECT id FROM purposes WHERE id = ?`, [num]);
        if (!p) {
          await ctx.reply('❌ Propósito no encontrado.');
        } else {
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, purpose_id) VALUES(?, ?)`, [chatId, num]);
          await ctx.reply('✅ Propósito asignado al grupo.');
        }
      }
      ctx.session.awaiting = null;
      return;
    }

    // 5. Lógica para config
    if (awaiting.action === 'config') {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const chatId = awaiting.chat_id;
      for (const line of lines) {
        const [k, v] = line.split('=').map(s => s.trim());
        if (k === 'require_photo') {
          const val = (v === 'on' || v === '1' || v === 'true') ? 1 : 0;
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, require_photo) VALUES(?, ?)`, [chatId, val]);
        } else if (k === 'paused') {
          const val = (v === 'on' || v === '1' || v === 'true') ? 1 : 0;
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [chatId, val]);
        } else if (k === 'purpose_id') {
          const pid = Number(v);
          if (!isNaN(pid)) {
            await runQuery(`INSERT OR REPLACE INTO settings(chat_id, purpose_id) VALUES(?, ?)`, [chatId, pid]);
          }
        }
      }
      await ctx.reply('✅ Configuración actualizada.');
      ctx.session.awaiting = null;
      return;
    }

    // 6. Lógica para fedmsg
    if (awaiting.action === 'fedmsg') {
      const fedtxt = `🚨  AVISO OFICIAL  🚨\n🚨FEDERACION CORVUS🚨\n==============\n${text}\n=============\n⌛ Auto borrado en 1 Hora`;
      const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
      for (const g of groups) {
        try {
          const sent = await ctx.telegram.sendMessage(g.chat_id, fedtxt);
          setTimeout(async () => {
            try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch (e) {}
          }, 60 * 60 * 1000);
        } catch (e) { }
      }
      await ctx.reply('✅ Mensaje de federación enviado.');
      ctx.session.awaiting = null;
      return;
    }

    // 7. Lógica para resetdb
    if (awaiting.action === 'resetdb_confirm') {
      if (text === BOT_PASSWORD) {
        await runQuery(`DELETE FROM name_rules`);
        await runQuery(`DELETE FROM banned_users`);
        await runQuery(`DELETE FROM groups`);
        await runQuery(`DELETE FROM settings`);
        await runQuery(`DELETE FROM user_history`);
        await runQuery(`DELETE FROM stats`);
        initDb();
        await ctx.reply('✅ Bases de datos reseteadas.');
      } else {
        await ctx.reply('❌ Contraseña incorrecta.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 8. Lógica para pauseall
    if (awaiting.action === 'pauseall_confirm') {
      if (text === BOT_PASSWORD) {
        await runQuery(`UPDATE settings SET paused = 1`);
        await ctx.reply('✅ Bot pausado globalmente.');
      } else {
        await ctx.reply('❌ Contraseña incorrecta.');
      }
      ctx.session.awaiting = null;
      return;
    }

  } catch (e) {
    console.error('Error en message handler:', e);
    if (ctx.session) ctx.session.awaiting = null;
  }
});

// --- Finalización y control ---
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  db.close();
  process.exit(0);
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  db.close();
  process.exit(0);
});

// --- Express Server ---
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('FEDERACIÓN CORVUS Bot'));
if (WEBHOOK_URL) {
  (async () => {
    try {
      const webhookPath = `/webhook/${WEBHOOK_SECRET_TOKEN}`;
      await bot.telegram.setWebhook(WEBHOOK_URL + webhookPath);
      app.use(webhookPath, (req, res) => {
        bot.handleUpdate(req.body, res).catch(() => {});
        res.sendStatus(200);
      });
      app.listen(PORT, () => console.log(`Express webhook listening on port ${PORT}`));
    } catch (e) {
      console.error('Error setting webhook:', e);
      bot.launch();
      app.listen(PORT, () => console.log(`Server listening on ${PORT} (polling fallback)`));
    }
  })();
} else {
  bot.launch();
  app.listen(PORT, () => console.log(`Server listening on ${PORT} (bot polling)`));
}

console.log('FEDERACIÓN CORVUS - Bot iniciado.');