
// ============================================================================
//   SISTEMA DE CONTROL PRO — MONITOR CENTRAL DE SEGURIDAD
//   Archivo: index.js (Arquitectura de Producción con Persistencia Fija)
// ============================================================================

const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// --- VALIDACIÓN ESTRICTA DE ENTORNO EN ARRANQUE ---
if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL || !process.env.WEBHOOK_SECRET_TOKEN) {
  console.error("❌ ERROR CRÍTICO: Faltan variables de entorno esenciales (BOT_TOKEN, WEBHOOK_URL o WEBHOOK_SECRET_TOKEN)");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Volátiles y Control de Estado en RAM
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const mensajesActivos = new Map();           
const temporizadoresSolicitudes = new Map(); 

let botPausado = false; 
const RUTA_JSON = path.join(__dirname, 'gruposActivos.json');

// --- NÚCLEO DE PERSISTENCIA: Carga y Guardado del JSON ---
function cargarConfiguracionMaestra() {
  if (!fs.existsSync(RUTA_JSON)) {
    console.error("⚠️ ALERTA: No se encontró 'gruposActivos.json'. El bot iniciará vacío.");
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
        gruposActivos.set(idStr, {
          id: idStr,
          nombre: grupo.nombre || "Chat Protegido",
          usuariosProcesados: parseInt(grupo.usuariosProcesados) || 0, 
          usuariosRechazados: parseInt(grupo.usuariosRechazados) || 0,   
          fechaInicio: grupo.fechaInicio || new Date().toISOString(),
          reglamento: parseInt(grupo.reglamento) || 1,
          verBienvenida: grupo.verBienvenida !== false, 
          verRechazo: grupo.verRechazo !== false
        });
        
        gruposAutorizados.add(idStr);
        contador++;
      });
      console.log(`📦 PERSISTENCIA: Se cargaron con éxito ${contador} grupos a la RAM.`);
    }
  } catch (err) {
    console.error("❌ PERSISTENCIA: Error al leer gruposActivos.json:", err.message);
  }
}

function guardarConfiguracionMaestra() {
  try {
    const arregloSalida = Array.from(gruposActivos.values());
    fs.writeFileSync(RUTA_JSON, JSON.stringify(arregloSalida, null, 2), 'utf8');
    console.log("💾 PERSISTENCIA: Estado del ecosistema guardado en el JSON correctamente.");
  } catch (err) {
    console.error("❌ PERSISTENCIA: Error fatal al escribir gruposActivos.json:", err.message);
  }
}

// Inicializar base de datos estática al arranque
cargarConfiguracionMaestra();

const REGLAMENTOS = {
  1: `💬 <b>COTORREO</b> 💬\nGrupo de plática y desmadre. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7. 🚫 <b>NO es espacio XXX, HOT ni de encuentros.</b>\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Preséntate:</b> interactúa, no seas un "mueble" o serás expulsado.\n💀 <b>Estrictamente prohibido:</b> Enviar fotopitos al grupo, CP, Gore, Zoo, etc.\n💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Creadoras de Contenido:</b> Pide permiso a un Admin y verifícate.\n💀 <b>Material Temporal:</b> Solo Material propio +18 (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.\n💀 <b>Límites:</b> No confundas el cotorreo con el bullying.`,

  2: `🔥<b>COTORREO HOT</b>🔥\nEspacio para conocer gente HOT, interactuar y promover contenido sin morbo pesado. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7.\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Actividad:</b> Intégrate al desmadre, evita quedarte de "mueble".\n💀 <b>Estrictamente prohibido:</b> Fotopitos, CP, Gore, Zoo, Material Ilegal, etc.\n💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Creadoras de Contenido:</b> Pide permiso y verifícate.\n💀 <b>Material Temporal:</b> Solo Material +18 Propio, no dormidas, filtrados, exs, (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.`
};

