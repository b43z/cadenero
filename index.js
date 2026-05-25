const { Telegraf } = require('telegraf');

// Token desde variable de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

// Set para rastrear usuarios ya procesados (prevenir duplicidad)
const usuariosProcesados = new Set();

// Map para rastrear grupos activos: chatId -> { nombre, usuarios_procesados, fecha_inicio }
const gruposActivos = new Map();

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

// Función para registrar un grupo activo
function registrarGrupo(chatId, chatTitle) {
  if (!gruposActivos.has(chatId)) {
    gruposActivos.set(chatId, {
      nombre: chatTitle || `Grupo ${chatId}`,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date(),
      id: chatId
    });
    console.log(`📍 Nuevo grupo registrado: ${chatTitle} (${chatId})`);
  }
}

// Función para actualizar estadísticas del grupo
function actualizarGrupo(chatId, aprobado = true) {
  if (gruposActivos.has(chatId)) {
    const grupo = gruposActivos.get(chatId);
    grupo.usuariosProcesados++;
    if (!aprobado) {
      grupo.usuariosRechazados++;
    }
  }
}

// Función centralizada para procesar usuarios
async function procesarUsuario(ctx, user, tipo = 'directo') {
  const userId = user.id;
  const chatId = ctx.chat.id;
  
  // Registrar grupo activo
  registrarGrupo(chatId, ctx.chat.title);
  
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
      actualizarGrupo(chatId, false);
      console.log(`🚫 Usuario rechazado: ${nombre} ${username}`);
    } else {
      if (tipo === 'solicitud') {
        await ctx.approveChatJoinRequest(userId);
      }
      ctx.reply(`✅ Usuario aprobado: Bienvenido ${nombre} ${username}`);
      actualizarGrupo(chatId, true);
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

// Comando para ver grupos activos
bot.command('grupos', (ctx) => {
  if (gruposActivos.size === 0) {
    ctx.reply("📭 El bot no está activo en ningún grupo aún.");
    return;
  }

  let mensaje = "📊 **Grupos Activos del Bot**\n\n";
  let contador = 1;

  gruposActivos.forEach((info, chatId) => {
    const tiempoActivo = Math.floor((new Date() - info.fechaInicio) / 1000 / 60); // en minutos
    mensaje += `${contador}. **${info.nombre}**\n`;
    mensaje += `   • ID: \`${chatId}\`\n`;
    mensaje += `   • Usuarios procesados: ${info.usuariosProcesados}\n`;
    mensaje += `   • Usuarios rechazados: ${info.usuariosRechazados}\n`;
    mensaje += `   • Tiempo activo: ${tiempoActivo} min\n\n`;
    contador++;
  });

  ctx.reply(mensaje, { parse_mode: 'Markdown' });
});

// Comando para ver estadísticas de un grupo específico
bot.command('estadisticas', (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!gruposActivos.has(chatId)) {
    ctx.reply("📭 Este grupo no ha sido registrado aún.");
    return;
  }

  const info = gruposActivos.get(chatId);
  const tiempoActivo = Math.floor((new Date() - info.fechaInicio) / 1000 / 60);
  const usuariosAprobados = info.usuariosProcesados - info.usuariosRechazados;
  const porcentajeAprobacion = info.usuariosProcesados > 0 
    ? ((usuariosAprobados / info.usuariosProcesados) * 100).toFixed(2)
    : 0;

  const mensaje = `📈 **Estadísticas del Grupo**\n\n` +
    `Nombre: **${info.nombre}**\n` +
    `ID: \`${chatId}\`\n` +
    `Tiempo activo: ${tiempoActivo} minutos\n\n` +
    `👥 **Usuarios Procesados:** ${info.usuariosProcesados}\n` +
    `✅ Aprobados: ${usuariosAprobados}\n` +
    `🚫 Rechazados: ${info.usuariosRechazados}\n` +
    `📊 Tasa de aprobación: ${porcentajeAprobacion}%`;

  ctx.reply(mensaje, { parse_mode: 'Markdown' });
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

// Rastrear cuando el bot abandona un grupo
bot.on('my_chat_member', (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;

  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    console.log(`👋 Bot removido del grupo: ${ctx.chat.title} (${chatId})`);
  }
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
