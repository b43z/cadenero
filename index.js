const { Telegraf } = require('telegraf');

// Token desde variable de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

// Set para rastrear usuarios ya procesados (prevenir duplicidad)
const usuariosProcesados = new Set();

// Regex compiladas una sola vez (reutilización)
const VALIDACIONES = {
  soloSimbolos: /^[\p{P}\p{S}]+$/u,
  unaLetra: /^[A-Za-zÁÉÍÓÚÜÑ]$/u,
  soloEmoji: /^[\p{Emoji}]+$/u,
  letrasRepetidas: /(.)\1{1,}/u
};

// Función para validar nombres
function nombreInvalido(nombre) {
  if (!nombre) return true;

  return (
    VALIDACIONES.soloSimbolos.test(nombre) ||
    VALIDACIONES.unaLetra.test(nombre) ||
    VALIDACIONES.soloEmoji.test(nombre) ||
    VALIDACIONES.letrasRepetidas.test(nombre)
  );
}

// Map para almacenar timeouts y evitar memory leaks
const timeoutMap = new Map();

// Función para limpiar usuarios procesados después de un tiempo
function limpiarUsuarioProcesado(userId) {
  // Limpiar timeout anterior si existe
  if (timeoutMap.has(userId)) {
    clearTimeout(timeoutMap.get(userId));
  }
  
  const timeout = setTimeout(() => {
    usuariosProcesados.delete(userId);
    timeoutMap.delete(userId);
  }, 30000); // Limpiar después de 30 segundos
  
  timeoutMap.set(userId, timeout);
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
  const esValido = !nombreInvalido(nombre);

  try {
    // Ejecutar acción según el tipo y validez
    if (!esValido) {
      if (tipo === 'solicitud') {
        await ctx.declineChatJoinRequest(userId);
      } else {
        await ctx.kickChatMember(userId);
      }
      ctx.reply(`🚫 Usuario rechazado por no tener un nombre válido: ${nombre} ${username}`);
      console.log(`🚫 Usuario rechazado: ${nombre} ${username}`);
    } else {
      if (tipo === 'solicitud') {
        await ctx.approveChatJoinRequest(userId);
      }
      ctx.reply(`✅ Usuario aprobado: Bienvenido ${nombre} ${username}`);
      console.log(`✅ Usuario aprobado: ${nombre} ${username}`);
    }
  } catch (err) {
    const accion = esValido ? 'aprobar' : 'procesar';
    ctx.reply(`❌ Error al ${accion} a ${nombre}: ${err.message}`);
    console.error(`Error ${accion} usuario:`, err.message);
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
bot.launch()
  .then(() => {
    console.log("✅ Bot iniciado en el grupo y en funciones.");
  })
  .catch((err) => {
    console.error("❌ Error al iniciar el bot:", err);
    process.exit(1);
  });

// Graceful stop para Railway/Heroku/Docker
process.once('SIGINT', () => {
  console.log("⏹️ Deteniendo bot (SIGINT)...");
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log("⏹️ Deteniendo bot (SIGTERM)...");
  bot.stop('SIGTERM');
});
