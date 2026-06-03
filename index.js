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
    const data = fs.readFileSync(FILE_GRUPOS, "utf8");
    const grupos = JSON.parse(data);

    grupos.forEach(grupo => {
      const idStr = String(grupo.id);
      gruposActivos.set(idStr, { ...grupo, id: idStr });
      gruposAutorizados.add(idStr);
    });

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
  if (/^[\p{P}]+$/u.test(limpio)) return true;
  if (/^[\p{S}]+$/u.test(limpio)) return true;
  if (/^\p{Emoji}+$/u.test(limpio)) return true;
  if (/^\p{Emoji}[a-zA-Z]$|^[a-zA-Z]\p{Emoji}$/u.test(limpio)) return true;
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
// --- BLOQUE 3: Funciones auxiliares adicionales ---
// --- Función auxiliar: verificar si un usuario es admin del grupo ---
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

// --- BLOQUE 4 + Pausa/Activo: Procesamiento de usuarios que entran directamente ---
async function procesarUsuario(ctx, user) {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;

  // 👇 Si el grupo está pausado, guardar en espera
  if (grupo.pausado) {
    gruposPendientes.set(user.id, { chatId, user });
    console.log(`⏸️ Usuario en espera: ${user.first_name} (${user.id})`);
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.banChatMember(chatId, user.id);
      actualizarGrupo(chatId, 0, 1);
      console.log(`❌ Usuario rechazado: ${user.first_name} ${username} (${user.id})`);
      autoDelete(ctx, `🚫 Usuario rechazado: *${user.first_name}* ${username} (ID: ${user.id})`);
    } catch (err) {
      console.error(`❌ Error al expulsar usuario inválido: ${err.message}`);
    }
    return;
  }

  if (usuariosProcesados.has(user.id)) {
    console.log(`ℹ️ Usuario ya procesado: ${user.first_name} ${username} (${user.id})`);
    return;
  }

  usuariosProcesados.add(user.id);
  actualizarGrupo(chatId, 1, 0);
  console.log(`✅ Usuario procesado: ${user.first_name} ${username} (${user.id})`);

  autoDelete(ctx, {
    text: `👋 Bienvenido *${user.first_name}* ${username} (ID: ${user.id}) al grupo *${grupo.nombre}*!`,
    options: {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚨 Banear", callback_data: `ban_${user.id}` }]
        ]
      }
    }
  });
}

// --- BLOQUE NUEVO: Pausar ingreso de usuarios ---
bot.command('pausar', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

  grupo.pausado = true; // 👈 marcar grupo como pausado
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  return ctx.reply("⏸️ El ingreso de nuevos usuarios ha sido pausado. Los usuarios quedarán en espera.");
});

// --- BLOQUE NUEVO: Reanudar ingreso de usuarios ---
bot.command('activo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo) {
    return ctx.reply("⚠️ Este grupo no está autorizado.");
  }

  grupo.pausado = false; // 👈 quitar pausa
  gruposActivos.set(chatId, grupo);
  guardarGrupos();

  // 👇 Procesar automáticamente los usuarios en espera de este grupo
  for (const [userId, pendiente] of gruposPendientes.entries()) {
    if (pendiente.chatId === chatId) {
      try {
        await ctx.telegram.approveChatJoinRequest(chatId, Number(userId));
        actualizarGrupo(chatId, 1, 0);
        console.log(`▶️ Usuario ${userId} reanudado en grupo ${grupo.nombre}`);
        autoDelete(ctx, `👋 Usuario (ID: ${userId}) fue admitido tras reanudar el grupo.`);
      } catch (err) {
        console.error(`❌ Error al procesar usuario en espera ${userId}:`, err.message);
      }
      gruposPendientes.delete(userId); // limpiar de la lista de espera
    }
  }

  return ctx.reply("▶️ El ingreso de nuevos usuarios ha sido reanudado. Se continúa con el proceso de aceptación.");
});