// --- BLOQUE 2: Validaciones y utilidades ---
async function esAdminDelGrupo(ctx, userId, chatId = null) {
  try {
    const targetChat = chatId ? chatId : ctx.chat.id;
    const admins = await ctx.telegram.getChatAdministrators(targetChat);
    return admins.some(admin => admin.user.id === userId);
  } catch {
    return false;
  }
}

function nombreInvalido(nombre) {
  if (!nombre) return true;
  const original = nombre.trim();

  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  if (prohibidos.some(p => original.toLowerCase().includes(p))) return true;

  if (/[\p{P}\p{S}\s\d]/gu.test(original)) return true;

  const soloTexto = original.replace(/\p{Emoji}/gu, '').toLowerCase();

  if (soloTexto.length < 3) return true;

  const regexLatina = /^[\p{Script=Latin}]+$/u;
  if (!regexLatina.test(soloTexto)) return true;

  if (/(.)\1{2,}/.test(soloTexto)) return true;    
  if (/(..)\1{1,}/.test(soloTexto)) return true;   
  if (/(...)\1{1,}/.test(soloTexto)) return true;  

  if (/[bcdfghjklmnñpqrstvwxyz]{4,}/.test(soloTexto)) return true;
  
  if (/[bcdfghjklmnñpqrstvwxyz]{3}/.test(soloTexto)) {
    const combinacionesValidas = ['str', 'chr', 'sch', 'bbr', 'ggr', 'llr', 'mbl', 'mpr', 'bcl', 'dfr'];
    const tieneCombinacionValida = combinacionesValidas.some(comb => soloTexto.includes(comb));
    if (!tieneCombinacionValida && /[^aeiouáéíóúüy]{3,}/.test(soloTexto)) {
      if (/asd|sdf|dfg|fgh|ghj|hjk|jkl|qwe|wer|ert|rty|tyu|yui|uio|iop|zxc|xcv|cvb|vbn|bnm/.test(soloTexto)) return true;
    }
  }

  const totalVocales = (soloTexto.match(/[aeiouáéíóúüy]/g) || []).length;
  const totalConsonantes = soloTexto.length - totalVocales;

  if (totalVocales === 0 || totalConsonantes === 0) return true;

  if (soloTexto.length >= 5) {
    if (totalVocales / soloTexto.length > 0.85) return true; 
    if (totalConsonantes / soloTexto.length > 0.85) return true; 
  }

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
      const listaOriginal = mensajesActivos.get(chatId);
      const copiaLimpieza = [...listaOriginal];
      listaOriginal.length = 0; 

      copiaLimpieza.forEach(viejoId => {
        ctx.deleteMessage(viejoId).catch(() => {});
      });
    } else {
      mensajesActivos.set(chatId, []);
    }

    const lista = mensajesActivos.get(chatId);
    lista.push(sent.message_id);

    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
      const idx = lista.indexOf(sent.message_id);
      if (idx !== -1) lista.splice(idx, 1);
      
      if (lista.length === 0) {
        mensajesActivos.delete(chatId);
      }
    }, 240000); // 4 minutos
    
  }).catch(err => console.error("❌ Error en función autoDelete:", err.message));
}

function acumularMetricasRAM(chatId, procesados, rechazados) {
  const idStr = String(chatId);
  if (gruposActivos.has(idStr)) {
    const group = gruposActivos.get(idStr);
    group.usuariosProcesados += procesados;
    group.usuariosRechazados += rechazados;
    gruposActivos.set(idStr, group); 
    guardarConfiguracionMaestra(); 
  }
}

function limpiarTemporizadorSolicitud(userId, chatId) {
  const llave = `${userId}_${chatId}`;
  if (temporizadoresSolicitudes.has(llave)) {
    clearTimeout(temporizadoresSolicitudes.get(llave));
    temporizadoresSolicitudes.delete(llave);
  }
}

