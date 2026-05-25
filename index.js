const { Telegraf } = require('telegraf');
const crypto = require('crypto');

const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = 'b43z6028-cirrus';

const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set(process.env.AUTHORIZED_GROUPS?.split(',').map(id => parseInt(id)) || []);
const gruposPendientes = new Map();
const intentosFallidos = new Map();

const VALIDACIONES = {
  soloSimbolos: /^[\p{P}\p{S}]+$/u,
  unaLetra: /^[A-Za-zÁÉÍÓÚÜÑ]$/u,
  soloEmoji: /^[\p{Emoji}]+$/u,
  letrasRepetidas: /(.)\1{1,}/u
};

function nombreInvalido(nombre) {
  if (!nombre) return true;
  return (
    VALIDACIONES.soloSimbolos.test(nombre) ||
    VALIDACIONES.unaLetra.test(nombre) ||
    VALIDACIONES.soloEmoji.test(nombre) ||
    VALIDACIONES.letrasRepetidas.test(nombre)
  );
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
    console.log(`📍 Nuevo grupo registrado: ${chatTitle} (${chatId})`);
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

// --- Comando /auth corregido ---
bot.command('auth', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!['group','supergroup'].includes(ctx.chat.type)) {
    ctx.reply("❌ Este comando solo funciona en grupos.");
    return;
  }
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    ctx.reply("❌ Solo administradores pueden usar este comando.");
    return;
  }
  if (gruposAutorizados.has(chatId)) {
    ctx.reply("✅ Este grupo ya está autorizado.");
    return;
  }
  if (!ctx.args || ctx.args.length === 0) {
    ctx.reply("❌ Por favor proporciona la contraseña. Uso: `/auth contraseña`", { parse_mode: 'Markdown' });
    return;
  }
  const passwordIngresado = ctx.args.join(' ');

  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    registrarGrupo(chatId, ctx.chat.title);

    // Limpieza completa al autorizar
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);

    ctx.reply("✅ ¡Contraseña correcta! El grupo ha sido autorizado exitosamente.");
    console.log(`🔑 Grupo autorizado: ${ctx.chat.title} (${chatId})`);
  } else {
    if (!intentosFallidos.has(chatId)) {
      intentosFallidos.set(chatId, { intentos: 0, fecha_ultimo_intento: new Date() });
    }
    const intento = intentosFallidos.get(chatId);
    intento.intentos++;
    intento.fecha_ultimo_intento = new Date();
    if (intento.intentos >= 3) {
      ctx.reply("🔒 Demasiados intentos fallidos. El bot se retirará en 30 segundos.");
      setTimeout(async () => {
        await bot.telegram.leaveChat(chatId);
        gruposActivos.delete(chatId);
        gruposPendientes.delete(chatId);
        intentosFallidos.delete(chatId);
      }, 30000);
    } else {
      ctx.reply(`❌ Contraseña incorrecta. Intentos restantes: ${3 - intento.intentos}`);
    }
  }
});

// --- Evento my_chat_member corregido ---
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
        usuario_que_agrego: ctx.myChatMember.new_chat_member.user.username || ctx.myChatMember.new_chat_member.user.first_name,
        fecha_solicitud: new Date()
      });
      ctx.reply(
        "🔐 **Bienvenido Bot de Validación de Usuarios**\n\n" +
        "Este grupo requiere autenticación.\n" +
        "Usa: `/auth contraseña`\n\n" +
        "Si no tienes la contraseña, contacta al administrador.",
        { parse_mode: 'Markdown' }
      );
    }
  }

  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
  }
});

// --- Eventos de usuarios ---
bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) return;
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

bot.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!gruposAutorizados.has(chatId)) return;
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
});

// Lanzar bot
bot.launch()
  .then(() => {
    console.log("✅ Bot iniciado.");
    console.log(`📋 Grupos autorizados: ${gruposAutorizados.size}`);
  })
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    process.exit(1);
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
