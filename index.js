// ============================================================================
//   SISTEMA DE CONTROL — FEDERACIÓN CANCERBEROS
//   Archivo: index.js (Optimizado para Estructura de Array JSON de GitHub)
// ============================================================================

// --- BLOQUE 1: Imports e Inicialización ---
const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// Validación estricta de variables de entorno esenciales
if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL) {
  console.error("❌ ERROR CRÍTICO: Faltan variables de entorno esenciales (BOT_TOKEN o WEBHOOK_URL)");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Mapas de control volátiles en memoria RAM
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const mensajesActivos = new Map();           // chatId -> array de message_id
const temporizadoresSolicitudes = new Map(); // "userId_chatId" -> setTimeout

let botPausado = false; 

// Ruta del archivo de configuración estático provisto desde tu repositorio de GitHub
const RUTA_JSON = path.join(__dirname, 'gruposActivos.json');

// --- FUNCIÓN: Cargar configuración estática desde el Array de tu JSON ---
function cargarConfiguracionMaestra() {
  if (!fs.existsSync(RUTA_JSON)) {
    console.error("⚠️ ALERTA: No se encontró el archivo 'gruposActivos.json' en la raíz. El bot arrancará vacío.");
    return;
  }

  try {
    const data = fs.readFileSync(RUTA_JSON, 'utf8');
    const listaGrupos = JSON.parse(data);
    let contador = 0;

    if (Array.isArray(listaGrupos)) {
      listaGrupos.forEach(grupo => {
        if (!grupo.id) return;
        
        const idStr = String(grupo.id);
        
        // Mapeo exacto de los atributos de tu JSON a la memoria de ejecución
        gruposActivos.set(idStr, {
          id: idStr,
          nombre: grupo.nombre || "Grupo Federación",
          usuariosProcesados: parseInt(grupo.usuariosProcesados) || 0, // Base estática de GitHub
          usuariosRechazados: parseInt(grupo.usuariosRechazados) || 0,   // Base estática de GitHub
          fechaInicio: grupo.fechaInicio || new Date().toISOString(),
          reglamento: parseInt(grupo.reglamento) || 1,
          verBienvenida: grupo.verBienvenida !== false, // Por si agregas el flag después
          verRechazo: grupo.verRechazo !== false
        });
        
        gruposAutorizados.add(idStr);
        contador++;
      });
      console.log(`📦 CONFIGURACIÓN MAESTRA: Se cargaron con éxito ${contador} grupos desde el Array JSON a la RAM.`);
    } else {
      console.error("❌ CONFIGURACIÓN MAESTRA: El formato del JSON no es un Array [] válido.");
    }
  } catch (err) {
    console.error("❌ CONFIGURACIÓN MAESTRA: Error severo al parsear gruposActivos.json:", err.message);
  }
}

// Inicializar la carga fija al encender el contenedor en Railway
cargarConfiguracionMaestra();

// Catálogo de Reglamentos Internos en formato HTML Soportado por Telegram
const REGLAMENTOS = {
  1: `💬 <b>COTORREO</b> 💬\nEste es un grupo para pláticas y desmadre. <b>NO es un espacio XXX, HOT ni de encuentros.</b>\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Preséntate:</b> interactúa, no seas un "mueble" o serás expulsado.\n💀 <b>Estrictamente prohibido:</b> Enviar fotopitos al grupo, CP, Gore, Zoo, etc.\n💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Creadoras de Contenido:</b> Pide permiso a un Admin y verifícate.\n💀 <b>Material Temporal:</b> Solo Material propio +18 (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.\n💀 <b>Límites:</b> No confundas el cotorreo con el bullying.`,

  2: `🔥<b>COTORREO HOT</b>🔥\nEspacio para conocer Gente HOT, interactuar de forma caliente y promover contenido, sin caer en el morbo pesado.\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Actividad:</b> Intégrate al desmadre, evita quedarte de "mueble".\n💀 <b>Estrictamente prohibido:</b> Fotopitos, CP, Gore, Zoo, Material Ilegal, etc.\n💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Creadoras de Contenido:</b> Pide permiso y verifícate.\n💀 <b>Material Temporal:</b> Solo Material +18 Propio, no dormidas, filtrados, exs, (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.`
};

// --- BLOQUE 2: Validaciones y utilidades ---
async function esAdminDelGrupo(ctx, userId) {
  try {
    const admins = await ctx.getChatAdministrators();
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

function nombreInvalido(nombre) {
  if (!nombre) return true;
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  const limpio = nombre.trim();
  const sinEspacios = limpio.replace(/\s+/g, '');

  if (prohibidos.some(p => limpio.toLowerCase().includes(p))) return true;
  
  const soloTexto = limpio.replace(/[\d\s\p{P}\p{S}\p{Emoji}]/gu, '');
  if (soloTexto.length < 3) return true;
  
  const regexLatina = /^[\p{Script=Latin}]+$/u;
  if (!regexLatina.test(soloTexto)) return true;
  if (/^\d+$/.test(sinEspacios)) return true;
  if (/(.)\1{2,}/.test(sinEspacios)) return true; 

  if (soloTexto.length <= 4) {
    if (!/[aeiouáéíóúüy]/i.test(soloTexto)) return true;
  }
  return false;
}

function autoDelete(ctx, mensaje) {
  const chatId = String(ctx.chat.id);
  const sendPromise = typeof mensaje === "string"
    ? ctx.reply(mensaje)
    : ctx.reply(mensaje.text, mensaje.options);

  sendPromise.then(sent => {
    if (mensajesActivos.has(chatId)) {
      const lista = mensajesActivos.get(chatId);
      while (lista.length > 0) {
        const viejoId = lista.shift();
        ctx.deleteMessage(viejoId).catch(() => {}); 
      }
    } else {
      mensajesActivos.set(chatId, []);
    }

    const lista = mensajesActivos.get(chatId);
    lista.push(sent.message_id);

    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      const idx = lista.indexOf(sent.message_id);
      if (idx !== -1) lista.splice(idx, 1);
      if (lista.length === 0) mensajesActivos.delete(chatId);
    }, 240000); // Purga automática a los 4 minutos
    
  }).catch(err => console.error("❌ Error en función autoDelete:", err.message));
}

function acumularMetricasRAM(chatId, procesados, rechazados) {
  const idStr = String(chatId);
  if (gruposActivos.has(idStr)) {
    const group = gruposActivos.get(idStr);
    group.usuariosProcesados += procesados;
    group.usuariosRechazados += rechazados;
    gruposActivos.set(idStr, group); 
  }
}

function limpiarTemporizadorSolicitud(userId, chatId) {
  const llave = `${userId}_${chatId}`;
  if (temporizadoresSolicitudes.has(llave)) {
    clearTimeout(temporizadoresSolicitudes.get(llave));
    temporizadoresSolicitudes.delete(llave);
  }
}

async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  const idStr = String(chatId);
  if (!gruposAutorizados.has(idStr)) return;

  limpiarTemporizadorSolicitud(user.id, idStr);
  const username = user.username ? ` 🆔 @${user.username}` : " 🆔 (sin username)";

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(idStr, user.id);
      acumularMetricasRAM(idStr, 0, 1);
      
      const configGrupo = gruposActivos.get(idStr) || { verRechazo: true };
      if (configGrupo.verRechazo !== false) {
        autoDelete(ctx, {
          text: `🚫 <b>Rechazado:</b> ${user.first_name}${username} (<a href="tg://user?id=${user.id}">${user.id}</a>) | Nombre/alfabeto inválido.`,
          options: { parse_mode: "HTML" }
        });
      }
    } catch (err) {
      console.error("❌ Error al rechazar por filtro de nombre:", err.message);
    }
  } else {
    const grupo = gruposActivos.get(idStr) || { reglamento: 1 };
    const numReglamento = grupo.reglamento || 1;
    const textoReglamento = REGLAMENTOS[numReglamento];

    const mensajeLlamativo = 
      `⚡ <b>¡SOLICITUD RECIBIDA CON ÉXITO!</b> ⚡\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Hola <b>${user.first_name}</b>, para completar tu ingreso al grupo: \n` +
      `🛡️ <b>${grupoNombre}</b> 🛡️\n\n` +
      `⚠️ <b>REQUISITO OBLIGATORIO:</b>\n` +
      `Debes leer el reglamento interno abajo y presionar el botón de <b>✅ Aceptar Reglamento</b>.\n` +
      `⏱️ <b>Tienes 10 minutos</b> o tu solicitud será cancelada automáticamente.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${textoReglamento}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
      const msgEnviado = await ctx.telegram.sendMessage(user.id, mensajeLlamativo, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Aceptar Reglamento y Entrar", callback_data: `reg_ok_${idStr}` }],
            [{ text: "❌ Rechazar / Cancelar", callback_data: `reg_no_${idStr}` }]
          ]
        }
      });

      const llaveTemporizador = `${user.id}_${idStr}`;
      const timer = setTimeout(async () => {
        try {
          await ctx.telegram.declineChatJoinRequest(idStr, user.id);
          acumularMetricasRAM(idStr, 0, 1);
          temporizadoresSolicitudes.delete(llaveTemporizador);

          await ctx.telegram.editMessageText(
            user.id,
            msgEnviado.message_id,
            null,
            `⏱️ <b>Tiempo agotado:</b> Tu solicitud para unirte a <b>${grupoNombre}</b> expiró porque no respondiste en los 10 minutos establecidos.`,
            { parse_mode: "HTML" }
          ).catch(() => {});

        } catch (timerErr) {
          console.error(`ℹ️ Expiración pasiva del usuario ${user.id}:`, timerErr.message);
        }
      }, 600000); // 10 minutos exactos

      temporizadoresSolicitudes.set(llaveTemporizador, timer);

    } catch (err) {
      console.log(`⚠️ El usuario ${user.id} tiene su chat privado cerrado. Declinado preventivo ejecutado.`);
      try {
        await ctx.telegram.declineChatJoinRequest(idStr, user.id);
        acumularMetricasRAM(idStr, 0, 1);
      } catch (declineErr) {
        console.error("❌ Error en declinado preventivo por PV cerrado:", declineErr.message);
      }
    }
  }
}

// --- BLOQUE 3: Interceptores de Eventos de Telegram ---
bot.on('chat_join_request', async (ctx) => {
  if (botPausado) return;
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const grupo = gruposActivos.get(chatId);
  await evaluarSolicitud(ctx, ctx.chatJoinRequest.from, chatId, grupo.nombre);
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const messageId = ctx.callbackQuery.message.message_id;

  if (data.startsWith("ban_")) {
    const targetUid = String(data.split("_")[1]);
    const chatId = ctx.callbackQuery.message.chat.id; 
    const esAdmin = await esAdminDelGrupo(ctx, userId);

    if (!esAdmin) {
      return ctx.answerCbQuery("❌ Operación denegada. Solo administradores autorizados.", { show_alert: true });
    }

    try {
      await ctx.telegram.banChatMember(chatId, targetUid);
      await ctx.editMessageText("🚨 Usuario baneado por administrador. Desplegando GBAN Federado...");

      const infoUsuario = await ctx.telegram.getChat(targetUid).catch(() => ({ first_name: "Usuario", username: null }));
      const labelUser = infoUsuario.username ? `@${infoUsuario.username}` : "(sin username)";
      const origGrupo = ctx.callbackQuery.message.chat.title || "Origen Desconocido";

      for (const [gId] of gruposActivos.entries()) {
        try {
          await ctx.telegram.banChatMember(gId, targetUid).catch(() => {});
          const notif = await ctx.telegram.sendMessage(
            gId,
            `🛡️ <b>GBAN — Federación Cancerberos</b>\n\n` +
            `🆔 <b>ID Penalizado:</b> <a href="tg://user?id=${targetUid}">${targetUid}</a>\n` +
            `👤 <b>Nombre:</b> ${infoUsuario.first_name}\n` +
            `🏷️ <b>Username:</b> ${labelUser}\n` +
            `📍 <b>Origen:</b> ${origGrupo}`,
            { parse_mode: "HTML" }
          ).catch(() => {});

          if (notif) {
            setTimeout(() => {
              ctx.telegram.deleteMessage(gId, notif.message_id).catch(() => {});
            }, 240000); 
          }
        } catch (fErr) {
          console.error(`❌ Error en propagación de baneo hacia la subred ${gId}:`, fErr.message);
        }
      }
    } catch (err) {
      await ctx.answerCbQuery(`❌ Fallo estructural al procesar baneo: ${err.message}`, { show_alert: true });
    }
    return;
  }

  if (data.startsWith("reg_ok_")) {
    const targetChatId = String(data.split("_")[2]);
    const grupo = gruposActivos.get(targetChatId);
    const grupoNombre = grupo ? grupo.nombre : "el grupo";

    limpiarTemporizadorSolicitud(userId, targetChatId);

    try {
      await ctx.telegram.approveChatJoinRequest(targetChatId, userId);
      acumularMetricasRAM(targetChatId, 1, 0);
      await ctx.deleteMessage(messageId).catch(() => {});

      ctx.reply(`✅ ¡Perfecto! Has aceptado el reglamento. Ya puedes ingresar a <b>${grupoNombre}</b>.`, { parse_mode: "HTML" })
        .then(m => setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 6000))
        .catch(() => {});

      const configGrupo = gruposActivos.get(targetChatId) || { verBienvenida: true };
      if (configGrupo.verBienvenida !== false) {
        const username = ctx.from.username ? ` 🆔 @${ctx.from.username}` : " 🆔 (sin username)";
        
        const pseudoCtx = {
          chat: { id: targetChatId },
          reply: (text, options) => ctx.telegram.sendMessage(targetChatId, text, options),
          deleteMessage: (msgId) => ctx.telegram.deleteMessage(targetChatId, msgId)
        };

        autoDelete(pseudoCtx, {
          text: `👋 ¡Bienvenido/a <b>${ctx.from.first_name}</b>${username} (<a href="tg://user?id=${userId}">${userId}</a>) a <b>${grupoNombre}</b>!`,
          options: {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "🚨 Banear de la Federación", callback_data: `ban_${userId}` }]]
            }
          }
        });
      }
    } catch (err) {
      console.error("❌ Error en flujo de aprobación por botón:", err.message);
      await ctx.answerCbQuery("⚠️ No se pudo procesar tu entrada de forma automática.", { show_alert: true }).catch(() => {});
    }
    return;
  }

  if (data.startsWith("reg_no_")) {
    const targetChatId = String(data.split("_")[2]);
    limpiarTemporizadorSolicitud(userId, targetChatId);

    try {
      await ctx.telegram.declineChatJoinRequest(targetChatId, userId);
      acumularMetricasRAM(targetChatId, 0, 1);
      
      await ctx.editMessageText("❌ Has rechazado el reglamento. Tu solicitud fue denegada.");
      setTimeout(() => ctx.deleteMessage(messageId).catch(() => {}), 5000);
    } catch (err) {
      console.error("❌ Error en flujo de declinado manual por botón:", err.message);
      await ctx.answerCbQuery("La solicitud expiró o fue modificada previamente.", { show_alert: true }).catch(() => {});
    }
    return;
  }
});

// --- BLOQUE 4: Comandos de Consola y Control Administrativo ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("👋 Hola. Los grupos protegidos están configurados desde el repositorio maestro de GitHub.");
  }

  if (!gruposAutorizados.has(chatId)) return; 
  const grupo = gruposActivos.get(chatId);

  return ctx.reply(
    `👋 Bot activo en el grupo <b>${grupo.nombre}</b>.\n\n` +
    `🛡️ Estado: <b>${botPausado ? "⏸️ PAUSADO" : "🟢 ACTIVO"}</b>\n` +
    `📊 Totales Procesados: ${grupo.usuariosProcesados} | 🚫 Rechazados: ${grupo.usuariosRechazados}\n` +
    `⚙️ Reglamento Máster: Reglamento ${grupo.reglamento || 1}\n` +
    `👋 Saludos: <b>ON</b> | Logs Filtrados: <b>ON</b>\n\n` +
    `💡 Escribe <code>/help</code> para desplegar los comandos válidos.`,
    { parse_mode: "HTML" }
  );
});

bot.command('help', (ctx) => {
  return ctx.reply(
    `🛡️ <b>MANUAL DE COMANDOS CANCERBEROS (ARRAY JSON)</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `• <code>/start</code> - Ver estado e indicadores acumulados en RAM.\n` +
    `• <code>/reglas</code> - Despliega el reglamento asignado en este chat.\n` +
    `• <code>/gmsg [Mensaje]</code> - Envía un comunicado oficial a toda la red cargada de GitHub.\n` +
    `• <code>/pausarbot</code> / <code>/reanudarbot</code> - Suspensión o reactivación global del escudo en caliente.`,
    { parse_mode: "HTML" }
  );
});

