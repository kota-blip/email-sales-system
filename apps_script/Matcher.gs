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
