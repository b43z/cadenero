const { Telegraf } = require('telegraf');

// 🔑 Configuración
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PASSWORD = "b43z6028-cirrus";
const bot = new Telegraf(BOT_TOKEN);

// 🔧 Mapas de control
const gruposAutorizados = new Set();
const gruposActivos = new Map();
const gruposPendientes = new Map();
const intentosFallidos = new Map();

// 🛠 Funciones auxiliares
async function esAdminDelGrupo(ctx, userId) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ['administrator','creator'].includes(member.status);
  } catch (err) {
    console.error("Error verificando admin:", err);
    return false;
  }
}

function borrarMensaje(ctx, msg) {
  setTimeout(() => {
    ctx.deleteMessage(msg.message_id).catch(() => {});
  }, 5000);
}

function registrarGrupo(chatId, nombre) {
  gruposActivos.set(chatId, {
    nombre,
    usuariosProcesados: 0,
    usuariosRechazados: 0,
    fechaInicio: new Date(),
    id: chatId
  });
}
// /start en grupos y privados
bot.command('start', async (ctx) => {
  if (ctx.chat.type === 'private') {
    const msg = await ctx.reply("⚡ Bot activado en privado.");
    borrarMensaje(ctx, msg);
  } else {
    registrarGrupo(ctx.chat.id, ctx.chat.title);
    const msg = await ctx.reply("⚡ Bot activado en grupo.");
    borrarMensaje(ctx, msg);
  }
});

// /auth para autorizar grupo
bot.command('auth', async (ctx) => {
  console.log("📩 Comando /auth recibido en grupo:", ctx.chat.id, ctx.chat.title);

  const chatId = ctx.chat.id;
  if (!['group','supergroup'].includes(ctx.chat.type)) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    const msg = await ctx.reply("❌ Solo administradores pueden usar este comando.");
    borrarMensaje(ctx, msg);
    return;
  }

  const partes = ctx.message.text.split(" ");
  if (partes.length < 2) {
    const msg = await ctx.reply("❌ Uso: `/auth contraseña`", { parse_mode: 'Markdown' });
    borrarMensaje(ctx, msg);
    return;
  }

  const passwordIngresado = partes.slice(1).join(" ");
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);

    const msg = await ctx.reply("✅ Grupo autorizado correctamente.");
    borrarMensaje(ctx, msg);
    console.log(`🔑 Grupo autorizado: ${ctx.chat.title} (${chatId})`);
  } else {
    const msg = await ctx.reply("❌ Contraseña incorrecta.");
    borrarMensaje(ctx, msg);
  }
});

// /grupos para listar grupos activos
bot.command('grupos', async (ctx) => {
  if (gruposActivos.size === 0) {
    const msg = await ctx.reply("📭 No hay grupos activos autorizados.");
    borrarMensaje(ctx, msg);
    return;
  }

  let texto = "📌 Grupos activos:\n\n";
  gruposActivos.forEach((info) => {
    texto += `• ${info.nombre} (ID: ${info.id})\n   Procesados: ${info.usuariosProcesados}\n   Rechazados: ${info.usuariosRechazados}\n   Inicio: ${info.fechaInicio.toLocaleString()}\n\n`;
  });

  const msg = await ctx.reply(texto);
  borrarMensaje(ctx, msg);
});

// Evento my_chat_member
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
      gruposPendientes.set(chatId, { nombre: ctx.chat.title, fecha_solicitud: new Date() });
      const msg = await ctx.reply("🔐 Este grupo requiere autenticación. Usa: `/auth contraseña`");
      borrarMensaje(ctx, msg);
    }
  }

  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    console.log(`🗑️ Bot eliminado del grupo: ${chatId}`);
  }
});
// Lanzar bot
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => console.error("❌ Error al iniciar bot:", err));

// 🛑 Optimización de cierre para Railway
const shutdown = (signal) => {
  console.log(`🛑 Recibida señal ${signal}, cerrando bot...`);
  bot.stop(signal);
  process.exit(0); // Finaliza limpio para Railway
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
