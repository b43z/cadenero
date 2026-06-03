// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf, Markup } = require('telegraf'); // ✅ CORREGIDO
const fs = require('fs');
const express = require('express');
const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';

const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();
const mensajesActivos = new Map(); // chatId -> último message_id
const warns = new Map(); // sistema de warns

const estadisticasUsuarios = new Map(); // ✅ CORREGIDO: ahora existe
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
  if (/^\p{Extended_Pictographic}+$/u.test(limpio)) return true;
  if (/^\p{Extended_Pictographic}[a-zA-Z]$|^[a-zA-Z]\p{Extended_Pictographic}$/u.test(limpio)) return true;
  if (/(.)\1{2,}/.test(limpio)) return true;
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
      const anterior = mensajesActivos.get(chatId);
      ctx.deleteMessage(anterior).catch(() => {});
    }
    mensajesActivos.set(chatId, sent.message_id);
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      mensajesActivos.delete(chatId);
    }, 240000);
  });
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

async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return miembro.status === "administrator" || miembro.status === "creator";
  } catch {
    return false;
  }
}

// --- BLOQUE 4: Procesamiento de usuarios directos ---
async function procesarUsuario(ctx, user) {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;
  const claveUsuario = `${chatId}-${user.id}`;

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "directo" });
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.banChatMember(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      autoDelete(ctx, `🚫 Usuario rechazado: *${user.first_name}* (ID: ${user.id})`);
    } catch {}
    return;
  }

  if (usuariosProcesados.has(claveUsuario)) return;
  usuariosProcesados.add(claveUsuario);
  actualizarGrupo(chatId, 1, 0);

  autoDelete(ctx, {
    text: `👋 Bienvenido *${user.first_name}* (ID: ${user.id}) al grupo *${grupo.nombre}*!`,
    options: {
      parse_mode: "Markdown",
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
  return ctx.reply("⏸️ El ingreso de nuevos usuarios ha sido pausado. Los usuarios quedarán en espera.");
});

bot.command('activo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return ctx.reply("⚠️ Este grupo no está autorizado.");
  grupo.pausado = false;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();
  for (const [userId, pendiente] of gruposPendientes.entries()) {
    if (pendiente.chatId === chatId) {
      try {
        if (pendiente.tipo === "directo") {
          actualizarGrupo(chatId, 1, 0);
          autoDelete(ctx, `👋 Usuario (ID: ${userId}) fue admitido tras reanudar el grupo.`);
        } else if (pendiente.tipo === "solicitud") {
          await ctx.telegram.approveChatJoinRequest(chatId, Number(userId));
          actualizarGrupo(chatId, 1, 0);
          autoDelete(ctx, `👋 Usuario (ID: ${userId}) fue admitido tras reanudar el grupo.`);
        }
      } catch {}
      gruposPendientes.delete(userId);
    }
  }
  return ctx.reply("▶️ El ingreso de nuevos usuarios ha sido reanudado.");
});

// --- BLOQUE 6: Manejo de solicitudes de unión con reglamento ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo || !gruposAutorizados.has(chatId)) return;

  const user = ctx.chatJoinRequest.from;
  const claveUsuario = `${chatId}-${user.id}`;

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "solicitud" });
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  if (nombreInvalido(user.first_name)) {
    await ctx.telegram.declineChatJoinRequest(chatId, user.id);
    actualizarGrupo(chatId, 0, 1);
    return autoDelete(ctx, `🚫 Usuario *${user.first_name}* fue rechazado por nombre inválido.`);
  }

  if (usuariosProcesados.has(claveUsuario)) return;

  const mensajeReglamento =
    `👋 Hola *${user.first_name}*!\n\n` +
    `Propósito del grupo:\nEste grupo es para platicar, conocer personas, y relajarse tirando cotorreo y carrilla, aveces se pone intensa la platica y pueden ponerse cachondas las cosas pero SI BUSCAS UN GRUPO XXX, PLATICAS HOT AQUI NO ES...\n\n` +
    `📖 REGLAMENTO\n` +
    `💀 No mandar fotopitos al grupo\n` +
    `☠️ Si Mandas Material +18 procura que sea tuyo y ten en cuenta que se borra pasados unos minutos\n` +
    `💀 Si no estás activo con regularidad serás expulsado\n` +
    `☠️ No se permite morbo, chantajes ni hackeos, fotopitos por error, nv x nv, cambios etc \n` +
    `☠️ Prohibido compartir links o pedir grupos (ban automático)\n` +
    `☠️ Ser mayor de edad (+18)\n` +
    `☠️ Prohibido CP y materiales ilegales\n` +
    `🚨 Si vendes contenido pregunta si puedes y verifícate con un adm antes de publicar o seras expulsada\n` +
    `🚨 Si compras contenido es bajo tu riesgo y responsabilidad, el grupo no interviene en las transacciones, si tienes un proble reporta y un admi puede intervenir mas no obligar a que entreguen contenido o reenvolso alguno\n` +
    `☠️ No acosar en privado o solicitarlos a cada momento\n` +
    `☠️ No estés de preguntón si no vas a comprar\n\n` +
    `¿Aceptas el reglamento para ingresar?`;

  try {
    await ctx.telegram.sendMessage(user.id, mensajeReglamento, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Acepto", callback_data: `acepto|${chatId}|${user.id}` }],
          [{ text: "❌ No acepto", callback_data: `rechazo|${chatId}|${user.id}` }]
        ]
      }
    });
  } catch {
    autoDelete(ctx, {
      text: mensajeReglamento,
      options: {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Acepto", callback_data: `acepto|${chatId}|${user.id}` }],
            [{ text: "❌ No acepto", callback_data: `rechazo|${chatId}|${user.id}` }]
          ]
        }
      }
    });
  }
});