async function ejecutarKickLocal(ctx, targetChatId, targetUserId, firstName, razon) {
  try {
    await ctx.telegram.banChatMember(targetChatId, targetUserId);
    await ctx.telegram.unbanChatMember(targetChatId, targetUserId);
    console.log(`🚪 KICK LOCAL: Usuario ${targetUserId} removido de ${targetChatId}. Razón: ${razon}`);
  } catch (err) {
    console.error(`❌ Error al ejecutar Kick local en el grupo ${targetChatId}:`, err.message);
  }
}

async function aplicarMutePreventivo(ctx, chatId, userId, grupoNombre) {
  try {
    await ctx.telegram.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    });
    console.log(`🛡️ ESCUDO MUTEO: Usuario ${userId} silenciado preventivamente en ${grupoNombre}.`);
  } catch (restrictErr) {
    console.error(`❌ Falló la restricción preventiva en el grupo:`, restrictErr.message);
  }
}

async function enviarValidacionPrivada(ctx, user, idStr, grupoNombre) {
  const grupo = gruposActivos.get(idStr) || { reglamento: 1 };
  const numReglamento = grupo.reglamento || 1;
  const textoReglamento = REGLAMENTOS[numReglamento];

  const mensajeLlamativo = 
    `⚡ <b>¡SOLICITUD RECIBIDA CON ÉXITO!</b> ⚡\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Hola <b>${user.first_name}</b>, para activar tus permisos en el grupo: \n` +
    `🛡️ <b>${grupoNombre}</b> 🛡️\n\n` +
    `📋 <b>REQUISITO OBLIGATORIO:</b>\n` +
    `Debes leer las normas internas aquí expuestas y presionar el botón de abajo:\n\n` +
    `👇 <b>UTILIZA ESTOS BOTONES PARA ENTRAR O DECLINAR</b> 👇\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${textoReglamento}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  const msgEnviado = await ctx.telegram.sendMessage(user.id, mensajeLlamativo, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ ACEPTAR REGLAMENTO Y ENTRAR", callback_data: `reg_ok_${idStr}` }],
        [{ text: "❌ RECHAZAR / DECLINAR", callback_data: `reg_no_${idStr}` }]
      ]
    }
  });

  const llaveTemporizador = `${user.id}_${idStr}`;
  const timer = setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(user.id, msgEnviado.message_id).catch(() => {});
      await ejecutarKickLocal(ctx, idStr, user.id, user.first_name, "Tiempo de verificación en privado agotado (10 min).");
      temporizadoresSolicitudes.delete(llaveTemporizador);
    } catch (timerErr) {
      console.error(`ℹ️ Error en temporizador pasivo de kick:`, timerErr.message);
    }
  }, 600000); 

  temporizadoresSolicitudes.set(llaveTemporizador, timer);
}

async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  const idStr = String(chatId);
  if (!gruposAutorizados.has(idStr)) return;

  limpiarTemporizadorSolicitud(user.id, idStr);
  const mention = `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(idStr, user.id);
      await ctx.telegram.sendMessage(idStr, `🚫 <b>${user.first_name}</b> rechazado por nombre no válido.`, { parse_mode: "HTML" });
    } catch (e) { console.error("Error al rechazar:", e.message); }
  } else {
    try {
      await ctx.telegram.approveChatJoinRequest(idStr, user.id);
      await aplicarMutePreventivo(ctx, idStr, user.id, grupoNombre);

      const configGrupo = gruposActivos.get(idStr) || { verBienvenida: true };
      if (configGrupo.verBienvenida !== false) {
        ctx.telegram.sendMessage(idStr, 
          `👋 Bienvenido ${mention} a <b>${grupoNombre}</b>.\n\n` +
          `⚠️ <b>ESTÁS EN MODO LECTURA.</b>\nPara activar tus permisos, presiona el botón.`, 
          { 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "📖 LEER REGLAS Y ACEPTAR", callback_data: `start_reg_${idStr}` }]] }
          }
        );

        const llaveKick = `${user.id}_${idStr}_kick`;
        const timer = setTimeout(async () => {
          try {
            const member = await ctx.telegram.getChatMember(idStr, user.id);
            if (member.permissions && member.permissions.can_send_messages === false) {
              await ejecutarKickLocal(ctx, idStr, user.id, user.first_name, "Tiempo agotado.");
            }
          } catch (e) { console.error("Timer de seguridad:", e.message); }
        }, 600000);
        temporizadoresSolicitudes.set(llaveKick, timer);
      }
    } catch (err) { console.log("Error en evaluación:", err.message); }
  }
}

