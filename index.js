// ============================================================================
//   SISTEMA DE CONTROL PRO — MONITOR CENTRAL DE SEGURIDAD
//   Archivo: index.js (Arquitectura de Producción con Persistencia Fija)
// ============================================================================

const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL || !process.env.WEBHOOK_SECRET_TOKEN) {
  console.error("❌ ERROR CRÍTICO: Faltan variables de entorno esenciales");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const gruposActivos = new Map();
const gruposAutorizados = new Set();
const mensajesActivos = new Map();           
const temporizadoresSolicitudes = new Map(); 

let botPausado = false; 
const RUTA_JSON = path.join(__dirname, 'gruposActivos.json');

function cargarConfiguracionMaestra() {
  if (!fs.existsSync(RUTA_JSON)) return;
  try {
    const data = fs.readFileSync(RUTA_JSON, 'utf8');
    const listaGrupos = JSON.parse(data);
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
      });
    }
  } catch (err) { console.error("❌ PERSISTENCIA:", err.message); }
}

function guardarConfiguracionMaestra() {
  try {
    fs.writeFileSync(RUTA_JSON, JSON.stringify(Array.from(gruposActivos.values()), null, 2), 'utf8');
  } catch (err) { console.error("❌ PERSISTENCIA:", err.message); }
}

cargarConfiguracionMaestra();

const REGLAMENTOS = {
  1: `💬 <b>COTORREO</b> 💬\nGrupo de plática y desmadre. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7. 🚫 <b>NO es espacio XXX, HOT ni de encuentros.</b>\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Preséntate:</b> interactúa, no seas un "mueble" o serás expulsado.\n💀 <b>Estrictamente prohibido:</b> Enviar fotopitos al grupo, CP, Gore, Zoo, etc.\n💀 <b>Sin Spam:</b> No Ventas, Venta de Contenido +18, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Material Temporal:</b> Solo Material propio +18 (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.\n💀 <b>Límites:</b> No confundas el cotorreo con el bullying.`,
  2: `🔥<b>COTORREO HOT</b>🔥\nEspacio para conocer gente HOT, interactuar y promover contenido sin morbo pesado. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7.\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Actividad:</b> Intégrate al desmadre, evita quedarte de "mueble".\n💀 <b>Estrictamente prohibido:</b> Fotopitos, CP, Gore, Zoo, Material Ilegal, etc.\n💀 <b>Sin Spam:</b> No Ventas, Hackeos, Chantajes, links/grupos, NvXNv, Cambios, etc.\n💀 <b>Creadoras de Contenido:</b> Pide permiso y verifícate.\n💀 <b>Material Temporal:</b> Solo Material +18 Propio, no dormidas, filtrados, exs, (se Elimina Auto).\n💀 <b>Respeta el Privado:</b> No acoso PV (DM) / Agg cotorrea en el grupo.`
};
async function esAdminDelGrupo(ctx, userId, chatId = null) {
  try {
    const targetChat = chatId ? chatId : ctx.chat.id;
    const admins = await ctx.telegram.getChatAdministrators(targetChat);
    return admins.some(admin => admin.user.id === userId);
  } catch { return false; }
}