// --- BLOQUE 7: Manejo de callback_query (unificado) ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("acepto|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);
    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    await ctx.answerCbQuery("✅ Has aceptado el reglamento.", { show_alert: true });
    await ctx.telegram.sendMessage(chatId, `👋 Bienvenido (ID: ${userId}) al grupo!`, { parse_mode: "Markdown" });
  }

  if (data.startsWith("rechazo|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);
    await ctx.telegram.declineChatJoinRequest(chatId, userId);
    await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    await ctx.answerCbQuery("❌ Has rechazado el reglamento.", { show_alert: true });
    await ctx.telegram.sendMessage(chatId, `🚫 Usuario (ID: ${userId}) rechazó el reglamento.`, { parse_mode: "Markdown" });
  }

  if (data.startsWith("ban|")) {
    const userId = Number(data.split("|")[1]);
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
    if (!esAdmin) return ctx.answerCbQuery("❌ Solo administradores pueden usar este botón.", { show_alert: true });
    await ctx.telegram.banChatMember(ctx.chat.id, userId);
    await ctx.editMessageText("🚨 Usuario baneado por administrador.");
  }

  if (data.startsWith("delmsg:")) {
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
    if (!esAdmin) return ctx.answerCbQuery("❌ Solo administradores pueden borrar mensajes.");
    await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    ctx.answerCbQuery("🗑️ Mensaje borrado.");
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
      "ℹ️ **/info <id | @usuario>** → Muestra información del usuario y los grupos donde está.\n" +
      "⏸️ **/pausar** → Pausa el ingreso de nuevos usuarios en el grupo.\n" +
      "▶️ **/activo** → Reanuda el ingreso de usuarios en espera.\n" +
      "🚨 **/gban <id | @usuario> [motivo]** → Ban global en todos los grupos activos (solo administradores).\n" +
      "✅ **/gunban <id | @usuario> [motivo]** → Quita el ban global en todos los grupos activos.\n" +
      "🚫 **/ban <id | @usuario> [motivo]** → Ban local en el grupo actual.\n" +
      "✅ **/unban <id_usuario> [motivo]** → Quita el ban local en el grupo actual.\n" +
      "⚠️ **/warn <id | @usuario> [motivo]** → Asigna un warn al usuario (3 warns = ban automático).\n" +
      "✅ **/unwarn <id_usuario> [motivo]** → Elimina los warns de un usuario.\n" +
      "🔇 **/mute <id | @usuario> [motivo]** → Silencia al usuario en el grupo.\n" +
      "✅ **/unmute <id | @usuario> [motivo]** → Quita el mute al usuario.\n\n" +
      "👉 *Nota:* Excepto `/start`, todos estos comandos **solo funcionan dentro de los grupos de la federación**."
      , { parse_mode: "Markdown" }
    );
  }

  // Caso normal: cuando se ejecuta en un grupo
  const idStr = String(chatId);
  if (gruposAutorizados.has(idStr)) {
    const grupo = gruposActivos.get(idStr);
    return autoDelete(ctx, {
      text:
        `👋 Hola, este bot está activo en el grupo *${grupo?.nombre || "Sin nombre"}*.\n\n` +
        `📊 Usuarios procesados: ${grupo?.usuariosProcesados}\n` +
        `🚫 Usuarios rechazados: ${grupo?.usuariosRechazados}`,
      options: { parse_mode: "Markdown" }
    });
  } else {
    return autoDelete(ctx, {
      text: "⚠️ Este grupo no está en la lista de autorizados.",
      options: {}
    });
  }
});

