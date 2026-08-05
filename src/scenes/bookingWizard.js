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
      'Пока нет ни одной услуги в прайсе. Попросите мастера добавить услуги через админ-панель (/admin).'
    );
    return ctx.scene.leave();
  }
  ctx.wizard.state.booking = {};
  const buttons = services.map((s) => [
    Markup.button.callback(`${s.name} — ${s.price}₽ (${s.duration_min} мин)`, `svc:${s.name}`),
  ]);
  await ctx.reply('Выберите услугу:', Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseService(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Пожалуйста, выберите услугу кнопкой выше.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('svc:')) return;
  const serviceName = data.slice(4);
  const services = await sheets.getServices();
  const service = services.find((s) => s.name === serviceName);
  if (!service) {
    await ctx.reply('Эта услуга больше недоступна, начните заново: /book');
    return ctx.scene.leave();
  }
  ctx.wizard.state.booking.service = service.name;
  ctx.wizard.state.booking.price = service.price;

  const freeSlots = await sheets.getFreeSlots();
  if (!freeSlots.length) {
    await ctx.reply('Свободных слотов пока нет. Попробуйте позже или напишите мастеру напрямую.');
    return ctx.scene.leave();
  }
  const dates = [...new Set(freeSlots.map((s) => s.date))];
  const buttons = dates.map((d) => [Markup.button.callback(formatDateLabel(d), `date:${d}`)]);
  await ctx.editMessageText('Выберите дату:', Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseDate(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Пожалуйста, выберите дату кнопкой выше.');
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
    await ctx.reply('На эту дату слотов уже не осталось, выберите другую: /book');
    return ctx.scene.leave();
  }
  const buttons = times.map((t) => [Markup.button.callback(t, `time:${t}`)]);
  await ctx.editMessageText(`Дата: ${formatDateLabel(date)}\nВыберите время:`, Markup.inlineKeyboard(buttons));
  return ctx.wizard.next();
}

async function chooseTime(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Пожалуйста, выберите время кнопкой выше.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (!data.startsWith('time:')) return;
  const time = data.slice(5);
  ctx.wizard.state.booking.time = time;
  await ctx.editMessageText('Как вас зовут? Напишите имя.');
  return ctx.wizard.next();
}

async function askName(ctx) {
  if (!ctx.message || !ctx.message.text) {
    await ctx.reply('Напишите имя текстом.');
    return;
  }
  ctx.wizard.state.booking.clientName = ctx.message.text.trim();
  await ctx.reply(
    'Укажите номер телефона для связи (можно нажать кнопку, чтобы поделиться контактом):',
    Markup.keyboard([Markup.button.contactRequest('📱 Отправить телефон')])
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
    await ctx.reply('Пришлите номер телефона текстом или кнопкой.');
    return;
  }
  ctx.wizard.state.booking.phone = phone;
  const b = ctx.wizard.state.booking;
  await ctx.reply(
    `Проверьте данные записи:\n\n` +
      `Услуга: ${b.service}\n` +
      `Дата: ${formatDateLabel(b.date)}\n` +
      `Время: ${b.time}\n` +
      `Имя: ${b.clientName}\n` +
      `Телефон: ${b.phone}\n` +
      `Стоимость: ${b.price}₽`,
    Markup.removeKeyboard()
  );
  await ctx.reply(
    'Всё верно?',
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Подтвердить', 'confirm:yes'),
      Markup.button.callback('❌ Отменить', 'confirm:no'),
    ])
  );
  return ctx.wizard.next();
}

async function confirmBooking(ctx) {
  if (!ctx.callbackQuery) {
    await ctx.reply('Нажмите «Подтвердить» или «Отменить» выше.');
    return;
  }
  const data = ctx.callbackQuery.data;
  await ctx.answerCbQuery();
  if (data === 'confirm:no') {
    await ctx.editMessageText('Запись отменена. Чтобы начать заново, отправьте /book');
    return ctx.scene.leave();
  }
  const b = ctx.wizard.state.booking;

  // На всякий случай перепроверяем, что слот всё ещё свободен (вдруг кто-то успел его занять).
  const freeSlots = await sheets.getFreeSlots();
  const stillFree = freeSlots.some((s) => s.date === b.date && s.time === b.time);
  if (!stillFree) {
    await ctx.editMessageText('К сожалению, это время уже заняли, пока вы выбирали. Начните заново: /book');
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
    `Готово! Вы записаны на ${formatDateLabel(b.date)} в ${b.time} (${b.service}).\n` +
      `Мы пришлём напоминание за ${config.REMINDER_HOURS_BEFORE} ч. до визита.`
  );

  if (config.ADMIN_CHAT_ID) {
    await ctx.telegram
      .sendMessage(
        config.ADMIN_CHAT_ID,
        `📅 Новая запись #${id}\n` +
          `Услуга: ${b.service} (${b.price}₽)\n` +
          `Дата: ${formatDateLabel(b.date)} в ${b.time}\n` +
          `Клиент: ${b.clientName}, тел. ${b.phone}\n` +
          `Telegram: @${ctx.from.username || '—'} (id ${ctx.from.id})`
      )
      .catch((e) => console.error('Не удалось уведомить мастера:', e.message));
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