// --- BLOQUE ÚNICO: Manejo de solicitudes de unión con validación y reglamento ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo || !gruposAutorizados.has(chatId)) {
    console.log(`⚠️ Solicitud en grupo no autorizado: ${chatId}`);
    return;
  }

  // 👇 Si el grupo está pausado, guardar en espera
  if (grupo.pausado) {
    const user = ctx.chatJoinRequest.from;
    gruposPendientes.set(user.id, { chatId, user });
    console.log(`⏸️ Solicitud en espera: ${user.first_name} (${user.id})`);
    return autoDelete(ctx, `⏸️ Usuario *${user.first_name}* quedó en espera porque el grupo está pausado.`);
  }

  const user = ctx.chatJoinRequest.from;
  const username = user.username ? `@${user.username}` : "(sin username)";
  console.log(`📩 Nueva solicitud: ${user.first_name} ${username} (${user.id}) en grupo ${grupo.nombre}`);

  if (nombreInvalido(user.first_name)) {
    await ctx.declineChatJoinRequest(user.id);
    actualizarGrupo(chatId, 0, 1);
    autoDelete(ctx, `🚫 Usuario *${user.first_name}* ${username} (ID: ${user.id}) fue rechazado por nombre inválido.`);
    return;
  }

  const mensajeReglamento =
    `👋 Hola *${user.first_name}*!\n\n` +
    `Propósito del grupo:\nEste grupo es para platicar y conocer personas, relajarse como en una cantina, encontrar todo tipo de gente y en ocasiones pláticas polémicas. No es un chat XXX ni para buscar sexo explícitamente.\n\n` +
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
    await ctx.telegram.sendMessage(user.id, mensajeReglamento, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Acepto", callback_data: `acepto_${chatId}_${user.id}` }],
          [{ text: "❌ No acepto", callback_data: `rechazo_${chatId}_${user.id}` }]
        ]
      }
    });
  } catch (err) {
    console.error("❌ No se pudo enviar mensaje privado:", err.message);
    autoDelete(ctx, {
      text: mensajeReglamento,
      options: {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Acepto", callback_data: `acepto_${chatId}_${user.id}` }],
            [{ text: "❌ No acepto", callback_data: `rechazo_${chatId}_${user.id}` }]
          ]
        }
      }
    });
  }
});

// --- BLOQUE ÚNICO: Manejo de aceptación/rechazo y botón Ban ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("acepto_")) {
    const [ , chatId, userIdStr ] = data.split("_");
    const userId = Number(userIdStr); // 👈 conversión necesaria
    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    actualizarGrupo(chatId, 1, 0);
    await ctx.answerCbQuery("✅ Has aceptado el reglamento. Bienvenido!");
    autoDelete(ctx, `👋 Bienvenido al grupo! (ID: ${userId})`);
  }

  if (data.startsWith("rechazo_")) {
    const [ , chatId, userIdStr ] = data.split("_");
    const userId = Number(userIdStr); // 👈 conversión necesaria
    await ctx.telegram.declineChatJoinRequest(chatId, userId);
    actualizarGrupo(chatId, 0, 1);
    await ctx.answerCbQuery("❌ Has rechazado el reglamento. No podrás ingresar.");
    autoDelete(ctx, `🚫 Usuario (ID: ${userId}) rechazó el reglamento.`);
  }

  if (data.startsWith("ban_")) {
    const userId = Number(data.split("_")[1]); // 👈 también convertido a número
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

// --- BLOQUE 5: Middleware de autorización ---
// (pendiente de implementar si necesitas validaciones adicionales)

// --- BLOQUE 6: Autenticación de grupos ---
// (pendiente de implementar si quieres password o token)

// --- BLOQUE 7: Limpieza de grupos ---
bot.command('delgrupo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (gruposActivos.has(chatId)) {
    gruposActivos.delete(chatId);
    gruposAutorizados.delete(chatId);
    guardarGrupos();
    return ctx.reply("🗑️ Grupo eliminado de la lista de autorizados.");
  } else {
    return ctx.reply("⚠️ Este grupo no estaba autorizado.");
  }
});

// --- BLOQUE 8: Comandos administrativos ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  console.log("➡️ /start recibido en chat:", chatId);

  if (gruposAutorizados.has(chatId)) {
    const grupo = gruposActivos.get(chatId);
    return ctx.reply(
      `👋 Hola, este bot está activo en el grupo *${grupo?.nombre || "Sin nombre"}*.\n\n` +
      `📊 Usuarios procesados: ${grupo?.usuariosProcesados}\n` +
      `🚫 Usuarios rechazados: ${grupo?.usuariosRechazados}`
    );
  } else {
    return ctx.reply("⚠️ Este grupo no está en la lista de autorizados.");
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

  // 🚨 Ban global en todos los grupos activos
  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      console.log(`🚨 Usuario ${userId} baneado en grupo: ${grupo.nombre} (${chatId})`);

      const sent = await ctx.telegram.sendMessage(
        chatId,
        `🚨 *GBAN de Federación*\n🆔 ID Usuario: ${userId} ${username}\n🏷️ Grupo: ${grupo.nombre} (ID: ${chatId})\n📝 Motivo: ${motivo}`,
        { parse_mode: "Markdown" }
      );

      // ⏱️ Borrar el mensaje en cada grupo después de 3 minutos
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(chatId, sent.message_id);
          console.log(`🗑️ Mensaje de GBAN eliminado en grupo ${grupo.nombre} (${chatId})`);
        } catch (err) {
          console.error(`❌ Error al borrar mensaje en grupo ${chatId}:`, err.message);
        }
      }, 180000); // 180000 ms = 3 minutos

    } catch (err) {
      console.error(`❌ Error al banear en grupo ${chatId}:`, err.message);
    }
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

// --- BLOQUE FINAL: Cierre y despliegue ---
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

console.log("✅ Bot inicializado correctamente con Webhook en Railway.");

