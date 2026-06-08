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

// --- PERSISTENCIA ---
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

// --- LÓGICA ---
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
    guardarConfiguracionMaestra(); 
  }
}

async function ejecutarKickLocal(ctx, targetChatId, targetUserId) {
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
              [{ text: "¿De qué trata este grupo?", callback_data: `que_hacer_${idStr}` }],
              [{ text: "📖 Reglamento", callback_data: `show_full_rules_${idStr}` }]
            ] 
          }
        });
      }
    } catch (err) { console.log("Error al procesar ingreso:", err.message); }
  }
}

// --- EVENTOS ---
bot.on('chat_join_request', async (ctx) => {
  // Log para depuración: Esto aparecerá en tu consola (o logs del servidor)
  // si Telegram está entregando correctamente el evento.
  console.log("📥 Recibida solicitud de:", ctx.chatJoinRequest.from.username || ctx.chatJoinRequest.from.first_name);
  
  if (botPausado) {
    console.log("⏸️ Bot pausado, ignorando solicitud.");
    return;
  }
  
  await evaluarSolicitud(
    ctx, 
    ctx.chatJoinRequest.from, 
    ctx.chatJoinRequest.chat.id, 
    ctx.chatJoinRequest.chat.title
  );
});

bot.on('new_chat_members', async (ctx) => {
  if (botPausado) return;
  const chatId = ctx.chat.id;
  const idStr = String(chatId);
  if (!gruposAutorizados.has(idStr)) return;

  for (const member of ctx.message.new_chat_members) {
    if (member.id === ctx.botInfo.id) continue;
    if (nombreInvalido(member.first_name)) {
      await ejecutarKickLocal(ctx, chatId, member.id);
      continue;
    }
  }
});

bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    
    // CORRECCIÓN: Obtenemos el chat y el mensaje a través del objeto callbackQuery
    const message = ctx.callbackQuery.message;
    if (!message) return; // Seguridad: Si no hay mensaje, abortamos
    
    const chatId = message.chat.id;
    const messageId = message.message_id;

    if (data.startsWith("bienvenida_ban_")) {
      const targetUserId = data.split("_")[2];
      if (!(await esAdminDelGrupo(ctx, userId, chatId))) return ctx.answerCbQuery("❌ Solo Admins.", { show_alert: true });
      await ejecutarKickLocal(ctx, chatId, targetUserId);
      await ctx.deleteMessage(messageId).catch(() => {});
      return;
    }

    if (data.startsWith("que_hacer_")) {
      const targetChatId = data.split("_")[2];
      const grupo = gruposActivos.get(targetChatId) || { reglamento: 1 };
      const desc = grupo.reglamento === 1 ? "COTORREO: NO es espacio XXX, HOT ni de Encuentros" : "COTORREO HOT: Espacio para conocer gente HOT.sin morbo pesado";
      await ctx.answerCbQuery(desc, { show_alert: true });
      return;
    }

    if (data.startsWith("show_full_rules_")) {
      const targetChatId = data.split("_")[2];
      const grupo = gruposActivos.get(targetChatId) || { reglamento: 1 };
      await ctx.telegram.sendMessage(userId, `📜 <b>REGLAMENTO COMPLETO</b>\n\n${REGLAMENTOS[grupo.reglamento]}`, { 
        parse_mode: "HTML",
        reply_markup: { 
          inline_keyboard: [
            [{ text: "⬅️ Volver al Grupo", url: "https://t.me/TU_LINK_REAL" }],
            [{ text: "❌ CERRAR", callback_data: "close_rules" }]
          ] 
        }
      });
      await ctx.answerCbQuery("✅ Reglamento enviado a tu privado.");
      return;
    }

    if (data === "close_rules") { 
      // Al ser un mensaje privado, ctx.deleteMessage() funcionará correctamente aquí
      await ctx.deleteMessage().catch(() => {}); 
      return;
    }
  } catch (e) { console.error("Error en Callback:", e.message); }
});

