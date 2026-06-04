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
// --- BLOQUE 3: Validaciones y utilidades ---
function nombreInvalido(nombre) {
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();
  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;
  if (limpio.length < 3) return true;
  if (/^\d+$/.test(limpio)) return true;
  if (/^[\p{P}]+$/u.test(limpio)) return true;
  if (/^[\p{S}]+$/u.test(limpio)) return true;
  if (/[\u{1F600}-\u{1F64F}]/u.test(limpio)) return true;
  if (/(.)\1{2,}/.test(limpio)) return true;
  return false;
}

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
async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(miembro.status);
  } catch (err) {
    console.error("❌ Error al verificar admin:", err.message);
    return false;
  }
}
// --- BLOQUE 4: Procesamiento de usuarios directos ---
async function procesarUsuario(ctx, user) {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;
  const claveUsuario = `${chatId}-${user.id}`;

  const ahora = Date.now();
  if (usuariosProcesados.has(claveUsuario)) {
    const { timestamp } = usuariosProcesados.get(claveUsuario);
    if (ahora - timestamp < 24 * 60 * 60 * 1000) return;
  }
  usuariosProcesados.set(claveUsuario, { timestamp: ahora });

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "directo" });
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.banChatMember(chatId, user.id);
      autoDelete(ctx, `🚫 Usuario rechazado: *${user.first_name}* (ID: ${user.id})`);
      grupo.usuariosRechazados = (grupo.usuariosRechazados || 0) + 1;
      guardarGrupos();
    } catch {}
    return;
  }

  const usernameText = user.username ? `@${user.username}` : "(sin username)";
  const mensajeBienvenida =
    `👋 Bienvenido *${user.first_name}* ${usernameText} (ID: ${user.id}) al grupo *${grupo.nombre}*!`;

  grupo.usuariosProcesados = (grupo.usuariosProcesados || 0) + 1;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  autoDelete(ctx, {
    text: mensajeBienvenida,
    options: {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "🚨 Banear", callback_data: `ban|${user.id}` }]] }
    }
  });
}
// --- BLOQUE 5: Comandos de pausa y reanudación ---
bot.command('pausar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return ctx.reply("⚠️ Este grupo no está autorizado.");
  grupo.pausado = true;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();
  return ctx.reply("⏸️ El ingreso de nuevos usuarios ha sido pausado.");
});

bot.command('activo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return ctx.reply("⚠️ Este grupo no está autorizado.");
  grupo.pausado = false;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();
  return ctx.reply("▶️ El ingreso de nuevos usuarios ha sido reanudado.");
});
// --- BLOQUE 6: Manejo de solicitudes de unión con reglamento obligatorio ---
// Función para obtener el reglamento configurado del grupo desde reglamentos.json
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

bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo || !gruposAutorizados.has(chatId)) return;

  const user = ctx.chatJoinRequest.from;

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "solicitud" });
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  if (nombreInvalido(user.first_name)) {
    await ctx.telegram.declineChatJoinRequest(chatId, user.id);
    grupo.usuariosRechazados = (grupo.usuariosRechazados || 0) + 1;
    guardarGrupos();
    return autoDelete(ctx, `🚫 Usuario *${user.first_name}* fue rechazado por nombre inválido.`);
  }

  const mensajeReglamento = obtenerReglamento(chatId) + 
    `\n\n¿Aceptas el reglamento para ingresar?`;

  try {
    await ctx.telegram.sendMessage(user.id, mensajeReglamento, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Acepto", callback_data: `acepto|${chatId}|${user.id}` }],
          [{ text: "❌ No acepto", callback_data: `rechazo|${chatId}|${user.id}` }]
        ]
      }
    });
  } catch (err) {
    console.error("❌ No se pudo enviar privado:", err.message);
    await ctx.telegram.declineChatJoinRequest(chatId, user.id);
    autoDelete(ctx, `⚠️ Usuario *${user.first_name}* debe abrir chat con el bot para ingresar. Solicitud rechazada.`);
  }
});
// --- BLOQUE 7: Manejo de callback_query (unificado) ---
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("acepto|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);
    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    await ctx.answerCbQuery("✅ Has aceptado el reglamento.", { show_alert: true });
    await ctx.telegram.sendMessage(chatId, `👋 Bienvenido al grupo!`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("rechazo|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);
    await ctx.telegram.declineChatJoinRequest(chatId, userId);
    await ctx.answerCbQuery("❌ Has rechazado el reglamento.", { show_alert: true });
    await ctx.telegram.sendMessage(chatId, `🚫 Usuario (ID: ${userId}) rechazó el reglamento.`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("ban|")) {
    const [ , userIdStr ] = data.split("|");
    const userId = Number(userIdStr);
    try {
      await ctx.telegram.banChatMember(ctx.chat.id, userId);
      await ctx.answerCbQuery("🚨 Usuario baneado.", { show_alert: true });
      await ctx.telegram.sendMessage(ctx.chat.id, `🚨 Usuario (ID: ${userId}) ha sido baneado.`, { parse_mode: "MarkdownV2" });
    } catch (err) {
      console.error("❌ Error al banear:", err.message);
      await ctx.answerCbQuery("❌ Error al banear.", { show_alert: true });
    }
  }
});
// --- BLOQUE 8: Comando /start ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  console.log("➡️ /start recibido en chat:", chatId);

  if (ctx.chat.type === "private") {
    return ctx.reply(
      "✅ El bot se ha iniciado correctamente.\n\n" +
      "📋 **Comandos Disponibles**\n\n" +
      "⚡ **/start** → Inicia el bot y muestra este menú.\n" +
      "ℹ️ **/info <id | @usuario>** → Muestra información del usuario.\n" +
      "⏸️ **/pausar** → Pausa el ingreso de nuevos usuarios.\n" +
      "▶️ **/activo** → Reanuda el ingreso de usuarios.\n" +
      "🚨 **/gban <id | @usuario> [motivo]** → Ban global.\n" +
      "✅ **/gunban <id | @usuario> [motivo]** → Quita ban global.\n" +
      "🚫 **/ban <id | @usuario> [motivo]** → Ban local.\n" +
      "✅ **/unban <id_usuario> [motivo]** → Quita ban local.\n" +
      "⚠️ **/warn <id | @usuario> [motivo]** → Asigna warn.\n" +
      "✅ **/unwarn <id_usuario> [motivo]** → Elimina warns.\n" +
      "🔇 **/mute <id | @usuario> [motivo]** → Silencia usuario.\n" +
      "✅ **/unmute <id | @usuario> [motivo]** → Quita mute.\n" +
      "📖 **/setreglamento <platica|contenido>** → Configura el reglamento del grupo.\n\n" +
      "👉 *Nota:* Excepto `/start`, todos estos comandos solo funcionan dentro de los grupos."
      , { parse_mode: "MarkdownV2" }
    );
  }

  const idStr = String(chatId);
  if (gruposAutorizados.has(idStr)) {
    const grupo = gruposActivos.get(idStr);
    return autoDelete(ctx, {
      text:
        `👋 Hola, este bot está activo en el grupo *${grupo?.nombre || "Sin nombre"}*.\n\n` +
        `📊 Usuarios procesados: ${grupo?.usuariosProcesados || 0}\n` +
        `🚫 Usuarios rechazados: ${grupo?.usuariosRechazados || 0}`,
      options: { parse_mode: "MarkdownV2" }
    });
  } else {
    return autoDelete(ctx, {
      text: "⚠️ Este grupo no está en la lista de autorizados.",
      options: {}
    });
  }
});
// --- BLOQUE 9: GBAN y GUNBAN ---
// Función auxiliar para resolver usernames a IDs
async function resolveUserId(ctx, chatId, username) {
  try {
    const targetUsername = username.replace("@", "").toLowerCase();
    const miembro = await ctx.telegram.getChatMember(chatId, targetUsername);
    return miembro?.user?.id || null;
  } catch {
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
        `🚨 *GBAN Federación*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`,
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
        `✅ *GUNBAN Federación*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`,
        { parse_mode: "MarkdownV2" }
      );
    } catch (err) {
      console.error(`❌ Error al desbanear en grupo ${chatId}:`, err.message);
    }
  }
});
// --- BLOQUE 10: Comando /setreglamento ---
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

  return ctx.reply(`✅ El reglamento del grupo ahora está configurado como: *${tipo}*`, { parse_mode: "MarkdownV2" });
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
