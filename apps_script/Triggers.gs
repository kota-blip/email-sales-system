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
  const ui = (typeof SpreadsheetApp !== 'undefined') ? SpreadsheetApp.getUi() : null;
  const message =
    '初期セットアップ完了！\n\n' +
    '次に「デプロイ」→「新しいデプロイ」→「ウェブアプリ」で公開し、\n' +
    'そのあと「🔗 Telegram Webhookを再設定」（=setTelegramWebhookToThisApp）を実行してください。';
  Logger.log(message);
  if (ui) {
    try { ui.alert(message); } catch (e) { /* メニュー経由でない場合はUIが無いため無視 */ }
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
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('先に「デプロイ」→「新しいデプロイ」→「ウェブアプリ」でこのプロジェクトを公開してください。');
  }
  const result = tgSetWebhook(url);
  Logger.log('setWebhook result: ' + JSON.stringify(result));
  return result;
}
