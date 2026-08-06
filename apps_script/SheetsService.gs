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