// --- COMANDOS DE CONTROL ---
bot.start((ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.chat.type === 'private') return ctx.reply("👋 Hola. Los grupos protegidos.");
  if (!gruposAutorizados.has(chatId)) return; 
  const g = gruposActivos.get(chatId);
  return ctx.reply(
    `👋 Bot activo en <b>${g.nombre}</b>.\n🛡️ Estado: <b>${botPausado ? "⏸️ PAUSADO" : "🟢 ACTIVO"}</b>\n` +
    `📊 Procesados: ${g.usuariosProcesados} | 🚫 Rechazados: ${g.usuariosRechazados}\n` +
    `⚙️ Reglamento: ${g.reglamento}\n` +
    `👋 Bienvenidas: <b>${g.verBienvenida ? "ON 🟢" : "OFF 🔴"}</b>\n` +
    `🚫 Logs: <b>${g.verRechazo ? "ON 🟢" : "OFF 🔴"}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.command('gban', async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!gruposAutorizados.has(chatId) || !(await esAdminDelGrupo(ctx, ctx.from.id, chatId))) return;
  const args = ctx.message.text.split(" ").slice(1);
  const targetUid = ctx.message.reply_to_message ? String(ctx.message.reply_to_message.from.id) : args[0];
  const razon = args.length > 1 ? args.slice(1).join(" ") : "No especificada";
  if (!targetUid || isNaN(targetUid)) return ctx.reply("⚠️ Formato: /gban [ID/Respuesta] [Razón]");

  let gruposAfectados = 0;
  for (const gId of gruposAutorizados) {
    try {
      await ctx.telegram.banChatMember(gId, targetUid);
      gruposAfectados++;
      const msgInfo = await ctx.telegram.sendMessage(gId, `⚠️ <b>GBAN</b>\nID: <code>${targetUid}</code>\nRazón: ${razon}`, { parse_mode: "HTML" });
      setTimeout(() => ctx.telegram.deleteMessage(gId, msgInfo.message_id).catch(() => {}), 180000);
    } catch (e) { console.error(`Error en grupo ${gId}:`, e.message); }
  }
  return ctx.reply(`✅ <b>GBAN COMPLETADO</b> en ${gruposAfectados} grupos.`, { parse_mode: "HTML" });
});

// Comandos de toggle con validación de existencia del grupo
const toggleCmds = [
  { cmd: 'pausarbienvenida', key: 'verBienvenida', val: false, msg: "🔴 Bienvenidas Ocultas." },
  { cmd: 'reanudarbienvenida', key: 'verBienvenida', val: true, msg: "🟢 Bienvenidas Activadas." },
  { cmd: 'pausarrechazo', key: 'verRechazo', val: false, msg: "🔴 Logs de Rechazo Ocultos." },
  { cmd: 'reanudarrechazo', key: 'verRechazo', val: true, msg: "🟢 Logs de Rechazo Activos." }
];

toggleCmds.forEach(c => {
  bot.command(c.cmd, async (ctx) => {
    const g = gruposActivos.get(String(ctx.chat.id));
    if (!g) return;
    g[c.key] = c.val;
    guardarConfiguracionMaestra();
    ctx.reply(c.msg, { parse_mode: "HTML" });
  });
});

bot.command('pausarbot', async (ctx) => { if (await esAdminDelGrupo(ctx, ctx.from.id)) { botPausado = true; ctx.reply("⏸️ PAUSA GLOBAL"); } });
bot.command('reanudarbot', async (ctx) => { if (await esAdminDelGrupo(ctx, ctx.from.id)) { botPausado = false; ctx.reply("▶️ REANUDADO"); } });

// --- BLOQUE 5: Servidor Web ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN_MASTER = process.env.WEBHOOK_SECRET_TOKEN;

// 1. Middleware
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`, { secretToken: SECRET_TOKEN_MASTER }));
app.get('/', (req, res) => res.send('🚀 Shield Online.'));

// 2. Servidor y registro de Webhook
app.listen(PORT, async () => {
  console.log("🚀 Servidor activo en " + PORT);
  
  try {
    const webhookPath = `${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`;
    await bot.telegram.setWebhook(webhookPath, {
      secret_token: SECRET_TOKEN_MASTER
    });
    console.log("✅ Webhook configurado correctamente en:", webhookPath);
  } catch (error) {
    console.error("❌ ERROR al configurar Webhook:", error.message);
  }
});

