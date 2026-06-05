// ============================================================================
//   SISTEMA DE CONTROL — FEDERACIÓN CANCERBEROS
//   Archivo: index.js (Versión Unificada Completa en HTML)
// ============================================================================

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

// Textos de Reglamentos de la Comunidad en HTML para consistencia total
const REGLAMENTOS = {
  1: `💬 <b>COTORREO</b> 💬
Este es un grupo para pláticas y desmadre. <b>NO es un espacio XXX, HOT ni de encuentros.</b>

⚰️ <i>Reglamento</i> ⚰️
💀 <b>Preséntate:</b> interactúa, no seas un "mueble" o serás expulsado.
💀 <b>Estrictamente prohibido:</b> Enviar fotopitos al grupo, CP, Gore, Zoo, etc.
💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.
💀 <b>Creadoras de Contenido:</b> Pide permiso a un Admin y verifícate.
💀 <b>Material Temporal:</b> Solo Material propio +18 (se Elimina Auto).
💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.
💀 <b>Garantía:</b> La compra de conte es bajo tu riesgo; el staff no se hace responsable.
💀 <b>Límites:</b> No confundas el cotorreo con el bullying.`,

  2: `🔥<b>COTORREO HOT</b>🔥
Espacio para conocer Gente HOT, interactuar de forma caliente y promover contenido, sin caer en el morbo pesado.

⚰️ <i>Reglamento</i> ⚰️
💀 <b>Actividad:</b> Intégrate al desmadre, evita quedarte de "mueble".
💀 <b>Estrictamente prohibido:</b> Fotopitos, CP, Gore, Zoo, Material Ilegal, etc.
💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.
💀 <b>Creadoras de Contenido:</b> Pide permiso y verifícate.
💀 <b>Material Temporal:</b> Solo Material +18 Propio, no dormidas, filtrados, exs, (se Elimina Auto).
💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.
💀 <b>Garantía:</b> La compra de conte es bajo tu riesgo; el staff no se hace responsable.`
};

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
        gruposActivos.set(idStr, { reglamento: 1, ...grupo, id: idStr });
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
async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

