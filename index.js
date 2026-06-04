// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const express = require('express');
const path = require('path');
const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);

const usuariosProcesados = new Map(); // ahora con TTL
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();
const mensajesActivos = new Map();
const warns = new Map();
const estadisticasUsuarios = new Map();
const FILE_GRUPOS = 'gruposActivos.json';

// --- BLOQUE 2: Guardar y cargar grupos ---
async function guardarGrupos() {
  try {
    const obj = {};
    for (const [id, grupo] of gruposActivos.entries()) {
      obj[String(id)] = grupo;
    }
    await fs.promises.writeFile(FILE_GRUPOS, JSON.stringify(obj, null, 2));
    console.log("💾 gruposActivos guardados en JSON.");
  } catch (err) {
    console.error("❌ Error al guardar grupos:", err.message);
  }
}

function cargarGrupos() {
  try {
    if (!fs.existsSync(FILE_GRUPOS)) {
      console.log("⚠️ No existe archivo de grupos, se inicia vacío.");
      return;
    }
    const data = fs.readFileSync(FILE_GRUPOS, "utf8");
    const grupos = JSON.parse(data);
    for (const [id, grupo] of Object.entries(grupos)) {
      const idStr = String(id);
      gruposActivos.set(idStr, { ...grupo, id: idStr });
      gruposAutorizados.add(idStr);
    }
    console.log("📂 gruposActivos cargados y autorizados desde JSON.");
  } catch (error) {
    console.error("❌ Error al cargar grupos:", error);
  }
}
cargarGrupos();

// --- BLOQUE 3: Funciones utilitarias ---
function autoDelete(ctx, mensaje) {
  const chatId = String(ctx.chat.id);

  let sendPromise;
  if (typeof mensaje === "string") {
    sendPromise = ctx.reply(mensaje);
  } else if (mensaje.text) {
    sendPromise = ctx.reply(mensaje.text, mensaje.options || {});
  } else {
    console.error("❌ autoDelete recibió objeto sin .text");
    return;
  }

  sendPromise.then(sent => {
    const anteriores = mensajesActivos.get(chatId) || [];
    for (const msgId of anteriores) {
      ctx.deleteMessage(msgId).catch(() => {});
    }
    mensajesActivos.set(chatId, [...anteriores, sent.message_id]);
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      const restantes = (mensajesActivos.get(chatId) || []).filter(id => id !== sent.message_id);
      if (restantes.length > 0) {
        mensajesActivos.set(chatId, restantes);
      } else {
        mensajesActivos.delete(chatId);
      }
    }, 240000);
  });
}

// Escapar caracteres reservados en MarkdownV2
function escapeMarkdownV2(text) {
  return text
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

// --- BLOQUE 3bis: Verificación de administradores ---
async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(miembro.status);
  } catch (err) {
    console.error("❌ Error al verificar admin:", err.message);
    return false;
  }
}
// --- BLOQUE 4: Validaciones de nombres ---
function nombreInvalido(nombre) {
  if (!nombre) return true;
  const soloSimbolos = /^[\p{P}\p{S}]+$/u;
  const unaLetra = /^[A-Za-zÁÉÍÓÚÜÑ]$/u;
  const letrasRepetidas = /(.)\1{2,}/u;
  const letraMasSimbolo = /^[A-Za-zÁÉÍÓÚÜÑ][\p{P}\p{S}]$/u;
  if (nombre.length < 2) return true;
  if (/^\s+$/.test(nombre)) return true;
  return (
    soloSimbolos.test(nombre) ||
    unaLetra.test(nombre) ||
    letrasRepetidas.test(nombre) ||
    letraMasSimbolo.test(nombre)
  );
}

// --- BLOQUE 4bis: Función para obtener reglamento ---
function obtenerReglamento(chatId) {
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return "📖 No hay reglamento configurado para este grupo.";
  try {
    const data = fs.readFileSync("reglamentos.json", "utf8");
    const reglamentos = JSON.parse(data);
    const tipo = grupo.tipoReglamento || "default";
    return reglamentos[tipo] || reglamentos["default"];
  } catch (err) {
    console.error("❌ Error al leer reglamentos:", err.message);
    return "📖 Reglamento por defecto: Respeta a los demás miembros.";
  }
}

