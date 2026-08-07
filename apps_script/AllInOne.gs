/**
 * 請求書集計システム(Google Apps Script版) - 全部入り1ファイル版
 * 
 * このファイル1つを Apps Script の Code.gs にまるごと貼り付けるだけでOKです。
 * (中身は Config/SafetyGuard/SheetsService/GmailService/ClaudeService/Matcher/TelegramService/Main/WebhookHandler/Triggers を結合したもの)
 */


// ============================================================
// ファイル: Config.gs
// ============================================================
/**
 * 設定管理（Google Apps Script版）
 *
 * 秘密情報はすべて「スクリプト プロパティ」から読み込みます。
 * Apps Scriptエディタの「プロジェクトの設定」→「スクリプト プロパティ」から設定してください。
 *
 * 必須:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CLAUDE_API_KEY
 * 任意（デフォルト値あり）:
 *   OWN_COMPANY_NAME, SPREADSHEET_ID, CLAUDE_MODEL, INVOICE_GMAIL_QUERY,
 *   INVOICE_MATCH_WINDOW_DAYS, INVOICE_MATCH_AMOUNT_TOLERANCE,
 *   REPORT_AUTO_TRIGGER_DAY, CONFIRMATION_REMINDER_DAY, CONFIRMATION_DEADLINE_DAY,
 *   MAX_MESSAGES_PER_SCAN
 */

function getProp(key, defaultValue) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return (value === null || value === undefined || value === '') ? defaultValue : value;
}

function setProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function requireProp_(key) {
  const value = getProp(key, null);
  if (!value) {
    throw new Error(
      `スクリプトプロパティ "${key}" が設定されていません。` +
      '「プロジェクトの設定」→「スクリプト プロパティ」から設定してください。'
    );
  }
  return value;
}

const CONFIG = {
  get TELEGRAM_BOT_TOKEN() { return requireProp_('TELEGRAM_BOT_TOKEN'); },
  get TELEGRAM_CHAT_ID() { return requireProp_('TELEGRAM_CHAT_ID'); },
  get CLAUDE_API_KEY() { return requireProp_('CLAUDE_API_KEY'); },
  get CLAUDE_MODEL() { return getProp('CLAUDE_MODEL', 'claude-3-5-sonnet-20241022'); },
  get OWN_COMPANY_NAME() { return getProp('OWN_COMPANY_NAME', ''); },
  get SPREADSHEET_ID() { return getProp('SPREADSHEET_ID', ''); },
  get GMAIL_QUERY() {
    return getProp(
      'INVOICE_GMAIL_QUERY',
      'has:attachment filename:pdf newer_than:45d (請求書 OR invoice OR 見積書 OR 納品書 OR quotation OR delivery)'
    );
  },
  get MATCH_WINDOW_DAYS() { return Number(getProp('INVOICE_MATCH_WINDOW_DAYS', '60')); },
  get MATCH_AMOUNT_TOLERANCE() { return Number(getProp('INVOICE_MATCH_AMOUNT_TOLERANCE', '0.15')); },
  get REPORT_AUTO_TRIGGER_DAY() { return Number(getProp('REPORT_AUTO_TRIGGER_DAY', '10')); },
  get CONFIRMATION_REMINDER_DAY() { return Number(getProp('CONFIRMATION_REMINDER_DAY', '15')); },
  get CONFIRMATION_DEADLINE_DAY() { return Number(getProp('CONFIRMATION_DEADLINE_DAY', '20')); },
  get MAX_MESSAGES_PER_SCAN() { return Number(getProp('MAX_MESSAGES_PER_SCAN', '30')); },
  // ===== 暴走防止 =====
  get DAILY_CLAUDE_CALL_LIMIT() { return Number(getProp('DAILY_CLAUDE_CALL_LIMIT', '50')); },
  get MAX_NEW_DOCS_PER_RUN() { return Number(getProp('MAX_NEW_DOCS_PER_RUN', '20')); },
};

// ステータス値
const STATUS_PENDING = '未承認';
const STATUS_APPROVED = '承認済み';
const STATUS_NEEDS_REVIEW = '要確認';
const STATUS_REJECTED = '却下';

// 支払対象アラート値
const PAYABLE_YES = '要払い';
const PAYABLE_NO = '対象外';
const PAYABLE_UNKNOWN = '確認中';

// ===== シート定義 =====