function nombreInvalido(nombre) {
  if (!nombre) return true;
  const original = nombre.trim();
  if (/[\p{P}\p{S}\s\d]/gu.test(original)) return true;
  const soloTexto = original.replace(/\p{Emoji}/gu, '').toLowerCase();
  if (soloTexto.length < 3) return true;
  const regexLatina = /^[\p{Script=Latin}]+$/u;
  if (!regexLatina.test(soloTexto)) return true;
  if (/(.)\1{2,}/.test(soloTexto)) return true;    
  if (/[bcdfghjklmnñpqrstvwxyz]{4,}/.test(soloTexto)) return true;
  return false; 
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

async function ejecutarKickLocal(ctx, targetChatId, targetUserId, firstName, razon) {
  try {
    await ctx.telegram.banChatMember(targetChatId, targetUserId);
    await ctx.telegram.unbanChatMember(targetChatId, targetUserId);
  } catch (err) { console.error(`❌ Error en Kick local:`, err.message); }
}

async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  const idStr = String(chatId);
  if (!gruposAutorizados.has(idStr)) return;
  const mention = `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;

  if (nombreInvalido(user.first_name)) {
    try {
      await ctx.telegram.declineChatJoinRequest(idStr, user.id);
      acumularMetricasRAM(idStr, 0, 1);
    } catch (e) { console.error("Error al rechazar:", e.message); }
  } else {
    try {
      await ctx.telegram.approveChatJoinRequest(idStr, user.id);
      acumularMetricasRAM(idStr, 1, 0);
      const configGrupo = gruposActivos.get(idStr) || { verBienvenida: true };
      if (configGrupo.verBienvenida !== false) {
        await ctx.telegram.sendMessage(idStr, `👋 Bienvenido ${mention} a <b>${grupoNombre}</b>.`, { 
          parse_mode: "HTML",
          reply_markup: { 
            inline_keyboard: [
              [{ text: "🚫 Rechazar (Ban)", callback_data: `bienvenida_ban_${user.id}` }],
              [{ text: "¿Qué hacer en este grupo?", callback_data: `que_hacer_${idStr}` }],
              [{ text: "📖 Reglamento", callback_data: `show_full_rules_${idStr}` }]
            ] 
          }
        });
      }
    } catch (err) { console.log("Error al procesar ingreso:", err.message); }
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
    if (nombreInvalido(member.first_name)) {
      await ejecutarKickLocal(ctx, chatId, member.id, member.first_name, "Nombre inválido.");
      continue;
    }
    const mention = `<a href="tg://user?id=${member.id}">${member.first_name}</a>`;
    const configGrupo = gruposActivos.get(idStr) || { verBienvenida: true };
    if (configGrupo.verBienvenida !== false) {
      await ctx.telegram.sendMessage(chatId, `👋 Bienvenido ${mention} a <b>${nombreGrupo}</b>.`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚫 Rechazar (Ban)", callback_data: `bienvenida_ban_${member.id}` }],
            [{ text: "¿Qué hacer en este grupo?", callback_data: `que_hacer_${idStr}` }],
            [{ text: "📖 Reglamento", callback_data: `show_full_rules_${idStr}` }]
          ]
        }
      });
    }
  }
});

bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    const messageId = ctx.callbackQuery.message.message_id;

    if (data.startsWith("bienvenida_ban_")) {
      const targetUserId = data.split("_")[2];
      const targetChatId = String(ctx.chat.id);
      if (!(await esAdminDelGrupo(ctx, userId, targetChatId))) return ctx.answerCbQuery("❌ Solo Admins.", { show_alert: true });
      await ejecutarKickLocal(ctx, targetChatId, targetUserId, "Usuario", "Baneo administrativo");
      await ctx.deleteMessage(messageId).catch(() => {});
      return;
    }

    if (data.startsWith("que_hacer_")) {
      const targetChatId = data.split("_")[2];
      const grupo = gruposActivos.get(targetChatId) || { reglamento: 1 };
      const desc = grupo.reglamento === 1 
        ? "COTORREO: Grupo de plática y desmadre. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7. NO es espacio XXX, HOT ni de encuentros."
        : "COTORREO HOT: Espacio para conocer gente HOT, interactuar y promover contenido sin morbo pesado. Tú pones el cotorreo, pero no esperes ser el centro de atención ni actividad 24/7.";
      await ctx.answerCbQuery(desc, { show_alert: true });
      return;
    }

    if (data.startsWith("show_full_rules_")) {
      const targetChatId = data.split("_")[2];
      const grupo = gruposActivos.get(targetChatId) || { reglamento: 1 };
      await ctx.telegram.sendMessage(userId, `📜 <b>REGLAMENTO COMPLETO</b>\n\n${REGLAMENTOS[grupo.reglamento]}`, { 
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "❌ CERRAR Y LIMPIAR", callback_data: "close_rules" }]] }
      });
      await ctx.answerCbQuery("✅ Reglamento enviado a tu privado.");
      return;
    }

    if (data === "close_rules") { await ctx.deleteMessage().catch(() => {}); return; }
  } catch (err) { console.error("❌ Callback Query:", err.message); }
});
// --- BLOQUE 4: Comandos de Consola y Control Administrativo ---

bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') {
    return ctx.reply("👋 Hola. Los grupos protegidos.");
  }
  if (!gruposAutorizados.has(chatId)) return; 
  const g = gruposActivos.get(chatId);
  return ctx.reply(
    `👋 Bot activo en el grupo <b>${g.nombre}</b>.\n\n` +
    `🛡️ Estado: <b>${botPausado ? "⏸️ PAUSADO" : "🟢 ACTIVO"}</b>\n` +
    `📊 Totales Procesados: ${g.usuariosProcesados} | 🚫 Rechazados: ${g.usuariosRechazados}\n` +
    `⚙️ Reglamento Asignado: Reglamento ${g.reglamento || 1}\n` +
    `👋 Saludos de Bienvenida: <b>${g.verBienvenida !== false ? "ON 🟢" : "OFF 🔴"}</b>\n` +
    `🚫 Logs de Filtros/Rechazo: <b>${g.verRechazo !== false ? "ON 🟢" : "OFF 🔴"}</b>\n\n` +
    `💡 Escribe <code>/help</code> para desplegar los comandos válidos.`,
    { parse_mode: "HTML" }
  );
});

bot.command('help', (ctx) => {
  return ctx.reply(
    `🛡️ <b>MANUAL DE COMANDOS DE CONTROL</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `• <code>/start</code> - Ver estado e indicadores.\n` +
    `• <code>/reglas</code> - Despliega el reglamento asignado.\n` +
    `• <code>/setrules [1 o 2]</code> - Cambia el reglamento.\n` +
    `• <code>/gban [ID/Respuesta] [Razón]</code> - Baneo masivo.\n` +
    `• <code>/gmsg [Mensaje]</code> - Comunicado oficial.\n` +
    `• <code>/pausarbot</code> / <code>/reanudarbot</code> - Control global.\n` +
    `• <code>/pausarbienvenida</code> / <code>/reanudarbienvenida</code> - Control bienvenidas.\n` +
    `• <code>/pausarrechazo</code> / <code>/reanudarrechazo</code> - Control logs de rechazo.`,
    { parse_mode: "HTML" }
  );
});

