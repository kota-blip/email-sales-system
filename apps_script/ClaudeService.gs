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