bot.on('new_chat_members', async (ctx) => {
  if (botPausado) return;
  const chatId = ctx.chat.id;
  const nombreGrupo = ctx.chat.title || "este grupo";
  const idStr = String(chatId);

  if (!gruposAutorizados.has(idStr)) return;

  for (const member of ctx.message.new_chat_members) {
    if (member.id === ctx.botInfo.id) continue;

    // 1. VALIDACIÓN INMEDIATA: Si el nombre es inválido, expulsar y salir del bucle
    if (nombreInvalido(member.first_name)) {
      await ejecutarKickLocal(ctx, chatId, member.id, member.first_name, "Nombre no válido.");
      continue; // Salta al siguiente miembro, ignorando el resto del código
    }

    // 2. ACCIONES POSTERIORES: Solo se ejecutan si el nombre es válido
    // Aplicar mute preventivo
    await aplicarMutePreventivo(ctx, chatId, member.id, nombreGrupo);

    const mention = `<a href="tg://user?id=${member.id}">${member.first_name}</a>`;

    try {
      const configGrupo = gruposActivos.get(idStr) || { verBienvenida: true };
      if (configGrupo.verBienvenida !== false) {
        
        await ctx.telegram.sendMessage(chatId, 
          `👋 Bienvenido ${mention} a <b>${nombreGrupo}</b>.\n\n` +
          `⚠️ <b>ESTÁS EN MODO LECTURA.</b>\n` +
          `Para participar, debes aceptar las reglas presionando el botón de abajo.`, 
          { 
            parse_mode: "HTML",
            reply_markup: { 
              inline_keyboard: [[{ text: "📖 LEER REGLAS Y ACEPTAR", callback_data: `start_reg_${idStr}` }]] 
            }
          }
        );

        // 3. Iniciar timer de seguridad
        const llaveKick = `${member.id}_${idStr}_kick`;
        const timer = setTimeout(async () => {
          try {
            const m = await ctx.telegram.getChatMember(chatId, member.id);
            if (m.permissions && m.permissions.can_send_messages === false) {
              await ejecutarKickLocal(ctx, chatId, member.id, member.first_name, "Tiempo agotado.");
            }
          } catch (e) { console.error("Error en timer de seguridad:", e.message); }
        }, 600000); // 10 minutos
        
        temporizadoresSolicitudes.set(llaveKick, timer);
      }
    } catch (err) {
      console.error(`❌ Error al enviar bienvenida a ${member.first_name}:`, err.message);
    }
  }
});

