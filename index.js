// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf } = require('telegraf');
const fs = require('fs');
const express = require('express');
const app = express();

if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL) {
  console.error("❌ ERROR: Faltan variables de entorno (BOT_TOKEN o WEBHOOK_URL)");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const mensajesActivos = new Map(); // chatId -> array de message_id

const FILE_GRUPOS = 'gruposActivos.json';

function guardarGrupos() {
  try {
    fs.writeFileSync(FILE_GRUPOS, JSON.stringify([...gruposActivos.values()], null, 2));
    console.log("💾 gruposActivos guardados en JSON.");
  } catch (err) {
    console.error("❌ Error al guardar grupos:", err.message);
  }
}

function cargarGrupos() {
  try {
    if (fs.existsSync(FILE_GRUPOS)) {
      const data = fs.readFileSync(FILE_GRUPOS, "utf8");
      const grupos = JSON.parse(data);

      grupos.forEach(grupo => {
        const idStr = String(grupo.id);
        gruposActivos.set(idStr, { ...grupo, id: idStr });
        gruposAutorizados.add(idStr);
      });
      console.log("📂 gruposActivos cargados y autorizados desde JSON.");
    }
  } catch (error) {
    console.error("❌ Error al cargar grupos:", error);
  }
}
cargarGrupos();

// --- BLOQUE 2: Validaciones y utilidades ---
function nombreInvalido(nombre) {
  if (!nombre) return true;
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();
  const sinEspacios = limpio.replace(/\s+/g, '');

  // Regla 1: Palabras prohibidas (Enlaces/Spam)
  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;

  // Regla 2: Menores a 3 letras o caracteres reales (ej: "ab", "x", "12")
  if (sinEspacios.length < 3) return true;

  // Regla 3: Solo números (ej: "12345")
  if (/^\d+$/.test(sinEspacios)) return true;

  // Regla 4: Solo puntuación o símbolos (ej: "...+", "$$$")
  if (/^[\p{P}]+$/u.test(sinEspacios)) return true;
  if (/^[\p{S}]+$/u.test(sinEspacios)) return true;

  // Regla 5: Solo emojis
  if (/^\p{Emoji}+$/u.test(sinEspacios)) return true;

  // Regla 6: Letras sueltas con espacios sospechosos (ej: "x d", "a b c")
  if (/^[a-zA-Z]\s+[a-zA-Z]$/i.test(limpio) || /^[a-zA-Z]\s+[a-zA-Z]\s+[a-zA-Z]$/i.test(limpio)) return true;

  // Regla 7: Sin vocales en nombres cortos (Anti-basura como "zxr", "vqc", "bdfg")
  if (sinEspacios.length <= 4) {
    const tieneVocal = /[aeiouáéíóúüy]/i.test(sinEspacios);
    if (!tieneVocal) return true;
  }

  // Regla 8: Letras repetidas (3 o más consecutivas ej: "aaasdf", "gerrr")
  if (/(.)\1{2,}/.test(sinEspacios)) return true;

  return false;
}

function registrarGrupo(chatId, nombre) {
  const idStr = String(chatId);
  if (!gruposActivos.has(idStr)) {
    gruposActivos.set(idStr, {
      nombre,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date().toISOString(),
      id: idStr
    });
    gruposAutorizados.add(idStr);
    guardarGrupos();
    console.log(`✅ Grupo registrado y authorized: ${nombre} (${idStr})`);
  }
}

// Historial limpio: Borra el mensaje anterior inmediatamente al enviar uno nuevo
function autoDelete(ctx, mensaje) {
  const chatId = String(ctx.chat.id);
  const sendPromise = typeof mensaje === "string"
    ? ctx.reply(mensaje)
    : ctx.reply(mensaje.text, mensaje.options);

  sendPromise.then(sent => {
    if (mensajesActivos.has(chatId)) {
      const lista = mensajesActivos.get(chatId);
      while (lista.length > 0) {
        const viejoId = lista.shift();
        ctx.deleteMessage(viejoId).catch(() => {}); 
      }
    } else {
      mensajesActivos.set(chatId, []);
    }

    const lista = mensajesActivos.get(chatId);
    lista.push(sent.message_id);

    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      const idx = lista.indexOf(sent.message_id);
      if (idx !== -1) lista.splice(idx, 1);
    }, 240000);
    
  }).catch(err => console.error("❌ Error en autoDelete al enviar:", err.message));
}

function actualizarGrupo(chatId, procesados, rechazados) {
  const idStr = String(chatId);
  if (gruposActivos.has(idStr)) {
    const grupo = gruposActivos.get(idStr);
    grupo.usuariosProcesados += procesados;
    grupo.usuariosRechazados += rechazados;
    gruposActivos.set(idStr, grupo);
    guardarGrupos();
  }
}

async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      autoDelete(ctx, `🚫 Usuario *${user.first_name}* ${username} (ID: ${user.id}) fue rechazado por nombre inválido.`);
    } catch (err) {
      console.error("❌ Error al rechazar solicitud:", err.message);
    }
  } else {
    try {
      await ctx.telegram.approveChatJoinRequest(chatId, user.id);
      actualizarGrupo(chatId, 1, 0);
      autoDelete(ctx, {
        text: `👋 Bienvenido *${user.first_name}* ${username} (ID: ${user.id}) al grupo *${grupoNombre}*!`,
        options: {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🚨 Banear", callback_data: `ban_${user.id}` }]]
          }
        }
      });
    } catch (err) {
      console.error("❌ Error al aprobar solicitud:", err.message);
    }
  }
}

