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

// Variable global para rastrear el último mensaje de bienvenida por chat_id
const lastWelcomeMessages = {};

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
        db.run(`INSERT INTO groups(chat_id, title, password) VALUES(?, ?, ?)`, [-1000000000000, 'GRUPO DE INICIALIZACION CORVUS', ''], () => {
          console.log('Grupo ficticio inicializado.');
        });
      }
    });

    db.get(`SELECT COUNT(*) as c FROM purposes`, (err, row) => {
      if (!err && row && row.c === 0) {
        const stm = db.prepare(`INSERT INTO purposes(purpose) VALUES(?)`);
        stm.run('Plática y Cotorreo Relax, NO es Grupo XXX ni de Encuentros, Mantente Activo. Evita el Acoso y el BAN.');
        stm.run('Platica y Cotorreo HOT, Sin Morbosos, CP y Contenido Ilegal, Mantente Activo. Evita el Acoso y el BAN');
        stm.finalize();
        console.log('Propósitos iniciales creados.');
      }
    });

db.get(`SELECT COUNT(*) as c FROM name_rules`, (err, row) => {
      if (!err && row && row.c === 0) {
        const insert = db.prepare(`INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`);
        // Reglas de Bloqueo (Forbidden)
        insert.run('forbidden', '^[\\p{Punct}\\s]+$', 'Solo símbolos de puntuación o espacios');
        insert.run('forbidden', '^[\\p{Emoji}\\s]+$', 'Solo emojis o espacios');
        insert.run('forbidden', '^(.)\\1{7,}$', 'Repetición exagerada de un mismo caracter (spam)');
        insert.run('forbidden', '^[A-Za-zÀ-ÖØ-öø-ÿ]$', 'Una sola letra');
        insert.run('forbidden', '^[A-Za-zÀ-ÖØ-öø-ÿ][\\p{Punct}\\s\\p{Emoji}]+$', 'Una letra con puros símbolos o emojis');
        insert.run('forbidden', '[\\p{Script=Cyrl}]', 'Bloquear alfabeto cirílico (ruso)');
        insert.run('forbidden', '[\\p{Script=Hani}]', 'Bloquear chino/japonés');
        insert.run('forbidden', '[\\p{Script=Arabic}]', 'Bloquear árabe');
        
        // Reglas Permitidas (Allowed) - Flexibilizada para admitir texto acompañado de cualquier emoji o símbolo externo
        insert.run('allowed', '[A-Za-zÀ-ÖØ-öø-ÿ]{2,}', 'Contiene al menos un nombre o palabra válida de 2 o más letras');
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
  
  // 1. Validar reglas de exclusión (forbidden)
  for (const r of rules.filter(x => x.type === 'forbidden')) {
    try {
      const re = new RegExp(r.pattern, 'u');
      if (re.test(trimmed)) return { ok: false, reason: r.description || 'Nombre no permitido' };
    } catch (e) {
      console.warn('Invalid regex in name_rules:', r.pattern);
    }
  }
  
  // 2. Control estricto de texto real: Limpiamos puntuación, emojis y espacios usando nombres estandarizados.
  // Si no quedan al menos 2 caracteres alfabéticos reales legibles, se rechaza.
  const cleanText = trimmed.replace(/[\p{punctuation}\p{Extended_Pictographic}\s]/gu, '');
  if (cleanText.length < 2) {
    return { ok: false, reason: 'El nombre debe contener al menos 2 letras reales legibles' };
  }
  
  // 3. Validar reglas de inclusión (allowed)
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

    // --- Borrado del mensaje anterior para evitar acumulación ---
    if (lastWelcomeMessages[chatId]) {
      await ctx.telegram.deleteMessage(chatId, lastWelcomeMessages[chatId]).catch(() => {});
    }

    const purposeRow = await getQuery(`SELECT p.purpose FROM settings s LEFT JOIN purposes p ON s.purpose_id = p.id WHERE s.chat_id = ?`, [chatId]);
    const purposeText = purposeRow && purposeRow.purpose ? purposeRow.purpose : null;
    const welcomeText = `😈 Bienvenido ${user.first_name || user.username || ''} a ${req.chat.title}\n\n` +
      (purposeText ? `El Propósito del Grupo es: ${purposeText}` : 'Propósito: No definido');

    // fila del botón Rechazo
    const keyboard = [
      [{ text: 'Rechazar Solicitud 🚫', callback_data: `manual_reject_${user.id}_${chatId}` }]
    ];

    const sent = await ctx.telegram.sendMessage(chatId, welcomeText, {
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'HTML'
    });

    // Guardamos el nuevo ID
    lastWelcomeMessages[chatId] = sent.message_id;

    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
        // Limpiamos del diccionario solo si sigue siendo el mismo mensaje
        if (lastWelcomeMessages[chatId] === sent.message_id) {
          delete lastWelcomeMessages[chatId];
        }
      } catch (e) { }
    }, 8 * 60 * 1000);

  } catch (e) {
    console.error('Error en chat_join_request:', e);
  }
});

