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

// === Comando /start ===
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
const usuariosProcesados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();

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

// === Ejecutar castigo solo si es admin ===
async function ejecutarCastigo(ctx, tipo, duracionSegundos = 0, motivo = "No especificado") {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return ctx.reply("❌ Este comando es exclusivo para administradores.");
  }
  const userId = await obtenerUserId(ctx);
  if (!userId) return ctx.reply("⚠️ Debes responder al mensaje o indicar un usuario válido.");
  await aplicarCastigo(ctx, userId, tipo, duracionSegundos, motivo);
}

// === Comandos de castigo ===
bot.command('ban', async (ctx) => {
  const motivo = ctx.args.join(" ") || "No especificado";
  const config = obtenerConfig(ctx.chat.id);
  if (!ctx.message.reply_to_message && ctx.args.length === 0) {
    return ctx.reply("⚠️ Debes responder a un mensaje o indicar un usuario.");
  }
  await ejecutarCastigo(ctx, 'ban', config.banDuration / 1000, motivo);
});

bot.command('mute', async (ctx) => {
  const [valor, unidad, ...motivoArr] = ctx.args;
  if (!valor || isNaN(valor)) {
    return ctx.reply("⚠️ Debes indicar un número válido y unidad (s/m/h/d).");
  }
  const motivo = motivoArr.join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'mute', convertirIntervalo(parseInt(valor), unidad), motivo);
});

bot.command('kick', async (ctx) => {
  const motivo = ctx.args.join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'kick', 0, motivo);
});

bot.command('warn', async (ctx) => {
  const motivo = ctx.args.join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'warn', 0, motivo);
});

// === Comando /grupos ===
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

// === Comando /menu ===
bot.command('menu', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);

  const tecladoBase = [
    [
      { text: "⚡ /start", callback_data: "cmd_start" },
      { text: "📊 /grupos", callback_data: "cmd_grupos" }
    ],
    [
      { text: "🔑 /auth", callback_data: "cmd_auth" },
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

// === Manejo de botones (configuración y menú) ===
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const config = obtenerConfig(chatId);

  let respuesta = "";
  let tecladoExtra = null;

  if (data === "cmd_start") {
    respuesta = "⚡ Usa el comando /start directamente en el grupo para activar el bot.";
  }
  if (data === "cmd_grupos") {
    if (gruposActivos.size === 0) {
      respuesta = "📭 El bot no está activo en ningún grupo aún.";
    } else {
      respuesta = "📊 Grupos activos:\n\n";
      gruposActivos.forEach((grupo, id) => {
        respuesta += `• ${grupo.nombre} (ID: ${id})\n   Estado: ${grupo.autorizado ? "✅ Autorizado" : "⚠️ Pendiente"}\n   Procesados: ${grupo.usuariosProcesados}\n   Rechazados: ${grupo.usuariosRechazados}\n\n`;
      });
    }
  }

  // Aquí mantienes la lógica de configuración (set_warns, set_ban, etc.)

  await bot.telegram.sendMessage(chatId, respuesta, { 
    parse_mode: "MarkdownV2", 
    reply_markup: tecladoExtra || undefined 
  });
  await bot.answerCallbackQuery(ctx.callbackQuery.id);
});

// === Funciones auxiliares necesarias ===
async function obtenerUserId(ctx) {
  if (ctx.message.reply_to_message) {
    return ctx.message.reply_to_message.from.id;
  }
  if (ctx.args && ctx.args[0]) {
    const idNum = parseInt(ctx.args[0]);
    if (!isNaN(idNum)) return idNum;
    return null; // no se soporta username directo
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
