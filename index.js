const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';

// Estado en memoria
const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();

// Validaciones de nombres
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
// Utilidad para borrar mensajes después de 5 minutos
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

const timeoutMap = new Map();
function limpiarUsuarioProcesado(userId) {
  if (timeoutMap.has(userId)) clearTimeout(timeoutMap.get(userId));
  const timeout = setTimeout(() => {
    usuariosProcesados.delete(userId);
    timeoutMap.delete(userId);
  }, 30000);
  timeoutMap.set(userId, timeout);
}

function registrarGrupo(chatId, chatTitle) {
  if (!gruposActivos.has(chatId)) {
    gruposActivos.set(chatId, {
      nombre: chatTitle || `Grupo ${chatId}`,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date(),
      id: chatId
    });
    console.log(`📍 Grupo registrado: ${chatTitle} (${chatId})`);
  }
}

function actualizarGrupo(chatId, aprobado = true) {
  if (gruposActivos.has(chatId)) {
    const grupo = gruposActivos.get(chatId);
    grupo.usuariosProcesados++;
    if (!aprobado) grupo.usuariosRechazados++;
  }
}

async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return miembro.status === 'administrator' || miembro.status === 'creator';
  } catch {
    return false;
  }
}
async function procesarUsuario(ctx, user, tipo = 'directo') {
  const userId = user.id;
  const chatId = ctx.chat.id;
  registrarGrupo(chatId, ctx.chat.title);

  if (usuariosProcesados.has(userId)) return;
  usuariosProcesados.add(userId);
  limpiarUsuarioProcesado(userId);

  const nombre = user.first_name || "";
  const username = user.username ? `@${user.username}` : "(sin username)";
  const esValido = !nombreInvalido(nombre);

  try {
    if (!esValido) {
      if (tipo === 'solicitud') await ctx.telegram.declineChatJoinRequest(chatId, userId);
      else await ctx.telegram.banChatMember(chatId, userId);
      await autoDelete(ctx, ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`));
      actualizarGrupo(chatId, false);
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(chatId, userId);
      await autoDelete(ctx, ctx.reply(`✅ Bienvenido ${nombre} ${username}`));
      actualizarGrupo(chatId, true);
    }
  } catch (err) {
    await autoDelete(ctx, ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`));
  }
}

// Middleware para habilitar ctx.args
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const parts = ctx.message.text.split(' ');
    ctx.args = parts.slice(1);
  }
  return next();
});

// Comando /start
bot.start((ctx) => {
  registrarGrupo(ctx.chat.id, ctx.chat.title);
  autoDelete(ctx, ctx.reply("⚡ Bot activado. Evaluará automáticamente a los nuevos usuarios."));
});
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) &&
      (['member','administrator','creator'].includes(nuevoEstado))) {
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.set(chatId, { nombre: ctx.chat.title, fecha_solicitud: new Date() });
    autoDelete(ctx, ctx.reply("🔐 Este grupo requiere autenticación.\nPor favor ingresa la contraseña:", {
      reply_markup: { force_reply: true }
    }));
  }

  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    console.log(`🗑️ Bot eliminado del grupo: ${chatId}`);
  }
});

// Captura automática del password (solo texto en grupos pendientes)
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;

  // ✅ Filtramos: solo procesar si el grupo está pendiente y el mensaje es texto
  if (gruposPendientes.has(chatId) && ctx.message.text) {
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
    if (!esAdmin) {
      return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden autorizar el grupo."));
    }

    const passwordIngresado = ctx.message.text.trim();

    if (passwordIngresado === BOT_PASSWORD) {
      gruposAutorizados.add(chatId);
      gruposPendientes.delete(chatId);
      intentosFallidos.delete(chatId);
      autoDelete(ctx, ctx.reply("✅ Grupo autorizado correctamente."));
      console.log(`🔑 Grupo autorizado: ${ctx.chat.title} (${chatId})`);
    } else {
      autoDelete(ctx, ctx.reply("❌ Contraseña incorrecta. El bot se eliminará en 10 minutos si no se autoriza."));
      intentosFallidos.set(chatId, (intentosFallidos.get(chatId) || 0) + 1);
    }
  }
});

// Limpieza automática de grupos pendientes
setInterval(async () => {
  const ahora = new Date();
  for (const [chatId, info] of gruposPendientes.entries()) {
    const minutosPendiente = (ahora - info.fecha_solicitud) / 1000 / 60;
    if (minutosPendiente > 10) {
      try {
        await bot.telegram.leaveChat(chatId);
        gruposPendientes.delete(chatId);
        gruposActivos.delete(chatId);
        intentosFallidos.delete(chatId);
        console.log(`⏱️ Grupo eliminado automáticamente por no autorizarse: ${chatId}`);
      } catch (err) {
        console.error(`Error al salir del grupo ${chatId}:`, err.message);
      }
    }
  }
}, 60000);

// Procesar nuevos miembros
bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) {
    return autoDelete(ctx, ctx.reply("⚠️ Este grupo aún no está autorizado. Ingresa la contraseña."));
  }
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

// Procesar solicitudes de unión
bot.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) {
    return autoDelete(ctx, ctx.reply("⚠️ Este grupo aún no está autorizado. Ingresa la contraseña."));
  }
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
});

// Comando /delgrupo <id>
bot.command('delgrupo', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden usar este comando."));
  }
  if (!ctx.args || ctx.args.length === 0) {
    return autoDelete(ctx, ctx.reply("❌ Uso: `/delgrupo <id>`", { parse_mode: 'Markdown' }));
  }
  const idEliminar = parseInt(ctx.args[0]);
  if (gruposActivos.has(idEliminar)) {
    gruposActivos.delete(idEliminar);
    gruposAutorizados.delete(idEliminar);
    gruposPendientes.delete(idEliminar);
    intentosFallidos.delete(idEliminar);
    autoDelete(ctx, ctx.reply(`🗑️ Grupo eliminado: ${idEliminar}`));
    console.log(`🗑️ Grupo eliminado manualmente: ${idEliminar}`);
  } else {
    autoDelete(ctx, ctx.reply("⚠️ Ese grupo no está registrado."));
  }
});
// 🔴 NUEVO BLOQUE: Comando /auth <password>
bot.command('auth', async (ctx) => {
  const chatId = ctx.chat.id;
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden autorizar el grupo."));
  }
  if (!ctx.args || ctx.args.length === 0) {
    return autoDelete(ctx, ctx.reply("❌ Uso: `/auth <password>`", { parse_mode: 'Markdown' }));
  }
  const passwordIngresado = ctx.args[0].trim();
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    autoDelete(ctx, ctx.reply("✅ Grupo autorizado correctamente."));
    console.log(`🔑 Grupo autorizado vía /auth: ${ctx.chat.title} (${chatId})`);
  } else {
    autoDelete(ctx, ctx.reply("❌ Contraseña incorrecta."));
    intentosFallidos.set(chatId, (intentosFallidos.get(chatId) || 0) + 1);
  }
});
// Lanzar bot en Railway
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    process.exit(1);
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
