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


// --- BLOQUE 4: Validaciones de nombres ---
function nombreInvalido(nombre) {
  if (!nombre) return true;

  // Solo símbolos o signos
  const soloSimbolos = /^[\p{P}\p{S}]+$/u;

  // Una sola letra
  const unaLetra = /^[A-Za-zÁÉÍÓÚÜÑ]$/u;

  // Letras repetidas (ej: aaa, bbb)
  const letrasRepetidas = /(.)\1{2,}/u;

  // Letra seguida de símbolo (ej: a!)
  const letraMasSimbolo = /^[A-Za-zÁÉÍÓÚÜÑ][\p{P}\p{S}]$/u;

  // Nombres demasiado cortos
  if (nombre.length < 2) return true;

  // Nombres con espacios raros o vacíos
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

    // tipoReglamento puede ser "platica", "contenido", etc.
    const tipo = grupo.tipoReglamento || "default";
    return reglamentos[tipo] || reglamentos["default"];
  } catch (err) {
    console.error("❌ Error al leer reglamentos:", err.message);
    return "📖 Reglamento por defecto: Respeta a los demás miembros.";
  }
}

// --- BLOQUE 5: Manejo de solicitudes de ingreso ---
bot.on('chat_join_request', async (ctx) => {
  try {
    const chatId = String(ctx.chat.id);
    const grupo = gruposActivos.get(chatId);
    if (!grupo || !gruposAutorizados.has(chatId)) return;

    const user = ctx.chatJoinRequest.from;

    // Si el grupo está pausado
    if (grupo.pausado) {
      gruposPendientes.set(user.id, { chatId, user, tipo: "solicitud" });
      return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
    }

    // Validación de nombre inválido
    if (nombreInvalido(user.first_name)) {
      await ctx.telegram.declineChatJoinRequest(chatId, user.id);
      grupo.usuariosRechazados = (grupo.usuariosRechazados || 0) + 1;
      guardarGrupos();
      return autoDelete(ctx, `🚫 Usuario *${user.first_name}* fue rechazado por nombre inválido.`);
    }

    // Intentar enviar reglamento en privado
    const mensajeReglamento = escapeMarkdownV2(obtenerReglamento(chatId)) +
      "\n\n¿Aceptas el reglamento para ingresar?";

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
    console.error("❌ Error al procesar chat_join_request:", err.message);
    const chatId = String(ctx.chat.id);
    const user = ctx.chatJoinRequest.from;

    // Aviso breve en el grupo (no se manda reglamento completo aquí)
    await ctx.telegram.sendMessage(
      chatId,
      `⚠️ Usuario *${user.first_name}* debe abrir chat con el bot (enviar /start en privado) para leer y aceptar el reglamento. 
      Hasta entonces, su solicitud quedará en espera.`,
      { parse_mode: "MarkdownV2" }
    );

    // Guardar en lista de espera
    gruposPendientes.set(user.id, { chatId, user, tipo: "pendiente" });
  }
}); // <-- cierre correcto del bloque



// --- BLOQUE 6: Manejo de botones de aceptación/rechazo y ban ---
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("acepto|")) {
      const [ , chatId, userIdStr ] = data.split("|");
      const userId = Number(userIdStr);
      await ctx.telegram.approveChatJoinRequest(chatId, userId);
      await ctx.answerCbQuery("✅ Has aceptado el reglamento.", { show_alert: true });
      await ctx.telegram.sendMessage(
        chatId,
        `🎉 Usuario *${ctx.from.first_name}* fue aprobado y ya puede ingresar.`,
        { parse_mode: "MarkdownV2" }
      );
    } else if (data.startsWith("rechazo|")) {
      const [ , chatId, userIdStr ] = data.split("|");
      const userId = Number(userIdStr);
      await ctx.telegram.declineChatJoinRequest(chatId, userId);
      await ctx.answerCbQuery("❌ Has rechazado el reglamento.", { show_alert: true });
      await ctx.telegram.sendMessage(
        chatId,
        `🚫 Usuario (ID: ${userId}) rechazó el reglamento.`,
        { parse_mode: "MarkdownV2" }
      );
    } else if (data.startsWith("ban|")) {
      const [ , userIdStr ] = data.split("|");
      const userId = Number(userIdStr);
      try {
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
        await ctx.answerCbQuery("🚨 Usuario baneado.", { show_alert: true });
        await ctx.telegram.sendMessage(
          ctx.chat.id,
          `🚨 Usuario (ID: ${userId}) ha sido baneado.`,
          { parse_mode: "MarkdownV2" }
        );
      } catch (err) {
        console.error("❌ Error al banear:", err.message);
        await ctx.answerCbQuery("❌ Error al banear.", { show_alert: true });
      }
    }
  } catch (err) {
    console.error("❌ Error al procesar callback_query:", err.message);
    await ctx.answerCbQuery("⚠️ Hubo un error al procesar tu respuesta.");
  }
}); // <-- cierre correcto

// --- BLOQUE 8: Comando /start adaptado ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  const esGrupo = ctx.chat.type.endsWith("group");

  // Si es grupo → estadísticas + menú
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

  // Si es privado → solo menú
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

// --- BLOQUE 9: Comando /grupos ---
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

// --- BLOQUE 10: Envío de reglamento en privado ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = ctx.chatJoinRequest.from;

  try {
    const mensajeReglamento = escapeMarkdownV2(obtenerReglamento(chatId)) +
      "\n\n¿Aceptas el reglamento para ingresar?";

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
    console.error("❌ Error al enviar reglamento:", err.message);
  }
});

// --- BLOQUE 11: Callback de aceptación/rechazo ---
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [accion, chatId, userId] = data.split("|");

  try {
    if (accion === "acepto") {
      await ctx.telegram.approveChatJoinRequest(chatId, Number(userId));
      await ctx.deleteMessage(); // borra el mensaje del reglamento
      return ctx.answerCbQuery("✅ Has aceptado el reglamento. Bienvenido al grupo.");
    }

    if (accion === "rechazo") {
      await ctx.telegram.declineChatJoinRequest(chatId, Number(userId));
      await ctx.deleteMessage(); // borra el mensaje del reglamento
      return ctx.answerCbQuery("❌ Has rechazado el reglamento. No podrás ingresar.");
    }
  } catch (err) {
    console.error("❌ Error en callback:", err.message);
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
