const { Telegraf } = require('telegraf');

// Token desde variable de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

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

// Mensaje de inicio
bot.start((ctx) => {
  ctx.reply("⚡ El bot está activo en el grupo y evaluará automáticamente a los nuevos usuarios.");
});

// Evaluar usuarios que entran directamente al grupo
bot.on('new_chat_members', async (ctx) => {
  ctx.message.new_chat_members.forEach(async (user) => {
    const nombre = user.first_name || "";
    const username = user.username ? `@${user.username}` : "(sin username)";

    ctx.reply(`🔍 Evaluando nuevo miembro: ${nombre} ${username}`);

    if (nombreInvalido(nombre)) {
      try {
        await ctx.kickChatMember(user.id);
        ctx.reply(`🚫 Usuario baneado automáticamente por no tener un nombre válido: ${nombre} ${username}`);
      } catch (err) {
        ctx.reply(`❌ Error al intentar banear a ${nombre}: ${err.message}`);
      }
    } else {
      ctx.reply(`✅ Usuario aprobado: Bienvenido ${nombre} ${username}`);
    }
  });
});

// Evaluar solicitudes de entrada en supergrupos con aprobación
bot.on('chat_join_request', async (ctx) => {
  const user = ctx.chatJoinRequest.from;
  const nombre = user.first_name || "";
  const username = user.username ? `@${user.username}` : "(sin username)";

  ctx.reply(`🔍 Evaluando solicitud de entrada: ${nombre} ${username}`);

  if (nombreInvalido(nombre)) {
    try {
      await ctx.declineChatJoinRequest(user.id);
      ctx.reply(`🚫 Solicitud rechazada automáticamente por incumplir el reglmento: ${nombre} ${username}`);
    } catch (err) {
      ctx.reply(`❌ Error al rechazar solicitud de ${nombre}: ${err.message}`);
    }
  } else {
    try {
      await ctx.approveChatJoinRequest(user.id);
      ctx.reply(`✅ Solicitud aprobada: Bienvenido ${nombre} ${username}`);
    } catch (err) {
      ctx.reply(`❌ Error al aprobar solicitud de ${nombre}: ${err.message}`);
    }
  }
});

// Lanzar el bot con soporte para Railway
bot.launch().then(() => {
  console.log("Bot iniciado en el grupo y en funciones.");
});

// Graceful stop para Railway/Heroku/Docker
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
