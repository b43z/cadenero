const { Telegraf } = require('telegraf');
const crypto = require('crypto');

// Token desde variable de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

// Contraseña para autorizar grupos
const BOT_PASSWORD = 'b43z6028-cirrus';

// Set para rastrear usuarios ya procesados (prevenir duplicidad)
const usuariosProcesados = new Set();

// Map para rastrear grupos activos: chatId -> { nombre, usuarios_procesados, fecha_inicio }
const gruposActivos = new Map();

// Set para rastrear grupos autorizados (IDs de chat)
const gruposAutorizados = new Set(process.env.AUTHORIZED_GROUPS?.split(',').map(id => parseInt(id)) || []);

// Map para rastrear grupos pendientes de autenticación: chatId -> { nombre, usuario_que_agrego, fecha_solicitud }
const gruposPendientes = new Map();

// Map para rastrear intentos fallidos de contraseña: chatId -> { intentos, fecha_ultimo_intento }
const intentosFallidos = new Map();

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

// Función para verificar si un usuario es administrador del grupo
async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return miembro.status === 'administrator' || miembro.status === 'creator';
  } catch (err) {
    console.error(`Error verificando admin para ${userId}:`, err.message);
    return false;
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
        await ctx.telegram.declineChatJoinRequest(ctx.chat.id, userId);
      } else {
        await ctx.telegram.banChatMember(ctx.chat.id, userId);
      }
      ctx.reply(`🚫 Usuario rechazado por no tener un nombre válido: ${nombre} ${username}`);
      actualizarGrupo(chatId, false);
      console.log(`🚫 Usuario rechazado: ${nombre} ${username}`);
    } else {
      if (tipo === 'solicitud') {
        await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
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
  // Si se ejecuta en un grupo, registrarlo
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    registrarGrupo(ctx.chat.id, ctx.chat.title);
    ctx.reply("⚡ Bot activado en este grupo. Evaluará automáticamente a los nuevos usuarios.");
  } else {
    ctx.reply("⚡ El bot está activo en el grupo y evaluará automáticamente a los nuevos usuarios.");
  }
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
    const estado = gruposAutorizados.has(chatId) ? "✅ Autorizado" : "⚠️ No autorizado";
    mensaje += `${contador}. **${info.nombre}**\n`;
    mensaje += `   • ID: \`${chatId}\`\n`;
    mensaje += `   • Estado: ${estado}\n`;
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

// Comando para eliminar grupos no autorizados (solo administradores)
bot.command('delgroup', async (ctx) => {
  try {
    // Verificar que es admin
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
    if (!esAdmin) {
      ctx.reply("❌ Solo administradores pueden usar este comando.");
      return;
    }

    // Obtener el ID del chat actual o el del argumento
    let targetChatId = ctx.chat.id;
    
    // Si se proporciona un argumento, usarlo como ID del grupo a eliminar
    if (ctx.args && ctx.args.length > 0) {
      targetChatId = parseInt(ctx.args[0]);
      if (isNaN(targetChatId)) {
        ctx.reply("❌ ID de grupo inválido. Uso: `/delgroup [id_grupo]`", { parse_mode: 'Markdown' });
        return;
      }
    }

    // Validar que el grupo existe en gruposActivos
    if (!gruposActivos.has(targetChatId)) {
      ctx.reply(`❌ El grupo con ID \`${targetChatId}\` no está registrado.`, { parse_mode: 'Markdown' });
      return;
    }

    const grupoInfo = gruposActivos.get(targetChatId);
    
    // Eliminar el grupo
    gruposActivos.delete(targetChatId);
    
    // Intentar salir del grupo
    try {
      await bot.telegram.leaveChat(targetChatId);
      ctx.reply(`🗑️ Grupo "${grupoInfo.nombre}" eliminado correctamente.\n❌ Bot removido del grupo.`, { parse_mode: 'Markdown' });
      console.log(`🗑️ Grupo eliminado: ${grupoInfo.nombre} (${targetChatId})`);
    } catch (err) {
      // Si no puede salir, al menos lo registra como eliminado
      ctx.reply(`🗑️ Grupo "${grupoInfo.nombre}" eliminado de registros.\n⚠️ No fue posible remover el bot del grupo automáticamente.`, { parse_mode: 'Markdown' });
      console.log(`🗑️ Grupo eliminado (registro): ${grupoInfo.nombre} (${targetChatId}) - Error: ${err.message}`);
    }
  } catch (err) {
    ctx.reply(`❌ Error al eliminar grupo: ${err.message}`);
    console.error('Error en comando delgroup:', err.message);
  }
});

// Comando para autenticar un grupo con contraseña (solo administradores)
bot.command('auth', async (ctx) => {
  const chatId = ctx.chat.id;
  
  // Solo funciona en grupos
  if (!ctx.chat.type || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
    ctx.reply("❌ Este comando solo funciona en grupos.");
    return;
  }

  // Verificar que es admin
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    ctx.reply("❌ Solo administradores pueden usar este comando.");
    return;
  }

  // Si el grupo ya está autorizado
  if (gruposAutorizados.has(chatId)) {
    ctx.reply("✅ Este grupo ya está autorizado.");
    return;
  }

  // Obtener la contraseña del argumento
  if (!ctx.args || ctx.args.length === 0) {
    ctx.reply("❌ Por favor proporciona la contraseña. Uso: `/auth contraseña`", { parse_mode: 'Markdown' });
    return;
  }

  const passwordIngresado = ctx.args.join(' ');

  // Verificar intentos fallidos
  if (intentosFallidos.has(chatId)) {
    const intento = intentosFallidos.get(chatId);
    const tiempoTranscurrido = (new Date() - intento.fecha_ultimo_intento) / 1000 / 60; // en minutos
    
    if (tiempoTranscurrido < 5 && intento.intentos >= 3) {
      ctx.reply("🔒 Demasiados intentos fallidos. Intenta de nuevo en 5 minutos.");
      return;
    }
  }

  // Verificar contraseña
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    // 🔧 FIX: Registrar el grupo cuando se autoriza correctamente
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    ctx.reply("✅ ¡Contraseña correcta! El grupo ha sido autorizado exitosamente.");
    console.log(`🔑 Grupo autorizado por contraseña: ${ctx.chat.title} (${chatId})`);
  } else {
    // Incrementar intentos fallidos
    if (!intentosFallidos.has(chatId)) {
      intentosFallidos.set(chatId, { intentos: 0, fecha_ultimo_intento: new Date() });
    }
    
    const intento = intentosFallidos.get(chatId);
    intento.intentos++;
    intento.fecha_ultimo_intento = new Date();

    const intentosRestantes = 3 - intento.intentos;
    if (intentosRestantes > 0) {
      ctx.reply(`❌ Contraseña incorrecta. Intentos restantes: ${intentosRestantes}`);
    } else {
      ctx.reply("🔒 Demasiados intentos fallidos. El bot se retirará del grupo en 30 segundos.");
      console.log(`⚠️ Demasiados intentos fallidos en: ${ctx.chat.title} (${chatId})`);
      
      setTimeout(async () => {
        try {
          await bot.telegram.leaveChat(chatId);
          gruposActivos.delete(chatId);
          gruposPendientes.delete(chatId);
          intentosFallidos.delete(chatId);
          console.log(`👋 Bot removido del grupo por intentos fallidos: ${ctx.chat.title} (${chatId})`);
        } catch (err) {
          console.error(`Error al remover bot del grupo ${chatId}:`, err.message);
        }
      }, 30000);
    }
  }
});

