/**
 * FEDERACIÓN CORVUS - index.js
 *
 * Node.js Telegram bot using Telegraf, Express, SQLite3, fs, path.
 * - Validación de nombres en chat_join_request
 * - Federación (GBAN / mensajes federación)
 * - Gestión de grupos autorizados, propósitos, reglas y configuraciones
 * - Comandos administrativos y de usuario
 *
 * Entorno (Railway): BOT_PASSWORD, BOT_TOKEN, PORT, WEBHOOK_URL, WEBHOOK_SECRET_TOKEN
 *
 * Bases de datos en volumen: /data_cadenero
 *
 * Nota: Este archivo es un punto de partida completo. Ajusta permisos de archivos,
 * despliegue y tokens en Railway antes de ejecutar.
 */

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
const BOT_PASSWORD = process.env.BOT_PASSWORD || ''; // para comandos sensibles si se requiere
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
    // Reglas de nombres (permitidos / no permitidos)
    db.run(`CREATE TABLE IF NOT EXISTS name_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, -- allowed | forbidden
      pattern TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Usuarios baneados (lista negra)
    db.run(`CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Grupos autorizados
    db.run(`CREATE TABLE IF NOT EXISTS groups (
      idx INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL UNIQUE,
      title TEXT,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Propósitos del grupo
    db.run(`CREATE TABLE IF NOT EXISTS purposes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Configuraciones generales por chat
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      chat_id INTEGER PRIMARY KEY,
      require_photo INTEGER DEFAULT 0,
      purpose_id INTEGER DEFAULT NULL,
      paused INTEGER DEFAULT 0,
      processed INTEGER DEFAULT 0,
      rejected INTEGER DEFAULT 0,
      FOREIGN KEY(purpose_id) REFERENCES purposes(id)
    )`);

    // Historial de usuarios (últimos cambios / eventos)
    db.run(`CREATE TABLE IF NOT EXISTS user_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      chat_id INTEGER,
      action TEXT,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Estadísticas simples
    db.run(`CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    )`);

    // Inicializar una fila de stats si no existe
    db.run(`INSERT OR IGNORE INTO stats(key, value) VALUES('processed', 0), ('rejected', 0)`);

    // Inicializar un grupo ficticio para evitar DB vacía
    db.get(`SELECT COUNT(*) as c FROM groups`, (err, row) => {
      if (!err && row && row.c === 0) {
        db.run(`INSERT INTO groups(chat_id, title, password) VALUES(?, ?, ?)`, [-1000000000000, 'GRUPO_FICTICIO_CORVUS', ''], () => {
          console.log('Grupo ficticio inicializado.');
        });
      }
    });

    // Inicializar propósitos por defecto si no existen
    db.get(`SELECT COUNT(*) as c FROM purposes`, (err, row) => {
      if (!err && row && row.c === 0) {
        const stm = db.prepare(`INSERT INTO purposes(purpose) VALUES(?)`);
        stm.run('Pláticas y cotorreo, NO XXX ni encuentros. Evita BAN.');
        stm.run('Cotorreo HOT y XXX, NO morbo. Conoce gente, disfruta.');
        stm.finalize();
        console.log('Propósitos iniciales creados.');
      }
    });

    // Reglas básicas de validación por defecto (guardadas como forbidden/allowed)
    db.get(`SELECT COUNT(*) as c FROM name_rules`, (err, row) => {
      if (!err && row && row.c === 0) {
        const insert = db.prepare(`INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`);
        // Forbidden patterns (regex strings)
        insert.run('forbidden', '^\\p{Punct}+$', 'Solo símbolos de puntuación');
        insert.run('forbidden', '^[\\p{Emoji}]+$', 'Solo emoji');
        insert.run('forbidden', '^(.)\\1{7,}$', 'Repetición exagerada de un mismo caracter (spam)');
        insert.run('forbidden', '^[A-Za-z]$', 'Una sola letra');
        insert.run('forbidden', '^[A-Za-z]\\p{Emoji}$', 'Una letra + emoji');
        // Block non-latin scripts (simplified)
        insert.run('forbidden', '[\\p{Script=Cyrl}]', 'Bloquear alfabeto cirílico (ruso)');
        insert.run('forbidden', '[\\p{Script=Hani}]', 'Bloquear chino/japonés');
        insert.run('forbidden', '[\\p{Script=Arabic}]', 'Bloquear árabe');
        // Allowed patterns
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

// Comprueba si el usuario es administrador o creador en el chat
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

// Incrementar estadística
function incrStat(key, amount = 1) {
  db.run(`INSERT INTO stats(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = value + ?`, [key, amount, amount]);
}

// --- Validación de nombres ---
/**
 * Validación basada en reglas guardadas en DB.
 * Devuelve { ok: boolean, reason: string|null }
 */
async function validateName(name) {
  if (!name || typeof name !== 'string') return { ok: false, reason: 'Nombre vacío' };

  // Normalize: trim
  const trimmed = name.trim();

  // Load rules
  const rules = await allQuery(`SELECT * FROM name_rules ORDER BY id ASC`);
  // Evaluate forbidden first
  for (const r of rules.filter(x => x.type === 'forbidden')) {
    try {
      const re = new RegExp(r.pattern, 'u');
      if (re.test(trimmed)) return { ok: false, reason: r.description || 'Nombre no permitido' };
    } catch (e) {
      // fallback: if pattern is not a valid regex, skip
      console.warn('Invalid regex in name_rules:', r.pattern);
    }
  }
  // Evaluate allowed rules: if any allowed rule matches, accept
  const allowedRules = rules.filter(x => x.type === 'allowed');
  if (allowedRules.length > 0) {
    for (const r of allowedRules) {
      try {
        const re = new RegExp(r.pattern, 'u');
        if (re.test(trimmed)) return { ok: true, reason: null };
      } catch (e) { }
    }
    // If there are allowed rules but none matched -> reject
    return { ok: false, reason: 'No cumple reglas de nombres latinos válidos' };
  }
  // If no allowed rules defined, accept by default
  return { ok: true, reason: null };
}

// --- Manejo de chat_join_request ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const req = ctx.update.chat_join_request;
    const chatId = req.chat.id;
    const user = req.from;
    const fullName = `${user.first_name || ''}${user.last_name ? ' ' + user.last_name : ''}`.trim();

    // Check if bot paused in this chat
    const s = await getQuery(`SELECT paused FROM settings WHERE chat_id = ?`, [chatId]);
    if (s && s.paused === 1) {
      // Auto reject while paused
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Bot pausado']);
      incrStat('rejected', 1);
      return;
    }

    // Check blacklist
    const banned = await getQuery(`SELECT * FROM banned_users WHERE user_id = ?`, [user.id]);
    if (banned) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Usuario en lista negra']);
      incrStat('rejected', 1);
      return;
    }

    // Validate name
    const validation = await validateName(fullName || user.username || '');
    if (!validation.ok) {
      // Reject
      await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
      await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', validation.reason]);
      incrStat('rejected', 1);
      return;
    }

    // Check require_photo setting
    const setting = await getQuery(`SELECT require_photo FROM settings WHERE chat_id = ?`, [chatId]);
    if (setting && setting.require_photo === 1) {
      // If require_photo is enabled, we attempt to check if user has a profile photo.
      // Telegram API: getUserProfilePhotos
      const photos = await ctx.telegram.getUserProfilePhotos(user.id, 0, 1).catch(() => null);
      if (!photos || photos.total_count === 0) {
        // Reject if no photo
        await ctx.telegram.declineChatJoinRequest(chatId, user.id).catch(() => {});
        await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_rejected', 'Requiere foto de perfil']);
        incrStat('rejected', 1);
        return;
      }
    }

    // Passed validations -> approve and send welcome message with popup button
    await ctx.telegram.approveChatJoinRequest(chatId, user.id).catch(() => {});
    await runQuery(`INSERT INTO user_history(user_id, chat_id, action, note) VALUES(?, ?, ?, ?)`, [user.id, chatId, 'join_request_approved', 'Validación OK']);
    incrStat('processed', 1);

    // Send ephemeral welcome message (auto-delete after 5 minutes)
    const purposeRow = await getQuery(`SELECT p.purpose FROM settings s LEFT JOIN purposes p ON s.purpose_id = p.id WHERE s.chat_id = ?`, [chatId]);
    const purposeText = purposeRow && purposeRow.purpose ? purposeRow.purpose : null;
    const welcomeText = `Bienvenido ${user.first_name || user.username || ''} a ${req.chat.title}\n\n` +
      (purposeText ? `Propósito: ${purposeText}` : 'Propósito: No definido');

    // Send message with inline keyboard: Propósito (popup) and Rechazo (only admins)
    const keyboard = [
      [{ text: 'Propósito', callback_data: `popup_purpose_${chatId}` }],
      [{ text: 'Rechazo 🚫', callback_data: `manual_reject_${user.id}_${chatId}` }]
    ];

    const sent = await ctx.telegram.sendMessage(chatId, welcomeText, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'HTML'
    });

    // Auto-delete welcome message after 5 minutes (300000 ms)
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
      } catch (e) { }
    }, 5 * 60 * 1000);

  } catch (e) {
    console.error('Error en chat_join_request:', e);
  }
});

