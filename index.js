const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';
const fs = require('fs');
const emojiRegex = require('emoji-regex');

// Middleware para habilitar ctx.args
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const parts = ctx.message.text.split(' ');
    ctx.args = parts.slice(1);
  }
  return next();
});

// === Configuración persistente en config.json ===
const CONFIG_FILE = 'config.json';
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
  const userArg = ctx.args[0];
  const motivo = ctx.args.slice(1).join(" ") || "No especificado";
  const config = obtenerConfig(ctx.chat.id);
  if (!userArg && !ctx.message.reply_to_message) {
    return ctx.reply("⚠️ Debes responder a un mensaje o indicar un usuario.");
  }
  await ejecutarCastigo(ctx, 'ban', config.banDuration / 1000, motivo);
});

bot.command('mute', async (ctx) => {
  const [_, valor, unidad, ...motivoArr] = ctx.args;
  const motivo = motivoArr.join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'mute', convertirIntervalo(parseInt(valor), unidad), motivo);
});

bot.command('kick', async (ctx) => {
  const motivo = ctx.args.slice(1).join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'kick', 0, motivo);
});

bot.command('warn', async (ctx) => {
  const motivo = ctx.args.slice(1).join(" ") || "No especificado";
  await ejecutarCastigo(ctx, 'warn', 0, motivo);
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

  ctx.reply("📋 **Menú de Comandos del Bot**\n\nSelecciona un comando:", { 
    parse_mode: "Markdown", 
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

  if (data === "cmd_config") {
    respuesta = "⚙️ **Configuración del Bot**\nSelecciona una opción:";
    tecladoExtra = {
      inline_keyboard: [
        [
          { text: "⚠️ Warns (3)", callback_data: "set_warns_3" },
          { text: "⚠️ Warns (5)", callback_data: "set_warns_5" }
        ],
        [
          { text: "⏳ Ban 1 día", callback_data: "set_ban_1d" },
          { text: "⏳ Ban 10 días", callback_data: "set_ban_10d" }
        ],
        [
          { text: "⏳ Ban 50 días", callback_data: "set_ban_50d" },
          { text: "⏳ Ban 365 días", callback_data: "set_ban_365d" }
        ],
        [
          { text: "✍️ Ban Manual", callback_data: "set_ban_manual" }
        ],
        [
          { text: "♻️ Resetear Castigos", callback_data: "reset_castigos" }
        ],
        [
          { text: "🌐 Modo Global", callback_data: "set_modo_global" },
          { text: "👥 Modo Individual", callback_data: "set_modo_individual" }
        ]
      ]
    };
  }

 // Warns
  if (data === "set_warns_3") {
    config.warns = 3;
    configuraciones.global.modo === "global" ? configuraciones.global.warns = 3 : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⚠️ Límite de warns fijado en **3**.";
  }
  if (data === "set_warns_5") {
    config.warns = 5;
    configuraciones.global.modo === "global" ? configuraciones.global.warns = 5 : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⚠️ Límite de warns fijado en **5**.";
  }
  // Ban Durations
  if (data === "set_ban_1d") {
    config.banDuration = 1 * 24 * 60 * 60 * 1000;
    configuraciones.global.modo === "global" ? configuraciones.global.banDuration = config.banDuration : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⏳ Duración de ban configurada en **1 día**.";
  }
  if (data === "set_ban_10d") {
    config.banDuration = 10 * 24 * 60 * 60 * 1000;
    configuraciones.global.modo === "global" ? configuraciones.global.banDuration = config.banDuration : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⏳ Duración de ban configurada en **10 días**.";
  }
  if (data === "set_ban_50d") {
    config.banDuration = 50 * 24 * 60 * 60 * 1000;
    configuraciones.global.modo === "global" ? configuraciones.global.banDuration = config.banDuration : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⏳ Duración de ban configurada en **50 días**.";
  }
  if (data === "set_ban_365d") {
    config.banDuration = 365 * 24 * 60 * 60 * 1000;
    configuraciones.global.modo === "global" ? configuraciones.global.banDuration = config.banDuration : configuraciones.grupos[chatId] = config;
    guardarConfig(configuraciones);
    respuesta = "⏳ Duración de ban configurada en **365 días**.";
  }

  // Ban Manual
  if (data === "set_ban_manual") {
    respuesta = "✍️ Ingresa la duración manual del ban en días usando:\n`/setban <días>`\nEjemplo: `/setban 15`";
  }

  // Reset Castigos mejorado
  if (data === "reset_castigos") {
    intentosFallidos.clear();
    usuariosProcesados.clear();
    gruposActivos.forEach(grupo => {
      grupo.usuariosProcesados = 0;
      grupo.usuariosRechazados = 0;
    });
    respuesta = "♻️ Castigos y warns reiniciados.";
  }

  // Modo Global / Individual
  if (data === "set_modo_global") {
    configuraciones.global.modo = "global";
    guardarConfig(configuraciones);
    respuesta = "🌐 Configuración cambiada a **modo global**. Todos los grupos usarán la misma configuración.";
  }
  if (data === "set_modo_individual") {
    configuraciones.global.modo = "individual";
    guardarConfig(configuraciones);
    respuesta = "👥 Configuración cambiada a **modo individual**. Cada grupo tendrá su propia configuración.";
  }

  // Cancelar configuración
  if (data === "cancel_config") {
    respuesta = "❎ Configuración cancelada.";
  }

  // Respuesta final al usuario
  await bot.telegram.sendMessage(chatId, respuesta, { 
    parse_mode: "Markdown", 
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
    const username = ctx.args[0].replace('@', '');
    try {
      const miembro = await ctx.telegram.getChatMember(ctx.chat.id, username);
      return miembro.user.id;
    } catch {
      return null;
    }
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
        permissions: { can_send_messages: false },
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
