require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Внимание: переменная окружения ${name} не задана`);
  }
  return value;
}

module.exports = {
  BOT_TOKEN: required('BOT_TOKEN'),
  ADMIN_CHAT_ID: String(process.env.ADMIN_CHAT_ID || ''),
  SHEET_ID: required('SHEET_ID'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  // В .env приватный ключ хранится с \n вместо переносов строк — разворачиваем обратно
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  REMINDER_HOURS_BEFORE: Number(process.env.REMINDER_HOURS_BEFORE || 24),
  CRON_SECRET: process.env.CRON_SECRET || '',
  PUBLIC_URL: process.env.PUBLIC_URL || '',
  PORT: Number(process.env.PORT || 3000),
};
