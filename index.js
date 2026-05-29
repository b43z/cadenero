// --- BLOQUE 1: Imports, inicialización y persistencia ---
const { Telegraf } = require('telegraf');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'b43z6028-cirrus';
const FILE_GRUPOS = "gruposActivos.json";

const bot = new Telegraf(BOT_TOKEN);

// Estado en memoria
const usuariosProcesados = new Set();
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const gruposPendientes = new Map();
const intentosFallidos = new Map();
const timeoutMap = new Map();

// Funciones de persistencia
function cargarGrupos() {
  try {
    if (fs.existsSync(FILE_GRUPOS)) {
      const data = fs.readFileSync(FILE_GRUPOS, "utf8");
      if (data.trim().length > 0) {
        const grupos = JSON.parse(data);
        gruposActivos.clear();
        gruposAutorizados.clear();

        grupos.forEach(grupo => {
          if (grupo.id && grupo.nombre) {
            gruposActivos.set(grupo.id, grupo);
            gruposAutorizados.add(grupo.id);
          }
        });

        console.log(`✅ Se cargaron ${gruposActivos.size} grupos desde ${FILE_GRUPOS}`);
      } else {
        console.warn("⚠️ El archivo de grupos está vacío.");
      }
    } else {
      console.warn("⚠️ No existe el archivo de grupos, creando uno nuevo vacío");
      fs.writeFileSync(FILE_GRUPOS, "[]", "utf8");
    }
  } catch (err) {
    console.error("❌ Error al cargar grupos:", err.message);
  }
}

function guardarGrupos() {
  try {
    fs.writeFileSync(FILE_GRUPOS, JSON.stringify([...gruposActivos.values()], null, 2), "utf8");
    console.log(`💾 Se guardaron ${gruposActivos.size} grupos en ${FILE_GRUPOS}`);
  } catch (err) {
    console.error("❌ Error al guardar grupos:", err.message);
  }
}

function registrarGrupo(chatId, nombre) {
  if (!gruposActivos.has(chatId)) {
    gruposActivos.set(chatId, {
      nombre,
      usuariosProcesados: 0,
      usuariosRechazados: 0,
      fechaInicio: new Date().toISOString(),
      id: chatId
    });
    guardarGrupos();
    console.log(`📌 Grupo registrado: ${nombre} (${chatId})`);
  }
}

// Cargar grupos al iniciar
// --- BLOQUE 2: Utilidades y validaciones ---
cargarGrupos();
const VALIDACIONES = {
  soloSimbolos: /^[\p{P}\p{S}]+$/u,
  unaLetra: /^[A-Za-zÁÉÍÓÚÜÑ]$/u,
  letrasRepetidas: /(.)\1{2,}/u,
  letraMasSimbolo: /^[A-Za-zÁÉÍÓÚÜÑ][\p{P}\p{S}]$/u
};

function nombreInvalido(nombre) {
  if (!nombre) return true;
  return (
    VALIDACIONES.soloSimbolos.test(nombre) ||
    VALIDACIONES.unaLetra.test(nombre) ||
    VALIDACIONES.letrasRepetidas.test(nombre) ||
    VALIDACIONES.letraMasSimbolo.test(nombre)
  );
}

async function autoDelete(ctx, messagePromise) {
  try {
    const sent = await messagePromise;
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
    }, 60000); // 1 minuto
  } catch (err) {
    console.error("Error al enviar/borrar mensaje:", err.message);
  }
}

async function esAdminDelGrupo(ctx, userId) {
  try {
    const miembro = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(miembro.status);
  } catch {
    return false;
  }
}
// --- BLOQUE 3: Procesamiento de usuarios ---
function limpiarUsuarioProcesado(userId) {
  if (timeoutMap.has(userId)) clearTimeout(timeoutMap.get(userId));
  const timeout = setTimeout(() => {
    usuariosProcesados.delete(userId);
    timeoutMap.delete(userId);
  }, 30000);
  timeoutMap.set(userId, timeout);
}

