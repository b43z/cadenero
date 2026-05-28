const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';

// Estado en memoria
const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set(
  (process.env.AUTHORIZED_GROUPS || "")
    .split(",")
    .filter(id => id)
    .map(id => parseInt(id))
);
const gruposPendientes = new Map();
const intentosFallidos = new Map();

// Validaciones de nombres
const VALIDACIONES = {
  soloSimbolos: /^[\p{P}\p{S}]+$/u,
  unaLetra: /^[A-Za-zÁÉÍÓÚÜÑ]$/u,
  soloEmoji: /^[\p{Emoji}]+$/u,
  letrasRepetidas: /(.)\1{2,}/u
};
function nombreInvalido(nombre) {
  if (!nombre) return true;
  return (
    VALIDACIONES.soloSimbolos.test(nombre) ||
    VALIDACIONES.unaLetra.test(nombre) ||
    VALIDACIONES.soloEmoji.test(nombre) ||
    VALIDACIONES.letrasRepetidas.test(nombre) // ahora solo detecta 3+ repeticiones
  );
}

// Utilidades
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
      if (tipo === 'solicitud') await ctx.telegram.declineChatJoinRequest(ctx.chat.id, userId);
      else await ctx.telegram.banChatMember(ctx.chat.id, userId);
      ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`);
      actualizarGrupo(chatId, false);
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
      ctx.reply(`✅ Bienvenido ${nombre} ${username}`);
      actualizarGrupo(chatId, true);
    }
  } catch (err) {
    ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`);
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
  ctx.reply("⚡ Bot activado. Evaluará automáticamente a los nuevos usuarios.");
});

// Comando /grupos
bot.command('grupos', (ctx) => {
  if (gruposActivos.size === 0) {
    ctx.reply("📭 El bot no está activo en ningún grupo aún.");
    return;
  }
  let mensaje = "📊 **Grupos Activos del Bot**\n\n";
  let contador = 1;
  gruposActivos.forEach((info, chatId) => {
    const tiempoActivo = Math.floor((new Date() - info.fechaInicio) / 1000 / 60);
    const estado = gruposAutorizados.has(chatId) ? "✅ Autorizado" : "⚠️ Pendiente";
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

// Comando /auth
bot.command('auth', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!['group','supergroup'].includes(ctx.chat.type)) return;
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return;
  if (gruposAutorizados.has(chatId)) {
    ctx.reply("✅ Este grupo ya está autorizado.");
    return;
  }
  if (!ctx.args || ctx.args.length === 0) {
    ctx.reply("❌ Uso: `/auth contraseña`", { parse_mode: 'Markdown' });
    return;
  }
  const passwordIngresado = ctx.args.join(' ');
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    ctx.reply("✅ Grupo autorizado correctamente.");
    console.log(`🔑 Grupo autorizado: ${ctx.chat.title} (${chatId})`);
  } else {
    ctx.reply("❌ Contraseña incorrecta.");
  }
});

// Comando /delgrupo <id>
bot.command('delgrupo', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    ctx.reply("❌ Solo administradores pueden usar este comando.");
    return;
  }
  if (!ctx.args || ctx.args.length === 0) {
    ctx.reply("❌ Uso: `/delgrupo <id>`", { parse_mode: 'Markdown' });
    return;
  }
  const idEliminar = parseInt(ctx.args[0]);
  if (gruposActivos.has(idEliminar)) {
    gruposActivos.delete(idEliminar);
    gruposAutorizados.delete(idEliminar);
    gruposPendientes.delete(idEliminar);
    intentosFallidos.delete(idEliminar);
    ctx.reply(`🗑️ Grupo eliminado: ${idEliminar}`);
    console.log(`🗑️ Grupo eliminado manualmente: ${idEliminar}`);
  } else {
    ctx.reply("⚠️ Ese grupo no está registrado.");
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
// Eventos
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) &&
      (['member','administrator','creator'].includes(nuevoEstado))) {
    if (gruposAutorizados.has(chatId)) {
      registrarGrupo(chatId, ctx.chat.title);
      console.log(`✅ Grupo ya autorizado: ${ctx.chat.title} (${chatId})`);
    } else {
      registrarGrupo(chatId, ctx.chat.title);
      gruposPendientes.set(chatId, {
        nombre: ctx.chat.title,
        fecha_solicitud: new Date()
      });
      ctx.reply("🔐 Este grupo requiere autenticación. Usa: `/auth contraseña`");
    }
  }
  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    console.log(`🗑️ Bot eliminado del grupo: ${chatId}`);
  }
});

bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) {
    ctx.reply("⚠️ Este grupo aún no está autorizado. Usa `/auth contraseña`.");
    return;
  }
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

bot.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) {
    ctx.reply("⚠️ Este grupo aún no está autorizado. Usa `/auth contraseña`.");
    return;
  }
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
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