// --- Callbacks: popup purpose and manual reject ---
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
      // Only admins can press manual reject
      const member = await ctx.telegram.getChatMember(chatId, fromId).catch(() => null);
      if (!member || !['creator', 'administrator'].includes(member.status)) {
        await ctx.answerCbQuery('Solo administradores pueden usar Rechazo.', { show_alert: true });
        return;
      }
      // Ban the user from this group and add to blacklist
      await ctx.telegram.banChatMember(chatId, targetUserId).catch(() => {});
      // Save to banned_users
      const userInfo = ctx.callbackQuery.message ? ctx.callbackQuery.message.reply_to_message ? ctx.callbackQuery.message.reply_to_message.from : null : null;
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

// --- Comandos públicos: /start y /help ---
bot.start(async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    // If in group: show summary in group; in private: announce if bot active
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

    // If private chat, only announce if bot is in functions (we'll say active)
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
FEDERACIÓN CORVUS - Comandos (sintaxis básica)

Comandos públicos:
/start - Resumen del estado del bot en este chat
/help - Mostrar esta ayuda

Comandos administradores (solo creadores/administradores del grupo):
/add_name_rule - Agregar regla de nombre (forbidden|allowed) (interactivo)
/list_name_rules - Ver reglas de nombres
/del_name_rule <id> - Borrar regla de nombre

/requirephoto on|off - Activar/desactivar requisito de foto para ingresar
/config - Modificar configuración rápida del grupo (interactivo)

/addgroup - Agregar grupo a la federación (privado con el bot, interactivo)
/delgroup <nombre> - Borrar grupo autorizado por nombre
/listgroups - Ver grupos autorizados (por nombre)

/gban <reply to user or user_id> <motivo> - Aplicar GBAN a usuario en toda la federación
/fedmsg - Enviar mensaje de federación a todos grupos (interactivo, auto-borra en 1 hora)

/addpurpose - Agregar propósito (interactivo)
/listpurposes - Listar propósitos
/delpurpose <id> - Borrar propósito
/setpurpose - Seleccionar propósito del grupo (interactivo)

/userinfo <user_id or reply> - Ver información básica de usuario
/userhistory <user_id or reply> - Ver últimos 5 registros del usuario

/resetdb - Resetear bases de datos (conserva registros iniciales)
/rawcounts - Mostrar conteo crudo de registros por tabla

/pausebot - Pausar bot en este chat
/resumebot - Reanudar funciones del bot

Notas:
- Todos los comandos administrativos requieren permisos de administrador o creador.
- Comandos interactivos se usan en privado con el bot o en el grupo según se indique.
  `;
  await ctx.reply(helpText);
});

// --- Comandos para reglas de nombres (interactivo simple) ---
bot.command('add_name_rule', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado. Solo administradores pueden usar este comando.');
  ctx.session.awaiting = { action: 'add_name_rule', chat_id: ctx.chat.id };
  await ctx.reply('Envíame ahora la regla en formato JSON simple: {"type":"forbidden","pattern":"<regex>","description":"texto"}\nEjemplo: {"type":"forbidden","pattern":"^\\\\p{Punct}+$","description":"Solo puntuación"}');
});
bot.command('list_name_rules', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT id, type, description, pattern, created_at FROM name_rules ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay reglas de nombres definidas.');
  const lines = rows.map(r => `${r.id} | ${r.type.toUpperCase()} | ${r.description || ''} | ${r.pattern}`);
  await ctx.reply(lines.join('\n'));
});
bot.command('del_name_rule', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /del_name_rule <id>');
  const id = Number(parts[1]);
  await runQuery(`DELETE FROM name_rules WHERE id = ?`, [id]);
  await ctx.reply(`Regla ${id} eliminada si existía.`);
});

// --- Captura de respuestas interactivas ---
bot.on('message', async (ctx) => {
  try {
    if (!ctx.session || !ctx.session.awaiting) return;
    const awaiting = ctx.session.awaiting;
    const text = ctx.message.text || '';
    // add_name_rule
    if (awaiting.action === 'add_name_rule') {
      try {
        const obj = JSON.parse(text);
        if (!obj.type || !obj.pattern) {
          await ctx.reply('JSON inválido. Debe contener type y pattern.');
        } else {
          await runQuery(`INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`, [obj.type, obj.pattern, obj.description || '']);
          await ctx.reply('Regla agregada correctamente.');
        }
      } catch (e) {
        await ctx.reply('Error al parsear JSON. Asegúrate de enviar un JSON válido.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // addgroup (interactive) - must be used in private chat
    if (awaiting.action === 'addgroup') {
      // Expecting: chat_id|title|password (password optional)
      // To avoid showing password in group, this must be done in private with the bot.
      const parts = text.split('|').map(s => s.trim());
      if (parts.length < 2) {
        await ctx.reply('Formato inválido. Envíame: chat_id|title|password(opcional)\nEjemplo: -1001234567890|Mi Grupo|miPasswordSecreto');
      } else {
        const chat_id = Number(parts[0]);
        const title = parts[1];
        const password = parts[2] || '';
        await runQuery(`INSERT OR REPLACE INTO groups(chat_id, title, password) VALUES(?, ?, ?)`, [chat_id, title, password]);
        await ctx.reply('Grupo agregado a la federación (contraseña guardada en privado).');
      }
      ctx.session.awaiting = null;
      return;
    }

    // addpurpose
    if (awaiting.action === 'addpurpose') {
      const purpose = text.trim();
      if (purpose.length === 0 || purpose.length > 60) {
        await ctx.reply('Propósito inválido. Debe tener entre 1 y 60 caracteres.');
      } else {
        await runQuery(`INSERT INTO purposes(purpose) VALUES(?)`, [purpose]);
        await ctx.reply('Propósito agregado.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // setpurpose (select by number)
    if (awaiting.action === 'setpurpose') {
      const chatId = awaiting.chat_id;
      const num = Number(text.trim());
      if (isNaN(num)) {
        await ctx.reply('Envía el número del propósito (ej: 1).');
      } else {
        const p = await getQuery(`SELECT id FROM purposes WHERE id = ?`, [num]);
        if (!p) {
          await ctx.reply('Propósito no encontrado.');
        } else {
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, purpose_id) VALUES(?, ?)`, [chatId, num]);
          await ctx.reply('Propósito asignado al grupo.');
        }
      }
      ctx.session.awaiting = null;
      return;
    }

    // config quick modify (simple key=value lines)
    if (awaiting.action === 'config') {
      // Expect lines like require_photo=on
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
      await ctx.reply('Configuración actualizada.');
      ctx.session.awaiting = null;
      return;
    }

  } catch (e) {
    console.error('Error en message handler interactivo:', e);
    ctx.session.awaiting = null;
  }
});

