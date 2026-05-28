const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);

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
    gruposActivos.set(ctx.chat.id, {
      nombre: ctx.chat.title,
      usuariosProcesados: 0,
      usuariosRechazados: 0
    });
    ctx.reply("✅ Grupo autorizado y activado correctamente. Ya puedes usar /grupos y /stats.");
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