function actualizarGrupo(chatId, aprobado = true) {
  if (gruposActivos.has(chatId)) {
    const grupo = gruposActivos.get(chatId);
    grupo.usuariosProcesados++;
    if (!aprobado) grupo.usuariosRechazados++;
    guardarGrupos();
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
      if (tipo === 'solicitud') await ctx.telegram.declineChatJoinRequest(chatId, userId);
      else await ctx.telegram.banChatMember(chatId, userId);
      await autoDelete(ctx, ctx.reply(`🚫 Usuario rechazado: ${nombre} ${username}`));
      actualizarGrupo(chatId, false);
    } else {
      if (tipo === 'solicitud') await ctx.telegram.approveChatJoinRequest(chatId, userId);
      await autoDelete(ctx, ctx.reply(`✅ Bienvenido ${nombre} ${username}`));
      actualizarGrupo(chatId, true);
    }
  } catch (err) {
    await autoDelete(ctx, ctx.reply(`❌ Error al procesar ${nombre}: ${err.message}`));
  }
}
// --- BLOQUE 4: Middleware y comandos básicos ---
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const parts = ctx.message.text.split(' ');
    ctx.args = parts.slice(1);
  }
  return next();
});

bot.start((ctx) => {
  registrarGrupo(ctx.chat.id, ctx.chat.title);
  autoDelete(ctx, ctx.reply("⚡ Bot activado. Evaluará automáticamente a los nuevos usuarios."));
});
// --- BLOQUE 5: Manejo de entrada/salida del bot ---
bot.on('my_chat_member', async (ctx) => {
  const chatId = ctx.chat.id;
  const nuevoEstado = ctx.myChatMember.new_chat_member.status;
  const estadoAnterior = ctx.myChatMember.old_chat_member.status;

  if ((estadoAnterior === 'left' || estadoAnterior === 'kicked' || !estadoAnterior) &&
      (['member','administrator','creator'].includes(nuevoEstado))) {
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.set(chatId, { nombre: ctx.chat.title, fecha_solicitud: new Date() });
    autoDelete(ctx, ctx.reply("🔐 Este grupo requiere autenticación.\nResponde con la contraseña:", {
      reply_markup: { force_reply: true, selective: true }
    }));
  }

  if (nuevoEstado === 'left' || nuevoEstado === 'kicked') {
    gruposActivos.delete(chatId);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    guardarGrupos();
    console.log(`🗑️ Bot eliminado del grupo: ${chatId}`);
  }
});
// --- BLOQUE 6: Autenticación de grupos ---
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  if (gruposPendientes.has(chatId) && ctx.message.text) {
    const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
    if (!esAdmin) return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden autorizar el grupo."));

    const passwordIngresado = ctx.message.text.trim();
    if (passwordIngresado === BOT_PASSWORD) {
      gruposAutorizados.add(chatId);
      registrarGrupo(chatId, ctx.chat.title);
      gruposPendientes.delete(chatId);
      intentosFallidos.delete(chatId);
      guardarGrupos();
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      autoDelete(ctx, ctx.reply("✅ Grupo autorizado correctamente."));
    } else {
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
           autoDelete(ctx, ctx.reply("❌ Contraseña incorrecta. El bot se eliminará en 10 minutos si no se autoriza."));
      intentosFallidos.set(chatId, (intentosFallidos.get(chatId) || 0) + 1);
    }
  }
});
      autoDelete(ctx, ctx.reply("❌ Contraseña incorrecta. El bot se eliminará en 10 minutos si no se autoriza."));
      intentosFallidos.set(chatId, (intentosFallidos.get(chatId) || 0) + 1);
    }
  }
});
// --- BLOQUE 8: Comandos administrativos ---
// Comando /delgrupo <id>
bot.command('delgrupo', async (ctx) => {
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden usar este comando."));
  if (!ctx.args || ctx.args.length === 0) return autoDelete(ctx, ctx.reply("❌ Uso: `/delgrupo <id>`", { parse_mode: 'Markdown' }));

  const idEliminar = parseInt(ctx.args[0]);
  if (isNaN(idEliminar)) return autoDelete(ctx, ctx.reply("⚠️ El ID debe ser un número válido."));

  if (gruposActivos.has(idEliminar)) {
    gruposActivos.delete(idEliminar);
    gruposAutorizados.delete(idEliminar);
    gruposPendientes.delete(idEliminar);
    intentosFallidos.delete(idEliminar);
    guardarGrupos();
    autoDelete(ctx, ctx.reply(`🗑️ Grupo eliminado: ${idEliminar}`));
    console.log(`🗑️ Grupo eliminado manualmente: ${idEliminar}`);
  } else {
    autoDelete(ctx, ctx.reply("⚠️ Ese grupo no está registrado."));
  }
});

