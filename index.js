const { Telegraf } = require('telegraf');

// Token desde variable de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

// Set para rastrear usuarios ya procesados (prevenir duplicidad)
const usuariosProcesados = new Set();

// Función para validar nombres
function nombreInvalido(nombre) {
  if (!nombre) return true;

  // 1.- Solo símbolos de puntuación
  const soloSimbolos = /^[\p{P}\p{S}]+$/u.test(nombre);

  // 2.- Solo una letra
  const unaLetra = /^[A-Za-zÁÉÍÓÚÜÑ]$/u.test(nombre);

  // 3.- Solo emojis
  const soloEmoji = /^[\p{Emoji}]+$/u.test(nombre);

  // 4.- Dos o más letras repetidas consecutivas
  const letrasRepetidas = /(.)\1{1,}/u.test(nombre);

  return soloSimbolos || unaLetra || soloEmoji || letrasRepetidas;
}

// Función para limpiar usuarios procesados después de un tiempo
function limpiarUsuarioProcesado(userId) {
  setTimeout(() => {
    usuariosProcesados.delete(userId);
  }, 30000); // Limpiar después de 30 segundos
}

// Función centralizada para procesar usuarios
async function procesarUsuario(ctx, user, tipo = 'directo') {
  const userId = user.id;
  
  // Evitar procesar el mismo usuario múltiples veces
  if (usuariosProcesados.has(userId)) {
    console.log(`⏭️ Usuario ${userId} ya fue procesado, omitiendo...`);
    return;
  }
  
  usuariosProcesados.add(userId);
  limpiarUsuarioProcesado(userId);

  const nombre = user.first_name || "";
  const username = user.username ? `@${user.username}` : "(sin username)";

  if (nombreInvalido(nombre)) {
    try {
      if (tipo === 'solicitud') {
        await ctx.declineChatJoinRequest(userId);
      } else {
        await ctx.kickChatMember(userId);
      }
      ctx.reply(`🚫 Usuario rechazado por no tener un nombre válido: ${nombre} ${username}`);
      console.log(`🚫 Usuario rechazado: ${nombre} ${username}`);
    } catch (err) {
      ctx.reply(`❌ Error al procesar a ${nombre}: ${err.message}`);
      console.error(`Error procesando usuario: ${err.message}`);
    }
  } else {
    try {
      if (tipo === 'solicitud') {
        await ctx.approveChatJoinRequest(userId);
      }
      ctx.reply(`✅ Usuario aprobado: Bienvenido ${nombre} ${username}`);
      console.log(`✅ Usuario aprobado: ${nombre} ${username}`);
    } catch (err) {
      ctx.reply(`❌ Error al aprobar a ${nombre}: ${err.message}`);
      console.error(`Error aprobando usuario: ${err.message}`);
    }
  }
}

// Mensaje de inicio
bot.start((ctx) => {
  ctx.reply("⚡ El bot está activo en el grupo y evaluará automáticamente a los nuevos usuarios.");
});

// Evaluar usuarios que entran directamente al grupo
bot.on('new_chat_members', async (ctx) => {
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

// Evaluar solicitudes de entrada en supergrupos con aprobación
bot.on('chat_join_request', async (ctx) => {
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
});

// Lanzar el bot con soporte para Railway
bot.launch().then(() => {
  console.log("Bot iniciado en el grupo y en funciones.");
});

// Graceful stop para Railway/Heroku/Docker
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
