/**
 * Telegram Webhook 受信処理（Apps Script版）
 *
 * 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で公開したURLをTelegramのWebhookに登録すると、
 * ボタン操作やメッセージがここに届く。
 *
 * 修正待ち状態（"✏️修正"を押した後、次のテキストを修正指示として扱う）は
 * スクリプトプロパティに保存するため、実行のたびに状態が消えることはない。
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const event = parseTelegramUpdate_(data);

    if (event.type === 'callback_query') {
      handleCallback_(event);
    } else if (event.type === 'message') {
      handleMessage_(event);
    }
  } catch (err) {
    Logger.log('Webhook処理エラー: ' + err);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput('OK: 請求書集計システム稼働中 ' + nowIso_());
}

function setAwaitingCorrection_(chatId, docId) {
  PropertiesService.getScriptProperties().setProperty('awaiting_' + chatId, docId);
}

function popAwaitingCorrection_(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = 'awaiting_' + chatId;
  const docId = props.getProperty(key);
  if (docId) props.deleteProperty(key);
  return docId;
}

function handleCallback_(event) {
  const action = event.action;
  const key = event.caseId; // 書類ID または yyyymm
  const chatId = event.chatId, messageId = event.messageId;
  const user = event.fromUser;
  const cqId = event.callbackQueryId;

  if (action === TG_CB_APPROVE) {
    updateInvoiceField(key, 'ステータス', STATUS_APPROVED);
    updateInvoiceField(key, '承認者', user);
    updateInvoiceField(key, '承認日時', nowIso_());
    tgAnswerCallbackQuery(cqId, '承認しました');
    tgClearKeyboard(chatId, messageId);
    tgSendMessage(`✅ 承認済みにしました\n書類ID: <code>${key}</code>`, chatId);

  } else if (action === TG_CB_REJECT) {
    updateInvoiceField(key, 'ステータス', STATUS_REJECTED);
    updateInvoiceField(key, '承認者', user);
    updateInvoiceField(key, '承認日時', nowIso_());
    tgAnswerCallbackQuery(cqId, '却下しました');
    tgClearKeyboard(chatId, messageId);
    tgSendMessage(`❌ 却下にしました\n書類ID: <code>${key}</code>`, chatId);

  } else if (action === TG_CB_EDIT) {
    setAwaitingCorrection_(chatId, key);
    updateInvoiceField(key, 'ステータス', STATUS_NEEDS_REVIEW);
    tgAnswerCallbackQuery(cqId, '修正内容を送ってください');
    tgSendMessage('✏️ 修正内容をテキストで送信してください\n（例：「金額を12,000円に」「支払期日を9/30に」）', chatId);

  } else if (action === TG_CB_CONFIRM_MONTH) {
    updateSummaryFinalCheck(key, `確認済み（${user}, ${nowIso_()}）`);
    tgAnswerCallbackQuery(cqId, '確定しました');
    tgClearKeyboard(chatId, messageId);
    tgSendMessage(`✅ ${key} 分を確認済みとして確定しました。お疲れさまでした！`, chatId);

  } else if (action === TG_CB_PAYABLE_YES) {
    updateInvoiceField(key, '支払対象', PAYABLE_YES);
    tgAnswerCallbackQuery(cqId, '支払対象にしました');
    tgSendMessage(`💰 支払対象に設定しました\n書類ID: <code>${key}</code>`, chatId);

  } else if (action === TG_CB_PAYABLE_NO) {
    updateInvoiceField(key, '支払対象', PAYABLE_NO);
    tgAnswerCallbackQuery(cqId, '対象外にしました');
    tgSendMessage(`🚫 対象外に設定しました（月次集計から除外されます）\n書類ID: <code>${key}</code>`, chatId);
  }
}

function handleMessage_(event) {
  const chatId = event.chatId;
  const text = (event.text || '').trim();
  // 前後の見えない文字・全角空白等の影響を受けにくくするため、比較用に空白類を除去した文字列も用意する
  // 　=全角スペース, ​-‍=ゼロ幅系文字, ﻿=BOM/ゼロ幅ノーブレークスペース
  const normalized = text.replace(/[\s\u3000\u200B-\u200D\uFEFF]+/g, '');

  Logger.log(`受信メッセージ: chatId=${chatId} text=${JSON.stringify(text)}`);

  // 修正待ち状態なら、これを修正指示として処理する
  const awaitingDocId = popAwaitingCorrection_(chatId);
  if (awaitingDocId) {
    applyCorrection_(awaitingDocId, text, chatId);
    return;
  }

  if (normalized.indexOf('集計') === 0 || normalized.indexOf('/集計') === 0 || normalized.indexOf('/monthly') === 0) {
    const parts = text.split(/\s+/);
    const yyyymm = parts[1] || previousMonthStr_();
    tgSendMessage(`🔄 ${yyyymm} の集計を実行します...`, chatId);
    generateMonthlyReport(yyyymm, true);
    return;
  }

  if (normalized === '一覧' || normalized === '/list') {
    const pending = getPendingInvoices();
    if (!pending.length) {
      tgSendMessage('未承認/要確認の書類はありません', chatId);
    } else {
      const lines = ['📋 未承認/要確認の書類:'];
      pending.slice(0, 15).forEach(r => {
        lines.push(`・${r['取引先名']} / ${r['書類種別']} / ${formatAmount_(r['金額(税込)'])} (ID:${r['書類ID']})`);
      });
      tgSendMessage(lines.join('\n'), chatId);
    }
    return;
  }

  if (normalized === '/scan' || normalized.indexOf('スキャン') !== -1) {
    tgSendMessage('🔄 Gmailをスキャンします...', chatId);
    processNewDocuments();
    return;
  }

  if (normalized === '停止' || normalized === '/pause') {
    pauseSystem_('ユーザーからの手動停止');
    tgSendMessage(
      '🛑 システムを一時停止しました。\nGmail監視・Claude API呼び出しをすべて止めています。\n再開するには「再開」と送ってください。',
      chatId
    );
    return;
  }

  if (normalized === '再開' || normalized === '/resume') {
    resumeSystem_();
    tgSendMessage('▶️ システムを再開しました。', chatId);
    return;
  }

  if (normalized === '状態' || normalized === '/status') {
    const paused = isSystemPaused_();
    const callCount = getClaudeCallCountToday_();
    tgSendMessage(
      `📊 稼働状況\n\n` +
      `状態: ${paused ? '🛑 停止中' : '▶️ 稼働中'}\n` +
      `本日のClaude API呼び出し: ${callCount} / ${CONFIG.DAILY_CLAUDE_CALL_LIMIT}回`,
      chatId
    );
    return;
  }

  const debugCodes = Array.from(text).map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ');
  tgSendMessage(
    '📧 請求書集計システム\n\n' +
    'コマンド:\n' +
    '「一覧」 - 未承認/要確認の書類一覧\n' +
    '「集計 [YYYY-MM]」 - 月次集計を実行（省略時は先月分）\n' +
    '「スキャン」 - Gmailを今すぐ確認\n' +
    '「停止」 - 緊急停止（Gmail監視・API呼び出しを全部止める）\n' +
    '「再開」 - 停止を解除\n' +
    '「状態」 - 稼働状況とAPI呼び出し回数を確認\n\n' +
    '新しい請求書/見積書/納品書を検出すると自動で通知します。\n\n' +
    `🔍<code>受信テキスト: ${text}</code>\n<code>文字コード: ${debugCodes}</code>`,
    chatId
  );
}

function applyCorrection_(docId, modificationText, chatId) {
  const invoices = getAllInvoices();
  const current = invoices.find(r => r['書類ID'] === docId);
  if (!current) {
    tgSendMessage('対象の書類が見つかりませんでした', chatId);
    return;
  }

  let revised;
  try {
    revised = reviseInvoiceData(rowToExtracted_(current), modificationText);
  } catch (e) {
    if (e && e.isQuotaError) {
      tgSendMessage(
        '🛑 本日のClaude API呼び出し上限に達しているため、今は修正できません。\n' +
        '明日また試すか、「再開」と送って手動で再開してください。',
        chatId
      );
      return;
    }
    tgSendMessage('修正処理中にエラーが発生しました: ' + e, chatId);
    return;
  }

  const updates = {
    '取引先名': revised.vendor_name || current['取引先名'],
    '書類種別': revised.doc_type || current['書類種別'],
    '金額(税込)': (revised.amount_with_tax !== null && revised.amount_with_tax !== undefined) ? revised.amount_with_tax : current['金額(税込)'],
    '金額(税抜)': (revised.amount_without_tax !== null && revised.amount_without_tax !== undefined) ? revised.amount_without_tax : current['金額(税抜)'],
    '支払期日': revised.due_date || current['支払期日'],
    '発行日': revised.document_date || current['発行日'],
    '請求書番号': revised.invoice_number || current['請求書番号'],
    'インボイス登録番号': revised.registration_number || current['インボイス登録番号'],
    '支払対象': PAYABLE_MAP[revised.is_payable] || current['支払対象'] || PAYABLE_UNKNOWN,
    'ステータス': STATUS_PENDING,
  };

  Object.keys(updates).forEach(field => updateInvoiceField(docId, field, updates[field]));

  regroupCases_(current['対象月']);

  const updatedRow = Object.assign({}, current, updates, { '書類ID': docId });
  tgSendMessage('✏️ 修正しました。内容を再確認してください。', chatId);
  notifyNewDocument_(updatedRow, revised);
}

function rowToExtracted_(row) {
  return {
    doc_type: row['書類種別'],
    vendor_name: row['取引先名'],
    amount_with_tax: toNumber_(row['金額(税込)']),
    amount_without_tax: toNumber_(row['金額(税抜)']),
    due_date: row['支払期日'] || null,
    document_date: row['発行日'] || null,
    invoice_number: row['請求書番号'] || null,
    registration_number: row['インボイス登録番号'] || null,
    is_payable: PAYABLE_REVERSE_MAP[row['支払対象']] || 'uncertain',
    is_payable_reason: '',
    confidence: 'medium',
    raw_note: row['備考'] || '',
    filename: row['添付ファイル名'] || '',
  };
}