// --- BLOQUE EXTRA: Middleware para comandos en privado ---
bot.use((ctx, next) => {
  if (ctx.chat.type === "private" && ctx.message && ctx.message.text) {
    const comando = ctx.message.text.split(" ")[0];
    if (comando.startsWith("/") && comando !== "/start") {
      return ctx.reply("⚠️ Este comando solo puede usarse dentro de los grupos de la federación.");
    }
  }
  return next();
});



// --- BLOQUE 9: GBAN y GUNBAN ---
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
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/gban <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      const miembro = await ctx.telegram.getChatMember(chatId, userId).catch(() => null);
      if (!miembro) continue;
      await ctx.telegram.banChatMember(chatId, userId);
      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🚨 *GBAN Federación*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`,
        { parse_mode: "Markdown" }
      );
      setTimeout(() => ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {}), 180000);
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
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId && !username) return ctx.reply("⚠️ Uso: `/gunban <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      if (userId) {
        await ctx.telegram.unbanChatMember(chatId, userId);
        await ctx.telegram.sendMessage(
          chatId,
          `✅ *GUNBAN Federación*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🗑️ Borrar", callback_data: "delmsg" }]]
            }
          }
        );
      }
      if (username) {
        await ctx.telegram.sendMessage(
          chatId,
          `✅ *GUNBAN Federación*\n👤 Usuario: ${username}\n🏷️ Grupo: ${grupo.nombre}\n📝 Motivo: ${motivo}\n⚠️ Nota: requiere ID numérico.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🗑️ Borrar", callback_data: "delmsg" }]]
            }
          }
        );
      }
    } catch (err) {
      console.error(`❌ Error al desbanear en grupo ${chatId}:`, err.message);
    }
  }
});

// --- BLOQUE 10: Comandos adicionales ---
// --- BLOQUE EXTRA: Comando /info ---
bot.command('info', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return ctx.reply("❌ Solo los administradores pueden usar este comando.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  let userId, username = "";

  if (args[0]) {
    if (/^\d+$/.test(args[0])) {
      userId = Number(args[0]);
    } else if (args[0].startsWith("@")) {
      username = args[0].replace("@", "");
    }
  }

  if (!userId && !username) {
    return ctx.reply("⚠️ Uso: `/info <id_usuario | @usuario>`", { parse_mode: "Markdown" });
  }

  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

  try {
    let miembro;
    if (userId) {
      miembro = await ctx.telegram.getChatMember(chatId, userId).catch(() => null);
    } else if (username) {
      miembro = await ctx.telegram.getChatMember(chatId, username).catch(() => null);
    }

    if (!miembro) {
      return ctx.reply("ℹ️ Usuario no encontrado en este grupo.");
    }

    // 🔎 Buscar estadísticas de actividad si existen
    const claveUsuario = `${chatId}:${miembro.user.id}`;
    let ultimaActividad = "(sin registro)";
    let tiempoInactivo = "(sin registro)";

    if (estadisticasUsuarios && estadisticasUsuarios.has(claveUsuario)) {
      const datos = estadisticasUsuarios.get(claveUsuario);
      ultimaActividad = datos.ultimaActividad.toLocaleString();
      const ahora = new Date();
      const diffMs = ahora - datos.ultimaActividad;
      const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      tiempoInactivo = `${diffDias} día(s)`;
    }

    const infoCompilada =
      `📌 *Información de Usuario*\n\n` +
      `🆔 ID: ${miembro.user.id}\n` +
      `👤 Nombre: ${miembro.user.first_name || ""} ${miembro.user.last_name || ""}\n` +
      `🔖 Username: ${miembro.user.username ? `@${miembro.user.username}` : "(sin username)"}\n` +
      `🌐 Grupo: ${grupo.nombre} (ID: ${chatId})\n` +
      `📅 Fecha de ingreso: ${grupo.fechaInicio}\n` +
      `🕒 Último mensaje: ${ultimaActividad}\n` +
      `⏳ Días de inactividad: ${tiempoInactivo}`;

    return ctx.reply(infoCompilada, { parse_mode: "Markdown" });

  } catch (err) {
    console.error(`❌ Error al obtener info en grupo ${chatId}:`, err.message);
    return ctx.reply("❌ Error al obtener la información del usuario.");
  }
});