bot.command('gmsg', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id))) return;
  if (!(await esAdminDelGrupo(ctx, ctx.from.id))) return ctx.reply("❌ Comando de uso exclusivo para administradores.");

  const mensajeGlobal = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!mensajeGlobal) return ctx.reply("⚠️ Formato incorrecto. Usa: <code>/gmsg [Tu comunicado aquí]</code>", { parse_mode: "HTML" });

  const plantilla = `📢 <b>COMUNICADO OFICIAL — FEDERACIÓN CANCERBEROS</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${mensajeGlobal}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 <i>Emitido por: ${ctx.from.first_name}</i>`;
  let ok = 0, errs = 0;

  for (const [chatId] of gruposActivos.entries()) {
    try {
      await ctx.telegram.sendMessage(chatId, plantilla, { parse_mode: "HTML" });
      ok++;
      await new Promise(r => setTimeout(r, 250)); // Control anti flood
    } catch {
      errs++;
    }
  }
  return ctx.reply(`✅ <b>Anuncio Global Desplegado</b>\n📊 Notificados: <b>${ok}</b> | ❌ Errores/Inactivos: <b>${errs}</b>`, { parse_mode: "HTML" });
});

bot.command('reglas', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const g = gruposActivos.get(chatId);
  autoDelete(ctx, {
    text: `📖 <b>Reglamento Vigente de: ${g.nombre}</b>\n\n${REGLAMENTOS[g.reglamento || 1]}`,
    options: { parse_mode: "HTML" }
  });
});