// --- MANEJADOR UNIFICADO DE CALLBACK_QUERY (BLOQUE CORREGIDO) ---
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const messageId = ctx.callbackQuery.message.message_id;

    // 1. Inicio de reglas
    if (data.startsWith("start_reg_")) {
      const targetChatId = data.split("_")[2];
      try {
        await enviarValidacionPrivada(ctx, ctx.from, targetChatId, "el grupo");
        await ctx.answerCbQuery("✅ Revisa tu chat privado.");
      } catch (e) { 
        await ctx.answerCbQuery("❌ Inicia el bot primero.", { show_alert: true }); 
      }
      return;
    }

    // 2. Aceptación de reglas (reg_ok_) - LÓGICA CORREGIDA
    if (data.startsWith("reg_ok_")) {
      const targetChatId = String(data.split("_")[2]);
      const grupo = gruposActivos.get(targetChatId);
      const grupoNombre = grupo ? grupo.nombre : "tu grupo";

      limpiarTemporizadorSolicitud(userId, targetChatId);
      
      try {
        // Borramos el mensaje de botones original
        await ctx.deleteMessage(messageId).catch(() => {});
        
        // Removemos el mute preventivo en el grupo
        await ctx.telegram.restrictChatMember(targetChatId, userId, { permissions: {} });
        
        // Enviamos un mensaje de confirmación con botón de retorno
        // Esto limpia la UI y permite al usuario salir del privado
        await ctx.reply(`✅ <b>¡Acceso Autorizado!</b>\nHas sido habilitado en <b>${grupoNombre}</b>.`, { 
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "⬅️ REGRESAR AL GRUPO", url: `https://t.me/c/${targetChatId.replace('-100', '')}` }]]
          }
        });
      } catch (err) {
        console.error("❌ Error al procesar reg_ok:", err.message);
      }
      return;
    }

    // 3. Rechazo de reglas (reg_no_)
    if (data.startsWith("reg_no_")) {
      const targetChatId = String(data.split("_")[2]);
      limpiarTemporizadorSolicitud(userId, targetChatId);
      try {
        await ctx.deleteMessage(messageId).catch(() => {});
        await ctx.reply("❌ Has declinado el reglamento. Serás expulsado del grupo.");
        await ejecutarKickLocal(ctx, targetChatId, userId, "Usuario", "Declinó reglamento.");
      } catch (err) {
        console.error("❌ Error al procesar reg_no:", err.message);
      }
      return;
    }

    // 4. Baneo Global (bienvenida_ban_)
    if (data.startsWith("bienvenida_ban_")) {
      const targetUserId = data.split("_")[2];
      const targetChatId = String(ctx.chat.id);

      if (!(await esAdminDelGrupo(ctx, userId, targetChatId))) {
        return ctx.answerCbQuery("❌ Solo administradores.", { show_alert: true });
      }

      await ctx.answerCbQuery("💀 Ejecutando baneo global...");
      
      try {
        let baneadosExito = 0;
        for (const [gId] of gruposActivos.entries()) {
          try { await ctx.telegram.banChatMember(gId, targetUserId); baneadosExito++; } catch (e) {}
        }
        await ctx.deleteMessage(messageId).catch(() => {});
        ctx.reply(`✅ <b>Baneo global ejecutado en ${baneadosExito} grupos.</b>`, { parse_mode: "HTML" });
      } catch (err) {
        console.error("❌ Error en baneo global:", err.message);
      }
      return;
    }

  } catch (err) {
    console.error("❌ Fallo en callback_query:", err.message);
  }
});

// --- BLOQUE 4: Comandos de Consola y Control Administrativo ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("👋 Hola. Los grupos protegidos pertenecen al ecosistema de seguridad máster central.");
  }

  if (!gruposAutorizados.has(chatId)) return; 
  const grupo = gruposActivos.get(chatId);

  return ctx.reply(
    `👋 Bot activo en el grupo <b>${grupo.nombre}</b>.\n\n` +
    `🛡️ Estado: <b>${botPausado ? "⏸️ PAUSADO" : "🟢 ACTIVO"}</b>\n` +
    `📊 Totales Procesados: ${grupo.usuariosProcesados} | 🚫 Rechazados: ${grupo.usuariosRechazados}\n` +
    `⚙️ Reglamento Asignado: Reglamento ${grupo.reglamento || 1}\n` +
    `👋 Saludos de Bienvenida: <b>${grupo.verBienvenida !== false ? "ON 🟢" : "OFF 🔴"}</b>\n` +
    `🚫 Logs de Filtros/Rechazo: <b>${grupo.verRechazo !== false ? "ON 🟢" : "OFF 🔴"}</b>\n\n` +
    `💡 Escribe <code>/help</code> para desplegar los comandos válidos.`,
    { parse_mode: "HTML" }
  );
});

