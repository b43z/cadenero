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

// Tiempo configurable para borrar mensajes (ms)
const TIEMPO_BORRADO_MS = 300000; // 5 minutos (cambia aquí)

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
    VALIDACIONES.letrasRepetidas.test(nombre)
  );
}

// Utilidad para borrar mensajes después de TIEMPO_BORRADO_MS
async function borrarMensaje(ctx, message) {
  try {
    setTimeout(async () => {
      try {
        await ctx.deleteMessage(message.message_id);
        console.log(`🗑️ Mensaje eliminado automáticamente: ${message.message_id}`);
      } catch (err) {
        console.error(`Error al eliminar mensaje ${message.message_id}:`, err.message);
      }
    }, TIEMPO_BORRADO_MS);
  } catch (err) {
    console.error("Error al programar borrado:", err.message);
  }
}

// Función procesarUsuario con borrado automático
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
      const msg = await ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`);
      borrarMensaje(ctx, msg);
      actualizarGrupo(chatId, false);
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
      const msg = await ctx.reply(`✅ Bienvenido ${nombre} ${username}`);
      borrarMensaje(ctx, msg);
      actualizarGrupo(chatId, true);
    }
  } catch (err) {
    const msg = await ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`);
    borrarMensaje(ctx, msg);
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

// Comando /start (versión de prueba)
bot.start(async (ctx) => {
  const msg = await ctx.reply("⚡ Bot activado en privado.");
  borrarMensaje(ctx, msg);
});
bot.command('start', async (ctx) => {
  registrarGrupo(ctx.chat.id, ctx.chat.title);
  const msg = await ctx.reply("⚡ Bot activado en grupo.");
  borrarMensaje(ctx, msg);
});
// Comando /grupos
bot.command('grupos', async (ctx) => {
  if (gruposActivos.size === 0) {
    const msg = await ctx.reply("📭 No hay grupos activos autorizados.");
    borrarMensaje(ctx, msg);
    return;
  }

  let texto = "📌 Grupos activos:\n\n";
  gruposActivos.forEach((info) => {
    texto += `• ${info.nombre} (ID: ${info.id})\n   Usuarios procesados: ${info.usuariosProcesados}\n   Usuarios rechazados: ${info.usuariosRechazados}\n   Inicio: ${info.fechaInicio.toLocaleString()}\n\n`;
  });

  const msg = await ctx.reply(texto);
  borrarMensaje(ctx, msg);
});
// Comando /auth
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

  // Extraer contraseña desde el texto del mensaje
  const partes = ctx.message.text.split(" ");
  if (partes.length < 2) {
    const msg = await ctx.reply("❌ Uso: `/auth contraseña`", { parse_mode: 'Markdown' });
    borrarMensaje(ctx, msg);
    return;
  }

  const passwordIngresado = partes.slice(1).join(" ");
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);

    gruposActivos.set(chatId, {
      nombre: ctx.chat.title,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date(),
      id: chatId
    });

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
// Comando /delgrupo <id>
bot.command('delgrupo', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    const msg = await ctx.reply("❌ Solo administradores pueden usar este comando.");
    borrarMensaje(ctx, msg);
    return;
  }
  if (!ctx.args || ctx.args.length === 0) {
    const msg = await ctx.reply("❌ Uso: `/delgrupo <id>`", { parse_mode: 'Markdown' });
    borrarMensaje(ctx, msg);
    return;
  }
  const idEliminar = parseInt(ctx.args[0]);
  if (gruposActivos.has(idEliminar)) {
    gruposActivos.delete(idEliminar);
    gruposAutorizados.delete(idEliminar);
    gruposPendientes.delete(idEliminar);
    intentosFallidos.delete(idEliminar);
    const msg = await ctx.reply(`🗑️ Grupo eliminado: ${idEliminar}`);
    borrarMensaje(ctx, msg);
  } else {
    const msg = await ctx.reply("⚠️ Ese grupo no está registrado.");
    borrarMensaje(ctx, msg);
  }
});

// Evento my_chat_member corregido
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) &&
      (['member','administrator','creator'].includes(nuevoEstado))) {
    if (gruposAutorizados.has(chatId)) {
      registrarGrupo(chatId, ctx.chat.title);
      gruposActivos.set(chatId, {
        nombre: ctx.chat.title,
        usuariosProcesados: 0,
        usuariosRechazados: 0,
        fechaInicio: new Date(),
        id: chatId
      });
      console.log(`✅ Grupo ya autorizado: ${ctx.chat.title} (${chatId})`);
    } else {
      registrarGrupo(chatId, ctx.chat.title);
      gruposPendientes.set(chatId, {
        nombre: ctx.chat.title,
        fecha_solicitud: new Date()
      });
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