const INVOICE_SHEET = '請求書ログ';
// 書類ID: 添付ファイル1件ごとの一意キー（再スキャン時の重複防止に使用）
// 案件ID: 見積書/納品書/請求書の3点セットとして紐付けられたグループのキー
const INVOICE_HEADERS = [
  '書類ID', '案件ID', '検出日時', '対象月', '発行日', '取引先名',
  '書類種別', '金額(税込)', '金額(税抜)', '支払期日',
  '請求書番号', 'インボイス登録番号', 'Gmailメッセージ ID',
  '添付ファイル名', '見積書有無', '納品書有無', '請求書有無',
  '支払対象', 'ステータス', '承認者', '承認日時', '備考',
];
// 日付/日時として自動変換されると困る列（Sheetsの型自動判定を防ぐため書式をテキスト固定にする）
const INVOICE_TEXT_COLUMNS = [3, 4, 5, 10, 21]; // 検出日時,対象月,発行日,支払期日,承認日時

const VENDOR_SHEET = '固定支払い先マスタ';
const VENDOR_HEADERS = ['取引先名', '頻度', '概算金額', '備考', '有効'];

const SUMMARY_SHEET = '月次サマリ';
const SUMMARY_HEADERS = [
  '対象月', '集計日時', '件数', '合計金額(税込)',
  '3点セット未完了件数', '固定支払い先の未着', '未承認件数', '最終確認',
];
const SUMMARY_TEXT_COLUMNS = [1, 2]; // 対象月, 集計日時

// ============================================================
// ファイル: SafetyGuard.gs
// ============================================================
/**
 * 暴走防止・API呼び出し上限（Apps Script版）
 *
 * - 緊急停止スイッチ：Telegramで「停止」と送るといつでも即座に全処理を止められる
 * - 1日あたりのClaude API呼び出し上限：DAILY_CLAUDE_CALL_LIMIT（既定50回/日）を超えたら自動停止
 * - 1回の実行あたりの処理件数上限：MAX_NEW_DOCS_PER_RUN（既定20件）で単発の暴走も抑える
 *
 * 想定利用量（月11〜30件×3点セット≒最大90件/月）に対して十分余裕を持たせつつ、
 * バグでGmail検索条件が意図せず広くヒットした場合などの被害を最小限にする。
 */

function isSystemPaused_() {
  return getProp('SYSTEM_PAUSED', 'FALSE').toUpperCase() === 'TRUE';
}

function pauseSystem_(reason) {
  setProp('SYSTEM_PAUSED', 'TRUE');
  Logger.log('🛑 システムを一時停止しました: ' + (reason || ''));
}

function resumeSystem_() {
  setProp('SYSTEM_PAUSED', 'FALSE');
  Logger.log('▶️ システムを再開しました');
}

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getClaudeCallCountToday_() {
  return Number(getProp('claude_calls_' + todayKey_(), '0'));
}

/**
 * Claude API呼び出し直前に必ず通す関門。
 * 上限に達していなければカウントを1つ消費してtrueを返す。達していればfalseを返す（呼び出し禁止）。
 */
function tryConsumeClaudeQuota_() {
  const limit = CONFIG.DAILY_CLAUDE_CALL_LIMIT;
  const key = 'claude_calls_' + todayKey_();
  const count = Number(getProp(key, '0'));

  if (count >= limit) return false;

  setProp(key, String(count + 1));
  return true;
}

/** 同じ日に何度も同じ通知を送らないようにするための重複防止付き通知 */
function notifyOncePerDay_(flagKey, text) {
  const key = flagKey + '_' + todayKey_();
  if (getProp(key, 'FALSE') === 'TRUE') return;
  setProp(key, 'TRUE');
  tgSendMessage(text);
}

function notifyQuotaExceeded_() {
  notifyOncePerDay_(
    'quota_notified',
    `🛑 <b>本日のClaude API呼び出し上限（${CONFIG.DAILY_CLAUDE_CALL_LIMIT}回）に達しました</b>\n\n` +
    '安全のため、これ以上の新規書類の読み取りを一時停止しています。\n' +
    '未処理分は明日また自動で処理されます。今すぐ再開したい場合は「再開」と送ってください\n' +
    '（上限は スクリプト プロパティの DAILY_CLAUDE_CALL_LIMIT で変更できます）。'
  );
}

/** 古い日次カウンタ・通知フラグを削除する（スクリプトプロパティの肥大化防止。毎日1回呼び出す想定） */
function cleanupOldDailyCounters_() {
  const props = PropertiesService.getScriptProperties();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffKey = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  props.getKeys().forEach(key => {
    const m = key.match(/^(claude_calls_|quota_notified_)(\d{4}-\d{2}-\d{2})$/);
    if (m && m[2] < cutoffKey) {
      props.deleteProperty(key);
    }
  });
}