// --- BLOQUE 5: Manejo de solicitudes de ingreso con contador ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const grupo = gruposActivos.get(chatId);
    if (!grupo || !gruposAutorizados.has(chatId)) return;

    const user = ctx.chatJoinRequest.from;

    // Validación de nombre inválido
    if (nombreInvalido(user.first_name)) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      grupo.usuariosRechazados = (grupo.usuariosRechazados || 0) + 1;
      guardarGrupos();
      return autoDelete(ctx, `🚫 Usuario *${user.first_name}* fue rechazado por nombre inválido.`);
    }

    // Aprobar ingreso pero restringir permisos (solo lectura)
    await ctx.telegram.approveChatJoinRequest(chatId, user.id);
    await ctx.telegram.restrictChatMember(chatId, user.id, {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false
    });

    // Enviar mensaje con contador inicial
    let tiempoRestante = 5 * 60; // 5 minutos en segundos
    const mensaje = await ctx.telegram.sendMessage(chatId,
      escapeMarkdownV2(`🎉 Bienvenido *${user.first_name}*.\n\nDebes aceptar ver y aceptar las reglas, preciona rules para verlas .\n⏱️ Tiempo restante: 5:00`),
      {
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📜 Rules", url: `https://t.me/${ctx.botInfo.username}?start=${chatId}_${user.id}` }]
          ]
        }
      }
    );

    // Actualizar contador cada minuto
    const interval = setInterval(async () => {
      tiempoRestante -= 60;
      const minutos = Math.floor(tiempoRestante / 60);
      const segundos = tiempoRestante % 60;
      const formato = `${minutos}:${segundos.toString().padStart(2, "0")}`;

      try {
        await ctx.telegram.editMessageText(chatId, mensaje.message_id, null,
          escapeMarkdownV2(`🎉 Bienvenido *${user.first_name}*.\n\nDebes aceptar las reglas en el chat del bot.\n⏱️ Tiempo restante: ${formato}`),
          {
            parse_mode: "MarkdownV2",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📜 Rules", url: `https://t.me/${ctx.botInfo.username}?start=${chatId}_${user.id}` }]
              ]
            }
          }
        );
      } catch (err) {
        console.error("❌ Error al actualizar contador:", err.message);
      }

      if (tiempoRestante <= 0) {
        clearInterval(interval);
        if (!usuariosProcesados.has(user.id)) {
          try {
            await ctx.telegram.kickChatMember(chatId, user.id);
            await ctx.telegram.sendMessage(chatId,
              escapeMarkdownV2(`⏱️ Usuario *${user.first_name}* fue expulsado por no aceptar las reglas a tiempo.`),
              { parse_mode: "MarkdownV2" }
            );
          } catch (err) {
            console.error("❌ Error al expulsar por timeout:", err.message);
          }
        }
      }
    }, 60 * 1000); // cada minuto
  } catch (err) {
    console.error("❌ Error en chat_join_request:", err.message);
  }
});

// --- BLOQUE 6: Manejo de aceptación/rechazo ---
// --- BLOQUE 6: Manejo de aceptación/rechazo ---
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("acepto|")) {
      const [ , chatIdStr, userIdStr ] = data.split("|");
      const chatId = Number(chatIdStr);
      const userId = Number(userIdStr);

      usuariosProcesados.set(userId, true); // marcar como aceptado
      await ctx.telegram.restrictChatMember(chatId, userId, {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      });

      await ctx.answerCbQuery("✅ Has aceptado el reglamento.", { show_alert: true });
      await ctx.deleteMessage();

    } else if (data.startsWith("rechazo|")) {
      const [ , chatIdStr, userIdStr ] = data.split("|");
      const chatId = Number(chatIdStr);
      const userId = Number(userIdStr);

      try {
        await ctx.telegram.kickChatMember(chatId, userId);
      } catch (err) {
        console.error("❌ Error al expulsar por rechazo:", err.message);
      }
      await ctx.answerCbQuery("❌ Has rechazado el reglamento.", { show_alert: true });
      await ctx.deleteMessage();
    }
  } catch (err) {
    console.error("❌ Error en callback_query:", err.message);
  }
});

