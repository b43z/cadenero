// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf } = require('telegraf');
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

const FILE_GRUPOS = 'gruposActivos.json';

async function guardarGrupos() {
  try {
    // Convertir todas las claves a string antes de guardar
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
    console.log("🔎 gruposAutorizados contiene:", [...gruposAutorizados]);
  } catch (error) {
    console.error("❌ Error al cargar grupos:", error);
  }
}
cargarGrupos();
// --- BLOQUE 2: Validaciones y utilidades ---
const mensajesActivos = new Map(); // chatId -> último message_id

function nombreInvalido(nombre) {
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();

  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;
  if (limpio.length < 3) return true;
  if (/^\d+$/.test(limpio)) return true;
  if (/^[\p{P}]+$/u.test(limpio)) return true; // solo puntuación
  if (/^[\p{S}]+$/u.test(limpio)) return true; // solo símbolos
  if (/^\p{Extended_Pictographic}+$/u.test(limpio)) return true; // solo emojis
  if (/^\p{Extended_Pictographic}[a-zA-Z]$|^[a-zA-Z]\p{Extended_Pictographic}$/u.test(limpio)) return true; // emoji + letra
  if (/(.)\1{2,}/.test(limpio)) return true; // repeticiones excesivas

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
      ctx.deleteMessage(anterior).catch(err => {
        console.error("❌ Error al borrar mensaje anterior:", err.message);
      });
    }

    mensajesActivos.set(chatId, sent.message_id);

    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(err => {
        console.error("❌ Error al borrar mensaje automático:", err.message);
      });
      mensajesActivos.delete(chatId);
    }, 240000); // 4 minutos
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
// --- BLOQUE 3: Funciones auxiliares adicionales ---
async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return (
      miembro.status === "administrator" ||
      miembro.status === "creator"
    );
  } catch (err) {
    console.error("❌ Error al verificar admin:", err.message);
    return false;
  }
}
// --- BLOQUE 4: Procesamiento de usuarios que entran directamente ---
async function procesarUsuario(ctx, user) {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;

  const claveUsuario = `${chatId}-${user.id}`;

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "directo" });
    console.log(`⏸️ Usuario en espera: ${user.first_name} (${user.id})`);
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      const botMember = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
      if (!botMember.can_restrict_members) {
        console.error("❌ El bot no tiene permisos para banear en este grupo.");
        return;
      }
      await ctx.telegram.banChatMember(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      console.log(`❌ Usuario rechazado: ${user.first_name} ${username} (${user.id})`);
      autoDelete(ctx, `🚫 Usuario rechazado: *${user.first_name}* ${username} (ID: ${user.id})`);
    } catch (err) {
      console.error(`❌ Error al expulsar usuario inválido: ${err.message}`);
    }
    return;
  }

  if (usuariosProcesados.has(claveUsuario)) {
    console.log(`ℹ️ Usuario ya procesado: ${user.first_name} ${username} (${user.id}) en grupo ${chatId}`);
    return;
  }

  usuariosProcesados.add(claveUsuario);
  actualizarGrupo(chatId, 1, 0);
  console.log(`✅ Usuario procesado: ${user.first_name} ${username} (${user.id})`);

  autoDelete(ctx, {
    text: `👋 Bienvenido *${user.first_name}* ${username} (ID: ${user.id}) al grupo *${grupo.nombre}*!`,
    options: {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚨 Banear", callback_data: `ban|${user.id}` }]
        ]
      }
    }
  });
}
// --- BLOQUE 5: Pausar ingreso de usuarios ---
bot.command('pausar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

  grupo.pausado = true;
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  return ctx.reply("⏸️ El ingreso de nuevos usuarios ha sido pausado. Los usuarios quedarán en espera.");
});

// --- BLOQUE 5: Reanudar ingreso de usuarios ---
bot.command('activo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

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
          console.log(`▶️ Usuario ${userId} reanudado en grupo ${grupo.nombre}`);
          autoDelete(ctx, `👋 Usuario (ID: ${userId}) fue admitido tras reanudar el grupo.`);
        }
      } catch (err) {
        console.error(`❌ Error al procesar usuario en espera ${userId}:`, err.message);
      }
      gruposPendientes.delete(userId);
    }
  }

  return ctx.reply("▶️ El ingreso de nuevos usuarios ha sido reanudado. Se continúa con el proceso de aceptación.");
});