// --- Comandos para requirephoto y config ---
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
  ctx.session.awaiting = { action: 'config', chat_id: ctx.chat.id };
  await ctx.reply('Envíame las configuraciones en líneas separadas, por ejemplo:\nrequire_photo=on\npaused=off\npurpose_id=2\n(usar on/off o valores numéricos)');
});

// --- Gestión de grupos autorizados ---
bot.command('addgroup', async (ctx) => {
  // To avoid exposing password in group, require private chat
  if (ctx.chat.type !== 'private') return ctx.reply('Para agregar un grupo, usa este comando en privado con el bot.');
  ctx.session.awaiting = { action: 'addgroup' };
  await ctx.reply('Envíame: chat_id|title|password(opcional). Ejemplo: -1001234567890|Mi Grupo|miPasswordSecreto');
});

bot.command('listgroups', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT idx, chat_id, title, created_at FROM groups ORDER BY idx ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay grupos autorizados.');
  // Show by name (title)
  const lines = rows.map(r => `${r.idx}. ${r.title} (chat_id: ${r.chat_id})`);
  await ctx.reply(lines.join('\n'));
});

bot.command('delgroup', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length === 0) return ctx.reply('Uso: /delgroup <nombre del grupo>');
  const name = parts.join(' ');
  // Delete by title
  await runQuery(`DELETE FROM groups WHERE title = ?`, [name]);
  // Reindex: ensure idx are consecutive - sqlite AUTOINCREMENT cannot be reset easily; we will rebuild table
  const groups = await allQuery(`SELECT chat_id, title, password, created_at FROM groups ORDER BY idx ASC`);
  await runQuery(`DELETE FROM groups`);
  const insert = db.prepare(`INSERT INTO groups(chat_id, title, password, created_at) VALUES(?, ?, ?, ?)`);
  for (const g of groups) {
    insert.run(g.chat_id, g.title, g.password || '', g.created_at || null);
  }
  insert.finalize();
  await ctx.reply(`Grupo "${name}" eliminado y base de datos depurada.`);
});