// --- BLOQUE 4B: Manejo de solicitudes de unión en tiempo real ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  
  if (!gruposActivos.has(chatId)) {
    registrarGrupo(chatId, ctx.chat.title || "Grupo de Telegram");
  }

  const grupo = gruposActivos.get(chatId);
  await evaluarSolicitud(ctx, ctx.chatJoinRequest.from, chatId, grupo.nombre);
});

// --- BLOQUE 4C: Activación automática por asignación de permisos + Procesamiento en lote ---
bot.on('chat_member', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const { old_chat_member, new_chat_member } = ctx.chatMember;

  const eraAdmin = old_chat_member.status === 'administrator';
  const esAdminAhora = new_chat_member.status === 'administrator';

  if (!eraAdmin && esAdminAhora) {
    if (new_chat_member.can_invite_users) {
      console.log(`⚡ Bot detectado como Administrator con permisos en: ${ctx.chat.title} (${chatId})`);
      
      registrarGrupo(chatId, ctx.chat.title || "Grupo de Telegram");
      const grupo = gruposActivos.get(chatId);

      ctx.reply(`⚙️ *¡Sistema de Control Activado!*\nHe tomado el control del grupo *${grupo.nombre}* con éxito. Revisando si existen solicitudes de unión pendientes...`, { parse_mode: "Markdown" });

      try {
        const solicitudesPendientes = await ctx.telegram.getChatJoinRequests(chatId);
        
        if (solicitudesPendientes && solicitudesPendientes.length > 0) {
          console.log(`📥 Procesando ${solicitudesPendientes.length} solicitudes acumuladas de inmediato...`);
          
          for (const solicitud of solicitudesPendientes) {
            await evaluarSolicitud(ctx, solicitud.from, chatId, grupo.nombre);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } else {
          console.log("🧹 No se encontraron solicitudes acumuladas. Esperando nuevos ingresos...");
        }
      } catch (err) {
        console.error("❌ Error al intentar procesar solicitudes acumuladas en lote:", err.message);
      }
    } else {
      ctx.reply("⚠️ Me han hecho administrador, pero necesito que actives el permiso de *'Invitar usuarios por enlace' (Aprobar nuevos miembros)* para poder empezar a filtrar.");
    }
  }
});

// --- BLOQUE EXTRA: Callback del botón Ban ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("ban_")) {
    const userId = parseInt(data.split("_")[1]);
    const chatId = ctx.callbackQuery.message.chat.id; 
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);

    if (!esAdmin) {
      return ctx.answerCbQuery("❌ Solo administradores pueden usar este botón.", { show_alert: true });
    }

    try {
      await ctx.telegram.banChatMember(chatId, userId);
      await ctx.editMessageText("🚨 Usuario baneado por administrador.");
    } catch (err) {
      await ctx.answerCbQuery(`❌ Error al banear: ${err.message}`, { show_alert: true });
    }
  }
});

// --- BLOQUE 8: Comandos administrativos ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  const chatType = ctx.chat.type;

  if (chatType === 'private') {
    return ctx.reply("👋 Hola! Añádeme a un grupo como administrador para empezar a filtrar usuarios.");
  }

  registrarGrupo(chatId, ctx.chat.title);
  const grupo = gruposActivos.get(chatId);

  return ctx.reply(
    `👋 Bot activo en el grupo *${grupo.nombre}*.\n\n` +
    `📊 Usuarios procesados: ${grupo.usuariosProcesados}\n` +
    `🚫 Usuarios rechazados: ${grupo.usuariosRechazados}`,
    { parse_mode: "Markdown" }
  );
});

async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

// 🛡️ SECCIÓN CORREGIDA CON LA IDENTIDAD DE FEDERACIÓN CANCERBEROS
bot.command('gban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId;
  let motivo = "Sin motivo especificado";
  let usernameLabel = "(sin username)";
  let nombreUsuario = "Usuario Externo";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id;
    nombreUsuario = target.first_name || "Usuario";
    usernameLabel = target.username ? `@${target.username}` : "(sin username)";
    if (args.length > 0) motivo = args.join(" ");
  } 
  else if (args[0] && /^-?\d+$/.test(args[0])) {
    userId = Number(args[0]);
    if (args.length > 1) motivo = args.slice(1).join(" ");
  }

  if (!userId && args[0] && args[0].startsWith("@")) {
    return ctx.reply("⚠️ No puedo banear usando solo el @username por limitaciones de Telegram. Responde a uno de sus mensajes o usa su ID numérico.");
  }

  if (!userId) {
    return ctx.reply("⚠️ Uso: `/gban <id_usuario>` (numérico) o responde al mensaje del usuario con `/gban [motivo]`.", { parse_mode: "Markdown" });
  }

  let completados = 0;
  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      completados++;

      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🛡️ *GBAN de Federación Cancerberos*\n\n` +
        `👤 *Usuario:* ${nombreUsuario}\n` +
        `🏷️ *Username:* ${usernameLabel}\n` +
        `🆔 *ID:* \`${userId}\`\n` +
        `📝 *Motivo:* ${motivo}\n\n` +
        `🛑 _Estado: Baneo preventivo aplicado globalmente._`,
        { parse_mode: "Markdown" }
      ).catch(() => {});

      if (sent) {
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
        }, 240000); 
      }
    } catch (err) {
      console.error(`❌ Error gban preventivo en grupo ${chatId} (ID: ${userId}):`, err.message);
    }
  }

  ctx.reply(`📢 Global Ban procesado.\nExpulsado/Bloqueado preventivamente en ${completados} grupos activos para el ID: \`${userId}\`.`);
});

// --- BLOQUE 10: Configuración de Webhook para Railway ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL; 

bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

app.get('/', (req, res) => {
  res.send('✅ Bot corriendo con Webhook en Railway');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});

// --- BLOQUE FINAL: Cierre ---
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