function nombreInvalido(nombre) {
  if (!nombre) return true;
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();
  const sinEspacios = limpio.replace(/\s+/g, '');

  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;
  
  const soloTexto = limpio.replace(/[\d\s\p{P}\p{S}\p{Emoji}]/gu, '');
  
  if (soloTexto.length < 3) return true;
  
  const regexLatina = /^[\p{Script=Latin}]+$/u;
  if (!regexLatina.test(soloTexto)) return true;

  if (/^\d+$/.test(sinEspacios)) return true;
  if (/(.)\1{2,}/.test(sinEspacios)) return true; 

  if (soloTexto.length <= 4) {
    const tieneVocal = /[aeiouáéíóúüy]/i.test(soloTexto);
    if (!tieneVocal) return true;
  }

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
      id: idStr,
      reglamento: 1
    });
    gruposAutorizados.add(idStr);
    guardarGrupos();
    console.log(`✅ Grupo registrado y autorizado: ${nombre} (${idStr})`);
  }
}

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
  const username = user.username ? ` 🆔 @${user.username}` : " 🆔 (sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      // CUADRE: Mensaje de rechazo adaptado a HTML con ID limpio e interactivo
      autoDelete(ctx, {
        text: `🚫 Usuario <b>${user.first_name}</b>${username} (ID: <a href="tg://user?id=${user.id}">${user.id}</a>) rechazado: nombre inválido o alfabeto no permitido.`,
        options: { parse_mode: "HTML" }
      });
    } catch (err) {
      console.error("❌ Error al rechazar solicitud automática:", err.message);
    }
  } else {
    const grupo = gruposActivos.get(String(chatId)) || { reglamento: 1 };
    const numReglamento = grupo.reglamento || 1;
    const textoReglamento = REGLAMENTOS[numReglamento];

    try {
      await ctx.telegram.sendMessage(
        user.id,
        `👋 ¡Hola! Para ingresar al grupo <b>${grupoNombre}</b>, primero debes leer y aceptar sus normas:\n\n${textoReglamento}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Aceptar Reglamento", callback_data: `reg_ok_${chatId}` },
                { text: "❌ Rechazar", callback_data: `reg_no_${chatId}` }
              ]
            ]
          }
        }
      );
    } catch (err) {
      console.error(`⚠️ El usuario ${user.id} tiene el privado cerrado. Enfoque preventivo ejecutado:`, err.message);
      try {
        await ctx.telegram.declineChatJoinRequest(chatId, user.id);
        actualizarGrupo(chatId, 0, 1);
      } catch (declineErr) {
        console.error("❌ Error al declinar tras bloqueo de PV:", declineErr.message);
      }
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
      registrarGrupo(chatId, ctx.chat.title || "Grupo de Telegram");
      const grupo = gruposActivos.get(chatId);

      // CUADRE: Notificación de activación ajustada a HTML
      ctx.reply(`⚙️ <b>¡Sistema de Control Activado!</b>\nHe tomado el control del grupo <b>${grupo.nombre}</b> con éxito. Revisando si existen solicitudes de unión pendientes...`, { parse_mode: "HTML" });

      try {
        const solicitudesPendientes = await ctx.telegram.getChatJoinRequests(chatId);
        if (solicitudesPendientes && solicitudesPendientes.length > 0) {
          for (const solicitud of solicitudesPendientes) {
            await evaluarSolicitud(ctx, solicitud.from, chatId, grupo.nombre);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
      } catch (err) {
        console.error("❌ Error al intentar procesar solicitudes acumuladas en lote:", err.message);
      }
    } else {
      ctx.reply("⚠️ Me han hecho administrador, pero necesito que actives el permiso de *'Invitar usuarios por enlace' (Aprobar nuevos miembros)* para poder empezar a filtrar.");
    }
  }
});

// --- BLOQUE EXTRA: Callbacks de botones (Ban y Aceptación de Reglamento) ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const messageId = ctx.callbackQuery.message.message_id;

  if (data.startsWith("ban_")) {
    const targetUid = String(data.split("_")[1]);
    const chatId = ctx.callbackQuery.message.chat.id; 
    const esAdmin = await esAdminDelGrupo(ctx, userId);

    if (!esAdmin) {
      return ctx.answerCbQuery("❌ Solo administradores pueden usar este botón.", { show_alert: true });
    }

    try {
      await ctx.telegram.banChatMember(chatId, targetUid);
      await ctx.editMessageText("🚨 Usuario baneado por administrador.");
    } catch (err) {
      await ctx.answerCbQuery(`❌ Error al banear: ${err.message}`, { show_alert: true });
    }
    return;
  }

  if (data.startsWith("reg_ok_")) {
    const targetChatId = data.split("_")[2];
    const grupo = gruposActivos.get(String(targetChatId));
    const grupoNombre = grupo ? grupo.nombre : "el grupo";

    try {
      await ctx.telegram.approveChatJoinRequest(targetChatId, userId);
      actualizarGrupo(targetChatId, 1, 0);

      await ctx.deleteMessage(messageId).catch(() => {});

      try {
        const msgConfirmacion = await ctx.reply(`✅ ¡Perfecto! Has aceptado el reglamento. Ya puedes ingresar y participar en <b>${grupoNombre}</b>.`, { parse_mode: "HTML" });
        setTimeout(() => {
          ctx.deleteMessage(msgConfirmacion.message_id).catch(() => {});
        }, 6000);
      } catch (chatErr) {
        console.log(`ℹ️ El usuario ${userId} cerró el chat privado antes de enviar el texto de confirmación.`);
      }

      // CORRECCIÓN SOLICITADA: Ícono 🆔 acoplado exclusivamente al @username
      const username = ctx.from.username ? ` 🆔 @${ctx.from.username}` : " 🆔 (sin username)";
      
      const pseudoCtx = {
        chat: { id: targetChatId },
        reply: (text, options) => ctx.telegram.sendMessage(targetChatId, text, options),
        deleteMessage: (msgId) => ctx.telegram.deleteMessage(targetChatId, msgId)
      };

      // CORRECCIÓN SOLICITADA: Estructura HTML impecable con ID interactivo numérico activo
      autoDelete(pseudoCtx, {
        text: `👋 ¡Bienvenido/a <b>${ctx.from.first_name}</b>${username} (ID: <a href="tg://user?id=${userId}">${userId}</a>) al grupo <b>${grupoNombre}</b>!`,
        options: {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🚨 Banear", callback_data: `ban_${userId}` }]]
          }
        }
      });

    } catch (err) {
      console.error("❌ Error crítico al procesar aprobación vía botón:", err.message);
      await ctx.answerCbQuery("⚠️ No se pudo procesar tu entrada. Es posible que tu solicitud haya expirado.", { show_alert: true }).catch(() => {});
    }
    return;
  }

  if (data.startsWith("reg_no_")) {
    const targetChatId = data.split("_")[2];

    try {
      await ctx.telegram.declineChatJoinRequest(targetChatId, userId);
      actualizarGrupo(targetChatId, 0, 1);
      
      await ctx.editMessageText("❌ Has rechazado el reglamento. Tu solicitud de acceso al grupo fue denegada.");
      setTimeout(() => {
        ctx.deleteMessage(messageId).catch(() => {});
      }, 5000);

    } catch (err) {
      console.error("❌ Error al declinar vía botón:", err.message);
      await ctx.answerCbQuery("La solicitud ya expiró o fue procesada.", { show_alert: true });
    }
    return;
  }
});

// --- BLOQUE 8: Comandos administrativos ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("👋 Hola! Añádeme a un grupo como administrador para empezar a filtrar usuarios.");
  }

  registrarGrupo(chatId, ctx.chat.title);
  const grupo = gruposActivos.get(chatId);

  // CUADRE: Panel de inicio unificado a HTML
  return ctx.reply(
    `👋 Bot activo en el grupo <b>${grupo.nombre}</b>.\n\n` +
    `📊 Usuarios procesados: ${grupo.usuariosProcesados}\n` +
    `🚫 Usuarios rechazados: ${grupo.usuariosRechazados}\n` +
    `⚙️ Reglamento actual: Reglamento ${grupo.reglamento || 1}`,
    { parse_mode: "HTML" }
  );
});

bot.command('setrules', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("❌ Este comando solo funciona dentro de grupos.");
  }

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden cambiar las reglas del grupo.");

  const args = ctx.message.text.split(" ").slice(1);
  const seleccion = parseInt(args[0]);

  if (seleccion !== 1 && seleccion !== 2) {
    return ctx.reply("⚠️ Sintaxis incorrecta. Define el reglamento usando:\n• <code>/setrules 1</code>\n• <code>/setrules 2</code>", { parse_mode: "HTML" });
  }

  if (!gruposActivos.has(chatId)) {
    registrarGrupo(chatId, ctx.chat.title);
  }

  const grupo = gruposActivos.get(chatId);
  grupo.reglamento = seleccion;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  return ctx.reply(`⚙️ <b>Configuración Aplicada</b>\nEste grupo ahora exigirá que se apruebe el <b>Reglamento ${seleccion}</b> en el chat privado antes de permitir el ingreso.`, { parse_mode: "HTML" });
});

bot.command('reglas', async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (ctx.chat.type === 'private') {
    return ctx.reply("❌ Este comando solo funciona dentro de un grupo.");
  }

  if (!gruposActivos.has(chatId)) {
    registrarGrupo(chatId, ctx.chat.title || "Grupo de Telegram");
  }

  const grupo = gruposActivos.get(chatId);
  const numReglamento = grupo.reglamento || 1; 
  const textoReglamento = REGLAMENTOS[numReglamento];

  autoDelete(ctx, {
    text: `📖 <b>Reglamento Vigente de: ${grupo.nombre}</b>\n\n${textoReglamento}`,
    options: { parse_mode: "HTML" }
  });
});

bot.help((ctx) => {
  const manualAyuda = 
    `📖 <b>Manual de Comandos — Federación Cancerberos</b>\n\n` +
    `🤖 <b>1. /start</b>\n` +
    `• <i>Sintaxis:</i> <code>/start</code>\n` +
    `• <i>Dónde:</i> Chat Privado y Grupos.\n\n` +

    `⚙️ <b>2. /setrules</b>\n` +
    `• <i>Descripción:</i> Cambia el reglamento del grupo (1 o 2) que los usuarios deben firmar en privado.\n` +
    `• <i>Sintaxis:</i> <code>/setrules &lt;1 o 2&gt;</code>\n` +
    `• <i>Quién:</i> Administradores.\n\n` +

    `📖 <b>3. /reglas</b>\n` +
    `• <i>Descripción:</i> Muestra las reglas actuales configuradas para este grupo. Desaparece en 4 minutos.\n` +
    `• <i>Sintaxis:</i> <code>/reglas</code>\n` +
    `• <i>Quién:</i> Cualquier miembro.\n\n` +
    
    `🛡️ <b>4. /gban</b>\n` +
    `• <i>Descripción:</i> Ejecuta un baneo preventivo global en la red de grupos.\n` +
    `• <i>Sintaxis:</i> <code>/gban &lt;id_numérico&gt; [motivo]</code> o respondiendo al mensaje del infractor.\n` +
    `• <i>Quién:</i> Administradores.\n\n` +
    
    `❓ <b>5. /help</b>\n` +
    `• <i>Sintaxis:</i> <code>/help</code>`;

  return ctx.reply(manualAyuda, { parse_mode: "HTML" });
});

// 🛡️ SECCIÓN GBAN OPTIMIZADA (Sincronizada por completo a HTML)
bot.command('gban', async (ctx) => {
  if (ctx.chat.type === 'private') {
    return ctx.reply("❌ Este comando solo funciona dentro de grupos.");
  }

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId; 
  let motivo = "Sin motivo especificado";
  let usernameLabel = "(sin username)";
  const grupoOrigen = ctx.chat.title || "Grupo de Origen";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = String(target.id);
    usernameLabel = target.username ? `🆔 @${target.username}` : "🆔 (sin username)";
    if (args.length > 0) motivo = args.join(" ");
  } 
  else if (args[0] && /^\d+$/.test(args[0].trim())) {
    userId = String(args[0].trim());
    if (args.length > 1) motivo = args.slice(1).join(" ");
  }

  if (!userId && args[0] && args[0].startsWith("@")) {
    return ctx.reply("⚠️ No se puede banear por @username. Usa ID numérico o responde a su mensaje.");
  }

  if (!userId) {
    return ctx.reply("⚠️ Uso: <code>/gban &lt;id_usuario_positivo&gt;</code> o responde al mensaje del usuario con <code>/gban [motivo]</code>.", { parse_mode: "HTML" });
  }

  // Ejecución del baneo global en los chats mapeados
  for (const [chatId] of gruposActivos.entries()) {
    try {
      if (userId.startsWith("-")) continue; 
      await ctx.telegram.banChatMember(chatId, userId);
    } catch (err) {
      if (err.message.includes("PARTICIPANT_ID_INVALID")) {
        console.warn(`⚠️ El ID ${userId} no es válido o ya no existe en el chat ${chatId}.`);
      } else {
        console.error(`❌ Error aplicando ban global en ${chatId}:`, err.message);
      }
    }
  }

  // CUADRE: Notificación global del Gban adaptada al nuevo formato HTML unificado
  for (const [chatId] of gruposActivos.entries()) {
    try {
      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🛡️ <b>Gban Federación Cancerberos</b>\n\n` +
        `🆔 <b>ID Activo:</b> <a href="tg://user?id=${userId}">${userId}</a>\n` +
        `🏷️ <b>Username:</b> ${usernameLabel}\n` +
        `📝 <b>Motivo:</b> ${motivo}\n` +
        `📍 <b>Origen:</b> ${grupoOrigen}`,
        { parse_mode: "HTML" }
      ).catch(() => {});

      if (sent) {
        setTimeout(() => {
          ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
        }, 240000); 
      }
    } catch (e) {}
  }
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
  console.log("🚀 Servidor escuchando en puerto " + PORT);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