bot.command('gban', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;

  const args = ctx.message.text.split(" ").slice(1);
  let targetUid = ctx.message.reply_to_message ? String(ctx.message.reply_to_message.from.id) : args[0];
  let razon = args.length > 1 ? args.slice(1).join(" ") : "No especificada";

  if (!targetUid || isNaN(targetUid)) {
    return ctx.reply("⚠️ Formato: <code>/gban [ID/Respuesta] [Razón]</code>", { parse_mode: "HTML" });
  }

  let gruposAfectados = 0;
  
  for (const [gId] of gruposAutorizados.entries()) { // Usamos gruposAutorizados o gruposActivos.entries()
    try {
      await ctx.telegram.banChatMember(gId, targetUid);
      gruposAfectados++;

      const msgInfo = await ctx.telegram.sendMessage(gId, 
        `⚠️ <b>GBAN - FEDERACIÓN CANCERBEROS</b> ⚠️\n\n` +
        `👤 <b>Usuario ID:</b> <code>${targetUid}</code>\n` +
        `🚫 <b>Acción:</b> Baneo Global aplicado.\n` +
        `📝 <b>Razón:</b> ${razon}\n\n` +
        `<i>Este mensaje se borrará en 3 minutos por seguridad.</i>`, 
        { parse_mode: "HTML" }
      );

      // Timer de 3 minutos
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(gId, msgInfo.message_id);
        } catch (e) {
          console.log(`ℹ️ No se pudo borrar el mensaje en ${gId}`);
        }
      }, 180000); // 180,000 ms

    } catch (e) {
      console.error(`Error al banear en grupo ${gId}:`, e.message);
    }
  } // <--- Asegúrate de cerrar este bloque

  return ctx.reply(`✅ <b>GBAN COMPLETADO</b> en ${gruposAfectados} grupos.`, { parse_mode: "HTML" });
});
bot.command('gmsg', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  const msg = ctx.message.text.split(" ").slice(1).join(" ");
  if (!msg) return ctx.reply("⚠️ Usa: <code>/gmsg [Mensaje]</code>", { parse_mode: "HTML" });
  let ok = 0;
  for (const [gId] of gruposActivos.entries()) {
    try { await ctx.telegram.sendMessage(gId, `📢 <b>COMUNICADO OFICIAL 📢 FEDERACIÓN CANCERBEROS</b>\n────────>\n\n${msg}`, { parse_mode: "HTML" }); ok++; } catch {}
  }
  return ctx.reply(`✅ <b>Anuncio Desplegado</b> en ${ok} grupos.`, { parse_mode: "HTML" });
});