bot.command('pausarbot', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id)) || !(await esAdminDelGrupo(ctx, ctx.from.id))) return;
  botPausado = true;
  return ctx.reply("⏸️ <b>SISTEMA EN PAUSA GLOBAL</b>", { parse_mode: "HTML" });
});

bot.command('reanudarbot', async (ctx) => {
  if (!gruposAutorizados.has(String(ctx.chat.id)) || !(await esAdminDelGrupo(ctx, ctx.from.id))) return;
  botPausado = false;
  await ctx.reply("▶️ <b>SISTEMA REANUDADO</b>. Escaneando cola de solicitudes pendientes...", { parse_mode: "HTML" });

  for (const [chatId, grupo] of gruposActivos.entries()) {
    try {
      const pendientes = await ctx.telegram.getChatJoinRequests(chatId);
      if (pendientes && pendientes.length > 0) {
        for (const sol of pendientes) {
          await evaluarSolicitud(ctx, sol.from, chatId, grupo.nombre);
          await new Promise(r => setTimeout(r, 250)); 
        }
      }
    } catch (e) {
      console.error(`❌ Error barriendo cola acumulada en chat ${chatId}:`, e.message);
    }
  }
  return ctx.reply("✅ Barrido masivo completado con éxito.", { parse_mode: "HTML" });
});

// --- BLOQUE 5: Servidor Web / Configuración de Webhook ---
const PORT = process.env.PORT || 3000;
bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

app.get('/', (req, res) => res.send('🚀 Federación Cancerberos Shield Operando en Modo Fijo.'));

app.listen(PORT, () => console.log(`🚀 Servidor listo escuchando en el puerto ${PORT}`));

// Controladores anti-caídas globales
process.on('uncaughtException', (err) => console.error('❌ EXCEPCIÓN NO CONTROLADA:', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ PROCESO RECHAZADO EN PROMESA:', reason));