// --- BLOQUE 8: Comando /start adaptado ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  const esGrupo = ctx.chat.type.endsWith("group");

  if (esGrupo) {
    const estadisticasGrupo =
      `👋 Este bot está activo en el grupo *${grupo?.nombre || "Sin nombre"}*.\n\n` +
      `📊 Usuarios procesados: ${grupo?.usuariosProcesados || 0}\n` +
      `🚫 Usuarios rechazados: ${grupo?.usuariosRechazados || 0}\n\n`;

    const menuComandos =
      `📜 *Menú de comandos del grupo*\n\n` +
      `➡️ /start – Muestra estadísticas del grupo y este menú\n` +
      `⚙️ /setreglamento – Configura o muestra el reglamento del grupo\n` +
      `⏸️ /pausar – Pausa el ingreso de nuevos usuarios\n` +
      `▶️ /activo – Reactiva el ingreso de usuarios\n` +
      `📂 /grupos – Lista los grupos activos y autorizados\n` +
      `❓ /help – Explicación rápida de cada comando\n`;

    return autoDelete(ctx, {
      text: escapeMarkdownV2(estadisticasGrupo + menuComandos),
      options: { parse_mode: "MarkdownV2" }
    });
  }

  const menuPrivado =
    `👋 Hola, soy el portero del grupo.\n\n` +
    `📜 *Comandos disponibles en privado*\n\n` +
    `➡️ /start – Muestra este menú\n` +
    `📖 /setreglamento – Configura el reglamento del grupo (solo admins)\n` +
    `❓ /help – Explicación rápida de cada comando\n\n` +
    `⚠️ Si vienes de un grupo, recibirás aquí el reglamento para aceptarlo.`;

  return autoDelete(ctx, {
    text: escapeMarkdownV2(menuPrivado),
    options: { parse_mode: "MarkdownV2" }
  });
});
// --- BLOQUE 9: GBAN y GUNBAN ---
async function resolveUserId(ctx, chatId, username) {
  try {
    const targetUsername = username.replace("@", "");
    const miembros = await ctx.telegram.getChatAdministrators(chatId);
    const miembro = miembros.find(m => m.user.username?.toLowerCase() === targetUsername.toLowerCase());
    return miembro?.user?.id || null;
  } catch (err) {
    console.error("❌ Error al resolver username:", err.message);
    return null;
  }
}

bot.command('gban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id;
    username = target.username ? `@${target.username}` : "";
  } else if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) {
      username = args[0];
      userId = await resolveUserId(ctx, ctx.chat.id, username);
    }
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/gban <id_usuario | @usuario> [motivo]`", { parse_mode: "MarkdownV2" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      await ctx.telegram.sendMessage(
        chatId,
        escapeMarkdownV2(`🚨 *GBAN Federación*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`),
        { parse_mode: "MarkdownV2" }
      );
    } catch (err) {
      console.error(`❌ Error al banear en grupo ${chatId}:`, err.message);
    }
  }
});

bot.command('gunban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) {
      username = args[0];
      userId = await resolveUserId(ctx, ctx.chat.id, username);
    }
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/gunban <id_usuario | @usuario> [motivo]`", { parse_mode: "MarkdownV2" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.unbanChatMember(chatId, userId);
      await ctx.telegram.sendMessage(
        chatId,
        escapeMarkdownV2(`✅ *GUNBAN Federación*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`),
        { parse_mode: "MarkdownV2" }
      );
    } catch (err) {
      console.error(`❌ Error al desbanear en grupo ${chatId}:`, err.message);
    }
  }
});
// --- BLOQUE 9bis: Comando /grupos ---
bot.command("grupos", (ctx) => {
  try {
    if (gruposActivos.size === 0) {
      return autoDelete(ctx, "📂 No hay grupos activos registrados.");
    }

    let mensaje = "📂 *Grupos activos y autorizados*\n\n";

    for (const [chatId, grupo] of gruposActivos.entries()) {
      const autorizado = gruposAutorizados.has(chatId) ? "✅ Autorizado" : "❌ No autorizado";
      const estado = grupo.pausado ? "⏸️ Pausado" : "▶️ Activo";
      const reglamento = grupo.tipoReglamento || "default";

      mensaje += `• ${grupo.nombre || "Sin nombre"} (${chatId})\n   Estado: ${estado}\n   Reglamento: ${reglamento}\n   ${autorizado}\n\n`;
    }

    return autoDelete(ctx, {
      text: escapeMarkdownV2(mensaje),
      options: { parse_mode: "MarkdownV2" }
    });
  } catch (err) {
    console.error("❌ Error en comando /grupos:", err.message);
    return autoDelete(ctx, "⚠️ Ocurrió un error al listar los grupos.");
  }
});

// --- BLOQUE 10bis: Comando /setreglamento ---
bot.command('setreglamento', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 1) {
    return ctx.reply("⚠️ Uso: `/setreglamento <platica|contenido>`", { parse_mode: "MarkdownV2" });
  }

  const tipo = args[0].toLowerCase();
  if (!["platica", "contenido"].includes(tipo)) {
    return ctx.reply("⚠️ Tipo inválido. Usa: `platica` o `contenido`", { parse_mode: "MarkdownV2" });
  }

  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

  grupo.tipoReglamento = tipo;
  gruposActivos.set(chatId, grupo);
  await guardarGrupos();

  return ctx.reply(
    escapeMarkdownV2(`✅ El reglamento del grupo ahora está configurado como: *${tipo}*`),
    { parse_mode: "MarkdownV2" }
  );
});

// --- INICIO DEL BOT ---
bot.launch()
  .then(() => {
    console.log("🤖 Bot iniciado correctamente y escuchando eventos...");
  })
  .catch(err => {
    console.error("❌ Error al iniciar el bot:", err.message);
  });

// --- Manejo de cierre seguro ---
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