// ============================================================
// ファイル: SheetsService.gs
// ============================================================
/**
 * Google Sheets 操作（Apps Script版）
 *
 * SpreadsheetApp を使うため、サービスアカウントや鍵ファイルは一切不要です。
 * このスクリプトを実行するあなたのGoogleアカウントの権限でそのまま読み書きします。
 */

function getOrCreateSpreadsheet_() {
  let id = CONFIG.SPREADSHEET_ID;

  if (!id) {
    // コンテナバインド（スプレッドシートから拡張機能→Apps Scriptで開いた）ならそれを使う
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      id = active.getId();
      setProp('SPREADSHEET_ID', id);
    } else {
      const ss = SpreadsheetApp.create('請求書管理_月次集計');
      id = ss.getId();
      setProp('SPREADSHEET_ID', id);
      Logger.log('✅ 新規スプレッドシートを作成しました: ' + ss.getUrl());
    }
  }

  return SpreadsheetApp.openById(id);
}

function ensureSheet_(ss, title, headers, textColumnIndexes) {
  let sheet = ss.getSheetByName(title);
  if (!sheet) {
    sheet = ss.insertSheet(title);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  if (textColumnIndexes && textColumnIndexes.length) {
    textColumnIndexes.forEach(colIdx => {
      sheet.getRange(1, colIdx, sheet.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sheet;
}

/** 初期セットアップ：3タブを作成し、既定のシート1が空なら削除する */
function initializeSpreadsheet() {
  const ss = getOrCreateSpreadsheet_();
  ensureSheet_(ss, INVOICE_SHEET, INVOICE_HEADERS, INVOICE_TEXT_COLUMNS);
  ensureSheet_(ss, VENDOR_SHEET, VENDOR_HEADERS);
  ensureSheet_(ss, SUMMARY_SHEET, SUMMARY_HEADERS, SUMMARY_TEXT_COLUMNS);

  ['シート1', 'Sheet1'].forEach(name => {
    const defaultSheet = ss.getSheetByName(name);
    if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 3) {
      ss.deleteSheet(defaultSheet);
    }
  });

  Logger.log('✅ スプレッドシート準備完了: ' + ss.getUrl());
  return ss;
}

function getInvoiceSheet_() {
  return ensureSheet_(getOrCreateSpreadsheet_(), INVOICE_SHEET, INVOICE_HEADERS, INVOICE_TEXT_COLUMNS);
}
function getVendorSheet_() {
  return ensureSheet_(getOrCreateSpreadsheet_(), VENDOR_SHEET, VENDOR_HEADERS);
}
function getSummarySheet_() {
  return ensureSheet_(getOrCreateSpreadsheet_(), SUMMARY_SHEET, SUMMARY_HEADERS, SUMMARY_TEXT_COLUMNS);
}

/** Dateオブジェクトが紛れ込んでいた場合に文字列へ正規化する（手動編集などの保険） */
function formatCellValue_(value) {
  if (value instanceof Date) {
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds();
    const tz = Session.getScriptTimeZone();
    return hasTime
      ? Utilities.formatDate(value, tz, "yyyy-MM-dd'T'HH:mm:ss")
      : Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  return value;
}

/** シートの全データをヘッダー付きオブジェクト配列として取得 */
function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = formatCellValue_(row[i]); });
      obj.__row = idx + 2; // 実際のシート行番号（ヘッダー分+1）
      return obj;
    });
}

// ---------- 請求書ログ ----------

function findInvoiceRow_(docId) {
  const sheet = getInvoiceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !docId) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === docId) return i + 2;
  }
  return null;
}

