const { Telegraf } = require('telegraf');

// Usa el token desde variables de entorno en Railway
const bot = new Telegraf(process.env.BOT_TOKEN);

// Función para validar nombres
function nombreInvalido(nombre) {
  if (!nombre) return true;
  const soloSimbolos = /^[\p{P}\p{S}]+$/u.test(nombre);
  const unCaracter = nombre.length === 1;
  const soloEmoji = /^[\p{Emoji}]+$/u.test(nombre);
  return soloSimbolos || unCaracter || soloEmoji;
}

// Comando /start
bot.start((ctx) => {
  ctx.reply("El bot se encuentra en funciones.");
  console.log(`[INFO] Bot activado en chat: ${ctx.chat.title || ctx.chat.id}`);
});

// Evaluar nuevos usuarios en cualquier grupo
bot.on('new_chat_members', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatTitle = ctx.chat.title || `Chat ${chatId}`;

  ctx.message.new_chat_members.forEach(async (user) => {
    const nombre = user.first_name || "";
    const username = user.username ? `@${user.username}` : "(sin username)";

    if (nombreInvalido(nombre)) {
      try {
        await ctx.kickChatMember(user.id);
        ctx.reply(`🚫 Usuario baneado automáticamente: ${nombre}`);
        console.log(`[BAN] Usuario baneado en "${chatTitle}" → Nombre: "${nombre}", Username: ${username}, ID: ${user.id}`);
      } catch (err) {
        console.error(`[ERROR] No se pudo banear en "${chatTitle}" → Usuario: ${nombre}, Error: ${err.message}`);
      }
    } else {
      ctx.reply(`👋 Bienvenido ${nombre}`);
      console.log(`[JOIN] Nuevo usuario en "${chatTitle}" → Nombre: "${nombre}", Username: ${username}, ID: ${user.id}`);
    }
  });
});

// Lanzar el bot
bot.launch().then(() => {
  console.log("[INFO] Bot iniciado y en funciones en todos los grupos donde esté agregado.");
});
