avaScript
// ============================================================================
//   SISTEMA DE CONTROL PRO — MONITOR CENTRAL DE SEGURIDAD (VERSION OPTIMIZADA)
// ============================================================================

const { Telegraf } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// --- CONFIGURACIÓN Y VALIDACIÓN ---
if (!process.env.BOT_TOKEN || !process.env.WEBHOOK_URL || !process.env.WEBHOOK_SECRET_TOKEN) {
  console.error("❌ ERROR CRÍTICO: Faltan variables de entorno esenciales");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const gruposActivos = new Map();
const gruposAutorizados = new Set();
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
        gruposActivos.set(idStr, { ...grupo, id: idStr });
        gruposAutorizados.add(idStr);
      });
    }
  } catch (err) { console.error("❌ PERSISTENCIA:", err.message); }
}

cargarConfiguracionMaestra();

const REGLAMENTOS = {
  1: `💬 <b>COTORREO</b> 💬\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Preséntate:</b> interactúa, no seas un "mueble".\n💀 <b>Prohibido:</b> Fotopitos, CP, Gore, Zoo, etc.\n💀 <b>Sin Spam:</b> Ventas, links, etc.\n💀 <b>Material:</b> Solo propio +18 (se Elimina Auto).`,
  2: `🔥<b>COTORREO HOT</b>🔥\n\n⚰️ <i>Reglamento</i> ⚰️\n💀 <b>Actividad:</b> Intégrate al desmadre.\n💀 <b>Prohibido:</b> Fotopitos, ilegalidades.\n💀 <b>Material:</b> Solo propio +18 (se Elimina Auto).`
};

// --- UTILIDADES ---
async function esAdminDelGrupo(ctx, userId, chatId) {
  try {
    const admins = await ctx.telegram.getChatAdministrators(chatId);
    return admins.some(admin => admin.user.id === userId);
  } catch { return false; }
}

function nombreInvalido(nombre) {
  if (!nombre) return true;
  const original = nombre.trim();
  const prohibidos = ["http", "https", "www", ".com", ".net", ".org"];
  if (prohibidos.some(p => original.toLowerCase().includes(p))) return true;
  if (/[\p{P}\p{S}\s\d]/gu.test(original)) return true;
  return false;
}

async function ejecutarKickLocal(ctx, targetChatId, targetUserId) {
  try {
    await ctx.telegram.banChatMember(targetChatId, targetUserId);
    await ctx.telegram.unbanChatMember(targetChatId, targetUserId);
  } catch (err) { console.error(`❌ Kick fallido:`, err.message); }
}

async function enviarValidacionPrivada(ctx, user, idStr, grupoNombre) {
  const grupo = gruposActivos.get(idStr) || { reglamento: 1 };
  const msgEnviado = await ctx.telegram.sendMessage(user.id, `⚡ <b>SOLICITUD:</b> ${grupoNombre}\n\n${REGLAMENTOS[grupo.reglamento]}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "✅ ACEPTAR Y ENTRAR", callback_data: `reg_ok_${idStr}` }], [{ text: "❌ RECHAZAR", callback_data: `reg_no_${idStr}` }]]
    }
  });

  const timer = setTimeout(async () => {
    await ctx.telegram.deleteMessage(user.id, msgEnviado.message_id).catch(() => {});
    await ejecutarKickLocal(ctx, idStr, user.id);
    temporizadoresSolicitudes.delete(`${user.id}_${idStr}`);
  }, 600000); 

  temporizadoresSolicitudes.set(`${user.id}_${idStr}`, timer);
}

// --- COMANDOS ---
bot.command('start', async (ctx) => {
  const nombreGrupo = ctx.chat.title || "Privado";
  const esAdmin = await esAdminDelGrupo(ctx, ctx.from.id, ctx.chat.id);
  const permisos = esAdmin ? "Gestión Total (Administrador)" : "Usuario Restringido (Lectura)";
  
  ctx.reply(`💀 **Sistema Portero en ${nombreGrupo}**\n\n` +
            `👤 **Usuario:** ${ctx.from.first_name}\n` +
            `🛡️ **Estado:** ${permisos}\n\n` +
            `El bot está activo protegiendo el ingreso.`, { parse_mode: "Markdown" });
});

bot.command('help', (ctx) => {
  const ayuda = `⚙️ **Manual de Comandos - Portero**\n\n` +
                `1. /start\n` +
                `   - Quién: Todos\n` +
                `   - Explicación: Info del grupo y tus permisos actuales.\n\n` +
                `2. /help\n` +
                `   - Quién: Todos\n` +
                `   - Explicación: Muestra este menú de ayuda.\n\n` +
                `*Nota: La administración de miembros es automática mediante eventos de unión.*`;
  
  ctx.reply(ayuda, { parse_mode: "Markdown" });
});

// --- LÓGICA PRINCIPAL ---
async function evaluarSolicitud(ctx, user, chatId, grupoNombre) {
  const idStr = String(chatId);
  if (nombreInvalido(user.first_name)) {
    await ctx.telegram.declineChatJoinRequest(idStr, user.id);
    return;
  }
  try {
    await ctx.telegram.approveChatJoinRequest(idStr, user.id);
    await ctx.telegram.restrictChatMember(idStr, user.id, { permissions: { can_send_messages: false } });
    await enviarValidacionPrivada(ctx, user, idStr, grupoNombre);
  } catch (err) { await ejecutarKickLocal(ctx, idStr, user.id); }
}

// --- EVENTOS ---
bot.on('chat_join_request', async (ctx) => {
  if (botPausado) return;
  await evaluarSolicitud(ctx, ctx.chatJoinRequest.from, ctx.chat.id, ctx.chat.title);
});

bot.on('new_chat_members', async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    if (nombreInvalido(member.first_name)) {
      await ejecutarKickLocal(ctx, ctx.chat.id, member.id);
      continue;
    }
    await ctx.telegram.restrictChatMember(ctx.chat.id, member.id, { permissions: { can_send_messages: false } });
    await enviarValidacionPrivada(ctx, member, ctx.chat.id, ctx.chat.title);
  }
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("reg_ok_")) {
    const chatId = data.split("_")[2];
    await ctx.telegram.restrictChatMember(chatId, ctx.from.id, { permissions: { can_send_messages: true } });
    await ctx.deleteMessage().catch(() => {});
    ctx.reply("✅ Acceso concedido.");
  }
});

// --- SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`, { secretToken: process.env.WEBHOOK_SECRET_TOKEN }));
app.listen(PORT, () => console.log("🚀 Servidor en línea."));
