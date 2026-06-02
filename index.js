// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf } = require('telegraf');
const fs = require('fs');
const express = require('express');
const app = express();

const bot = new Telegraf(process.env.BOT_TOKEN);
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';

const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();

const FILE_GRUPOS = 'gruposActivos.json';

function guardarGrupos() {
  try {
    fs.writeFileSync(FILE_GRUPOS, JSON.stringify([...gruposActivos.values()], null, 2));
    console.log("💾 gruposActivos guardados en JSON.");
  } catch (err) {
    console.error("❌ Error al guardar grupos:", err.message);
  }
}

function cargarGrupos() {
  if (fs.existsSync(FILE_GRUPOS)) {
    try {
      const data = JSON.parse(fs.readFileSync(FILE_GRUPOS));
      data.forEach(grupo => {
        const idNum = Number(grupo.id); // ✅ forzar número
        gruposActivos.set(idNum, { ...grupo, id: idNum });
        gruposAutorizados.add(idNum);
      });
      console.log("📂 gruposActivos cargados y autorizados desde JSON.");
      console.log("🔎 gruposAutorizados contiene:", [...gruposAutorizados]);
    } catch (err) {
      console.error("❌ Error al cargar grupos:", err.message);
    }
  }
}

cargarGrupos();
// --- BLOQUE 2: Validaciones y utilidades ---
function nombreInvalido(nombre) {
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  return prohibidos.some(p => nombre.toLowerCase().includes(p));
}

function autoDelete(ctx, mensaje) {
  ctx.reply(mensaje).then(sent => {
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
    }, 10000);
  });
}
// --- BLOQUE 3: Registro y actualización de grupos ---
function registrarGrupo(chatId, nombre) {
  const idNum = Number(chatId);
  if (!gruposActivos.has(idNum)) {
    gruposActivos.set(idNum, {
      nombre,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date().toISOString(),
      id: idNum
    });
    gruposAutorizados.add(idNum);
    guardarGrupos();
    console.log(`✅ Grupo registrado y autorizado: ${nombre} (${idNum})`);
  }
}

function actualizarGrupo(chatId, procesados, rechazados) {
  const idNum = Number(chatId);
  if (gruposActivos.has(idNum)) {
    const grupo = gruposActivos.get(idNum);
    grupo.usuariosProcesados += procesados;
    grupo.usuariosRechazados += rechazados;
    gruposActivos.set(idNum, grupo);
    guardarGrupos();
  }
}
// --- BLOQUE 4: Procesamiento de usuarios ---
async function procesarUsuario(ctx, user, origen) {
  const chatId = Number(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return;

  if (nombreInvalido(user.first_name)) {
    await ctx.kickChatMember(user.id);
    actualizarGrupo(chatId, 0, 1);
    console.log(`❌ Usuario rechazado: ${user.first_name}`);
  } else {
    usuariosProcesados.add(user.id);
    actualizarGrupo(chatId, 1, 0);
    console.log(`✅ Usuario procesado: ${user.first_name}`);
  }
}
// --- BLOQUE 5: Middleware de autorización ---
bot.use(async (ctx, next) => {
  const chatId = Number(ctx.chat?.id);
  if (!chatId) return next();

  if (!gruposAutorizados.has(chatId)) {
    return autoDelete(ctx, "⚠️ Este grupo aún no está autorizado. Ingresa la contraseña.");
  }
  return next();
});
// --- BLOQUE 6: Autenticación de grupos ---
bot.command('auth', async (ctx) => {
  const chatId = Number(ctx.chat.id);
  const args = ctx.message.text.split(" ").slice(1);
  const password = args[0];

  if (password === BOT_PASSWORD) {
    registrarGrupo(chatId, ctx.chat.title || ctx.chat.username || "Grupo sin nombre");
    return ctx.reply("✅ Grupo autorizado correctamente.");
  } else {
    const intentos = (intentosFallidos.get(chatId) || 0) + 1;
    intentosFallidos.set(chatId, intentos);
    return ctx.reply(`❌ Contraseña incorrecta. Intento ${intentos}/3`);
  }
});
// --- BLOQUE 7: Limpieza de grupos ---
bot.command('delgrupo', async (ctx) => {
  const chatId = Number(ctx.chat.id);
  if (gruposActivos.has(chatId)) {
    gruposActivos.delete(chatId);
    gruposAutorizados.delete(chatId);
    guardarGrupos();
    return ctx.reply("🗑️ Grupo eliminado de la lista de autorizados.");
  } else {
    return ctx.reply("⚠️ Este grupo no estaba autorizado.");
  }
});
// --- BLOQUE 8: Comandos administrativos ---
bot.command('stats', async (ctx) => {
  const chatId = Number(ctx.chat.id);
  const grupo = gruposActivos.get(chatId);
  if (!grupo) return ctx.reply("⚠️ Grupo no autorizado.");

  return ctx.reply(
    `📊 Estadísticas del grupo:\n` +
    `Usuarios procesados: ${grupo.usuariosProcesados}\n` +
    `Usuarios rechazados: ${grupo.usuariosRechazados}\n` +
    `Fecha inicio: ${grupo.fechaInicio}`
  );
});

bot.command('grupos', async (ctx) => {
  if (gruposActivos.size === 0) return ctx.reply("⚠️ No hay grupos autorizados.");
  let mensaje = "📋 Lista de grupos autorizados:\n";
  gruposActivos.forEach(grupo => {
    mensaje += `- ${grupo.nombre} (ID: ${grupo.id})\n`;
  });
  return ctx.reply(mensaje);
});
// --- BLOQUE 9: GBAN y funciones auxiliares ---
async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

bot.command('gban', async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  const userId = Number(args[0]);
  if (!userId) return ctx.reply("⚠️ Debes indicar el ID del usuario.");

  try {
    await ctx.kickChatMember(userId);
    ctx.reply(`🚫 Usuario ${userId} baneado globalmente.`);
  } catch (err) {
    ctx.reply("❌ Error al banear usuario: " + err.message);
  }
});
// --- BLOQUE 10: Configuración de Webhook para Railway ---
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL; // ej: https://cadenero-production.up.railway.app

// Configurar webhook con la URL pública de Railway
bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);

// Endpoint para recibir actualizaciones desde Telegram
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

// Endpoint de prueba para verificar que el servicio está activo
app.get('/', (req, res) => {
  res.send('✅ Bot corriendo con Webhook en Railway');
});

// Iniciar servidor en el puerto asignado por Railway
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
// --- BLOQUE FINAL: Cierre y despliegue ---
process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada sin manejar:', reason);
});

// Confirmación de inicio
console.log("✅ Bot inicializado correctamente con Webhook en Railway.");