// --- Callbacks ---
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const fromId = ctx.from.id;
    
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
/addvalidname - Agregar regla (JSON) para ACEPTAR nombres
/listvalidnames - Ver reglas de nombres permitidos
/delvalidname <id> - Borrar regla de nombre permitido

/addnamevalid - Solicitar entrada interactiva para regla de ACEPTAR nombres
/addnameinvalid - Solicitar entrada interactiva para regla de RECHAZAR nombres
/listnamerules - Ver todas las reglas de nombres (Forbidden/Allowed)
/delnamerule <id> - Borrar regla de nombre por ID

/requirephoto on|off - Requisito de foto para ingresar
/config - Modificar configuración rápida del grupo

/addgroup - Agregar grupo a la federación
/delgroup <número> - Borrar grupo autorizado por índice secuencial
/listgroups - Ver grupos autorizados

/gban <reply o user_id | @username> <motivo> - Aplicar GBAN federación
/ungban <reply o user_id | @username> - Remover GBAN de la federación
/addinfo <motivo> - Extrae y guarda datos respondiendo a un mensaje de bot
/addblacklist - Agregar usuario a blacklist desde mensaje de bot
/fedmsg - Enviar mensaje de federación a todos los grupos

/addpurpose - Agregar propósito (máx. 60 chars)
/listpurposes - Listar propósitos
/delpurpose <id> - Borrar propósito por ID
/setpurpose - Seleccionar propósito del grupo

/userinfo <user_id o @username o reply> - Ver información de usuario y últimos 5 registros
/userhistory <user_id o @username o reply> - Ver últimos 5 registros de historial

/resetdb - Resetear bases de datos con contraseña
/pauseall - Pausar el bot en todos los grupos afiliados (vía privado con contraseña)
/rawcounts - Mostrar conteo crudo de registros por tabla