/** 書類IDが既存なら更新、無ければ追加（同じ添付を再スキャンしても重複しない） */
function upsertInvoice(row) {
  const sheet = getInvoiceSheet_();
  const rowIdx = row['書類ID'] ? findInvoiceRow_(row['書類ID']) : null;
  const values = INVOICE_HEADERS.map(h => (row[h] !== undefined && row[h] !== null) ? row[h] : '');

  if (rowIdx) {
    sheet.getRange(rowIdx, 1, 1, values.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

function updateInvoiceField(docId, field, value) {
  const rowIdx = findInvoiceRow_(docId);
  if (!rowIdx) return false;
  const colIdx = INVOICE_HEADERS.indexOf(field) + 1;
  if (colIdx < 1) return false;
  getInvoiceSheet_().getRange(rowIdx, colIdx).setValue(value);
  return true;
}

/** 同じ案件IDを持つ全行に対して、複数フィールドをまとめて更新する（3点セット状態の反映用） */
function updateInvoiceFieldsByCase(caseId, fields) {
  const sheet = getInvoiceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const caseCol = INVOICE_HEADERS.indexOf('案件ID') + 1;
  const caseValues = sheet.getRange(2, caseCol, lastRow - 1, 1).getValues();
  let updated = 0;

  caseValues.forEach((rowVals, idx) => {
    if (rowVals[0] === caseId) {
      const rowIdx = idx + 2;
      Object.keys(fields).forEach(field => {
        const colIdx = INVOICE_HEADERS.indexOf(field) + 1;
        sheet.getRange(rowIdx, colIdx).setValue(fields[field]);
      });
      updated++;
    }
  });
  return updated;
}

function getAllInvoices() {
  return sheetToObjects_(getInvoiceSheet_());
}
function getInvoicesForMonth(yyyymm) {
  return getAllInvoices().filter(r => r['対象月'] === yyyymm);
}
function getPendingInvoices() {
  return getAllInvoices().filter(r => r['ステータス'] === STATUS_PENDING || r['ステータス'] === STATUS_NEEDS_REVIEW);
}

// ---------- 固定支払い先マスタ ----------

function getFixedVendors() {
  const rows = sheetToObjects_(getVendorSheet_());
  return rows.filter(r => {
    const flag = (r['有効'] === undefined || r['有効'] === '') ? 'TRUE' : String(r['有効']);
    return flag.toUpperCase() !== 'FALSE';
  });
}

// ---------- 月次サマリ ----------

function writeMonthlySummary(row) {
  const sheet = getSummarySheet_();
  const values = SUMMARY_HEADERS.map(h => (row[h] !== undefined && row[h] !== null) ? row[h] : '');
  sheet.appendRow(values);
}

function getSummaryForMonth(yyyymm) {
  const rows = sheetToObjects_(getSummarySheet_());
  const matches = rows.filter(r => r['対象月'] === yyyymm);
  return matches.length ? matches[matches.length - 1] : null;
}

/** 指定月の最新サマリ行の「最終確認」列を更新する（月末の人間による最終目視チェック用） */
function updateSummaryFinalCheck(yyyymm, value) {
  const sheet = getSummarySheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const monthCol = SUMMARY_HEADERS.indexOf('対象月') + 1;
  const checkCol = SUMMARY_HEADERS.indexOf('最終確認') + 1;
  const monthValues = sheet.getRange(2, monthCol, lastRow - 1, 1).getValues();

  let targetRow = null;
  monthValues.forEach((v, idx) => {
    if (v[0] === yyyymm) targetRow = idx + 2;
  });
  if (!targetRow) return false;

  sheet.getRange(targetRow, checkCol).setValue(value);
  return true;
}

// ============================================================
// ファイル: GmailService.gs
// ============================================================
/**
 * Gmail 検索・添付PDF取得（Apps Script版）
 *
 * GmailApp を使うため、credentials.json やOAuth初回ログインは不要です。
 * このスクリプトを実行するあなたのGoogleアカウントの受信箱をそのまま検索します。
 */

/**
 * 指定クエリでスレッドを検索し、PDF添付があるメッセージだけを返す
 * 戻り値: [{ msgId, from, subject, date, attachments: [{ filename, blob }] }]
 */
function searchPdfAttachments(query, maxThreads) {
  const threads = GmailApp.search(query, 0, maxThreads || CONFIG.MAX_MESSAGES_PER_SCAN);
  const results = [];

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
      const pdfAttachments = attachments.filter(a => {
        const name = (a.getName() || '').toLowerCase();
        return a.getContentType() === 'application/pdf' || name.endsWith('.pdf');
      });
      if (pdfAttachments.length === 0) return;

      results.push({
        msgId: message.getId(),
        from: message.getFrom(),
        subject: message.getSubject(),
        date: message.getDate(),
        attachments: pdfAttachments.map(a => ({ filename: a.getName(), blob: a.copyBlob() })),
      });
    });
  });

  return results;
}

// ============================================================
// ファイル: ClaudeService.gs
// ============================================================
/**
 * Claude API 連携（Apps Script版）
 *
 * PDFはテキスト抽出せず、そのままドキュメントとしてClaudeに渡して読み取らせる。
 * これにより画像スキャンPDF（OCR未対応の帳票）にもある程度対応できる。
 */

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

function callClaude_(payload) {
  // 暴走防止：1日あたりの呼び出し上限を超えていたら、実際のAPI通信をせずここで止める
  if (!tryConsumeClaudeQuota_()) {
    const err = new Error(`本日のClaude API呼び出し上限（${CONFIG.DAILY_CLAUDE_CALL_LIMIT}回）に達しました`);
    err.isQuotaError = true;
    throw err;
  }

  const response = UrlFetchApp.fetch(CLAUDE_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) {
    throw new Error(`Claude APIエラー (${code}): ${text}`);
  }
  const data = JSON.parse(text);
  return (data.content && data.content[0]) ? data.content[0].text : '';
}