bot.command('help', (ctx) => {
  return ctx.reply(
    `🛡️ <b>MANUAL DE COMANDOS DE CONTROL</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `• <code>/start</code> - Ver estado e indicadores guardados en JSON.\n` +
    `• <code>/reglas</code> - Despliega el reglamento asignado en este chat.\n` +
    `• <code>/setrules [1 o 2]</code> - Cambia el reglamento vigente en este grupo.\n` +
    `• <code>/gban [ID/Respuesta] [Razón]</code> - Baneo masivo con réplica multimedia.\n` +
    `• <code>/gmsg [Mensaje]</code> - Envía un comunicado oficial a toda la red unificada.\n` +
    `• <code>/pausarbot</code> - Suspensión global del escudo en caliente.\n` +
    `• <code>/reanudarbot</code> - Reactivación local de defensas y evaluación de pendientes.\n` +
    `• <code>/pausarbienvenida</code> - Apaga las bienvenidas en este grupo.\n` +
    `• <code>/reanudarbienvenida</code> - Enciende las bienvenidas en este grupo.\n` +
    `• <code>/pausarrechazo</code> - Apaga los mensajes de rechazo en este grupo.\n` +
    `• <code>/reanudarrechazo</code> - Enciende los mensajes de rechazo en este grupo.`,
    { parse_mode: "HTML" }
  );
});

bot.command('gban', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id, chatId);
  if (!esAdmin) return ctx.reply("❌ Operación denegada. Comando exclusivo de la administración.");

  let targetUid = null;
  let razon = "No especificada";
  let mensajeAReplicarId = null;

  const args = ctx.message.text.split(" ").slice(1);

  if (ctx.message.reply_to_message) {
    targetUid = String(ctx.message.reply_to_message.from.id);
    mensajeAReplicarId = ctx.message.reply_to_message.message_id;
    if (args.length > 0) razon = args.join(" ");
  } else if (args.length > 0) {
    targetUid = args[0];
    if (args.length > 1) razon = args.slice(1).join(" ");
  }

  if (!targetUid || isNaN(targetUid)) {
    return ctx.reply("⚠️ <b>Formato incorrecto para GBAN.</b>\n\n" +
                     "• Por Respuesta: <code>/gban [razón]</code>\n" +
                     "• Por ID Directo: <code>/gban [ID_Usuario] [razón]</code>", { parse_mode: "HTML" });
  }

  if (targetUid === String(ctx.botInfo.id) || targetUid === String(ctx.from.id)) {
    return ctx.reply("❌ Operación inválida. No puedes banearte a ti mismo o al bot.");
  }

  let infoUsuario;
  try {
    infoUsuario = await ctx.telegram.getChat(targetUid);
  } catch {
    infoUsuario = { first_name: "Usuario Desconocido", username: null };
  }

  const avisoInicial = await ctx.reply(`🚨 <b>Procesando GBAN de Federación...</b>`, { parse_mode: "HTML" });

  let baneadosExito = 0;
  let fallidos = 0;

  for (const [gId] of gruposActivos.entries()) {
    try {
      await ctx.telegram.banChatMember(gId, targetUid);
      baneadosExito++;

      const notifReporte = await ctx.telegram.sendMessage(
        gId,
        `🛡️ <b>GBAN — Federación CANCERBEROS</b>\n` +
        `━━━━\n\n` +
        `🆔 <b>ID Penalizado:</b> <a href="tg://user?id=${targetUid}">${targetUid}</a>\n` +
        `👤 <b>Nombre:</b> ${infoUsuario.first_name}\n` +
        `⚖️ <b>Razón:</b> ${razon}\n` +
        `━━━\n` +
        `⚠️ <i>Esta alerta se auto-eliminará en 4 minutos.</i>`,
        { parse_mode: "HTML" }
      ).catch(() => {});

      let notifReplica = null;
      if (mensajeAReplicarId) {
        notifReplica = await ctx.telegram.forwardMessage(gId, chatId, mensajeAReplicarId).catch(() => {});
      }

      setTimeout(() => {
        if (notifReporte) ctx.telegram.deleteMessage(gId, notifReporte.message_id).catch(() => {});
        if (notifReplica) ctx.telegram.deleteMessage(gId, notifReplica.message_id).catch(() => {});
      }, 240000); 

      await new Promise(r => setTimeout(r, 200)); 

    } catch (fErr) {
      fallidos++;
    }
  }

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      avisoInicial.message_id,
      null,
      `✅ <b>GBAN COMPLETADO</b>\n━━━━━━n` +
      `🛡️ <b>Grupos Limpiados:</b> ${baneadosExito}\n\n` +
      `❌ <b>Errores/Grupos sin Aplicar:</b> ${fallidos}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error(err.message);
  }
});

