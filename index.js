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
const mensajesActivos = new Map(); // chatId -> array de message_id

function nombreInvalido(nombre) {
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();

  // Regla 1: palabras prohibidas
  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;

  // Regla 2: longitud mínima (>=3 caracteres válidos)
  if (limpio.length < 3) return true;

  // Regla 3: solo números
  if (/^\d+$/.test(limpio)) return true;

  // Regla 4: solo puntuación
  if (/^[\p{P}]+$/u.test(limpio)) return true;

  // Regla 5: solo símbolos
  if (/^[\p{S}]+$/u.test(limpio)) return true;

  // Regla 6: solo emojis
  if (/^\p{Emoji}+$/u.test(limpio)) return true;

  // Regla 7: emoji + una sola letra
  if (/^\p{Emoji}[a-zA-Z]$|^[a-zA-Z]\p{Emoji}$/u.test(limpio)) return true;

  // Regla 8: letras repetidas (3+ consecutivas)
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

  // Permite enviar texto simple o texto con opciones (inline keyboard, parse_mode, etc.)
  const sendPromise = typeof mensaje === "string"
    ? ctx.reply(mensaje)
    : ctx.reply(mensaje.text, mensaje.options);

  sendPromise.then(sent => {
    if (!mensajesActivos.has(chatId)) mensajesActivos.set(chatId, []);
    const lista = mensajesActivos.get(chatId);
    lista.push(sent.message_id);

    // Si hay más de 3 mensajes, borra los más antiguos
    while (lista.length > 3) {
      const viejo = lista.shift();
      ctx.deleteMessage(viejo).catch(() => {});
    }

    // Borra este mensaje después de 4 minutos (240000 ms)
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      const idx = lista.indexOf(sent.message_id);
      if (idx !== -1) lista.splice(idx, 1);
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
// --- BLOQUE 4: Procesamiento de usuarios ---
async function procesarUsuario(ctx, user, origen) {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;

  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(user.first_name)) {
    await ctx.kickChatMember(user.id);
    actualizarGrupo(chatId, 0, 1);
    console.log(`❌ Usuario rechazado: ${user.first_name} ${username} (${user.id})`);

    // Mensaje de rechazo (sin botón) autoeliminado
    autoDelete(ctx, `🚫 Usuario rechazado: *${user.first_name}* ${username} (ID: ${user.id})`);
  } else {
    usuariosProcesados.add(user.id);
    actualizarGrupo(chatId, 1, 0);
    console.log(`✅ Usuario procesado: ${user.first_name} ${username} (${user.id})`);

    // Mensaje de bienvenida con botón Ban autoeliminado
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
}
// --- BLOQUE 4B: Manejo de solicitudes de unión con mensajes y botón Ban ---
bot.on('chat_join_request', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);

  if (!grupo || !gruposAutorizados.has(chatId)) {
    console.log(`⚠️ Solicitud en grupo no autorizado: ${chatId}`);
    return;
  }

  const user = ctx.chatJoinRequest.from;
  const username = user.username ? `@${user.username}` : "(sin username)";
  console.log(`📩 Nueva solicitud: ${user.first_name} ${username} (${user.id}) en grupo ${grupo.nombre}`);

  if (nombreInvalido(user.first_name)) {
    await ctx.declineChatJoinRequest(user.id);
    actualizarGrupo(chatId, 0, 1);
    console.log(`❌ Solicitud rechazada: ${user.first_name} ${username} (${user.id})`);

    // Mensaje de rechazo (sin botón) autoeliminado
    autoDelete(ctx, `🚫 Usuario *${user.first_name}* ${username} (ID: ${user.id}) fue rechazado por nombre inválido.`);
  } else {
    await ctx.approveChatJoinRequest(user.id);
    usuariosProcesados.add(user.id);
    actualizarGrupo(chatId, 1, 0);
    console.log(`✅ Solicitud aprobada: ${user.first_name} ${username} (${user.id})`);

    // Mensaje de bienvenida con botón Ban autoeliminado
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
});

// --- BLOQUE EXTRA: Callback del botón Ban ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("ban_")) {
    const userId = parseInt(data.split("_")[1]);
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

// --- BLOQUE 6: Autenticación de grupos ---

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
// Comando START
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
// --- BLOQUE 9: GBAN y funciones auxiliares ---
async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

bot.command('gban', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return autoDelete(ctx, "❌ Solo los administradores pueden usar este comando.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  let userId, motivo = "Sin motivo especificado";
  let nombreUsuario = "(desconocido)";

  // 1️⃣ Si se responde a un mensaje
  if (ctx.message.reply_to_message) {
    userId = ctx.message.reply_to_message.from.id;
    nombreUsuario = ctx.message.reply_to_message.from.first_name || "(sin nombre)";
  } else if (args[0]) {
    // 2️⃣ Si es ID numérico
    if (/^\d+$/.test(args[0])) {
      userId = Number(args[0]);
    }
    // 3️⃣ Si es @usuario
    else if (args[0].startsWith("@")) {
      const username = args[0].slice(1);
      for (const [chatId] of gruposActivos.entries()) {
        try {
          const miembro = await ctx.telegram.getChatMember(chatId, ctx.from.id);
          if (miembro.user.username === username) {
            userId = miembro.user.id;
            nombreUsuario = miembro.user.first_name || `@${username}`;
            break;
          }
        } catch {
          // Ignorar errores si el usuario no está en ese grupo
        }
      }
      if (!userId) {
        return autoDelete(ctx, `⚠️ No se pudo resolver el usuario ${args[0]} en los grupos activos.`);
      }
    }
  }

  // 4️⃣ Motivo (si hay más argumentos después del ID/username)
  if (args.length > 1) {
    motivo = args.slice(1).join(" ");
  }

  if (!userId) {
    return autoDelete(ctx, "⚠️ Uso: `/gban <id_usuario | @usuario> [motivo]` o responde al mensaje del usuario.", { parse_mode: "Markdown" });
  }

  // 🚨 Ban global en todos los grupos activos
  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(chatId, userId);
      console.log(`🚨 Usuario ${nombreUsuario} (${userId}) baneado en grupo: ${grupo.nombre} (${chatId})`);

      // Mensaje en cada grupo con autoDelete (5 min)
      autoDelete(ctx, {
        text: `🚨 Usuario *${nombreUsuario}* (ID: ${userId}) fue baneado globalmente.\n📝 Motivo: ${motivo}`,
        options: { parse_mode: "Markdown" }
      });
    } catch (err) {
      console.error(`❌ Error al banear en grupo ${chatId}:`, err.message);
    }
  }

  // Confirmación en el grupo donde se ejecutó el comando
  autoDelete(ctx, {
    text: `🚨 Usuario *${nombreUsuario}* (ID: ${userId}) baneado globalmente.\n📝 Motivo: ${motivo}`,
    options: { parse_mode: "Markdown" }
  });
});

// --- BLOQUE 10: Configuración de Webhook para Railway ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL; // ej: https://cadenero-production.up.railway.app

// Configurar webhook con la URL pública de Railway
bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);

// Endpoint para recibir actualizaciones desde Telegram
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

// Endpoint de prueba para verificar que el servicio está activo
app.get('/', (req, res) => {
  res.send('✅ Bot corriendo con Webhook en Railway');
});

// Iniciar servidor en el puerto asignado por Railway
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

// Confirmación de inicio
console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
