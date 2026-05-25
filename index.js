const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';

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
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    registrarGrupo(ctx.chat.id, ctx.chat.title);
    ctx.reply("⚡ Bot activado en este grupo. Evaluará automáticamente a los nuevos usuarios.");
  } else {
    ctx.reply("⚡ El bot está activo y evaluará automáticamente a los nuevos usuarios en los grupos.");
  }
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

// Eventos
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) &&
      (['member','administrator','creator'].includes(nuevoEstado))) {
    if (gruposAutorizados.has(chatId)) {
      registrarGrupo(chatId, ctx.chat.title);
    } else {
      registrarGrupo(chatId, ctx.chat.title);
      gruposPendientes.set(chatId, {
        nombre: ctx.chat.title,
        usuario_que_agrego: ctx.myChatMember.new_chat_member.user.username || ctx.myChatMember.new_chat_member.user.first_name,
        fecha_solicitud: new Date()
      });
      ctx.reply("🔐 Este grupo requiere autenticación. Usa: `/auth contraseña`");
    }
  }
  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
  }
});

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