bot.command('setrules', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;
  if (!(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return ctx.reply("❌ Comando restringido a administradores.");

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const numReglamento = parseInt(args);

  if (!REGLAMENTOS[numReglamento]) { 
    return ctx.reply("⚠️ Usa: <code>/setrules 1</code> o <code>/setrules 2</code>", { parse_mode: "HTML" });
  }

  const grupo = gruposActivos.get(chatId);
  grupo.reglamento = numReglamento;
  gruposActivos.set(chatId, grupo);
  guardarConfiguracionMaestra(); 

  return ctx.reply(`✅ <b>Reglamento actualizado:</b> Se aplicará el <b>Reglamento ${numReglamento}</b>.`, { parse_mode: "HTML" });
});

bot.command('gmsg', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;
  if (!(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return ctx.reply("❌ Comando restringido.");

  const mensajeGlobal = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!mensajeGlobal) return ctx.reply("⚠️ Usa: <code>/gmsg [Mensaje]</code>", { parse_mode: "HTML" });

  // Estética ajustada con subrayado de línea única y compacta
  const plantilla = `📢 <b>COMUNICADO OFICIAL 📢 FEDERACIÓN CANCERBEROS</b>\n` +
                    `────────>\n\n` +
                    `${mensajeGlobal}\n`;
  let ok = 0;

  for (const [gId] of gruposActivos.entries()) {
    try {
      await ctx.telegram.sendMessage(gId, plantilla, { parse_mode: "HTML" });
      ok++;
      await new Promise(r => setTimeout(r, 200)); 
    } catch {}
  }
  return ctx.reply(`✅ <b>Anuncio Desplegado</b> en ${ok} grupos.`, { parse_mode: "HTML" });
});

bot.command('reglas', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;

  const g = gruposActivos.get(chatId);
  autoDelete(ctx, {
    text: `📖 <b>Reglamento Vigilante de: ${g.nombre}</b>\n\n${REGLAMENTOS[g.reglamento || 1]}`,
    options: { parse_mode: "HTML" }
  });
});

bot.command('pausarbot', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  botPausado = true;
  return ctx.reply("⏸️ <b>SISTEMA EN PAUSA GLOBAL</b>", { parse_mode: "HTML" });
});