// --- GBAN y federación ---
bot.command('gban', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  // Usage: reply to user or /gban <user_id> <reason>
  let targetId = null;
  let reason = 'GBAN federación';
  if (ctx.message.reply_to_message) {
    targetId = ctx.message.reply_to_message.from.id;
  } else {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length >= 2) targetId = Number(parts[1]);
    if (parts.length >= 3) reason = parts.slice(2).join(' ');
  }
  if (!targetId) return ctx.reply('Indica el usuario (responde a su mensaje o usa /gban <user_id> <motivo>)');

  // Get user info if possible
  let userInfo = { id: targetId, first_name: '', last_name: '', username: '' };
  try {
    const u = ctx.message.reply_to_message ? ctx.message.reply_to_message.from : null;
    if (u) {
      userInfo.first_name = u.first_name || '';
      userInfo.last_name = u.last_name || '';
      userInfo.username = u.username || '';
    }
  } catch (e) { }

  // Insert into banned_users
  await runQuery(`INSERT OR IGNORE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`, [userInfo.id, userInfo.first_name, userInfo.last_name, userInfo.username, reason]);

  // Send GBAN message to all groups
  const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]); // exclude ficticio
  const gbantxt = `🚨GBAN DE FEDERACION CORVUS🚨
==============================
👤 ${userInfo.id}
👦🏻 ${userInfo.first_name || '-'}
👪 ${userInfo.last_name || '-'}
🌐 ${userInfo.username ? '@' + userInfo.username : '-'}
🇪🇸 es
==============================
⌛️Auto borrado en 5 min ⌛️`;

  for (const g of groups) {
    try {
      const sent = await ctx.telegram.sendMessage(g.chat_id, gbantxt);
      // Auto-delete after 5 minutes
      setTimeout(async () => {
        try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch (e) {}
      }, 5 * 60 * 1000);
      // Also attempt to ban user from each group
      await ctx.telegram.banChatMember(g.chat_id, userInfo.id).catch(() => {});
    } catch (e) {
      // ignore per-group errors
    }
  }
  await ctx.reply('GBAN aplicado y notificación enviada a la federación.');
});

