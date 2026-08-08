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
    // キーワード縛り（「請求書」等の文言が本文に無いと拾えない）は「漏れ」の原因になるため外し、
    // PDF添付があるメールは広く拾う。実際に支払対象かどうかの判断はClaudeに任せる設計。
    return getProp('INVOICE_GMAIL_QUERY', 'has:attachment filename:pdf newer_than:45d');
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