//COMANDO BAN
bot.command('ban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id; username = target.username ? `@${target.username}` : "";
  } else if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/ban <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  try {
    await ctx.telegram.banChatMember(ctx.chat.id, userId);
    await ctx.reply(`🚨 *BAN Local*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}`, { parse_mode: "Markdown" });
  } catch (err) {
    ctx.reply(`❌ Error al banear: ${err.message}`);
  }
});

bot.command('unban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado";
  if (args[0] && /^\d+$/.test(args[0])) userId = Number(args[0]);
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/unban <id_usuario> [motivo]`", { parse_mode: "Markdown" });

  try {
    await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
    await ctx.reply(`✅ *UNBAN Local*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}`, { parse_mode: "Markdown" });
  } catch (err) {
    ctx.reply(`❌ Error al desbanear: ${err.message}`);
  }
});

bot.command('warn', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id; username = target.username ? `@${target.username}` : "";
  } else if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/warn <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  const chatId = String(ctx.chat.id);
  if (!warns.has(chatId)) warns.set(chatId, new Map());
  const grupoWarns = warns.get(chatId);

  const userWarn = grupoWarns.get(userId) || { count: 0, motivos: [] };
  userWarn.count += 1;
  userWarn.motivos.push(motivo);
  grupoWarns.set(userId, userWarn);

  await ctx.reply(`⚠️ *WARN Local*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}\n📊 Total Warns: ${userWarn.count}`, { parse_mode: "Markdown" });

  if (userWarn.count >= 3) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      await ctx.reply(`🚨 Usuario ${userId} ${username} baneado automáticamente por acumular ${userWarn.count} warns.`, { parse_mode: "Markdown" });
      grupoWarns.delete(userId);
    } catch (err) {
      console.error(`❌ Error al banear automáticamente:`, err.message);
    }
  }
});

bot.command('unwarn', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado";
  if (args[0] && /^\d+$/.test(args[0])) userId = Number(args[0]);
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/unwarn <id_usuario> [motivo]`", { parse_mode: "Markdown" });

  const chatId = String(ctx.chat.id);
  if (!warns.has(chatId)) warns.set(chatId, new Map());
  const grupoWarns = warns.get(chatId);

  if (userId && grupoWarns.has(userId)) {
    grupoWarns.delete(userId);
    await ctx.reply(`✅ *UNWARN Local*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}\n📊 Warns reiniciados.`, { parse_mode: "Markdown" });
  } else {
    ctx.reply("ℹ️ No se encontraron warns activos para este usuario.");
  }
});

bot.command('mute', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id; username = target.username ? `@${target.username}` : "";
  } else if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) return ctx.reply("⚠️ Uso: `/mute <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    });

    await ctx.reply(
      `🔇 *MUTE Local*\n🆔 Usuario: ${userId} ${username}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    ctx.reply(`❌ Error al mutear: ${err.message}`);
  }
});

bot.command('unmute', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return ctx.reply("❌ Solo los administradores pueden usar este comando.");

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado", username = "";

  if (args[0]) {
    if (/^\d+$/.test(args[0])) userId = Number(args[0]);
    else if (args[0].startsWith("@")) username = args[0];
  }
  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId && !username) return ctx.reply("⚠️ Uso: `/unmute <id_usuario | @usuario> [motivo]`", { parse_mode: "Markdown" });

  try {
    if (userId) {
      await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true
        }
      });

      await ctx.reply(
        `✅ *UNMUTE Local*\n🆔 Usuario: ${userId}\n🏷️ Grupo: ${ctx.chat.title}\n📝 Motivo: ${motivo}`,
        { parse_mode: "Markdown" }
      );
    } else {
      ctx.reply("⚠️ El unmute requiere ID numérico.");
    }
  } catch (err) {
    ctx.reply(`❌ Error al desmutear: ${err.message}`);
  }
});

// --- BLOQUE 11: Configuración de Webhook ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL;
if (!URL || !process.env.BOT_TOKEN) {
  console.error("❌ Error: Falta configurar WEBHOOK_URL o BOT_TOKEN.");
  process.exit(1);
}
bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));
app.get('/', (req, res) => res.send('✅ Bot corriendo con Webhook en Railway'));
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en puerto ${PORT}`));

// --- BLOQUE FINAL: Manejo de errores globales ---
process.on('uncaughtException', (err) => console.error('❌ Error no capturado:', err));
process.on('unhandledRejection', (reason) => console.error('❌ Promesa rechazada:', reason));
console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