// Enviar mensaje de federación (auto-borra en 1 hora)
bot.command('fedmsg', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  ctx.session.awaiting = { action: 'fedmsg', chat_id: ctx.chat.id };
  await ctx.reply('Envíame ahora el mensaje de federación que será enviado a todos los grupos (se auto-borrará en 1 hora).');
});
bot.on('message', async (ctx) => {
  if (!ctx.session || !ctx.session.awaiting) return;
  if (ctx.session.awaiting.action === 'fedmsg') {
    const text = ctx.message.text || '';
    const fedtxt = `🚨  AVISO OFICIAL  🚨
🚨FEDERACION CORVUS🚨
======================
${text}
======================
⌛️Auto borrado en 1 Hora⌛️`;
    const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
    for (const g of groups) {
      try {
        const sent = await ctx.telegram.sendMessage(g.chat_id, fedtxt);
        setTimeout(async () => {
          try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch (e) {}
        }, 60 * 60 * 1000); // 1 hour
      } catch (e) { }
    }
    await ctx.reply('Mensaje de federación enviado.');
    ctx.session.awaiting = null;
  }
});

// --- Propósitos ---
bot.command('addpurpose', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
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
  // Interactive: list purposes and ask for number
  const rows = await allQuery(`SELECT id, purpose FROM purposes ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay propósitos definidos.');
  const lines = rows.map(r => `${r.id}.- ${r.purpose}`);
  await ctx.reply('Propósitos disponibles:\n' + lines.join('\n') + '\n\nEnvía ahora el número del propósito que deseas asignar a este grupo.');
  ctx.session.awaiting = { action: 'setpurpose', chat_id: ctx.chat.id };
});

// --- Reset DB (conservar iniciales) ---
bot.command('resetdb', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  // Keep initial groups and purposes, clear others
  // For safety, require BOT_PASSWORD if set
  if (BOT_PASSWORD) {
    ctx.session.awaiting = { action: 'resetdb_confirm' };
    await ctx.reply('Envía la contraseña del bot para confirmar el reseteo (privado con el bot).');
    return;
  }
  // proceed
  await runQuery(`DELETE FROM name_rules`);
  await runQuery(`DELETE FROM banned_users`);
  await runQuery(`DELETE FROM groups`);
  await runQuery(`DELETE FROM settings`);
  await runQuery(`DELETE FROM user_history`);
  await runQuery(`DELETE FROM stats`);
  // Re-init DB
  initDb();
  await ctx.reply('Bases de datos reseteadas (registros iniciales restaurados).');
});
bot.on('message', async (ctx) => {
  if (!ctx.session || !ctx.session.awaiting) return;
  if (ctx.session.awaiting.action === 'resetdb_confirm') {
    const pw = ctx.message.text || '';
    if (pw === BOT_PASSWORD) {
      // proceed reset
      await runQuery(`DELETE FROM name_rules`);
      await runQuery(`DELETE FROM banned_users`);
      await runQuery(`DELETE FROM groups`);
      await runQuery(`DELETE FROM settings`);
      await runQuery(`DELETE FROM user_history`);
      await runQuery(`DELETE FROM stats`);
      initDb();
      await ctx.reply('Bases de datos reseteadas (registros iniciales restaurados).');
    } else {
      await ctx.reply('Contraseña incorrecta. Operación cancelada.');
    }
    ctx.session.awaiting = null;
  }
});

// --- Información de usuario ---
bot.command('userinfo', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  let targetId = null;
  if (ctx.message.reply_to_message) targetId = ctx.message.reply_to_message.from.id;
  else {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length >= 2) targetId = Number(parts[1]);
  }
  if (!targetId) return ctx.reply('Uso: /userinfo <user_id> o responde al mensaje del usuario con /userinfo');

  // Try to fetch Telegram info via getChatMember in current chat
  let tgInfo = null;
  try {
    const chatId = ctx.chat.id;
    tgInfo = await ctx.telegram.getChatMember(chatId, targetId).catch(() => null);
  } catch (e) { }

  // DB info
  const dbUser = await getQuery(`SELECT * FROM banned_users WHERE user_id = ?`, [targetId]);
  const history = await allQuery(`SELECT action, note, created_at FROM user_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [targetId]);

  const lines = [
    `👤 ID: ${targetId}`,
    `👦🏻 Nombre: ${tgInfo && tgInfo.user ? (tgInfo.user.first_name || '-') : (dbUser ? dbUser.first_name || '-' : '-')}`,
    `👪 Apellido: ${tgInfo && tgInfo.user ? (tgInfo.user.last_name || '-') : (dbUser ? dbUser.last_name || '-' : '-')}`,
    `🌐 Username: ${tgInfo && tgInfo.user ? (tgInfo.user.username ? '@' + tgInfo.user.username : '-') : (dbUser && dbUser.username ? '@' + dbUser.username : '-')}`,
    `📅 Último registro: ${history && history.length ? history[0].created_at : '-'}`,
    `📝 Motivo: ${dbUser && dbUser.reason ? dbUser.reason : '-'}`,
    `Alertas/Bloqueos: ${dbUser ? 'Sí' : 'No'}`
  ];
  await ctx.reply(lines.join('\n'));

  if (history && history.length) {
    const histLines = history.map(h => `${h.created_at} | ${h.action} | ${h.note}`);
    await ctx.reply('Historial (últimos 5):\n' + histLines.join('\n'));
  }
});