bot.command('reanudarbot', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  
  const grupoActual = gruposActivos.get(chatId);
  const nombreGrupo = grupoActual ? grupoActual.nombre : (ctx.chat.title || "Este grupo");

  botPausado = false;
  await ctx.reply(`▶️ <b>SISTEMA REANUDADO</b>\n🔍 <i>Verificando estado del grupo: <b>${nombreGrupo}</b>...</i>`, { parse_mode: "HTML" });

  let totalProcesadas = 0;

  try {
    // Intentamos obtener el chat para ver si tiene configurada la aprobación
    const chatInfo = await ctx.telegram.getChat(chatId);
    
    // Si el grupo NO tiene activada la opción join_by_request, evitamos la consulta
    if (!chatInfo.join_by_request) {
      return ctx.reply("✅ <b>Sistema Reanudado.</b>\n\n💡 <i>Nota: El grupo no tiene activada la 'Aprobación de miembros'. El bot está operando correctamente en modo contingencia (filtros activos para nuevos miembros).</i>", { parse_mode: "HTML" });
    }

    // Si tiene la opción activa, procedemos a buscar solicitudes
    const resultado = await ctx.telegram.callApi('getChatJoinRequests', {
      chat_id: chatId
    });

    if (resultado && resultado.requests && resultado.requests.length > 0) {
      for (const req of resultado.requests) {
        await evaluarSolicitud(ctx, req.from, chatId, nombreGrupo);
        totalProcesadas++;
        await new Promise(r => setTimeout(r, 250));
      }
    }
  } catch (err) {
    console.error(`❌ Error en reanudarbot para ${chatId}:`, err.message);
    return ctx.reply("⚠️ <b>Estado:</b> Sistema activo. (No se pudieron listar solicitudes, verifica permisos).", { parse_mode: "HTML" });
  }

  if (totalProcesadas > 0) {
    return ctx.reply(`✅ <b>Procesamiento Finalizado:</b> Se encontraron y procesaron <b>${totalProcesadas}</b> solicitudes pendientes.`, { parse_mode: "HTML" });
  }
});

bot.command('pausarbienvenida', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  
  const grupo = gruposActivos.get(chatId);
  grupo.verBienvenida = false;
  gruposActivos.set(chatId, grupo);
  guardarConfiguracionMaestra();
  return ctx.reply("🔴 <b>Bienvenidas Ocultas.</b>", { parse_mode: "HTML" });
});

bot.command('reanudarbienvenida', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  
  const grupo = gruposActivos.get(chatId);
  grupo.verBienvenida = true;
  gruposActivos.set(chatId, grupo);
  guardarConfiguracionMaestra();
  return ctx.reply("🟢 <b>Bienvenidas Activadas.</b>", { parse_mode: "HTML" });
});

bot.command('pausarrechazo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  
  const grupo = gruposActivos.get(chatId);
  grupo.verRechazo = false;
  gruposActivos.set(chatId, grupo);
  guardarConfiguracionMaestra();
  return ctx.reply("🔴 <b>Logs de Rechazo Ocultos.</b>", { parse_mode: "HTML" });
});

bot.command('reanudarrechazo', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  
  const grupo = gruposActivos.get(chatId);
  grupo.verRechazo = true;
  gruposActivos.set(chatId, grupo);
  guardarConfiguracionMaestra();
  return ctx.reply("🟢 <b>Logs de Rechazo Activos.</b>", { parse_mode: "HTML" });
});

// --- BLOQUE 5: Servidor Web ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN_MASTER = process.env.WEBHOOK_SECRET_TOKEN;

// Configuración del Webhook con retraso pasivo para asegurar estabilidad en el despliegue de Railway
setTimeout(() => {
  console.log("🌐 Conectando con la API de Telegram...");
  bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`, {
    secret_token: SECRET_TOKEN_MASTER
  })
    .then(() => console.log("✅ Webhook de Telegram configurado con éxito y protegido con Secret Token."))
    .catch(err => console.error("⚠️ Error al configurar Webhook:", err.message));
}, 5000);

// Middleware de Express para procesar los Updates firmados por Telegram
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`, {
  secretToken: SECRET_TOKEN_MASTER
}));

app.get('/', (req, res) => res.send('🚀 Shield Online con Base Fija y Filtro Anti-Spoofing.'));

app.listen(PORT, () => console.log("🚀 Servidor escuchando en el puerto " + PORT));

// Controladores globales de fallos para evitar caídas del contenedor en Railway
process.on('uncaughtException', (err) => console.error('❌ CRÍTICO:', err.message));
process.on('unhandledRejection', (reason) => console.error('❌ RECHAZO:', reason));

