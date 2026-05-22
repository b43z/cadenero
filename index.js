const { Telegraf } = require('telegraf');

// Reemplaza con tu token
const bot = new Telegraf('8575442767:AAG9MBOMGuNrJOD0iuSTA0liICx6nx2wMC0');

// Función para validar nombres
function nombreInvalido(nombre) {
  if (!nombre) return true;

  // 1.- Solo símbolos de puntuación
  const soloSimbolos = /^[\p{P}\p{S}]+$/u.test(nombre);

  // 2.- Solo una letra
  const unaLetra = /^[A-Za-zÁÉÍÓÚÜÑ]$/u.test(nombre);

  // 3.- Solo emojis
  const soloEmoji = /^[\p{Emoji}]+$/u.test(nombre);

  // 4.- Dos o más letras repetidas consecutivas
  const letrasRepetidas = /(.)\1{1,}/u.test(nombre);

  return soloSimbolos || unaLetra || soloEmoji || letrasRepetidas;
}

// 1.- Comando /start
bot.start((ctx) => {
  ctx.reply("El bot se encuentra en funciones.");
});

// 2.- Evaluar nuevos usuarios al ingresar
bot.on('new_chat_members', async (ctx) => {
  ctx.message.new_chat_members.forEach(async (user) => {
    const nombre = user.first_name || "";
    if (nombreInvalido(nombre)) {
      try {
        await ctx.kickChatMember(user.id);
        ctx.reply(`🚫 Usuario baneado automáticamente: ${nombre}`);
      } catch (err) {
        console.error("Error al banear:", err.message);
      }
    } else {
      ctx.reply(`👋 Bienvenido ${nombre}`);
    }
  });
});

// Lanzar el bot
bot.launch().then(() => {
  console.log("Bot iniciado y en funciones.");
});
