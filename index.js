const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const fs = require('fs');

// === Password requerido ===
const BOT_PASSWORD = "b43z6028-cirrus";

// === Registro de grupos activos y autorizados ===
const gruposActivos = new Map();
const gruposAutorizados = new Set();

// === Comando /start ===
bot.start((ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    if (!gruposAutorizados.has(ctx.chat.id)) {
      ctx.reply("🔒 Este grupo no está autorizado. Usa /auth <password> para activarlo.");
      return;
    }
    gruposActivos.set(ctx.chat.id, {
      nombre: ctx.chat.title,
      usuariosProcesados: 0,
      usuariosRechazados: 0
    });
    ctx.reply("⚡ Bot activado en este grupo. Evaluará automáticamente a los nuevos usuarios.");
  } else {
    ctx.reply("⚡ El Cadenero está en funciones. Usa /grupos o /stats para ver opciones.");
  }
});

// === Comando /auth ===
bot.command('auth', (ctx) => {
  const args = ctx.message.text.split(" ");
  const password = args[1];
  if (!password) {
    return ctx.reply("⚠️ Debes ingresar el password. Ejemplo: /auth b43z6028-cirrus");
  }
  if (password === BOT_PASSWORD) {
    gruposAutorizados.add(ctx.chat.id);
    ctx.reply("✅ Grupo autorizado correctamente. Ahora puedes usar /start.");
  } else {
    ctx.reply("❌ Password incorrecto. Intenta de nuevo.");
  }
});

// === Comando /grupos ===
bot.command('grupos', (ctx) => {
  if (gruposActivos.size === 0) {
    return ctx.reply("📭 El bot no está activo en ningún grupo aún.");
  }
  let salida = "📊 *Grupos activos:*\n\n";
  gruposActivos.forEach((grupo, id) => {
    salida += `• ${grupo.nombre} (ID: ${id})\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n\n`;
  });
  ctx.reply(salida, { parse_mode: "MarkdownV2" });
});

// === Comando /stats ===
bot.command('stats', (ctx) => {
  if (gruposActivos.size === 0) {
    return ctx.reply("📭 No hay estadísticas porque el bot no está activo en ningún grupo.");
  }
  let salida = "📈 *Estadísticas del bot:*\n\n";
  gruposActivos.forEach((grupo, id) => {
    salida += `• ${grupo.nombre} (ID: ${id})\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n\n`;
  });
  ctx.reply(salida, { parse_mode: "MarkdownV2" });
});
// === Funciones auxiliares ===
async function obtenerUserId(ctx) {
  if (ctx.message && ctx.message.reply_to_message) {
    return ctx.message.reply_to_message.from.id;
  }
  if (ctx.args && ctx.args[0]) {
    const idNum = parseInt(ctx.args[0]);
    if (!isNaN(idNum)) return idNum;
    return null;
  }
  return null;
}

async function aplicarCastigo(ctx, userId, tipo, duracionSegundos, motivo) {
  try {
    if (tipo === 'ban') {
      await ctx.telegram.banChatMember(ctx.chat.id, userId, { until_date: Math.floor(Date.now() / 1000) + duracionSegundos });
      return ctx.reply(`🚫 Usuario baneado por ${Math.floor(duracionSegundos / 86400)} días. Motivo: ${motivo}`);
    }
    if (tipo === 'mute') {
      await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
        permissions: { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false },
        until_date: Math.floor(Date.now() / 1000) + duracionSegundos
      });
      return ctx.reply(`🔇 Usuario muteado por ${Math.floor(duracionSegundos / 3600)} horas. Motivo: ${motivo}`);
    }
    if (tipo === 'kick') {
      await ctx.telegram.banChatMember(ctx.chat.id, userId);
      await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
      return ctx.reply(`👢 Usuario expulsado. Motivo: ${motivo}`);
    }
    if (tipo === 'warn') {
      return ctx.reply(`⚠️ Usuario advertido. Motivo: ${motivo}`);
    }
  } catch (err) {
    console.error("Error en aplicarCastigo:", err);
    return ctx.reply("❌ Error al aplicar el castigo.");
  }
}

function convertirIntervalo(valor, unidad) {
  switch (unidad) {
    case 's': return valor;
    case 'm': return valor * 60;
    case 'h': return valor * 3600;
    case 'd': return valor * 86400;
    default: return valor;
  }
}

// === Lanzar bot en Railway ===
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    process.exit(1);
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
