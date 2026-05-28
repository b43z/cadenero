const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';
const fs = require('fs');

// === Registro de grupos activos ===
const gruposActivos = new Map();
const gruposAutorizados = new Set(
  (process.env.AUTHORIZED_GROUPS || "")
    .split(",")
    .filter(id => id)
    .map(id => parseInt(id))
);

// === Comando /start (privado y grupos) ===
bot.start((ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    gruposActivos.set(ctx.chat.id, {
      nombre: ctx.chat.title,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      autorizado: gruposAutorizados.has(ctx.chat.id)
    });
    ctx.reply("⚡ Bot activado en este grupo. Evaluará automáticamente a los nuevos usuarios.");
  } else {
    ctx.reply("⚡ El Cadenero está en funciones. Usa /menu para ver opciones.");
  }
});

// Middleware para habilitar ctx.args
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const parts = ctx.message.text.trim().split(/\s+/);
    ctx.args = parts.slice(1);
  }
  return next();
});

// === Configuración persistente en config.json ===
const CONFIG_FILE = 'config.json';
function cargarConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ 
      global: { warns: 3, banDuration: 86400000, modo: "global" }, 
      grupos: {} 
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE));
}
function guardarConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
let configuraciones = cargarConfig();
function obtenerConfig(chatId) {
  if (configuraciones.global.modo === "global") {
    return configuraciones.global;
  }
  if (!configuraciones.grupos[chatId]) {
    configuraciones.grupos[chatId] = { 
      warns: configuraciones.global.warns, 
      banDuration: configuraciones.global.banDuration 
    };
    guardarConfig(configuraciones);
  }
  return configuraciones.grupos[chatId];
}

// === Verificar si el usuario es administrador ===
async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(miembro.status);
  } catch {
    return false;
  }
}

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

// === Comandos principales ===
bot.command('grupos', (ctx) => {
  if (gruposActivos.size === 0) {
    return ctx.reply("📭 El bot no está activo en ningún grupo aún.");
  }
  let salida = "📊 *Grupos activos:*\n\n";
  gruposActivos.forEach((grupo, id) => {
    salida += `• ${grupo.nombre} (ID: ${id})\n   Estado: ${grupo.autorizado ? "✅ Autorizado" : "⚠️ Pendiente"}\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n\n`;
  });
  ctx.reply(salida, { parse_mode: "MarkdownV2" });
});

bot.command('stats', (ctx) => {
  if (gruposActivos.size === 0) {
    return ctx.reply("📭 No hay estadísticas porque el bot no está activo en ningún grupo.");
  }
  let salida = "📈 *Estadísticas del bot:*\n\n";
  gruposActivos.forEach((grupo, id) => {
    salida += `• ${grupo.nombre} (ID: ${id})\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n   Estado: ${grupo.autorizado ? "✅ Autorizado" : "⚠️ Pendiente"}\n\n`;
  });
  ctx.reply(salida, { parse_mode: "MarkdownV2" });
});

bot.command('menu', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  const tecladoBase = [
    [
      { text: "⚡ /start", callback_data: "cmd_start" },
      { text: "📊 /grupos", callback_data: "cmd_grupos" }
    ],
    [
      { text: "📈 /stats", callback_data: "cmd_stats" },
      { text: "🔑 /auth", callback_data: "cmd_auth" }
    ],
    [
      { text: "🗑️ /delgrupo", callback_data: "cmd_delgrupo" }
    ]
  ];
  if (esAdmin) {
    tecladoBase.push([{ text: "⚙️ Configuración", callback_data: "cmd_config" }]);
  }
  ctx.reply("📋 *Menú de Comandos del Bot*\n\nSelecciona un comando:", { 
    parse_mode: "MarkdownV2", 
    reply_markup: { inline_keyboard: tecladoBase }
  });
});
// === Acciones de botones inline ===
bot.action('cmd_start', async (ctx) => {
  await ctx.reply("⚡ Usa el comando /start directamente en el grupo para activar el bot.");
  await ctx.answerCallbackQuery();
});

bot.action('cmd_grupos', async (ctx) => {
  if (gruposActivos.size === 0) {
    await ctx.reply("📭 El bot no está activo en ningún grupo aún.");
  } else {
    let salida = "📊 Grupos activos:\n\n";
    gruposActivos.forEach((grupo, id) => {
      salida += `• ${grupo.nombre} (ID: ${id})\n   Estado: ${grupo.autorizado ? "✅ Autorizado" : "⚠️ Pendiente"}\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n\n`;
    });
    await ctx.reply(salida, { parse_mode: "MarkdownV2" });
  }
  await ctx.answerCallbackQuery();
});

bot.action('cmd_stats', async (ctx) => {
  if (gruposActivos.size === 0) {
    await ctx.reply("📭 No hay estadísticas porque el bot no está activo en ningún grupo.");
  } else {
    let salida = "📈 Estadísticas del bot:\n\n";
    gruposActivos.forEach((grupo, id) => {
      salida += `• ${grupo.nombre} (ID: ${id})\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n   Estado: ${grupo.autorizado ? "✅ Autorizado" : "⚠️ Pendiente"}\n\n`;
    });
    await ctx.reply(salida, { parse_mode: "MarkdownV2" });
  }
  await ctx.answerCallbackQuery();
});

bot.action('cmd_auth', async (ctx) => {
  await ctx.reply("🔑 Usa /auth <password> para autorizar este grupo.");
  await ctx.answerCallbackQuery();
});

bot.action('cmd_delgrupo', async (ctx) => {
  await ctx.reply("🗑️ Usa /delgrupo para eliminar este grupo de la lista de activos.");
  await ctx.answerCallbackQuery();
});

bot.action('cmd_config', async (ctx) => {
  await ctx.reply("⚙️ Panel de configuración. Aquí podrás ajustar warns y duración de baneos.");
  await ctx.answerCallbackQuery();
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
