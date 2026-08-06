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