// --- BLOQUE 6: Manejo de solicitudes de unión con validación y reglamento ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo || !gruposAutorizados.has(chatId)) {
    console.log(`⚠️ Solicitud en grupo no autorizado: ${chatId}`);
    return;
  }

  const user = ctx.chatJoinRequest.from;
  const claveUsuario = `${chatId}-${user.id}`;

  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user, tipo: "solicitud" });
    console.log(`⏸️ Solicitud en espera: ${user.first_name} (${user.id})`);
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  const username = user.username ? `@${user.username}` : "(sin username)";
  console.log(`📩 Nueva solicitud: ${user.first_name} ${username} (${user.id}) en grupo ${grupo.nombre}`);

  if (nombreInvalido(user.first_name)) {
    await ctx.telegram.declineChatJoinRequest(chatId, user.id);
    actualizarGrupo(chatId, 0, 1);
    autoDelete(ctx, `🚫 Usuario *${user.first_name}* ${username} (ID: ${user.id}) fue rechazado por nombre inválido.`);
    return;
  }

  if (usuariosProcesados.has(claveUsuario)) {
    console.log(`ℹ️ Solicitud ya procesada: ${user.first_name} ${username} (${user.id}) en grupo ${chatId}`);
    return;
  }

  const mensajeReglamento =
    `👋 Hola *${user.first_name}*!\n\n` +
    `Propósito del grupo:\nEste grupo es para platicar, conocer personas, y relajarse tirando cotorreo y carrilla...\n\n` +
    `📖 REGLAMENTO\n` +
    `💀 No mandar fotopitos al grupo\n` +
    `💀 Si no estás activo con regularidad serás expulsado\n` +
    `☠️ No se permite morbo, chantaje ni hackeos\n` +
    `☠️ Prohibido compartir links (ban automático)\n` +
    `☠️ Ser mayor de edad (+18)\n` +
    `☠️ Prohibido CP y materiales ilegales\n` +
    `🚨 Si vendes contenido verifícate con un adm\n` +
    `☠️ No acosar en privado\n` +
    `☠️ No estés de preguntón si no vas a comprar\n\n` +
    `¿Aceptas el reglamento para ingresar?`;

  try {
    // Intentar enviar SIEMPRE al privado del usuario
    await ctx.telegram.sendMessage(user.id, mensajeReglamento, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Acepto", callback_data: `acepto|${chatId}|${user.id}` }],
          [{ text: "❌ No acepto", callback_data: `rechazo|${chatId}|${user.id}` }]
        ]
      }
    });
    console.log(`📤 Reglamento enviado al privado de ${user.first_name} (${user.id})`);
  } catch (err) {
    console.error("❌ No se pudo enviar mensaje privado:", err.message);
    // Si falla, mostrarlo en el grupo como fallback
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

// --- BLOQUE 7: Manejo de aceptación/rechazo y botón Ban ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("acepto|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);

    try {
      await ctx.telegram.approveChatJoinRequest(chatId, userId);

      // Borra el mensaje en el chat privado
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);

      // Cierra el popup del botón y fuerza que el chat quede en primer plano
      await ctx.answerCbQuery("✅ Has aceptado el reglamento. Bienvenido!", { show_alert: true });

      // Mensaje en el grupo confirmando ingreso
      await ctx.telegram.sendMessage(
        chatId,
        `👋 Bienvenido *${ctx.from.first_name}* (ID: ${userId}) al grupo!`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("❌ Error al aprobar solicitud:", err.message);
    }
  }

  if (data.startsWith("rechazo|")) {
    const [ , chatId, userIdStr ] = data.split("|");
    const userId = Number(userIdStr);

    try {
      await ctx.telegram.declineChatJoinRequest(chatId, userId);

      // Borra el mensaje en el chat privado
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);

      // Cierra el popup del botón y fuerza que el chat quede en primer plano
      await ctx.answerCbQuery("❌ Has rechazado el reglamento. No podrás ingresar.", { show_alert: true });

      // Mensaje en el grupo confirmando rechazo
      await ctx.telegram.sendMessage(
        chatId,
        `🚫 Usuario (ID: ${userId}) rechazó el reglamento.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("❌ Error al rechazar solicitud:", err.message);
    }
  }

  if (data.startsWith("ban|")) {
    const userId = Number(data.split("|")[1]);
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);

    if (!esAdmin) {
      return ctx.answerCbQuery("❌ Solo administradores pueden usar este botón.", { show_alert: true });
    }

    try {
      await ctx.telegram.banChatMember(ctx.chat.id, userId);
      await ctx.editMessageText("🚨 Usuario baneado por administrador.");
    } catch (err) {
      await ctx.answerCbQuery(`❌ Error al banear: ${err.message}`, { show_alert: true });
    }
  }
});

// --- BLOQUE 8: Comando /start ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  console.log("➡️ /start recibido en chat:", chatId);
  console.log("🔎 gruposAutorizados actuales:", [...gruposAutorizados]);

  if (ctx.chat.type === "private") {
    return ctx.reply(
      "✅ El bot se ha iniciado correctamente.\n\n" +
      "📋 **Menú de Comandos Disponibles**\n\n" +
      "⚡ **/start** → Inicia el bot y muestra este menú.\n" +
      "⏸️ **/pausar** → Pausa el ingreso de nuevos usuarios en el grupo.\n" +
      "▶️ **/activo** → Reanuda el ingreso de usuarios en espera.\n" +
      "🚨 **/gban <id | @usuario> [motivo]** → Ban global en todos los grupos activos (solo administradores).\n\n" +
      "👉 Usa estos comandos dentro de los grupos para gestionar usuarios y la federación."
      , { parse_mode: "Markdown" }
    );
  }

  // Normalización: asegurar que el chatId esté en formato string
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
    console.warn("⚠️ El grupo no está autorizado. chatId:", idStr);
    return autoDelete(ctx, {
      text: "⚠️ Este grupo no está en la lista de autorizados.",
      options: {}
    });
  }
});
// --- BLOQUE 9: GBAN y funciones auxiliares ---
bot.command('gban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return ctx.reply("❌ Solo los administradores pueden usar este comando.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado";
  let username = "";

  if (ctx.message.reply_to_message) {
    const target = ctx.message.reply_to_message.from;
    userId = target.id;
    username = target.username ? `@${target.username}` : "";
  } else if (args[0]) {
    if (/^\d+$/.test(args[0])) {
      userId = Number(args[0]);
    } else if (args[0].startsWith("@")) {
      username = args[0];
    }
  }

  if (args.length > 1) motivo = args.slice(1).join(" ");
  if (!userId) {
    return ctx.reply("⚠️ Uso: `/gban <id_usuario | @usuario> [motivo]` o responde al mensaje del usuario.", { parse_mode: "Markdown" });
  }

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      const miembro = await ctx.telegram.getChatMember(chatId, userId).catch(() => null);
      if (!miembro) {
        console.log(`ℹ️ Usuario ${userId} no está en grupo ${grupo.nombre} (${chatId}), se omite ban.`);
        continue;
      }

      await ctx.telegram.banChatMember(chatId, userId);
      console.log(`🚨 Usuario ${userId} baneado en grupo: ${grupo.nombre} (${chatId})`);

      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🚨 *GBAN de Federación*\n🆔 ID Usuario: ${userId} ${username}\n🏷️ Grupo: ${grupo.nombre} (ID: ${chatId})\n📝 Motivo: ${motivo}`,
        { parse_mode: "Markdown" }
      );

      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, sent.message_id);
          console.log(`🗑️ Mensaje de GBAN eliminado en grupo ${grupo.nombre} (${chatId})`);
        } catch (err) {
          console.error(`❌ Error al borrar mensaje en grupo ${chatId}:`, err.message);
        }
      }, 180000);

    } catch (err) {
      console.error(`❌ Error al banear en grupo ${chatId}:`, err.message);
    }
  }
});
// --- BLOQUE 10: Configuración de Webhook para Railway ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL;

if (!URL || !process.env.BOT_TOKEN) {
  console.error("❌ Error: Falta configurar WEBHOOK_URL o BOT_TOKEN en variables de entorno.");
  process.exit(1);
}

bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

app.get('/', (req, res) => {
  res.send('✅ Bot corriendo con Webhook en Railway');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
// --- BLOQUE FINAL: Cierre y despliegue ---
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
