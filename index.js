// ============================================================================
//   SISTEMA DE CONTROL — FEDERACIÓN CANCERBEROS
//   Archivo: gemini-code-1780624552230.js (Versión RAM Definitiva y Blindada)
// ============================================================================

// --- BLOQUE 1: Imports e Inicialización ---
const { Telegraf } = require('telegraf');
const express = require('express');
const app = express();

// Validación estricta de entorno en Railway
if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL) {
  console.error("❌ ERROR: Faltan variables de entorno esenciales (BOT_TOKEN o WEBHOOK_URL)");
  process.exit(1);
}

if (!process.env.BOT_PASSWORD) {
  console.error("⚠️ ADVERTENCIA: La variable BOT_PASSWORD no está definida en Railway. Los comandos de autorización manual fallarán.");
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const mensajesActivos = new Map(); // chatId -> array de message_id
const temporizadoresSolicitudes = new Map(); // "userId_chatId" -> setTimeout reference

// Enlace directo y exclusivo a tu variable configurada en Railway
const PASSWORD_AUTORIZACION = process.env.BOT_PASSWORD; 

// Variables globales de control operativo (Volátiles en RAM)
let botPausado = false; 

// Textos de Reglamentos de la Comunidad en HTML
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
      reglamento: 1,
      verBienvenida: true,
      verRechazo: true
    });
    gruposAutorizados.add(idStr);
    console.log(`✅ Grupo registrado y autorizado en memoria RAM: ${nombre} (${idStr})`);
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
      if (lista.length === 0) mensajesActivos.delete(chatId); // Limpieza de RAM activa
    }, 240000); 
    
  }).catch(err => console.error("❌ Error en autoDelete al enviar:", err.message));
}

function actualizarGrupo(chatId, procesados, rechazados) {
  const idStr = String(chatId);
  if (gruposActivos.has(idStr)) {
    const group = gruposActivos.get(idStr);
    group.usuariosProcesados += procesados;
    group.usuariosRechazados += rechazados;
    gruposActivos.set(idStr, group);
  }
}

function limpiarTemporizadorSolicitud(userId, chatId) {
  const llave = `${userId}_${chatId}`;
  if (temporizadoresSolicitudes.has(llave)) {
    clearTimeout(temporizadoresSolicitudes.get(llave));
    temporizadoresSolicitudes.delete(llave);
  }
}