// Comando /auth <password>
bot.command('auth', async (ctx) => {
  const chatId = ctx.chat.id;
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden autorizar el grupo."));
  if (!ctx.args || ctx.args.length === 0) return autoDelete(ctx, ctx.reply("❌ Uso: `/auth <password>`", { parse_mode: 'Markdown' }));

  const passwordIngresado = ctx.args[0].trim();
  if (passwordIngresado === BOT_PASSWORD) {
    gruposAutorizados.add(chatId);
    registrarGrupo(chatId, ctx.chat.title);
    gruposPendientes.delete(chatId);
    intentosFallidos.delete(chatId);
    guardarGrupos();
    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    autoDelete(ctx, ctx.reply("✅ Grupo autorizado correctamente."));
    console.log(`🔑 Grupo autorizado vía /auth: ${ctx.chat.title} (${chatId})`);
  } else {
    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    autoDelete(ctx, ctx.reply("❌ Contraseña incorrecta."));
    intentosFallidos.set(chatId, (intentosFallidos.get(chatId) || 0) + 1);
  }
});

// Comando /grupos simplificado
bot.command('grupos', async (ctx) => {
  const chatId = ctx.chat.id;
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id);
  if (!esAdmin) {
    return autoDelete(ctx, ctx.reply("❌ Solo administradores pueden usar este comando."));
  }

  try {
    const data = fs.readFileSync(FILE_GRUPOS, "utf8");

    if (!data || data.trim().length === 0) {
      return autoDelete(ctx, ctx.reply("⚠️ El archivo de grupos está vacío. Este grupo NO está registrado."));
    }

    const grupos = JSON.parse(data);

    if (!Array.isArray(grupos) || grupos.length === 0) {
      return autoDelete(ctx, ctx.reply("⚠️ No hay grupos registrados en el archivo JSON. Este grupo NO está registrado."));
    }

    const grupoActual = grupos.find(g => Number(g.id) === Number(chatId));
    let mensaje;
    if (grupoActual) {
      mensaje = `✅ El grupo "${ctx.chat.title}" (ID: ${chatId}) está registrado y funcionando.\n` +
                `Procesados: ${grupoActual.usuariosProcesados} | Rechazados: ${grupoActual.usuariosRechazados}`;
    } else {
      mensaje = `⚠️ El grupo "${ctx.chat.title}" (ID: ${chatId}) NO está registrado.`;
    }

    autoDelete(ctx, ctx.reply(mensaje));
  } catch (err) {
    console.error("❌ Error al leer grupos:", err.message);
    return autoDelete(ctx, ctx.reply("❌ Error al leer el archivo de grupos."));
  }
});
// --- BLOQUE 9: Lanzamiento y cierre del bot ---
bot.launch()
  .then(() => console.log("✅ Bot iniciado en Railway."))
  .catch((err) => {
    console.error("❌ Error al iniciar:", err);
    // No usamos process.exit(1) para evitar bucles en Railway
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
