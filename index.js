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

// Textos de Reglamentos de la Comunidad (Formato corregido y optimizado)
const REGLAMENTOS = {
  1: `💬 *REGLAMENTO: SÓLO COTORREO* 💬
Este es un grupo para pláticas y desmadre. **NO es un espacio XXX, HOT ni de encuentros.**

⚰️ *NORMAS DE CONVIVENCIA* ⚰️
💀 **Preséntate:** Al ingresar interactúa, no seas un "mueble" o serás expulsado.
💀 **Estrictamente prohibido:** Enviar fotopitos, CP, Gore, Zoo, etc.
💀 **Sin Spam:** Prohibido ventas, pedir o compartir links/grupos sin autorización de un Admin.
💀 **Creadoras de Contenido:** Si vendes material, pide permiso a un Admin y verifícate antes de promocionarte.
💀 **Material Temporal:** Se permite compartir material propio temporalmente (se borrará después).
💀 **Respeta el Privado:** No acoses en PV a los miembros sin antes haber cotorreado en el grupo. No se toleran chantajes ni hackeos.
💀 **Garantía:** Compras bajo tu propio riesgo; el grupo y los admins no interfieren en ventas.
💀 **Límites:** No confundas el cotorreo con el bullying.`,

  2: `🔥 *REGLAMENTO: COTORREO HOT* 🔥
Espacio para conocer gente, interactuar de forma caliente y promover contenido, sin caer en el morbo pesado.

⚰️ *NORMAS DE CONVIVENCIA* ⚰️
💀 **Actividad:** Al ingresar intégrate al desmadre, evita quedarte de "mueble" o serás expulsado.
💀 **Estrictamente prohibido:** Enviar fotopitos al grupo, pedir/vender CP, Gore, Zoo, etc.
💀 **Sin Spam:** Prohibido ventas, pedir o compartir links/grupos sin autorización de un Admin.
💀 **Creadoras de Contenido:** Si vendes material, pide permiso a un Admin y verifícate antes de promocionarte.
💀 **Material Temporal:** Puedes compartir tu material +18 propio, pero se eliminará pasado un tiempo.
💀 **No Acoso:** Respeta a los miembros; prohibido hostigar en PV, chantajes, NvXNv o hackeos.
💀 **Garantía:** Las transacciones económicas son bajo tu propio riesgo; el staff no se hace responsable.`
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
function nombreInvalido(nombre) {
  if (!nombre) return true;
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();
  const sinEspacios = limpio.replace(/\s+/g, '');

  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;
  if (sinEspacios.length < 3) return true;
  if (/^\d+$/.test(sinEspacios)) return true;
  if (/^[\p{P}]+$/u.test(sinEspacios)) return true;
  if (/^[\p{S}]+$/u.test(sinEspacios)) return true;
  if (/^\p{Emoji}+$/u.test(sinEspacios)) return true;
  if (/^[a-zA-Z]\s+[a-zA-Z]$/i.test(limpio) || /^[a-zA-Z]\s+[a-zA-Z]\s+[a-zA-Z]$/i.test(limpio)) return true;

  if (sinEspacios.length <= 4) {
    const tieneVocal = /[aeiouáéíóúüy]/i.test(sinEspacios);
    if (!tieneVocal) return true;
  }

  if (/(.)\1{2,}/.test(sinEspacios)) return true;

  // Filtro de Alfabetos No Latinos (Chino, Árabe, Cirílico, etc.)
  const soloTexto = limpio.replace(/[\d\s\p{P}\p{S}\p{Emoji}]/gu, '');
  if (soloTexto.length > 0) {
    const regexLatina = /^[\p{Script=Latin}]+$/u;
    if (!regexLatina.test(soloTexto)) return true;
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
  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      autoDelete(ctx, `🚫 Usuario *${user.first_name}* ${username} (ID: ${user.id}) fue rechazado automáticamente por nombre inválido o alfabeto no permitido.`);
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
        `👋 ¡Hola! Para ingresar al grupo *${grupoNombre}*, primero debes leer y aceptar sus normas:\n\n${textoReglamento}`,
        {
          parse_mode: "Markdown",
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
      console.error(`⚠️ El usuario ${user.id} tiene el privado cerrado. Rechazando por seguridad:`, err.message);
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

      ctx.reply(`⚙️ *¡Sistema de Control Activado!*\nHe tomado el control del grupo *${grupo.nombre}* con éxito. Revisando si existen solicitudes de unión pendientes...`, { parse_mode: "Markdown" });

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

      await ctx.editMessageText(`✅ ¡Perfecto! Has aceptado el reglamento. Ya puedes ingresar y participar en *${grupoNombre}*.`);

      const username = ctx.from.username ? `@${ctx.from.username}` : "(sin username)";
      
      const pseudoCtx = {
        chat: { id: targetChatId },
        reply: (text, options) => ctx.telegram.sendMessage(targetChatId, text, options),
        deleteMessage: (msgId) => ctx.telegram.deleteMessage(targetChatId, msgId)
      };

      autoDelete(pseudoCtx, {
        text: `👋 Bienvenido *${ctx.from.first_name}* ${username} (ID: \`${userId}\`) al grupo *${grupoNombre}*!`,
        options: {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🚨 Banear", callback_data: `ban_${userId}` }]]
          }
        }
      });

    } catch (err) {
      console.error("❌ Error al procesar aprobación vía botón:", err.message);
      await ctx.answerCbQuery("⚠️ No se pudo procesar tu entrada. Es posible que tu solicitud haya expirado por tiempo.", { show_alert: true });
    }
    return;
  }

  if (data.startsWith("reg_no_")) {
    const targetChatId = data.split("_")[2];

    try {
      await ctx.telegram.declineChatJoinRequest(targetChatId, userId);
      actualizarGrupo(targetChatId, 0, 1);
      await ctx.editMessageText("❌ Has rechazado el reglamento. Tu solicitud de acceso al grupo fue denegada.");
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

  return ctx.reply(
    `👋 Bot activo en el grupo *${grupo.nombre}*.\n\n` +
    `📊 Usuarios procesados: ${grupo.usuariosProcesados}\n` +
    `🚫 Usuarios rechazados: ${grupo.usuariosRechazados}\n` +
    `⚙️ Reglamento actual: Reglamento ${grupo.reglamento || 1}`,
    { parse_mode: "Markdown" }
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
    return ctx.reply("⚠️ Sintaxis incorrecta. Define el reglamento usando:\n• \`/setrules 1\`\n• \`/setrules 2\`", { parse_mode: "Markdown" });
  }

  if (!gruposActivos.has(chatId)) {
    registrarGrupo(chatId, ctx.chat.title);
  }

  const grupo = gruposActivos.get(chatId);
  grupo.reglamento = seleccion;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  return ctx.reply(`⚙️ *Configuración Aplicada*\nEste grupo ahora exigirá que se apruebe el *Reglamento ${seleccion}* en el chat privado antes de permitir el ingreso.`, { parse_mode: "Markdown" });
});

// 📖 Comando /reglas para mostrar el reglamento configurado con auto-delete
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
    text: `📖 *Reglamento Vigente de: ${grupo.nombre}*\n\n${textoReglamento}`,
    options: { parse_mode: "Markdown" }
  });
});

