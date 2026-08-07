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
