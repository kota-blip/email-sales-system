/**
 * Telegram Bot API 連携（Apps Script版）
 * 請求書抽出結果の通知・承認/修正/却下（ダブルチェック）・月次サマリ通知を担当
 */

const TG_CB_APPROVE = 'appr';
const TG_CB_EDIT = 'edit';
const TG_CB_REJECT = 'rej';
const TG_CB_CONFIRM_MONTH = 'confm';
const TG_CB_PAYABLE_YES = 'payy';
const TG_CB_PAYABLE_NO = 'payn';

function tgApiUrl_(method) {
  return `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`;
}

function tgCall_(method, payload) {
  const response = UrlFetchApp.fetch(tgApiUrl_(method), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const raw = response.getContentText();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    Logger.log(`Telegram APIレスポンス解析エラー (${method}): ${raw}`);
    return { ok: false, error: raw };
  }
  if (!data.ok) {
    Logger.log(`Telegram APIエラー (${method}): ${raw}`);
  }
  return data;
}

function tgSendMessage(text, chatId, replyMarkup) {
  const payload = { chat_id: chatId || CONFIG.TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgCall_('sendMessage', payload);
}

/** 抽出結果を通知し、承認/修正/却下ボタンを付ける（ダブルチェックの起点）
 *  askPayable=true なら「これは支払うものですか？」の判定ボタンも上段に付ける */
function tgSendInvoiceApproval(caseId, text, chatId, askPayable) {
  const rows = [];
  if (askPayable) {
    rows.push([
      { text: '💰 支払うものです', callback_data: `${TG_CB_PAYABLE_YES}:${caseId}` },
      { text: '🚫 対象外です', callback_data: `${TG_CB_PAYABLE_NO}:${caseId}` },
    ]);
  }
  rows.push([
    { text: '✅ 承認', callback_data: `${TG_CB_APPROVE}:${caseId}` },
    { text: '✏️ 修正', callback_data: `${TG_CB_EDIT}:${caseId}` },
    { text: '❌ 却下', callback_data: `${TG_CB_REJECT}:${caseId}` },
  ]);
  return tgSendMessage(text, chatId, { inline_keyboard: rows });
}

/** 月末の最終目視チェック依頼（人間の最終承認ゲート） */
function tgSendMonthEndConfirmation(yyyymm, text, chatId) {
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ 今月分を確認済みにする', callback_data: `${TG_CB_CONFIRM_MONTH}:${yyyymm}` },
    ]],
  };
  return tgSendMessage(text, chatId, keyboard);
}

function tgAnswerCallbackQuery(callbackQueryId, text) {
  return tgCall_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
}

function tgClearKeyboard(chatId, messageId) {
  return tgCall_('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

function tgSetWebhook(url) {
  return tgCall_('setWebhook', { url: url });
}

function tgDeleteWebhook() {
  return tgCall_('deleteWebhook', {});
}

/** Telegramのupdate JSONを扱いやすい形に変換する */
function parseTelegramUpdate_(data) {
  if (data.callback_query) {
    const cq = data.callback_query;
    const raw = String(cq.data || '');
    const sep = raw.indexOf(':');
    const action = sep >= 0 ? raw.substring(0, sep) : raw;
    const caseId = sep >= 0 ? raw.substring(sep + 1) : '';
    return {
      type: 'callback_query',
      action: action,
      caseId: caseId,
      callbackQueryId: cq.id,
      chatId: cq.message.chat.id,
      messageId: cq.message.message_id,
      fromUser: (cq.from && (cq.from.username || cq.from.first_name)) || 'unknown',
    };
  }
  if (data.message && data.message.text !== undefined) {
    const msg = data.message;
    return {
      type: 'message',
      text: msg.text,
      chatId: msg.chat.id,
      fromUser: (msg.from && (msg.from.username || msg.from.first_name)) || 'unknown',
    };
  }
  return { type: 'unknown' };
}
