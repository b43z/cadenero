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
            gruposAutorizados.add(Number(grupo.id)); // 🔎 aseguramos que sea número
          }
        });

        console.log(`✅ Se cargaron ${gruposActivos.size} grupos desde ${FILE_GRUPOS}`);
        console.log("🔎 Grupos autorizados al inicio:", [...gruposAutorizados]);
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
    gruposAutorizados.add(Number(chatId)); // 🔎 aseguramos que quede autorizado
    guardarGrupos();
    console.log(`📌 Grupo registrado: ${nombre} (${chatId})`);
  }
}
// Cargar grupos al iniciar
// --- BLOQUE 2: Utilidades y validaciones ---
cargarGrupos();

// 🔧 Corrección: asegurar que todos los grupos cargados queden autorizados
for (const [id] of gruposActivos.entries()) {
  gruposAutorizados.add(Number(id));
}

console.log("🔎 Grupos autorizados tras cargar archivo:", [...gruposAutorizados]);

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
js
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

  const grupo = gruposActivos.get(ctx.chat.id);
  let mensaje = `⚡ Bot activado en el grupo "${ctx.chat.title}" (ID: ${ctx.chat.id}).\n`;

  if (grupo) {
    mensaje += `📊 Usuarios procesados: ${grupo.usuariosProcesados}\n`;
    mensaje += `🚫 Usuarios rechazados: ${grupo.usuariosRechazados}\n`;
    mensaje += `📅 Fecha de inicio: ${grupo.fechaInicio}`;
  } else {
    mensaje += "⚠️ Este grupo aún no está registrado en memoria.";
  }

  // Si quieres que el mensaje se borre al minuto:
  // autoDelete(ctx, ctx.reply(mensaje));

  // Si quieres que el mensaje permanezca:
  ctx.reply(mensaje);
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
// --- BLOQUE 7: Limpieza automática y manejo de miembros ---
// Diagnóstico: mostrar grupos autorizados al inicio
console.log("🔎 Grupos autorizados al arrancar:", [...gruposAutorizados]);

setInterval(async () => {
  const ahora = new Date();
  for (const [chatId, info] of gruposPendientes.entries()) {
    const minutosPendiente = (ahora - info.fecha_solicitud) / 1000 / 60;
    if (minutosPendiente > 10) {
      try {
        await bot.telegram.leaveChat(chatId);
        gruposPendientes.delete(chatId);
        gruposActivos.delete(chatId);
        intentosFallidos.delete(chatId);
        guardarGrupos();
        console.log(`⏱️ Grupo eliminado automáticamente por no autorizarse: ${chatId}`);
      } catch (err) {
        console.error(`Error al salir del grupo ${chatId}:`, err.message);
      }
    }
  }
}, 60000);

// Procesar nuevos miembros
bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`👥 Nuevos miembros detectados en grupo ${chatId}`);
  if (!gruposAutorizados.has(chatId)) {
    console.warn(`⚠️ Grupo ${chatId} no está en gruposAutorizados, no se procesan usuarios.`);
    return autoDelete(ctx, ctx.reply("⚠️ Este grupo aún no está autorizado. Ingresa la contraseña."));
  }
  for (const user of ctx.message.new_chat_members) {
    await procesarUsuario(ctx, user, 'directo');
  }
});

// Procesar solicitudes de unión
bot.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`📩 Solicitud de unión detectada en grupo ${chatId}`);
  if (!gruposAutorizados.has(chatId)) {
    console.warn(`⚠️ Grupo ${chatId} no está en gruposAutorizados, solicitud no procesada.`);
    return autoDelete(ctx, ctx.reply("⚠️ Este grupo aún no está autorizado. Ingresa la contraseña."));
  }
  const user = ctx.chatJoinRequest.from;
  await procesarUsuario(ctx, user, 'solicitud');
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
// ---Comando /grupos corregido ---
bot.command('grupos', async (ctx) => {
  console.log("🚀 Entró al comando /grupos en chatId:", ctx.chat.id);

  try {
    const data = fs.readFileSync(FILE_GRUPOS, "utf8");
    console.log("📂 Contenido bruto del archivo:", data);

    const grupos = JSON.parse(data);
    console.log("📋 Grupos parseados:", grupos);

    // Convertir chatId a número para evitar BigInt vs Number
    const chatIdNum = Number(ctx.chat.id);
    const grupoActual = grupos.find(g => Number(g.id) === chatIdNum);
    console.log("🔎 Resultado búsqueda:", grupoActual);

    let mensaje;
    if (grupoActual) {
      mensaje = `✅ El grupo "${ctx.chat.title}" (ID: ${chatIdNum}) está registrado.\n` +
                `Procesados: ${grupoActual.usuariosProcesados} | Rechazados: ${grupoActual.usuariosRechazados}`;
    } else {
      mensaje = `⚠️ El grupo "${ctx.chat.title}" (ID: ${chatIdNum}) NO está registrado.`;
    }

    console.log("📤 Mensaje a enviar:", mensaje);
    await ctx.reply(mensaje);
  } catch (err) {
    console.error("❌ Error en /grupos:", err);
    await ctx.reply("❌ Error al leer el archivo de grupos.");
  }
});
// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
