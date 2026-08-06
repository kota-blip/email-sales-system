/**
 * 請求書集計システム メインロジック（Apps Script版・払う側の請求書を毎月自動集計する）
 *
 * - Gmail監視: 添付PDF（見積書/納品書/請求書）を検出 → Claudeで構造化抽出 → Sheetsに記録
 * - 支払対象アラート: 支払うものと確信できれば「💰支払うものです」と明示、判断できなければ
 *   「❓これは支払うものですか？」とボタンで確認を求める（両側からのダブルチェック）
 * - ダブルチェック: 抽出結果をTelegramに通知し、人間が承認/修正/却下（AI抽出→人間が1回承認）
 * - 漏れ検知: 固定支払い先マスタとの突合＋3点セット（見積書/納品書/請求書）の充足チェック
 * - 月次集計: 自動（毎月REPORT_AUTO_TRIGGER_DAY日ごろ）/手動（Telegramコマンド）でサマリを生成し、
 *   最終目視確認を依頼（CONFIRMATION_REMINDER_DAY日ごろに軽いリマインド、
 *   CONFIRMATION_DEADLINE_DAY日ごろに期限アラート）
 */

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function targetMonthFrom_(documentDateStr) {
  const d = parseDate_(documentDateStr);
  if (d) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}

function previousMonthStr_(base) {
  base = base || new Date();
  const firstOfThisMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  const lastMonthEnd = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
  return Utilities.formatDate(lastMonthEnd, Session.getScriptTimeZone(), 'yyyy-MM');
}

function yesNo_(flag) { return flag ? 'TRUE' : 'FALSE'; }