// Registrar grupo cuando el bot se agrega
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  console.log(`Estado anterior: ${estadoAnterior} → Estado nuevo: ${nuevoEstado}`);

  // Cuando el bot entra al grupo (cualquier transición hacia un estado activo)
  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) && 
      (nuevoEstado === 'member' || nuevoEstado === 'administrator' || nuevoEstado === 'creator')) {
    
    console.log(`✅ Bot agregado al grupo: ${ctx.chat.title} (${chatId})`);
    
    // Verificar si el grupo ya está autorizado
    if (gruposAutorizados.has(chatId)) {
      registrarGrupo(chatId, ctx.chat.title);
      console.log(`✅ Grupo ya autorizado, registrando: ${ctx.chat.title} (${chatId})`);
    } else {
      // 🔧 FIX: Registrar el grupo incluso cuando está pendiente de autorización
      registrarGrupo(chatId, ctx.chat.title);
      // El grupo no está autorizado, pedir contraseña
      gruposPendientes.set(chatId, {
        nombre: ctx.chat.title,
        usuario_que_agrego: ctx.myChatMember.new_chat_member.user.username || ctx.myChatMember.new_chat_member.user.first_name,
        fecha_solicitud: new Date()
      });
      
      ctx.reply(
        "🔐 **Bienvenido Bot de Validación de Usuarios**\n\n" +
        "Este grupo requiere autenticación para usar el bot.\n" +
        "Por favor, proporciona la contraseña usando el comando:\n\n" +
        "`/auth contraseña`\n\n" +
        "Si no tienes la contraseña, contacta al administrador del bot.",
        { parse_mode: 'Markdown' }
      );
      console.log(`⚠️ Grupo pendiente de autorización: ${ctx.chat.title} (${chatId})`);
    }
  }

  // Cuando el bot se va o es removido
  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    console.log(`👋 Bot removido del grupo: ${ctx.chat.title} (${chatId})`);
  }
});

// Registrar grupo automáticamente cuando llegan mensajes
bot.on('message', (ctx, next) => {
  // Registrar grupo si no está en el mapa y está autorizado
  if ((ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') && 
      !gruposActivos.has(ctx.chat.id) && 
      gruposAutorizados.has(ctx.chat.id)) {
    registrarGrupo(ctx.chat.id, ctx.chat.title);
  }
  return next();
});

// Evaluar usuarios que entran directamente al grupo (solo si está autorizado)
bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  
  // Solo procesar si el grupo está autorizado
  if (!gruposAutorizados.has(chatId)) {
    console.log(`⚠️ Nuevo miembro en grupo no autorizado: ${ctx.chat.title} (${chatId})`);
    return;
  }

  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

// Evaluar solicitudes de entrada en supergrupos con aprobación (solo si está autorizado)
bot.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chat.id;
  
  // Solo procesar si el grupo está autorizado
  if (!gruposAutorizados.has(chatId)) {
    console.log(`⚠️ Solicitud de entrada en grupo no autorizado: ${ctx.chat.title} (${chatId})`);
    return;
  }

  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
});

// Lanzar el bot con soporte para Railway
bot.launch()
  .then(() => {
    console.log("✅ Bot iniciado en el grupo y en funciones.");
    console.log(`📋 Grupos autorizados cargados: ${gruposAutorizados.size}`);
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