async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  if (!gruposAutorizados.has(String(chatId))) return;

  limpiarTemporizadorSolicitud(user.id, chatId);
  const username = user.username ? ` 🆔 @${user.username}` : " 🆔 (sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      
      const configGrupo = gruposActivos.get(String(chatId)) || { verRechazo: true };
      
      if (configGrupo.verRechazo !== false) {
        autoDelete(ctx, {
          text: `🚫 <b>Rechazado:</b> ${user.first_name}${username} (<a href="tg://user?id=${user.id}">${user.id}</a>) | Nombre/alfabeto inválido.`,
          options: { parse_mode: "HTML" }
        });
      }
    } catch (err) {
      console.error("❌ Error al rechazar de forma automática:", err.message);
    }
  } else {
    const grupo = gruposActivos.get(String(chatId)) || { reglamento: 1 };
    const numReglamento = grupo.reglamento || 1;
    const textoReglamento = REGLAMENTOS[numReglamento];

    const mensajeLlamativo = 
      `⚡ <b>¡SOLICITUD RECIBIDA CON ÉXITO!</b> ⚡\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Hola <b>${user.first_name}</b>, para completar tu ingreso al grupo: \n` +
      `🛡️ <b>${grupoNombre}</b> 🛡️\n\n` +
      `⚠️ <b>REQUISITO OBLIGATORIO:</b>\n` +
      `Debes leer el reglamento interno abajo y presionar el botón de <b>✅ Aceptar Reglamento</b>.\n` +
      `⏱️ <b>Tienes 10 minutos</b> o tu solicitud será cancelada automáticamente.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${textoReglamento}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
      const msgEnviado = await ctx.telegram.sendMessage(
        user.id,
        mensajeLlamativo,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Aceptar Reglamento y Entrar", callback_data: `reg_ok_${chatId}` }
              ],
              [
                { text: "❌ Rechazar / Cancelar", callback_data: `reg_no_${chatId}` }
              ]
            ]
          }
        }
      );

      const llaveTemporizador = `${user.id}_${chatId}`;
      const timer = setTimeout(async () => {
        try {
          await ctx.telegram.declineChatJoinRequest(chatId, user.id);
          actualizarGrupo(chatId, 0, 1);
          temporizadoresSolicitudes.delete(llaveTemporizador);

          await ctx.telegram.editMessageText(
            user.id,
            msgEnviado.message_id,
            null,
            `⏱️ <b>Tiempo agotado:</b> Tu solicitud para unirte a <b>${grupoNombre}</b> expiró porque no respondiste en los 10 minutos establecidos. Si deseas ingresar, vuelve a solicitar el acceso.`,
            { parse_mode: "HTML" }
          ).catch(() => {});

        } catch (timerErr) {
          console.error(`ℹ️ Error en la expiración automática del usuario ${user.id}:`, timerErr.message);
        }
      }, 600000); 

      temporizadoresSolicitudes.set(llaveTemporizador, timer);

    } catch (err) {
      console.error(`⚠️ El usuario ${user.id} tiene el privado cerrado o bloqueado. Ejecutando declinado preventivo.`);
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
  if (botPausado) return;

  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const grupo = gruposActivos.get(chatId);
  await evaluarSolicitud(ctx, ctx.chatJoinRequest.from, chatId, grupo.nombre);
});

// --- BLOQUE 4C: Manejo de permisos iniciales (Optimizado contra Rate Limits) ---
bot.on('chat_member', async (ctx) => {
  if (botPausado) return;

  const chatId = String(ctx.chat.id);
  const { old_chat_member, new_chat_member } = ctx.chatMember;

  // Solo actuar si el bot mismo es el que fue promovido a Administrador
  if (new_chat_member.user.id === ctx.botInfo.id) {
    const eraAdmin = old_chat_member.status === 'administrator';
    const esAdminAhora = new_chat_member.status === 'administrator';

    if (!eraAdmin && esAdminAhora) {
      if (!new_chat_member.can_invite_users) {
        try {
          console.log(`⚠️ Permiso faltante en ${ctx.chat.title}: Invitar usuarios por enlace.`);
        } catch (e) {}
      }
    }
  }
});

// --- COMANDO MANUAL: /autorizar ---
bot.command('autorizar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const messageId = ctx.message.message_id;

  if (ctx.chat.type === 'private') {
    return ctx.reply("❌ Este comando solo debe ejecutarse dentro del grupo que deseas dar de alta.");
  }

  try {
    await ctx.deleteMessage(messageId);
  } catch (err) {
    console.error("❌ No se pudo borrar el mensaje. Dale permiso al bot de 'Eliminar mensajes' en este grupo.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  const passwordIntroducido = args[0];

  if (!PASSWORD_AUTORIZACION || !passwordIntroducido || passwordIntroducido !== PASSWORD_AUTORIZACION) {
    console.log(`🔒 Intento fallido de autorización con contraseña errónea en: ${ctx.chat.title} (${chatId})`);
    try {
      await ctx.telegram.sendMessage(ctx.from.id, `❌ <b>Autenticación Fallida:</b> La contraseña proporcionada es incorrecta o no está configurada para el grupo: <i>${ctx.chat.title}</i>.`, { parse_mode: "HTML" });
    } catch (e) {}
    return;
  }

  if (!gruposActivos.has(chatId)) {
    registrarGrupo(chatId, ctx.chat.title || "Grupo de Telegram");
    
    try {
      const solicitudesPendientes = await ctx.telegram.getChatJoinRequests(chatId);
      if (solicitudesPendientes && solicitudesPendientes.length > 0) {
        for (const solicitud of solicitudesPendientes) {
          await evaluarSolicitud(ctx, solicitud.from, chatId, ctx.chat.title);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    } catch (err) {
      console.error("❌ Error en barrido inicial tras autorización:", err.message);
    }

    try {
      await ctx.telegram.sendMessage(ctx.from.id, `🚀 <b>¡Escudo Activado Exitosamente!</b>\nEl grupo <b>${ctx.chat.title}</b> ha sido autorizado mediante firma digital y ya se encuentra protegido en la memoria RAM.`, { parse_mode: "HTML" });
    } catch (e) {}
  }
});

// --- BLOQUE EXTRA: Callbacks de botones e Integración de GBAN Cruzado ---
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
      await ctx.editMessageText("🚨 Usuario baneado por administrador. Desplegando GBAN Federado...");

      const infoUsuario = await ctx.telegram.getChat(targetUid).catch(() => ({ first_name: "Usuario", username: null }));
      const labelUser = infoUsuario.username ? `@${infoUsuario.username}` : "(sin username)";
      const origGrupo = ctx.callbackQuery.message.chat.title || "Origen Desconocido";

      for (const [gId] of gruposActivos.entries()) {
        try {
          await ctx.telegram.banChatMember(gId, targetUid).catch(() => {});
          
          const notif = await ctx.telegram.sendMessage(
            gId,
            `🛡️ <b>GBAN — Federación Cancerberos</b>\n\n` +
            `🆔 <b>ID Penalizado:</b> <a href="tg://user?id=${targetUid}">${targetUid}</a>\n` +
            `👤 <b>Nombre:</b> ${infoUsuario.first_name}\n` +
            `🏷️ <b>Username:</b> ${labelUser}\n` +
            `📝 <b>Motivo:</b> Bloqueo por botón (Escudo de Bienvenida)\n` +
            `📍 <b>Origen:</b> ${origGrupo}`,
            { parse_mode: "HTML" }
          ).catch(() => {});

          if (notif) {
            setTimeout(() => {
              ctx.telegram.deleteMessage(gId, notif.message_id).catch(() => {});
            }, 240000); 
          }
        } catch (fErr) {
          console.error(`❌ Error en propagación cruzada hacia grupo ${gId}:`, fErr.message);
        }
      }

    } catch (err) {
      await ctx.answerCbQuery(`❌ Error al banear: ${err.message}`, { show_alert: true });
    }
    return;
  }

  if (data.startsWith("reg_ok_")) {
    const targetChatId = data.split("_")[2];
    const grupo = gruposActivos.get(String(targetChatId));
    const grupoNombre = grupo ? grupo.nombre : "el grupo";

    limpiarTemporizadorSolicitud(userId, targetChatId);

    try {
      await ctx.telegram.approveChatJoinRequest(targetChatId, userId);
      actualizarGrupo(targetChatId, 1, 0);
      await ctx.deleteMessage(messageId).catch(() => {});

      try {
        const msgConfirmacion = await ctx.reply(`✅ ¡Perfecto! Has aceptado el reglamento. Ya puedes ingresar y participar en <b>${grupoNombre}</b>.`, { parse_mode: "HTML" });
        setTimeout(() => {
          ctx.deleteMessage(msgConfirmacion.message_id).catch(() => {});
        }, 6000);
      } catch (chatErr) {}

      const username = ctx.from.username ? ` 🆔 @${ctx.from.username}` : " 🆔 (sin username)";
      const pseudoCtx = {
        chat: { id: targetChatId },
        reply: (text, options) => ctx.telegram.sendMessage(targetChatId, text, options),
        deleteMessage: (msgId) => ctx.telegram.deleteMessage(targetChatId, msgId)
      };

      const configGrupo = gruposActivos.get(String(targetChatId)) || { verBienvenida: true };

      if (configGrupo.verBienvenida !== false) {
        autoDelete(pseudoCtx, {
          text: `👋 ¡Bienvenido/a <b>${ctx.from.first_name}</b>${username} (<a href="tg://user?id=${userId}">${userId}</a>) a <b>${grupoNombre}</b>!`,
          options: {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "🚨 Banear de la Federación", callback_data: `ban_${userId}` }]]
            }
          }
        });
      }

    } catch (err) {
      console.error("❌ Error crítico al procesar aprobación vía botón:", err.message);
      await ctx.answerCbQuery("⚠️ No se pudo procesar tu entrada. Es posible que tu solicitud haya expirado.", { show_alert: true }).catch(() => {});
    }
    return;
  }

  if (data.startsWith("reg_no_")) {
    const targetChatId = data.split("_")[2];
    limpiarTemporizadorSolicitud(userId, targetChatId);

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

// --- BLOQUE 8: Comandos Administrativos Tradicionales ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("👋 ¡Hola! Añádeme a un grupo como administrador y actívalo enviando la contraseña mediante el comando /autorizar.");
  }

  if (!gruposAutorizados.has(chatId)) return; 

  const grupo = gruposActivos.get(chatId);
  const vBienvenida = grupo.verBienvenida !== false ? "🟢 Activos" : "🔴 Ocultos";
  const vRechazo = grupo.verRechazo !== false ? "🟢 Activos" : "🔴 Ocultos";
  const estadoPausa = botPausado ? "⏸️ PAUSADO (Mantenimiento)" : "🟢 ACTIVO (Protegiendo)";

  return ctx.reply(
    `👋 Bot activo en el grupo <b>${grupo.nombre}</b>.\n\n` +
    `🛡️ Estado del Escudo: <b>${estadoPausa}</b>\n` +
    `📊 Usuarios procesados: ${grupo.usuariosProcesados}\n` +
    `🚫 Usuarios rechazados: ${grupo.usuariosRechazados}\n` +
    `⚙️ Reglamento actual: Reglamento ${grupo.reglamento || 1}\n` +
    `👋 Log Bienvenidas: <b>${vBienvenida}</b>\n` +
    `🚫 Log Rechazos: <b>${vRechazo}</b>\n\n` +
    `💡 Escribe <code>/help</code> para ver la lista de comandos disponibles.`,
    { parse_mode: "HTML" }
  );
});

// 📌 COMANDO ADICIONAL: /help (Corregido y Añadido)
bot.command('help', async (ctx) => {
  const ayudaTxt = 
    `🛡️ <b>SISTEMA CANCERBEROS — MANUAL DE COMANDOS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚙️ <b>Configuración (Solo Admins del Grupo):</b>\n` +
    `• <code>/start</code> - Estado actual, contadores y logs de este grupo.\n` +
    `• <code>/setrules [1 o 2]</code> - Cambia el reglamento exigido al usuario.\n` +
    `• <code>/reglas</code> - Muestra de inmediato las reglas vigentes en el chat.\n` +
    `• <code>/logbienvenida</code> - Alterna la visibilidad de saludos públicos de entrada.\n` +
    `• <code>/logrechazo</code> - Alterna alertas de usuarios rechazados por nombre.\n\n` +
    `📢 <b>Comandos Globales de Federación:</b>\n` +
    `• <code>/gmsg [Tu Mensaje]</code> - Envía un comunicado oficial a toda la red activa.\n` +
    `• <code>/pausarbot</code> - Detiene la verificación temporal de solicitudes.\n` +
    `• <code>/reanudarbot</code> - Reactiva el escudo y vacía solicitudes en cola.\n\n` +
    `🔑 <b>Inicialización de Seguridad:</b>\n` +
    `• <code>/autorizar [password]</code> - Enlaza tu grupo con el servidor RAM global.`;

  return ctx.reply(ayudaTxt, { parse_mode: "HTML" });
});

bot.command('setrules', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden cambiar las reglas.");

  const args = ctx.message.text.split(" ").slice(1);
  const seleccion = parseInt(args[0]);

  if (seleccion !== 1 && seleccion !== 2) {
    return ctx.reply("⚠️ Sintaxis incorrecta. Define el reglamento usando:\n• <code>/setrules 1</code>\n• <code>/setrules 2</code>", { parse_mode: "HTML" });
  }

  const grupo = gruposActivos.get(chatId);
  grupo.reglamento = seleccion;
  gruposActivos.set(chatId, grupo);

  return ctx.reply(`⚙️ <b>Configuración Aplicada</b>\nEste grupo ahora exigirá que se apruebe el <b>Reglamento ${seleccion}</b> en el chat privado antes de permitir el ingreso.`, { parse_mode: "HTML" });
});

bot.command('logbienvenida', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const grupo = gruposActivos.get(chatId);
  grupo.verBienvenida = grupo.verBienvenida !== false ? false : true;
  const estado = grupo.verBienvenida ? "🟢 VISIBLES" : "🔴 OCULTOS";

  gruposActivos.set(chatId, grupo);
  return ctx.reply(`⚙️ Mensajes de <b>bienvenida</b> ahora están: <b>${estado}</b>`, { parse_mode: "HTML" });
});

bot.command('logrechazo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const grupo = gruposActivos.get(chatId);
  grupo.verRechazo = grupo.verRechazo !== false ? false : true;
  const estado = group.verRechazo ? "🟢 VISIBLES" : "🔴 OCULTOS";

  gruposActivos.set(chatId, grupo);
  return ctx.reply(`⚙️ Mensajes de <b>rechazo</b> ahora están: <b>${estado}</b>`, { parse_mode: "HTML" });
});

bot.command('reglas', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const grupo = gruposActivos.get(chatId);
  const numReglamento = grupo.reglamento || 1; 
  const textoReglamento = REGLAMENTOS[numReglamento];

  autoDelete(ctx, {
    text: `📖 <b>Reglamento Vigente de: ${grupo.nombre}</b>\n\n${textoReglamento}`,
    options: { parse_mode: "HTML" }
  });
});

bot.command('pausarbot', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id))) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden pausar el sistema.");

  if (botPausado) return ctx.reply("⏳ El sistema ya se encuentra pausado.");

  botPausado = true;
  return ctx.reply("⏸️ <b>SISTEMA EN PAUSA</b>\nLas validaciones automáticas de ingreso han sido suspendidas globalmente.", { parse_mode: "HTML" });
});

bot.command('reanudarbot', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id))) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden reanudar el sistema.");

  if (!botPausado) return ctx.reply("🟢 El sistema ya está operando con normalidad.");

  botPausado = false;
  await ctx.reply("▶️ <b>SISTEMA REANUDADO</b>\nEl Escudo Cancerberos está de vuelta en línea. Escaneando solicitudes acumuladas en memoria...", { parse_mode: "HTML" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      const solicitudesPendientes = await ctx.telegram.getChatJoinRequests(chatId);
      if (solicitudesPendientes && solicitudesPendientes.length > 0) {
        for (const solicitud of solicitudesPendientes) {
          await evaluarSolicitud(ctx, solicitud.from, chatId, grupo.nombre);
          await new Promise(resolve => setTimeout(resolve, 300)); 
        }
      }
    } catch (err) {
      console.error(`❌ Error al procesar cola acumulada en el grupo ${chatId}:`, err.message);
    }
  }
  return ctx.reply("✅ <b>Barrido Completado:</b> Todas las solicitudes en cola han sido procesadas exitosamente.", { parse_mode: "HTML" });
});

// 🛠️ COMANDO CORREGIDO Y AFINADO: /gmsg (Filtro obsoleto removido)
bot.command('gmsg', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id))) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores autorizados pueden emitir comunicados globales.");

  const mensajeGlobal = ctx.message.text.split(" ").slice(1).join(" ").trim();

  if (!mensajeGlobal) {
    return ctx.reply("⚠️ Sintaxis incorrecta. Usa: <code>/gmsg [Tu comunicado]</code>", { parse_mode: "HTML" });
  }

  const plantillaAnuncio = 
    `📢 <b>COMUNICADO OFICIAL — FEDERACIÓN CANCERBEROS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${mensajeGlobal}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <i>Emitido por: ${ctx.from.first_name}</i>`;

  let enviosExitosos = 0;
  let enviosFallidos = 0;

  for (const [chatId] of gruposActivos.entries()) {
    try {
      // Removida la lógica estricta de prefijos que saltaba canales o supergrupos válidos
      await ctx.telegram.sendMessage(chatId, plantillaAnuncio, { parse_mode: "HTML" });
      enviosExitosos++;
      await new Promise(resolve => setTimeout(resolve, 250)); // Delay sutil anti-flood de Telegram
    } catch (err) {
      console.error(`❌ Error al enviar mensaje global al chat ID ${chatId}:`, err.message);
      enviosFallidos++;
    }
  }

  return ctx.reply(`✅ <b>Anuncio Global Desplegado</b>\n📊 Notificados: <b>${enviosExitosos}</b> | ❌ Errores o inactivos: <b>${enviosFallidos}</b>`, { parse_mode: "HTML" });
});

// --- BLOQUE 10: Configuración de Webhook para Railway ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL; 

bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

app.get('/', (req, res) => {
  res.send('✅ Bot corriendo con Webhook en Railway (Modo Memoria RAM Absoluto + Variable de Entorno + GBAN Integrado)');
});

app.listen(PORT, () => {
  console.log("🚀 Servidor escuchando en puerto " + PORT);
});

// Gestión preventiva global de errores para evitar que caiga el contenedor en Railway
process.on('uncaughtException', (err) => console.error('❌ Error general no capturado:', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ Promesa rechazada globalmente:', reason));