function extractJson_(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw;
  return JSON.parse(jsonStr);
}

function emptyExtractResult_(filename, note) {
  return {
    doc_type: '不明',
    vendor_name: null,
    amount_with_tax: null,
    amount_without_tax: null,
    due_date: null,
    document_date: null,
    invoice_number: null,
    registration_number: null,
    is_payable: 'uncertain',
    is_payable_reason: '',
    confidence: 'low',
    raw_note: note || '',
    filename: filename,
  };
}

function buildExtractPrompt_(companyLine, filename) {
  return `あなたは経理のプロフェッショナルです。
添付されたPDF（請求書・見積書・納品書のいずれか）の内容を読み取り、
以下のJSON形式で JSONのみ を出力してください（説明文・コードフェンス不要）。

${companyLine}
【ファイル名】${filename}

【支払対象(is_payable)の判定について】
- 書類の「請求先」「宛先」が自社名と一致する（＝自社が支払う側）なら "yes"
- 書類の「発行元」「差出人」が自社名と一致する（＝自社が請求している側で、支払うものではない）なら "no"
- 自社名が未設定、または判別できない場合は "uncertain"

【出力JSON形式】
{
  "doc_type": "請求書 または 見積書 または 納品書 または 不明",
  "vendor_name": "取引先（発行元）の会社名・氏名",
  "amount_with_tax": 税込金額（数値のみ。不明ならnull）,
  "amount_without_tax": 税抜金額（数値のみ。不明ならnull）,
  "due_date": "支払期日（YYYY-MM-DD。請求書以外や不明ならnull）",
  "document_date": "発行日（YYYY-MM-DD。不明ならnull）",
  "invoice_number": "書類番号（不明ならnull）",
  "registration_number": "インボイス登録番号 T+13桁（記載が無ければnull）",
  "is_payable": "yes か no か uncertain（上記の判定基準に従って）",
  "is_payable_reason": "判定理由を一言で",
  "confidence": "high か medium か low（読み取り確信度。画像が不鮮明な場合はlow）",
  "raw_note": "判読しづらかった点・注意点があれば簡潔に。無ければ空文字"
}`;
}

/** PDF(Blob)から請求書/見積書/納品書の構造化データを抽出する */
function extractInvoiceFromPdf(pdfBlob, filename) {
  const ownCompanyName = CONFIG.OWN_COMPANY_NAME;
  const companyLine = ownCompanyName
    ? `【自社名（支払う側）】${ownCompanyName}`
    : '【自社名】未設定（is_payableは基本的にuncertainとしてください）';

  const promptText = buildExtractPrompt_(companyLine, filename);
  const base64Data = Utilities.base64Encode(pdfBlob.getBytes());

  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
        { type: 'text', text: promptText },
      ],
    }],
  };

  try {
    const raw = callClaude_(payload);
    const data = extractJson_(raw);
    data.filename = filename;
    return data;
  } catch (e) {
    if (e && e.isQuotaError) throw e; // 上限超過は呼び出し元(processNewDocuments)で処理を止めるため再スロー
    Logger.log('Claude 抽出エラー: ' + e);
    return emptyExtractResult_(filename, '抽出失敗: ' + e + '（要目視確認）');
  }
}

/** 人間からの修正指示（自然文）を反映した抽出結果を再生成する */
function reviseInvoiceData(currentData, modificationText) {
  const prompt = `以下は請求書/見積書/納品書から抽出したデータです。
人間からの修正指示に従って値を修正し、同じJSON形式で修正後の全項目を出力してください。
指示にない項目は元の値のまま維持してください。JSONのみを出力してください。

【現在のデータ】
${JSON.stringify(currentData, null, 2)}

【修正指示】
${modificationText}

【出力JSON形式（現在のデータと同じキー構成）】`;

  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    const raw = callClaude_(payload);
    const data = extractJson_(raw);
    data.filename = currentData.filename || '';
    return data;
  } catch (e) {
    if (e && e.isQuotaError) throw e; // 上限超過は呼び出し元(applyCorrection_)で処理を止めるため再スロー
    Logger.log('Claude 修正エラー: ' + e);
    return currentData;
  }
}

// ============================================================
// ファイル: Matcher.gs
// ============================================================
/**
 * 3点セット紐付け・固定支払い先との突合（Apps Script版）
 *
 * 見積書・納品書・請求書を「取引先名＋金額＋時期の近さ」で同一案件に紐付け、
 * 固定支払い先マスタと突合して当月未着の取引先を検知する（漏れ検知の中核）。
 *
 * 3点セットの紐付けは完全一致IDが無い前提のヒューリスティック（推定）です。
 * 誤マッチ・未マッチは自動で確定せず、Telegramでの人間確認（ダブルチェック）に必ず回します。
 */

