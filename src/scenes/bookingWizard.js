const { Scenes, Markup } = require('telegraf');
const dayjs = require('dayjs');
const sheets = require('../sheets');
const config = require('../config');

const STEP = {
  SERVICE: 'service',
  DATE: 'date',
  TIME: 'time',
  NAME: 'name',
  PHONE: 'phone',
  CONFIRM: 'confirm',
};

function formatDateLabel(dateStr) {
  return dayjs(dateStr).format('DD.MM.YYYY (dd)');
}

async function enterScene(ctx) {
  const services = await sheets.getServices();
  if (!services.length) {
    await ctx.reply(
      'Поки немає жодної послуги в прайсі. Попросіть майстра додати послуги через адмін-панель (/admin).'
    );
    return ctx.scene.leave();
  }
  ctx.wizard.state.booking = {};
  const buttons = services.map((s) => [
    Markup.button.callback(`${s.name} — ${s.price}₴ (${s.duration_min} хв)`, `svc:${s.name}`),
  ]);
  await ctx.reply('Оберіть послугу:', Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseService(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть послугу кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('svc:')) return;
  const serviceName = data.slice(4);
  const services = await sheets.getServices();
  const service = services.find((s) => s.name === serviceName);
  if (!service) {
    await ctx.reply('Ця послуга вже недоступна, почніть заново: /book');
    return ctx.scene.leave();
  }
  ctx.wizard.state.booking.service = service.name;
  ctx.wizard.state.booking.price = service.price;

  const freeSlots = await sheets.getFreeSlots();
  if (!freeSlots.length) {
    await ctx.reply('Вільних слотів поки немає. Спробуйте пізніше або напишіть майстру напряму.');
    return ctx.scene.leave();
  }
  const dates = [...new Set(freeSlots.map((s) => s.date))];
  const buttons = dates.map((d) => [Markup.button.callback(formatDateLabel(d), `date:${d}`)]);
  await ctx.editMessageText('Оберіть дату:', Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseDate(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть дату кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('date:')) return;
  const date = data.slice(5);
  ctx.wizard.state.booking.date = date;

  const freeSlots = await sheets.getFreeSlots();
  const times = freeSlots.filter((s) => s.date === date).map((s) => s.time);
  if (!times.length) {
    await ctx.reply('На цю дату слотів вже не залишилось, оберіть іншу: /book');
    return ctx.scene.leave();
  }
  const buttons = times.map((t) => [Markup.button.callback(t, `time:${t}`)]);
  await ctx.editMessageText(`Дата: ${formatDateLabel(date)}\nОберіть час:`, Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseTime(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Будь ласка, оберіть час кнопкою вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('time:')) return;
  const time = data.slice(5);
  ctx.wizard.state.booking.time = time;
  await ctx.editMessageText('Як вас звати? Напишіть ім\'я.');
  return ctx.wizard.next();
}

async function askName(ctx) {
  if (!ctx.message || !ctx.message.text) {
    await ctx.reply('Напишіть ім\'я текстом.');
    return;
  }
  ctx.wizard.state.booking.clientName = ctx.message.text.trim();
  await ctx.reply(
    'Вкажіть номер телефону для зв\'язку (можна натиснути кнопку, щоб поділитися контактом):',
    Markup.keyboard([Markup.button.contactRequest('📱 Надіслати телефон')])
      .oneTime()
      .resize()
  );
  return ctx.wizard.next();
}

async function askPhone(ctx) {
  let phone = null;
  if (ctx.message && ctx.message.contact) {
    phone = ctx.message.contact.phone_number;
  } else if (ctx.message && ctx.message.text) {
    phone = ctx.message.text.trim();
  }
  if (!phone) {
    await ctx.reply('Надішліть номер телефону текстом або кнопкою.');
    return;
  }
  ctx.wizard.state.booking.phone = phone;
  const b = ctx.wizard.state.booking;
  await ctx.reply(
    `Перевірте дані запису:\n\n` +
      `Послуга: ${b.service}\n` +
      `Дата: ${formatDateLabel(b.date)}\n` +
      `Час: ${b.time}\n` +
      `Ім'я: ${b.clientName}\n` +
      `Телефон: ${b.phone}\n` +
      `Вартість: ${b.price}₴`,
    Markup.removeKeyboard()
  );
  await ctx.reply(
    'Все вірно?',
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Підтвердити', 'confirm:yes'),
      Markup.button.callback('❌ Скасувати', 'confirm:no'),
    ])
  );
  return ctx.wizard.next();
}

async function confirmBooking(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Натисніть «Підтвердити» або «Скасувати» вище.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (data === 'confirm:no') {
    await ctx.editMessageText('Запис скасовано. Щоб почати заново, надішліть /book');
    return ctx.scene.leave();
  }
  const b = ctx.wizard.state.booking;

  // На всяк випадок перевіряємо, що слот ще вільний (раптом хтось встиг його зайняти).
  const freeSlots = await sheets.getFreeSlots();
  const stillFree = freeSlots.some((s) => s.date === b.date && s.time === b.time);
  if (!stillFree) {
    await ctx.editMessageText('На жаль, цей час вже зайняли, поки ви обирали. Почніть заново: /book');
    return ctx.scene.leave();
  }

  const id = await sheets.addBooking({
    date: b.date,
    time: b.time,
    service: b.service,
    price: b.price,
    clientName: b.clientName,
    phone: b.phone,
    clientChatId: ctx.from.id,
  });

  await ctx.editMessageText(
    `Готово! Вас записано на ${formatDateLabel(b.date)} о ${b.time} (${b.service}).\n` +
      `Ми надішлемо нагадування за ${config.REMINDER_HOURS_BEFORE} год. до візиту.`
  );

  if (config.ADMIN_CHAT_ID) {
    await ctx.telegram
      .sendMessage(
        config.ADMIN_CHAT_ID,
        `📅 Новий запис #${id}\n` +
          `Послуга: ${b.service} (${b.price}₴)\n` +
          `Дата: ${formatDateLabel(b.date)} о ${b.time}\n` +
          `Клієнт: ${b.clientName}, тел. ${b.phone}\n` +
          `Telegram: @${ctx.from.username || '—'} (id ${ctx.from.id})`
      )
      .catch((e) => console.error('Не вдалося сповістити майстра:', e.message));
  }

  return ctx.scene.leave();
}

const bookingWizard = new Scenes.WizardScene(
  'booking-wizard',
  enterScene,
  chooseService,
  chooseDate,
  chooseTime,
  askName,
  askPhone,
  confirmBooking
);

module.exports = { bookingWizard, STEP };
