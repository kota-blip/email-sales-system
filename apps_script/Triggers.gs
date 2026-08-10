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
    .addItem('📲 Telegram受信をポーリング方式にする', 'switchToPollingMode')
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
    'Telegram受信はポーリング方式（毎分getUpdates）で動きます。ウェブアプリの公開は不要です。\n' +
    'もしWebhookを使っていた場合は「📲 Telegram受信をポーリング方式にする」を一度実行してください。';
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
  ScriptApp.newTrigger('pollTelegramUpdates').timeBased().everyMinutes(1).create();
  Logger.log('✅ トリガーを設定しました（毎時: Gmail監視 / 毎日9時: 月次 / 毎分: Telegram受信）');
}

/**
 * Telegram受信をWebhook方式からポーリング方式に切り替える（Google Workspaceの302問題を回避）。
 * Webhookを解除し、1分ごとにgetUpdatesで新着を取りに行くトリガーを設定する。
 * ウェブアプリの公開・URL登録・「全員に公開」が一切不要になる。
 */
function switchToPollingMode() {
  // まずネットワーク不要の処理（トリガー作成）を先に済ませる。
  // これにより、後段のネットワーク処理が遅くても、受信トリガーは確実に作られる。
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'pollTelegramUpdates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollTelegramUpdates').timeBased().everyMinutes(1).create();
  setProp('TG_OFFSET', '0'); // 溜まっていた古い更新は読み飛ばす

  // 最後にWebhookを解除（getUpdatesと併用不可のため）。ネットワークが絡む処理はここだけ。
  const del = tgDeleteWebhook();
  Logger.log('deleteWebhook result: ' + JSON.stringify(del));

  const msg = '📲 ポーリング方式に切り替えました。1分以内に受信できるようになります。';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
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