bot.command('setrules', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  const num = parseInt(ctx.message.text.split(" ")[1]);
  if (!REGLAMENTOS[num]) return ctx.reply("⚠️ Usa: <code>/setrules 1</code> o <code>/setrules 2</code>", { parse_mode: "HTML" });
  const g = gruposActivos.get(chatId);
  g.reglamento = num;
  gruposActivos.set(chatId, g);
  guardarConfiguracionMaestra();
  return ctx.reply(`✅ <b>Reglamento actualizado:</b> Se aplicará el <b>Reglamento ${num}</b>.`, { parse_mode: "HTML" });
});

bot.command('reglas', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId)) return;
  const g = gruposActivos.get(chatId);
  return ctx.reply(`📖 <b>Reglamento de: ${g.nombre}</b>\n\n${REGLAMENTOS[g.reglamento || 1]}`, { parse_mode: "HTML" });
});

bot.command('pausarbot', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (await esAdminDelGrupo(ctx, ctx.from.id, chatId)) { botPausado = true; return ctx.reply("⏸️ <b>SISTEMA EN PAUSA GLOBAL</b>", { parse_mode: "HTML" }); }
});

bot.command('reanudarbot', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  botPausado = false;
  ctx.reply("▶️ <b>SISTEMA REANUDADO</b>", { parse_mode: "HTML" });
  try {
    const res = await ctx.telegram.callApi('getChatJoinRequests', { chat_id: chatId });
    if (res?.requests) for (const req of res.requests) await evaluarSolicitud(ctx, req.from, chatId, gruposActivos.get(chatId).nombre);
  } catch (e) { console.error("Error al procesar pendientes:", e.message); }
});

bot.command('pausarbienvenida', async (ctx) => { const g = gruposActivos.get(String(ctx.chat.id)); g.verBienvenida = false; guardarConfiguracionMaestra(); ctx.reply("🔴 <b>Bienvenidas Ocultas.</b>", { parse_mode: "HTML" }); });
bot.command('reanudarbienvenida', async (ctx) => { const g = gruposActivos.get(String(ctx.chat.id)); g.verBienvenida = true; guardarConfiguracionMaestra(); ctx.reply("🟢 <b>Bienvenidas Activadas.</b>", { parse_mode: "HTML" }); });
bot.command('pausarrechazo', async (ctx) => { const g = gruposActivos.get(String(ctx.chat.id)); g.verRechazo = false; guardarConfiguracionMaestra(); ctx.reply("🔴 <b>Logs de Rechazo Ocultos.</b>", { parse_mode: "HTML" }); });
bot.command('reanudarrechazo', async (ctx) => { const g = gruposActivos.get(String(ctx.chat.id)); g.verRechazo = true; guardarConfiguracionMaestra(); ctx.reply("🟢 <b>Logs de Rechazo Activos.</b>", { parse_mode: "HTML" }); });

// --- BLOQUE 5: Servidor Web ---
// 1. Declaramos las constantes necesarias
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN_MASTER = process.env.WEBHOOK_SECRET_TOKEN;

// 2. Configuración del Webhook
setTimeout(() => {
  console.log("🌐 Conectando con la API de Telegram...");
  bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`, {
    secret_token: SECRET_TOKEN_MASTER
  })
  .then(() => console.log("✅ Webhook configurado correctamente."))
  .catch(err => console.error("⚠️ Error al configurar Webhook:", err.message));
}, 5000);

// 3. Middleware de Express
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`, {
  secretToken: SECRET_TOKEN_MASTER
}));

app.get('/', (req, res) => res.send('🚀 Shield Online.'));

// 4. Inicio del servidor (Aquí ya reconocerá la constante PORT definida arriba)
app.listen(PORT, () => console.log("🚀 Servidor escuchando en el puerto " + PORT));