bot.help((ctx) => {
  const manualAyuda = 
    `📖 *Manual de Comandos — Federación Cancerberos*\n\n` +
    `🤖 *1. /start*\n` +
    `• *Sintaxis:* \`/start\`\n` +
    `• *Dónde:* Chat Privado y Grupos.\n\n` +

    `⚙️ *2. /setrules*\n` +
    `• *Descripción:* Cambia el reglamento del grupo (1 o 2) que los usuarios deben firmar en privado.\n` +
    `• *Sintaxis:* \`/setrules <1 o 2>\`\n` +
    `• *Quién:* Administradores.\n\n` +

    `📖 *3. /reglas*\n` +
    `• *Descripción:* Muestra las reglas actuales configuradas para este grupo. Desaparece en 4 minutos.\n` +
    `• *Sintaxis:* \`/reglas\`\n` +
    `• *Quién:* Cualquier miembro.\n\n` +
    
    `🛡️ *4. /gban*\n` +
    `• *Descripción:* Ejecuta un baneo preventivo global en la red de grupos.\n` +
    `• *Sintaxis:* \`/gban <id_numérico> [motivo]\` o respondiendo al mensaje del infractor.\n` +
    `• *Quién:* Administradores.\n\n` +
    
    `❓ *5. /help*\n` +
    `• *Sintaxis:* \`/help\``;

  return ctx.reply(manualAyuda, { parse_mode: "Markdown" });
});

async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

// 🛡️ SECCIÓN GBAN ULTRA-COMPACTA (Soporte nativo para strings e IDs Int64)
bot.command('gban', async (ctx) => {
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
    usernameLabel = target.username ? `@${target.username}` : "(sin username)";
    if (args.length > 0) motivo = args.join(" ");
  } 
  else if (args[0] && /^-?\d+$/.test(args[0])) {
    userId = String(args[0]);
    if (args.length > 1) motivo = args.slice(1).join(" ");
  }

  if (!userId && args[0] && args[0].startsWith("@")) {
    return ctx.reply("⚠️ No se puede banear por @username. Usa ID numérico o responde a su mensaje.");
  }

  if (!userId) {
    return ctx.reply("⚠️ Uso: \`/gban <id_usuario>\` o responde al mensaje del usuario con \`/gban [motivo]\`.", { parse_mode: "Markdown" });
  }

  let completados = 0;
  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      completados++;
    } catch (err) {
      console.error(`❌ Error aplicando ban global en ${chatId}:`, err.message);
    }
  }

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🛡️ *Gban de Federación Cancerberos*\n\n` +
        `🆔 *ID:* \`${userId}\`\n` +
        `🏷️ *Username:* ${usernameLabel}\n` +
        `📝 *Motivo:* ${motivo}\n` +
        `📍 *Origen:* ${grupoOrigen}`,
        { parse_mode: "Markdown" }
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
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