/pausebot - Pausar bot en este chat
/resumebot - Reanudar funciones del bot en este chat
  `;
  await ctx.reply(helpText);
});

bot.command('addgroup', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  
  if (ctx.chat.type === 'private') {
    return ctx.reply('❌ Este comando debe ser ejecutado dentro del grupo que deseas vincular a la Federación.');
  }

  if (!ctx.session) ctx.session = {};
  
  // Guardamos el chat_id explícito del grupo actual y la acción
  ctx.session.awaiting = { 
    action: 'addgroup_confirm', 
    chat_id: ctx.chat.id,
    chat_title: ctx.chat.title
  };
  
  await ctx.reply('Escribe la contraseña de la federación para registrar este grupo:', {
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
bot.command('addnamevalid', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  
  ctx.session.awaiting = { action: 'add_name_valid_rule', chat_id: ctx.chat.id };
  await ctx.reply('Regla para ACEPTAR nombres.\nEnvíame el patrón y la descripción separados por una barra vertical o pipe (|):\n\nEjemplo:\n^[A-Za-z]{2,}$ | Nombres latinos estándar');
});

bot.command('addnameinvalid', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
  if (!ctx.session) ctx.session = {};
  
  ctx.session.awaiting = { action: 'add_name_invalid_rule', chat_id: ctx.chat.id };
  await ctx.reply('Regla para RECHAZAR nombres.\nEnvíame el patrón y la descripción separados por una barra vertical o pipe (|):\n\nEjemplo:\n^[0-9]+$ | Bloquear nombres que sean solo números');
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
  
  // Se usa 'idx' que es el nombre de la columna en tu tabla
  const rows = await allQuery(`SELECT idx, chat_id, title, created_at FROM groups ORDER BY idx ASC`);
  
  if (!rows || rows.length === 0) return ctx.reply('No hay grupos autorizados.');
  
  const lines = rows.map(r => `${r.idx}. ${r.title} (chat_id: ${r.chat_id})`);
  await ctx.reply(`Grupos autorizados:\n${lines.join('\n')}`);
});

bot.command('delgroup', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');

  const parts = ctx.message.text.split(' ');
  const index = parseInt(parts[1]);

  if (isNaN(index)) return ctx.reply('Uso: /delgroup <número>');
  if (index === 1) return ctx.reply('❌ Error: El grupo 1 está protegido y no se puede eliminar.');

  try {
    // 1. Verificar si el grupo existe
    const groupExists = await getQuery(`SELECT idx FROM groups WHERE idx = ?`, [index]);
    if (!groupExists) {
      return ctx.reply(`❌ No se encontró ningún grupo con el índice ${index}.`);
    }

    // 2. Eliminar el grupo
    await runQuery(`DELETE FROM groups WHERE idx = ?`, [index]);

    // 3. Reorganizar los índices (idx) para que sean continuos
    // Seleccionamos todos los registros ordenados por su índice actual
    const rows = await allQuery(`SELECT idx FROM groups ORDER BY idx ASC`);
    
    // Actualizamos cada uno con un nuevo índice secuencial
    for (let i = 0; i < rows.length; i++) {
      await runQuery(`UPDATE groups SET idx = ? WHERE idx = ?`, [i + 1, rows[i].idx]);
    }

    // 4. Opcional: Resetear el autoincremento de SQLite para el siguiente registro
    // Esto asegura que si agregas uno nuevo, siga el orden correcto
    await runQuery(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'groups'`, [rows.length]);

    ctx.reply(`✅ Grupo con índice ${index} eliminado y registros reorganizados.`);
  } catch (err) {
    console.error(err);
    ctx.reply('Error al intentar eliminar y reorganizar los grupos.');
  }
});

// --- GBAN ---
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
    if (parts.length < 2) return ctx.reply('Uso: /gban <id | @username> <motivo>');
    const target = parts[1];
    if (parts.length >= 3) reason = parts.slice(2).join(' ');

    if (/^\d+$/.test(target)) {
      userInfo.id = Number(target);
    } else if (target.startsWith('@')) {
      const username = target.slice(1).toLowerCase();
      const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
      for (const g of groups) {
        try {
          const miembros = await ctx.telegram.getChatAdministrators(g.chat_id);
          for (const m of miembros) {
            if (m.user.username && m.user.username.toLowerCase() === username) {
              userInfo.id = m.user.id;
              userInfo.first_name = m.user.first_name || '';
              userInfo.last_name = m.user.last_name || '';
              userInfo.username = m.user.username || '';
              break;
            }
          }
          if (userInfo.id) break;
        } catch {}
      }
      if (!userInfo.id) return ctx.reply(`⚠️ No se pudo resolver el usuario ${target} en los grupos activos.`);
    }
  }

  if (!userInfo.id) return ctx.reply('Error al identificar al usuario.');

  await runQuery(
    `INSERT OR IGNORE INTO banned_users(user_id, first_name, last_name, username, reason) VALUES(?, ?, ?, ?, ?)`,
    [userInfo.id, userInfo.first_name, userInfo.last_name, userInfo.username, reason]
  );

  const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
  const gbantxt = `🚨GBAN FEDERACION CORVUS\n=================\n👤 ${userInfo.id}\n👦🏻 ${userInfo.first_name || '-'}\n👪 ${userInfo.last_name || '-'}\n🌐 ${userInfo.username ? '@' + userInfo.username : '-'}\n📝 Motivo: ${reason}\n=================\n⌛️Auto borrado en 5 min⌛️`;

  for (const g of groups) {
    try {
      const sent = await ctx.telegram.sendMessage(g.chat_id, gbantxt);
      setTimeout(async () => {
        try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch {}
      }, 5 * 60 * 1000);
      await ctx.telegram.banChatMember(g.chat_id, userInfo.id).catch(() => {});
    } catch {}
  }

  await ctx.reply(`🚨 Usuario ${userInfo.username ? '@' + userInfo.username : userInfo.id} baneado globalmente.`);
});

