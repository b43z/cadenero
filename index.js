const { Telegraf } = require('telegraf');

// Reemplaza con tu token
const bot = new Telegraf('8575442767:AAG9MBOMGuNrJOD0iuSTA0liICx6nx2wMC0');

// Función de validación de nombres
function nombreInvalido(nombre) {
  if (!nombre) return false;

  // Solo símbolos/puntuación
  if (/^[\p{P}\p{S}]+$/u.test(nombre)) return true;

  // Solo una letra
  if (/^[A-Za-z]$/.test(nombre)) return true;

  // Solo emojis (usando rango Unicode aproximado)
  if (/^[\p{Emoji}]+$/u.test(nombre)) return true;

  // Dos o más letras repetidas consecutivas
  if (/([A-Za-z])\1{1,}/.test(nombre)) return true;

  return false;
}

// Middleware para loguear cada mensaje y grupo
bot.use((ctx, next) => {
  console.log("Mensaje en chat:", ctx.chat.id, "->", ctx.message?.text);
  return next();
});

// Bienvenida y validación de nuevos miembros
bot.on("new_chat_members", async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    const nombre = member.first_name || member.username || "";
    if (nombreInvalido(nombre)) {
      try {
        await ctx.kickChatMember(member.id);
        ctx.reply(`🚫 Usuario ${nombre} expulsado por nombre inválido.`);
      } catch (err) {
        console.error("Error al expulsar:", err);
        ctx.reply(`⚠️ No pude expulsar a ${nombre}, revisa permisos del bot.`);
      }
    } else {
      ctx.reply(`👋 Bienvenido/a ${nombre}!`);
    }
  }
});

// Mensaje de despedida
bot.on("left_chat_member", (ctx) => {
  ctx.reply(`👋 Adiós ${ctx.left_chat_member.first_name}, suerte!`);
});

// Comando básico
bot.command("ping", (ctx) => {
  ctx.reply("🏓 Pong!");
});

// Comando /start para corroborar que el bot está activo
bot.start((ctx) => {
  ctx.reply("✅ El Bot está funcionando y mandando alv a los misteriosos");
});

// Inline query
bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query || "";
  const results = [
    {
      type: "article",
      id: "1",
      title: "Eco del texto",
      input_message_content: {
        message_text: `Tu consulta fue: ${query}`
      }
    }
  ];
  await ctx.answerInlineQuery(results);
});

bot.launch();