function formatAmount_(value) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || isNaN(n)) return '(不明)';
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function toNumber_(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function adjacentMonths_(yyyymm) {
  const parts = yyyymm.split('-').map(Number);
  const y = parts[0], m = parts[1];
  const months = new Set();
  [-1, 0, 1].forEach(delta => {
    let mm = m + delta, yy = y;
    if (mm < 1) { mm += 12; yy -= 1; }
    else if (mm > 12) { mm -= 12; yy += 1; }
    months.add(`${yy}-${String(mm).padStart(2, '0')}`);
  });
  return months;
}

const PAYABLE_MAP = { yes: PAYABLE_YES, no: PAYABLE_NO, uncertain: PAYABLE_UNKNOWN };
const PAYABLE_REVERSE_MAP = (() => {
  const m = {};
  m[PAYABLE_YES] = 'yes';
  m[PAYABLE_NO] = 'no';
  m[PAYABLE_UNKNOWN] = 'uncertain';
  return m;
})();

// ========== 請求書取り込み ==========

/** Gmailを検索し、未処理のPDF添付を抽出・Sheets記録・Telegram通知する（メインの定期実行関数） */
function processNewDocuments() {
  Logger.log('🔍 請求書メールをスキャン中...');
  const mailItems = searchPdfAttachments(CONFIG.GMAIL_QUERY, CONFIG.MAX_MESSAGES_PER_SCAN);

  let newCount = 0;
  const touchedMonths = new Set();

  mailItems.forEach(item => {
    item.attachments.forEach(att => {
      const docId = makeDocId_(item.msgId, att.filename);
      if (findInvoiceRow_(docId)) return; // 既に処理済み

      const extracted = extractInvoiceFromPdf(att.blob, att.filename);
      const row = buildInvoiceRow_(docId, item, att.filename, extracted);
      upsertInvoice(row);
      newCount++;
      touchedMonths.add(row['対象月']);

      notifyNewDocument_(row, extracted);
    });
  });

  touchedMonths.forEach(month => regroupCases_(month));

  Logger.log(newCount ? `✅ 新規${newCount}件の書類を処理しました` : '   新規の書類はありませんでした');
  return newCount;
}

function buildInvoiceRow_(docId, mailItem, filename, extracted) {
  const targetMonth = targetMonthFrom_(extracted.document_date);
  return {
    '書類ID': docId,
    '案件ID': '', // regroupCases_ が設定する
    '検出日時': nowIso_(),
    '対象月': targetMonth,
    '発行日': extracted.document_date || '',
    '取引先名': extracted.vendor_name || '(取引先不明)',
    '書類種別': extracted.doc_type || '不明',
    '金額(税込)': (extracted.amount_with_tax !== null && extracted.amount_with_tax !== undefined) ? extracted.amount_with_tax : '',
    '金額(税抜)': (extracted.amount_without_tax !== null && extracted.amount_without_tax !== undefined) ? extracted.amount_without_tax : '',
    '支払期日': extracted.due_date || '',
    '請求書番号': extracted.invoice_number || '',
    'インボイス登録番号': extracted.registration_number || '',
    'Gmailメッセージ ID': mailItem.msgId,
    '添付ファイル名': filename,
    '見積書有無': 'FALSE',
    '納品書有無': 'FALSE',
    '請求書有無': 'FALSE',
    '支払対象': PAYABLE_MAP[extracted.is_payable] || PAYABLE_UNKNOWN,
    'ステータス': extracted.confidence === 'low' ? STATUS_NEEDS_REVIEW : STATUS_PENDING,
    '承認者': '',
    '承認日時': '',
    '備考': extracted.raw_note || '',
  };
}

function notifyNewDocument_(row, extracted) {
  const payableStatus = row['支払対象'];
  const lines = ['📄 <b>新しい書類を検出しました</b>', ''];

  if (payableStatus === PAYABLE_YES) {
    lines.push('💰 <b>支払うものです</b>');
  } else if (payableStatus === PAYABLE_NO) {
    lines.push('🚫 支払い対象ではない可能性があります（発行元が自社と一致するようです）');
  } else {
    lines.push('❓ <b>これは支払うものですか？</b>（自動判定できませんでした。下のボタンで教えてください）');
  }
  if (extracted.is_payable_reason) {
    lines.push(`（判定理由: ${extracted.is_payable_reason}）`);
  }

  lines.push('');
  lines.push(`種別: ${row['書類種別']}`);
  lines.push(`取引先: ${row['取引先名']}`);
  lines.push(`金額(税込): ${formatAmount_(row['金額(税込)'])}`);
  lines.push(`支払期日: ${row['支払期日'] || '(記載なし)'}`);
  lines.push(`添付: ${row['添付ファイル名']}`);

  if (extracted.confidence === 'low') {
    lines.push('⚠️ 読み取り確信度が低いです。内容を確認してください。');
  }
  if (row['備考']) {
    lines.push(`備考: ${row['備考']}`);
  }
  lines.push('');
  lines.push(`書類ID: <code>${row['書類ID']}</code>`);

  const askPayable = payableStatus === PAYABLE_UNKNOWN;
  tgSendInvoiceApproval(row['書類ID'], lines.join('\n'), null, askPayable);
}

/** 対象月の前後1か月を含めて再グルーピングし、案件ID・3点セットフラグをSheetsへ反映する */
function regroupCases_(targetMonth) {
  const months = adjacentMonths_(targetMonth);
  const invoices = getAllInvoices().filter(r => months.has(r['対象月']));
  if (!invoices.length) return;

  const docs = invoices.map(inv => ({
    doc_type: inv['書類種別'],
    vendor_name: inv['取引先名'],
    amount_with_tax: toNumber_(inv['金額(税込)']),
    amount_without_tax: toNumber_(inv['金額(税抜)']),
    document_date: inv['発行日'] || null,
    _docId: inv['書類ID'],
  }));

  const cases = groupIntoCases(docs, CONFIG.MATCH_WINDOW_DAYS, CONFIG.MATCH_AMOUNT_TOLERANCE);

  cases.forEach(c => {
    c.documents.forEach(d => updateInvoiceField(d._docId, '案件ID', c.caseId));
    updateInvoiceFieldsByCase(c.caseId, {
      '見積書有無': yesNo_(c.hasQuote),
      '納品書有無': yesNo_(c.hasDelivery),
      '請求書有無': yesNo_(c.hasInvoice),
    });
  });
}

// ========== 月次集計（漏れ検知の要） ==========

/** 指定月の集計を行い、固定支払い先の未着・3点セット未完了・未承認件数を洗い出す */
function generateMonthlyReport(yyyymm, notify) {
  if (notify === undefined) notify = true;

  const invoices = getInvoicesForMonth(yyyymm);
  const fixedVendors = getFixedVendors();
  const missingVendors = findMissingFixedVendors(fixedVendors, invoices);

  // 「対象外」と確定した書類は集計金額・件数から除外する（自社発行の請求書などを混入させないため）
  const payableInvoices = invoices.filter(r => r['支払対象'] !== PAYABLE_NO);
  const uncertainPayable = invoices.filter(r => r['支払対象'] === PAYABLE_UNKNOWN);

  const casesMap = {};
  payableInvoices.forEach(inv => {
    const key = inv['案件ID'] || inv['書類ID'];
    casesMap[key] = inv;
  });
  const incompleteCases = Object.keys(casesMap)
    .map(k => casesMap[k])
    .filter(c => !(c['見積書有無'] === 'TRUE' && c['納品書有無'] === 'TRUE' && c['請求書有無'] === 'TRUE'));

  const invoiceDocs = payableInvoices.filter(r => r['書類種別'] === '請求書');
  const totalAmount = invoiceDocs.reduce((sum, r) => sum + (toNumber_(r['金額(税込)']) || 0), 0);
  const pending = invoices.filter(r => r['ステータス'] === STATUS_PENDING || r['ステータス'] === STATUS_NEEDS_REVIEW);

  const summaryRow = {
    '対象月': yyyymm,
    '集計日時': nowIso_(),
    '件数': invoiceDocs.length,
    '合計金額(税込)': totalAmount,
    '3点セット未完了件数': incompleteCases.length,
    '固定支払い先の未着': missingVendors.map(v => v['取引先名']).join('、') || 'なし',
    '未承認件数': pending.length,
    '最終確認': '未確認',
  };
  writeMonthlySummary(summaryRow);

  if (notify) {
    const text = buildMonthlyReportText_(yyyymm, summaryRow, missingVendors, pending, uncertainPayable);
    tgSendMonthEndConfirmation(yyyymm, text);
  }

  return summaryRow;
}

function buildMonthlyReportText_(yyyymm, summary, missingVendors, pending, uncertainPayable) {
  uncertainPayable = uncertainPayable || [];
  const lines = [
    `📊 <b>${yyyymm} 月次請求書集計</b>`, '',
    `請求書件数: ${summary['件数']}件`,
    `合計金額(税込): ${formatAmount_(summary['合計金額(税込)'])}`,
    `未承認・要確認: ${summary['未承認件数']}件`,
    `3点セット未完了: ${summary['3点セット未完了件数']}件`,
  ];

  if (missingVendors.length) {
    lines.push('');
    lines.push('⚠️ <b>固定支払い先で今月まだ届いていないもの:</b>');
    missingVendors.forEach(v => lines.push(`・${v['取引先名']}（${v['頻度'] || ''}）`));
  } else {
    lines.push('');
    lines.push('✅ 固定支払い先はすべて確認できました');
  }

  if (uncertainPayable.length) {
    lines.push('');
    lines.push(`❓ 「これは支払うものですか？」が未回答の書類が${uncertainPayable.length}件あります。`);
  }

  if (pending.length) {
    lines.push('');
    lines.push(`🔸 未承認/要確認の書類が${pending.length}件あります。「一覧」で確認してください。`);
  }

  lines.push('');
  lines.push('すべて目視確認できたら、下のボタンで今月分を確定してください。');
  return lines.join('\n');
}

/** 月末の最終確認がまだなら、Telegramでリマインド/期限アラートを送る */
function sendConfirmationReminder_(yyyymm, urgent) {
  const summary = getSummaryForMonth(yyyymm);
  if (!summary) return; // まだ集計自体が生成されていない
  const finalCheck = summary['最終確認'];
  if (finalCheck && finalCheck !== '未確認') return; // 既に確認済み

  const text = urgent
    ? `🚨 <b>${yyyymm} の最終確認期限です</b>\n\nまだ確認が完了していません。今日中に内容を確認し、確定をお願いします。`
    : `🔔 <b>${yyyymm} の最終確認リマインド</b>\n\nそろそろ月次確認をお願いします（期限の目安: ${CONFIG.CONFIRMATION_DEADLINE_DAY}日ごろ）。`;

  tgSendMonthEndConfirmation(yyyymm, text);
}