function normalizeVendorName_(name) {
  if (!name) return '';
  let n = String(name).trim();
  ['株式会社', '（株）', '(株)', '有限会社', '合同会社', '御中', '様'].forEach(junk => {
    n = n.split(junk).join('');
  });
  return n.trim().toLowerCase();
}

function levenshtein_(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** 簡易的な文字列類似度（0〜1、Levenshtein距離ベース） */
function vendorSimilarity_(a, b) {
  const s1 = normalizeVendorName_(a);
  const s2 = normalizeVendorName_(b);
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const dist = levenshtein_(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function amountClose_(a, b, tolerance) {
  if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') return false;
  a = Number(a); b = Number(b);
  if (isNaN(a) || isNaN(b)) return false;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= tolerance;
}

function md5Hex_(input) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, input, Utilities.Charset.UTF_8);
  return bytes.map(b => {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** 物理ドキュメント（添付ファイル）を一意に識別する安定ID。再スキャン時の重複防止に使う。 */
function makeDocId_(gmailMessageId, filename) {
  return 'doc_' + md5Hex_(`${gmailMessageId}|${filename}`).substring(0, 10);
}

function parseDate_(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function docAmount_(doc) {
  const withTax = doc.amount_with_tax;
  return (withTax !== null && withTax !== undefined && withTax !== '') ? withTax : doc.amount_without_tax;
}

/**
 * ドキュメント群を案件（3点セット候補）単位でグルーピングする
 * docs: [{ doc_type, vendor_name, amount_with_tax, amount_without_tax, document_date, _docId }, ...]
 * 戻り値: [{ caseId, vendorName, documents, hasQuote, hasDelivery, hasInvoice, isCompleteSet }]
 */
function groupIntoCases(docs, windowDays, amountTolerance) {
  const cases = [];

  docs.forEach(doc => {
    const target = findMatchingCase_(cases, doc, windowDays, amountTolerance);
    if (target) {
      target.documents.push(doc);
    } else {
      cases.push({ vendorName: doc.vendor_name, documents: [doc] });
    }
  });

  cases.forEach(c => {
    c.hasQuote = c.documents.some(d => d.doc_type === '見積書');
    c.hasDelivery = c.documents.some(d => d.doc_type === '納品書');
    c.hasInvoice = c.documents.some(d => d.doc_type === '請求書');
    c.isCompleteSet = c.hasQuote && c.hasDelivery && c.hasInvoice;
    c.caseId = makeCaseId_(c);
  });

  return cases;
}

function findMatchingCase_(cases, doc, windowDays, amountTolerance) {
  let best = null, bestScore = 0;
  cases.forEach(c => {
    const score = vendorSimilarity_(c.vendorName, doc.vendor_name);
    if (score < 0.6) return;
    if (!withinWindow_(c, doc, windowDays)) return;
    if (!amountMatches_(c, doc, amountTolerance)) return;
    if (score > bestScore) { best = c; bestScore = score; }
  });
  return best;
}

function withinWindow_(c, doc, windowDays) {
  const docDate = parseDate_(doc.document_date);
  if (!docDate) return true; // 日付不明なら日付だけでは弾かない
  return c.documents.every(d => {
    const existing = parseDate_(d.document_date);
    if (!existing) return true;
    const diffDays = Math.abs((docDate - existing) / (1000 * 60 * 60 * 24));
    return diffDays <= windowDays;
  });
}

function amountMatches_(c, doc, tolerance) {
  const docAmt = docAmount_(doc);
  if (docAmt === null || docAmt === undefined || docAmt === '') return true; // 金額不明なら弾かない
  return c.documents.every(d => {
    const existingAmt = docAmount_(d);
    if (existingAmt === null || existingAmt === undefined || existingAmt === '') return true;
    return amountClose_(docAmt, existingAmt, tolerance);
  });
}

function makeCaseId_(c) {
  const dates = c.documents.map(d => parseDate_(d.document_date)).filter(Boolean).sort((a, b) => a - b);
  const anchor = dates.length
    ? Utilities.formatDate(dates[0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : 'unknown-date';
  const key = `${normalizeVendorName_(c.vendorName)}|${anchor}`;
  return 'case_' + md5Hex_(key).substring(0, 10);
}

/** 固定支払い先マスタのうち、当月の請求書ログに一致する取引先が無いものを返す（＝漏れ候補） */
function findMissingFixedVendors(fixedVendors, monthInvoices) {
  const seenNames = monthInvoices.map(inv => inv['取引先名'] || '');
  return fixedVendors.filter(vendor => {
    const vendorName = vendor['取引先名'];
    if (!vendorName) return false;
    return !seenNames.some(seen => vendorSimilarity_(vendorName, seen) >= 0.6);
  });
}

// ============================================================
// ファイル: TelegramService.gs
// ============================================================
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

// ============================================================
// ファイル: Main.gs
// ============================================================
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
  if (isSystemPaused_()) {
    Logger.log('🛑 システムは一時停止中のためスキップします（Telegramで「再開」と送ると復帰します）');
    return 0;
  }

  Logger.log('🔍 請求書メールをスキャン中...');
  const mailItems = searchPdfAttachments(CONFIG.GMAIL_QUERY, CONFIG.MAX_MESSAGES_PER_SCAN);

  let newCount = 0;
  let quotaHit = false;
  const touchedMonths = new Set();

  outerLoop:
  for (let i = 0; i < mailItems.length; i++) {
    const item = mailItems[i];
    for (let j = 0; j < item.attachments.length; j++) {
      const att = item.attachments[j];
      const docId = makeDocId_(item.msgId, att.filename);
      if (findInvoiceRow_(docId)) continue; // 既に処理済み

      // 暴走防止：1回の実行での処理件数に上限を設ける（残りは次回の実行に持ち越す）
      if (newCount >= CONFIG.MAX_NEW_DOCS_PER_RUN) {
        Logger.log(`⚠️ 1回の実行での処理上限（${CONFIG.MAX_NEW_DOCS_PER_RUN}件）に達したため、残りは次回に持ち越します`);
        break outerLoop;
      }

      let extracted;
      try {
        extracted = extractInvoiceFromPdf(att.blob, att.filename);
      } catch (e) {
        if (e && e.isQuotaError) {
          quotaHit = true;
          break outerLoop; // このドキュメントは未処理のまま残し、次回（明日以降）に再試行させる
        }
        throw e;
      }

      const row = buildInvoiceRow_(docId, item, att.filename, extracted);
      upsertInvoice(row);
      newCount++;
      touchedMonths.add(row['対象月']);

      notifyNewDocument_(row, extracted);
    }
  }

  touchedMonths.forEach(month => regroupCases_(month));

  if (quotaHit) {
    Logger.log('🛑 本日のClaude API呼び出し上限に達したため処理を中断しました');
    notifyQuotaExceeded_();
  }

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

// ============================================================
// ファイル: WebhookHandler.gs
// ============================================================
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

  // 修正待ち状態なら、これを修正指示として処理する
  const awaitingDocId = popAwaitingCorrection_(chatId);
  if (awaitingDocId) {
    applyCorrection_(awaitingDocId, text, chatId);
    return;
  }

  if (text.indexOf('/集計') === 0 || text.indexOf('集計') === 0 || text.indexOf('/monthly') === 0) {
    const parts = text.split(/\s+/);
    const yyyymm = parts[1] || previousMonthStr_();
    tgSendMessage(`🔄 ${yyyymm} の集計を実行します...`, chatId);
    generateMonthlyReport(yyyymm, true);
    return;
  }

  if (text === '一覧' || text === '/list') {
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

  if (text === '/scan' || text === 'スキャン') {
    tgSendMessage('🔄 Gmailをスキャンします...', chatId);
    processNewDocuments();
    return;
  }

  if (text === '停止' || text === '/pause') {
    pauseSystem_('ユーザーからの手動停止');
    tgSendMessage(
      '🛑 システムを一時停止しました。\nGmail監視・Claude API呼び出しをすべて止めています。\n再開するには「再開」と送ってください。',
      chatId
    );
    return;
  }

  if (text === '再開' || text === '/resume') {
    resumeSystem_();
    tgSendMessage('▶️ システムを再開しました。', chatId);
    return;
  }

  if (text === '状態' || text === '/status') {
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

  tgSendMessage(
    '📧 請求書集計システム\n\n' +
    'コマンド:\n' +
    '「一覧」 - 未承認/要確認の書類一覧\n' +
    '「集計 [YYYY-MM]」 - 月次集計を実行（省略時は先月分）\n' +
    '「スキャン」 - Gmailを今すぐ確認\n' +
    '「停止」 - 緊急停止（Gmail監視・API呼び出しを全部止める）\n' +
    '「再開」 - 停止を解除\n' +
    '「状態」 - 稼働状況とAPI呼び出し回数を確認\n\n' +
    '新しい請求書/見積書/納品書を検出すると自動で通知します。',
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

// ============================================================
// ファイル: Triggers.gs
// ============================================================
/**
 * トリガー設定・スケジュール実行・カスタムメニュー（Apps Script版）
 */

/** スプレッドシートを開いたときにメニューを追加する（コンテナバインド時のみ有効） */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📧 請求書集計')
    .addItem('🔍 今すぐGmailをスキャン', 'processNewDocuments')
    .addItem('📊 月次集計を実行（先月分）', 'runMonthlyReportForPreviousMonth_')
    .addSeparator()
    .addItem('⚙️ 初期セットアップ（初回のみ）', 'initialSetup')
    .addItem('🔗 Telegram Webhookを再設定', 'setTelegramWebhookToThisApp')
    .addToUi();
}

function runMonthlyReportForPreviousMonth_() {
  generateMonthlyReport(previousMonthStr_(), true);
}

/** 初回セットアップ：シート作成＋トリガー設定をまとめて実行する */
function initialSetup() {
  initializeSpreadsheet();
  setupTriggers();
  const message =
    '初期セットアップ完了！\n\n' +
    '次に「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で公開し、\n' +
    'そのあと「🔗 Telegram Webhookを再設定」（=setTelegramWebhookToThisApp）を実行してください。';
  Logger.log(message);
  // SpreadsheetApp.getUi() はスプレッドシートのメニュー経由で呼んだときしか使えず、
  // エディタから直接実行した場合は呼び出し自体が例外になるため丸ごとtry/catchする
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // エディタから直接実行した場合はここに来る（実行ログにメッセージが出ていればOK）
  }
}

function setupTriggers() {
  deleteAllTriggers_();
  ScriptApp.newTrigger('processNewDocuments').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyScheduleCheck').timeBased().everyDays(1).atHour(9).create();
  Logger.log('✅ トリガーを設定しました（毎時: Gmail監視 / 毎日9時ごろ: 月次スケジュールチェック）');
}

function deleteAllTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

/**
 * 毎日1回実行：スケジュールに沿って自動集計・確認リマインド・期限アラートを行う
 * - REPORT_AUTO_TRIGGER_DAY（既定10日）: 前月分を自動集計してTelegramに通知
 * - CONFIRMATION_REMINDER_DAY（既定15日）: 未確認なら軽いリマインド
 * - CONFIRMATION_DEADLINE_DAY（既定20日）: 未確認なら期限アラート
 */
function dailyScheduleCheck() {
  cleanupOldDailyCounters_(); // 暴走防止用の日次カウンタ等の掃除（肥大化防止）

  const today = new Date();
  const day = today.getDate();
  const yyyymm = previousMonthStr_(today);

  if (day === CONFIG.REPORT_AUTO_TRIGGER_DAY) {
    const already = getSummaryForMonth(yyyymm);
    if (!already) {
      Logger.log(`📅 ${CONFIG.REPORT_AUTO_TRIGGER_DAY}日のため ${yyyymm} の月次集計を自動生成します`);
      generateMonthlyReport(yyyymm, true);
    }
  }

  if (day === CONFIG.CONFIRMATION_REMINDER_DAY) {
    sendConfirmationReminder_(yyyymm, false);
  }

  if (day === CONFIG.CONFIRMATION_DEADLINE_DAY) {
    sendConfirmationReminder_(yyyymm, true);
  }
}

/** 初回セットアップ用：Telegram Webhookを、このプロジェクトのウェブアプリURLに登録する */
function setTelegramWebhookToThisApp() {
  // ScriptApp.getService().getUrl() はエディタから手動実行すると /dev URL（開発用、Telegramからは
  // 401になる）を返してしまう既知のクセがあるため使わない。「デプロイを管理」に表示される
  // /exec で終わる本番URLを、あらかじめスクリプトプロパティ WEB_APP_URL に設定しておく方式にする。
  const url = getProp('WEB_APP_URL', null);
  if (!url) {
    throw new Error(
      'スクリプトプロパティ "WEB_APP_URL" が未設定です。' +
      '「デプロイ」→「デプロイを管理」に表示される、/exec で終わるウェブアプリのURLをコピーし、' +
      'プロジェクトの設定 → スクリプト プロパティ に WEB_APP_URL として追加してから、もう一度実行してください。'
    );
  }
  if (url.indexOf('/dev') !== -1) {
    throw new Error(
      'WEB_APP_URL が /dev で終わる開発用URLになっています。Telegramからは接続できません。' +
      '「デプロイを管理」画面に表示される /exec で終わる本番URLに直してください。'
    );
  }
  const result = tgSetWebhook(url);
  Logger.log('setWebhook result: ' + JSON.stringify(result));
  return result;
}