// --- UNGBAN ---
bot.command('ungban', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');

  let targetId = null;
  const parts = ctx.message.text.split(' ').filter(Boolean);

  if (ctx.message.reply_to_message) {
    targetId = ctx.message.reply_to_message.from.id;
  } else {
    if (parts.length < 2) return ctx.reply('Uso: /ungban <id | @username>');
    const target = parts[1];

    if (/^\d+$/.test(target)) {
      targetId = Number(target);
    } else if (target.startsWith('@')) {
      const username = target.slice(1).toLowerCase();
      const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
      for (const g of groups) {
        try {
          const miembros = await ctx.telegram.getChatAdministrators(g.chat_id);
          for (const m of miembros) {
            if (m.user.username && m.user.username.toLowerCase() === username) {
              targetId = m.user.id;
              break;
            }
          }
          if (targetId) break;
        } catch {}
      }
      if (!targetId) return ctx.reply(`⚠️ No se pudo resolver el usuario ${target} en los grupos activos.`);
    }
  }

  if (!targetId) return ctx.reply('Error al identificar al usuario.');

  await runQuery(`DELETE FROM banned_users WHERE user_id = ?`, [targetId]);

  const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
  const ungbanTxt = `✅ UNGBAN FEDERACION CORVUS\n=================\n👤 ${targetId}\n=================\n⌛️Auto borrado en 5 min⌛️`;

  for (const g of groups) {
    try {
      const sent = await ctx.telegram.sendMessage(g.chat_id, ungbanTxt);
      setTimeout(async () => {
        try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch {}
      }, 5 * 60 * 1000);
      await ctx.telegram.unbanChatMember(g.chat_id, targetId).catch(() => {});
    } catch {}
  }

  await ctx.reply(`✅ Usuario ${targetId} desbaneado globalmente.`);
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
  // Guardamos la acción en sesión
  ctx.session.awaiting = { action: 'addpurpose' };
  // Texto actualizado sin límite de caracteres
  await ctx.reply('Envíame el texto del propósito (sin límite de caracteres).');
});


