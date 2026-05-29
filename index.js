// --- BLOQUE 1: Imports, inicialización ---
const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);

// Estado en memoria
const usuariosProcesados = new Set();
const timeoutMap = new Map();

// --- BLOQUE 2: Validaciones y utilidades ---
const VALIDACIONES = {
  soloSimbolos: /^[\p{P}\p{S}]+$/u,
  unaLetra: /^[A-Za-zÁÉÍÓÚÜÑ]$/u,
  soloEmoji: /^[\p{Emoji}]+$/u,
  letrasRepetidas: /(.)\1{2,}/u,
  letraMasSimbolo: /^[A-Za-zÁÉÍÓÚÜÑ][\p{P}\p{S}]$/u,
  emojiMasSimbolo: /^[\p{Emoji}][\p{P}\p{S}]$/u
};
function nombreInvalido(nombre) {
  if (!nombre) return true;
  return (
    VALIDACIONES.soloSimbolos.test(nombre) ||
    VALIDACIONES.unaLetra.test(nombre) ||
    VALIDACIONES.soloEmoji.test(nombre) ||
    VALIDACIONES.letrasRepetidas.test(nombre) ||
    VALIDACIONES.letraMasSimbolo.test(nombre) ||
    VALIDACIONES.emojiMasSimbolo.test(nombre)
  );
}

async function autoDelete(ctx, messagePromise) {
  try {
    const sent = await messagePromise;
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
    }, 5 * 60 * 1000);
  } catch (err) {
    console.error("Error al enviar/borrar mensaje:", err.message);
  }
}

// --- BLOQUE 3: Procesamiento de usuarios ---
function limpiarUsuarioProcesado(userId) {
  if (timeoutMap.has(userId)) clearTimeout(timeoutMap.get(userId));
  const timeout = setTimeout(() => {
    usuariosProcesados.delete(userId);
    timeoutMap.delete(userId);
  }, 30000);
  timeoutMap.set(userId, timeout);
}

async function procesarUsuario(ctx, user, tipo = 'directo') {
  const userId = user.id;
  if (usuariosProcesados.has(userId)) return;
  usuariosProcesados.add(userId);
  limpiarUsuarioProcesado(userId);

  const nombre = user.first_name || "";
  const username = user.username ? `@${user.username}` : "(sin username)";
  const esValido = !nombreInvalido(nombre);

  try {
    if (!esValido) {
      if (tipo === 'solicitud') await ctx.telegram.declineChatJoinRequest(ctx.chat.id, userId);
      else await ctx.telegram.banChatMember(ctx.chat.id, userId);
      await autoDelete(ctx, ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`));
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
      await autoDelete(ctx, ctx.reply(`✅ Bienvenido ${nombre} ${username}`));
    }
  } catch (err) {
    await autoDelete(ctx, ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`));
  }
}

// --- BLOQUE 4: Middleware y comando /start ---
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const parts = ctx.message.text.split(' ');
    ctx.args = parts.slice(1);
  }
  return next();
});

bot.start((ctx) => {
  autoDelete(ctx, ctx.reply("⚡ Bot activado. Evaluará automáticamente a los nuevos usuarios."));
});

// --- BLOQUE 5: Manejo de miembros ---
bot.on('new_chat_members', async (ctx) => {
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

bot.on('chat_join_request', async (ctx) => {
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
});

// --- BLOQUE 6: Lanzamiento y cierre del bot ---
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
// --- BLOQUE 7: Logs de diagnóstico (opcional) ---
function logUsuario(nombre, username, resultado) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Usuario: ${nombre} ${username} → ${resultado}`);
}

// Ajuste dentro de procesarUsuario para usar logs:
async function procesarUsuario(ctx, user, tipo = 'directo') {
  const userId = user.id;
  if (usuariosProcesados.has(userId)) return;
  usuariosProcesados.add(userId);
  limpiarUsuarioProcesado(userId);

  const nombre = user.first_name || "";
  const username = user.username ? `@${user.username}` : "(sin username)";
  const esValido = !nombreInvalido(nombre);

  try {
    if (!esValido) {
      if (tipo === 'solicitud') await ctx.telegram.declineChatJoinRequest(ctx.chat.id, userId);
      else await ctx.telegram.banChatMember(ctx.chat.id, userId);
      await autoDelete(ctx, ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`));
      logUsuario(nombre, username, "RECHAZADO");
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
      await autoDelete(ctx, ctx.reply(`✅ Bienvenido ${nombre} ${username}`));
      logUsuario(nombre, username, "ACEPTADO");
    }
  } catch (err) {
    await autoDelete(ctx, ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`));
    logUsuario(nombre, username, `ERROR → ${err.message}`);
  }
}

// --- BLOQUE 8: Manejo de errores globales ---
bot.catch((err, ctx) => {
  console.error(`❌ Error inesperado en actualización ${ctx.updateType}:`, err);
});

// --- BLOQUE 9: Lanzamiento y cierre del bot ---
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