// --- userhistory command ---
bot.command('userhistory', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  let targetId = null;
  if (ctx.message.reply_to_message) targetId = ctx.message.reply_to_message.from.id;
  else {
    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length >= 2) targetId = Number(parts[1]);
  }
  if (!targetId) return ctx.reply('Uso: /userhistory <user_id> o responde al mensaje del usuario con /userhistory');
  const history = await allQuery(`SELECT action, note, created_at FROM user_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [targetId]);
  if (!history || history.length === 0) return ctx.reply('No hay historial para este usuario.');
  const histLines = history.map(h => `${h.created_at} | ${h.action} | ${h.note}`);
  await ctx.reply('Historial (últimos 5):\n' + histLines.join('\n'));
});

// --- Pausar y reanudar bot en chat ---
bot.command('pausebot', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [ctx.chat.id, 1]);
  await ctx.reply('Bot pausado en este chat.');
});
bot.command('resumebot', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [ctx.chat.id, 0]);
  await ctx.reply('Bot reanudado en este chat.');
});

// --- Conteo crudo de registros por tabla ---
bot.command('rawcounts', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const tables = ['name_rules', 'banned_users', 'groups', 'purposes', 'settings', 'user_history', 'stats'];
  const results = [];
  for (const t of tables) {
    const r = await getQuery(`SELECT COUNT(*) as c FROM ${t}`);
    results.push(`${t}: ${r ? r.c : 0}`);
  }
  await ctx.reply('Conteo crudo:\n' + results.join('\n'));
});

// --- Comandos para agregar/ver/borrar reglas de nombres válidos (alias de name_rules) ---
bot.command('add_valid_name', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  ctx.session.awaiting = { action: 'add_name_rule', chat_id: ctx.chat.id }; // reuse interactive
  await ctx.reply('Envía la regla permitida en JSON: {"type":"allowed","pattern":"<regex>","description":"texto"}');
});
bot.command('list_valid_names', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const rows = await allQuery(`SELECT id, pattern, description FROM name_rules WHERE type = 'allowed' ORDER BY id ASC`);
  if (!rows || rows.length === 0) return ctx.reply('No hay reglas de nombres válidos.');
  const lines = rows.map(r => `${r.id} | ${r.pattern} | ${r.description || ''}`);
  await ctx.reply(lines.join('\n'));
});
bot.command('del_valid_name', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length < 2) return ctx.reply('Uso: /del_valid_name <id>');
  const id = Number(parts[1]);
  await runQuery(`DELETE FROM name_rules WHERE id = ? AND type = 'allowed'`, [id]);
  await ctx.reply(`Regla válida ${id} eliminada si existía.`);
});

// --- Comandos para pausar procesamiento global (admin of bot) ---
bot.command('pauseall', async (ctx) => {
  // This would be a bot-owner command; we check BOT_PASSWORD if set
  if (ctx.chat.type !== 'private') return ctx.reply('Este comando debe ejecutarse en privado con el bot.');
  if (!BOT_PASSWORD) return ctx.reply('No hay contraseña configurada para este comando.');
  ctx.session.awaiting = { action: 'pauseall_confirm' };
  await ctx.reply('Envía la contraseña para pausar todas las funciones del bot.');
});
bot.on('message', async (ctx) => {
  if (!ctx.session || !ctx.session.awaiting) return;
  if (ctx.session.awaiting.action === 'pauseall_confirm') {
    const pw = ctx.message.text || '';
    if (pw === BOT_PASSWORD) {
      // Set paused=1 for all settings rows
      await runQuery(`UPDATE settings SET paused = 1`);
      await ctx.reply('Bot pausado globalmente (todas las configuraciones de chat).');
    } else {
      await ctx.reply('Contraseña incorrecta.');
    }
    ctx.session.awaiting = null;
  }
});

// --- Reset and graceful shutdown helpers ---
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

// --- Express webhook (optional) ---
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('FEDERACIÓN CORVUS Bot'));
if (WEBHOOK_URL) {
  // Set webhook
  (async () => {
    try {
      const webhookPath = `/webhook/${WEBHOOK_SECRET_TOKEN}`;
      await bot.telegram.setWebhook(WEBHOOK_URL + webhookPath);
      app.use(webhookPath, (req, res) => {
        bot.handleUpdate(req.body, res).catch(() => {});
        res.sendStatus(200);
      });
      app.listen(PORT, () => {
        console.log(`Express webhook listening on port ${PORT}`);
      });
    } catch (e) {
      console.error('Error setting webhook:', e);
      // fallback to polling
      bot.launch();
      app.listen(PORT, () => console.log(`Server listening on ${PORT} (polling fallback)`));
    }
  })();
} else {
  // Polling mode
  bot.launch();
  app.listen(PORT, () => console.log(`Server listening on ${PORT} (bot polling)`));
}

console.log('FEDERACIÓN CORVUS - Bot iniciado.');