bot.command('listpurposes', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Acceso denegado.');
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

  try {
    // 1. Verificar si existe el propósito
    const purposeExists = await getQuery(`SELECT id FROM purposes WHERE id = ?`, [id]);
    if (!purposeExists) {
      return ctx.reply(`❌ No se encontró ningún propósito con el ID ${id}.`);
    }

    // 2. Eliminar el propósito
    await runQuery(`DELETE FROM purposes WHERE id = ?`, [id]);

    // 3. Reorganizar los IDs para que sean continuos
    const rows = await allQuery(`SELECT id FROM purposes ORDER BY id ASC`);
    for (let i = 0; i < rows.length; i++) {
      await runQuery(`UPDATE purposes SET id = ? WHERE id = ?`, [i + 1, rows[i].id]);
    }

    // 4. Resetear el autoincremento de SQLite
    await runQuery(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'purposes'`, [rows.length]);

    ctx.reply(`✅ Propósito con ID ${id} eliminado y registros reorganizados.`);
  } catch (err) {
    console.error(err);
    ctx.reply('Error al intentar eliminar y reorganizar los propósitos.');
  }
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

// --- Unificación exclusiva de todas las entradas de texto y estados de sesión ---
bot.on('message', async (ctx) => {
  try {
    const text = ctx.message.text || '';
    
    // Si el mensaje es un comando, ignorarlo aquí para que Telegraf lo mande a su command handler
    if (text.startsWith('/')) return;

    if (!ctx.session) ctx.session = {};
    if (!ctx.session.awaiting) return;

    const awaiting = ctx.session.awaiting;

    // 1. Lógica para procesar la contraseña de addgroup
    if (awaiting.action === 'addgroup_confirm') {
      // Borra la contraseña del usuario inmediatamente por seguridad informática
      await ctx.deleteMessage().catch(() => {}); 
      
      const targetChatId = awaiting.chat_id;
      const targetTitle = awaiting.chat_title || ctx.chat.title || 'Grupo';

      if (text === BOT_PASSWORD) {
        // Al usar INSERT OR IGNORE evitamos romper restricciones de unicidad de SQLite de forma abrupta
        await runQuery(
          `INSERT OR REPLACE INTO groups(chat_id, title, password) VALUES(?, ?, ?)`, 
          [targetChatId, targetTitle, BOT_PASSWORD]
        );
        
        // Inicializar de paso la fila en la tabla settings si no existe
        await runQuery(
          `INSERT OR IGNORE INTO settings(chat_id, require_photo, paused) VALUES(?, 0, 0)`,
          [targetChatId]
        );

        await ctx.reply(`✅ El grupo "${targetTitle}" ha sido autorizado e indexado exitosamente en la Federación Corvus.`);
      } else {
        await ctx.reply('❌ Contraseña de federación incorrecta. Vinculación cancelada.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 2. Lógica para procesar add_name_valid_rule y add_name_invalid_rule
    if (awaiting.action === 'add_name_valid_rule' || awaiting.action === 'add_name_invalid_rule') {
      const parts = text.split('|');
      const pattern = parts[0] ? parts[0].trim() : '';
      const description = parts[1] ? parts[1].trim() : 'Sin descripción';
      const type = awaiting.action === 'add_name_valid_rule' ? 'allowed' : 'forbidden';

      if (!pattern) {
        await ctx.reply('❌ Error: El patrón regex no puede estar vacío.');
        ctx.session.awaiting = null;
        return;
      }

      try {
        new RegExp(pattern, 'u');
        await runQuery(
          `INSERT INTO name_rules(type, pattern, description) VALUES(?, ?, ?)`, 
          [type, pattern, description]
        );
        await ctx.reply(`✅ Regla de tipo [${type.toUpperCase()}] agregada exitosamente.\n\n🔬 Patrón: ${pattern}\n📝 Descripción: ${description}`);
      } catch (e) {
        await ctx.reply(`❌ Error: La expresión regular provista no es válida.\n${e.message}`);
      }
      ctx.session.awaiting = null;
      return;
    }

    // 3. Lógica para procesar fedmsg
    if (awaiting.action === 'fedmsg') {
      ctx.session.awaiting = null;
      const groups = await allQuery(`SELECT chat_id FROM groups WHERE chat_id != ?`, [-1000000000000]);
      const fedtxt = `🚨     AVISO OFICIAL     🚨\n🚨FEDERACION CORVUS🚨\n======================\n${text}\n======================\n⌛️Auto borrado en 1 Hora⌛️`;
      let sentCount = 0;

      for (const g of groups) {
        try {
          const sent = await ctx.telegram.sendMessage(g.chat_id, fedtxt);
          sentCount++;
          setTimeout(async () => {
            try { await ctx.telegram.deleteMessage(g.chat_id, sent.message_id).catch(() => {}); } catch (e) {}
          }, 60 * 60 * 1000);
        } catch (e) { }
      }
      await ctx.reply(`📢 Comunicado oficial enviado a ${sentCount} grupos afiliados.`);
      return;
    }

    // 4. Lógica para procesar addpurpose
    if (awaiting.action === 'addpurpose') {
      const purposeText = text.trim();
      if (!purposeText) {
        await ctx.reply('❌ Error: El texto no puede estar vacío.');
      } else {
        await runQuery(`INSERT INTO purposes(purpose) VALUES(?)`, [purposeText]);
        await ctx.reply('✅ Propósito agregado exitosamente.');
      }
      ctx.session.awaiting = null;
      return;
    }

    // 5. Lógica para procesar setpurpose
    if (awaiting.action === 'setpurpose') {
      const purposeId = Number(text);
      if (isNaN(purposeId)) {
        await ctx.reply('❌ Error: ID inválido.');
      } else {
        const p = await getQuery(`SELECT id FROM purposes WHERE id = ?`, [purposeId]);
        if (!p) {
          await ctx.reply('❌ Error: ID de propósito no existe.');
        } else {
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, purpose_id) VALUES(?, ?)`, [awaiting.chat_id, purposeId]);
          await ctx.reply(`✅ Propósito del grupo actualizado.`);
        }
      }
      ctx.session.awaiting = null;
      return;
    }

    // 6. Lógica para resetdb_confirm
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

    // 7. Lógica para config
    if (awaiting.action === 'config') {
      const lines = text.split('\n');
      for (const line of lines) {
        const parts = line.split('=');
        if (parts.length === 2) {
          const key = parts[0].trim().toLowerCase();
          const val = parts[1].trim().toLowerCase();
          if (key === 'require_photo') {
            await runQuery(`INSERT OR REPLACE INTO settings(chat_id, require_photo) VALUES(?, ?)`, [awaiting.chat_id, val === 'on' ? 1 : 0]);
          } else if (key === 'paused') {
            await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [awaiting.chat_id, val === 'on' ? 1 : 0]);
          } else if (key === 'purpose_id') {
            await runQuery(`INSERT OR REPLACE INTO settings(chat_id, purpose_id) VALUES(?, ?)`, [awaiting.chat_id, Number(val)]);
          }
        }
      }
      await ctx.reply('✅ Configuración aplicada.');
      ctx.session.awaiting = null;
      return;
    }

    // 8. Lógica para pauseall_confirm
    if (awaiting.action === 'pauseall_confirm') {
      if (text === BOT_PASSWORD) {
        const groups = await allQuery(`SELECT chat_id FROM groups`);
        for (const g of groups) {
          await runQuery(`INSERT OR REPLACE INTO settings(chat_id, paused) VALUES(?, ?)`, [g.chat_id, 1]);
        }
        await ctx.reply('✅ Todas las funciones en todos los grupos han sido pausadas.');
      } else {
        await ctx.reply('❌ Contraseña incorrecta.');
      }
      ctx.session.awaiting = null;
      return;
    }

  } catch (e) {
    console.error('Error en el colector central de mensajes:', e);
  }
});

// --- Captura de señales para cierre correcto ---
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

// --- Iniciar Servidor y Webhook ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('FEDERACIÓN CORVUS Bot en línea y funcionando.'));

if (WEBHOOK_URL) {
  (async () => {
    try {
      const webhookPath = `/webhook/${WEBHOOK_SECRET_TOKEN}`;
      await bot.telegram.setWebhook(WEBHOOK_URL + webhookPath);
      console.log(`Webhook configurado en: ${WEBHOOK_URL}${webhookPath}`);

      app.use(webhookPath, (req, res) => {
        bot.handleUpdate(req.body, res).catch(() => {});
        res.sendStatus(200);
      });

      app.listen(PORT, () => {
        console.log(`Servidor webhook corriendo en el puerto ${PORT}`);
      });
    } catch (e) {
      console.error('Error al configurar webhook:', e);
    }
  })();
} else {
bot.launch().then(() => {
    console.log('Bot lanzado en modo polling');
  }).catch((e) => {
    console.error('Error al lanzar en modo polling:', e);
  });
}