#!/usr/bin/env python3
"""
Google Sheets クライアント

請求書集計システムの「真のデータソース」としてスプレッドシートを読み書きする。
- 請求書ログ：Gmailから検出した請求書/見積書/納品書の抽出結果と承認状態
- 固定支払い先マスタ：毎月/定期的に来るはずの取引先リスト（漏れ検知の基準）
- 月次サマリ：月次集計結果と最終確認状態
"""

import gspread
from google.oauth2.service_account import Credentials

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

SPREADSHEET_TITLE = "請求書管理_月次集計"

INVOICE_SHEET = "請求書ログ"
# 書類ID: 添付ファイル1件ごとの一意キー（再スキャン時の重複防止に使用）
# 案件ID: 見積書/納品書/請求書の3点セットとして紐付けられたグループのキー
INVOICE_HEADERS = [
    "書類ID", "案件ID", "検出日時", "対象月", "発行日", "取引先名",
    "書類種別", "金額(税込)", "金額(税抜)", "支払期日",
    "請求書番号", "インボイス登録番号", "Gmailメッセージ ID",
    "添付ファイル名", "見積書有無", "納品書有無", "請求書有無",
    "支払対象", "ステータス", "承認者", "承認日時", "備考",
]

VENDOR_SHEET = "固定支払い先マスタ"
VENDOR_HEADERS = ["取引先名", "頻度", "概算金額", "備考", "有効"]

SUMMARY_SHEET = "月次サマリ"
SUMMARY_HEADERS = [
    "対象月", "集計日時", "件数", "合計金額(税込)",
    "3点セット未完了件数", "固定支払い先の未着", "未承認件数", "最終確認",
]

# ステータス値
STATUS_PENDING = "未承認"
STATUS_APPROVED = "承認済み"
STATUS_NEEDS_REVIEW = "要確認"
STATUS_REJECTED = "却下"

# 支払対象アラート値（「これは支払うものですか？」の判定・回答）
PAYABLE_YES = "要払い"
PAYABLE_NO = "対象外"
PAYABLE_UNKNOWN = "確認中"


class SheetsClient:
    def __init__(self, config):
        self.config = config
        creds = Credentials.from_service_account_file(
            config.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=SCOPES
        )
        self.gc = gspread.authorize(creds)
        self.spreadsheet = self._open_or_create()
        self.invoice_ws = self._ensure_sheet(INVOICE_SHEET, INVOICE_HEADERS)
        self.vendor_ws = self._ensure_sheet(VENDOR_SHEET, VENDOR_HEADERS)
        self.summary_ws = self._ensure_sheet(SUMMARY_SHEET, SUMMARY_HEADERS)

    # ---------- 初期化 ----------

    def _open_or_create(self):
        if self.config.GOOGLE_SPREADSHEET_ID:
            return self.gc.open_by_key(self.config.GOOGLE_SPREADSHEET_ID)

        # スプレッドシート未指定 → 新規作成する
        sh = self.gc.create(SPREADSHEET_TITLE)
        if self.config.GOOGLE_SHEET_SHARE_EMAIL:
            sh.share(self.config.GOOGLE_SHEET_SHARE_EMAIL, perm_type="user", role="writer")
        print("✅ 新規スプレッドシートを作成しました")
        print(f"   ID: {sh.id}")
        print(f"   URL: {sh.url}")
        print("   .env の GOOGLE_SPREADSHEET_ID に上記IDを設定すると、次回から同じシートを使います")
        return sh

    def _ensure_sheet(self, title, headers):
        try:
            ws = self.spreadsheet.worksheet(title)
        except gspread.WorksheetNotFound:
            ws = self.spreadsheet.add_worksheet(title=title, rows=2000, cols=len(headers) + 2)
            ws.append_row(headers)
            return ws

        existing = ws.row_values(1)
        if not existing:
            ws.append_row(headers)
        return ws

    # ---------- 請求書ログ ----------

    def find_invoice_row(self, doc_id):
        """書類IDで行番号を検索。見つからなければ None"""
        try:
            cell = self.invoice_ws.find(doc_id, in_column=1)
        except gspread.exceptions.CellNotFound:
            return None
        return cell.row if cell else None

    def upsert_invoice(self, row: dict):
        """書類IDが既存なら更新、無ければ追加（同じ添付を再スキャンしても重複しない）"""
        doc_id = row.get("書類ID")
        row_idx = self.find_invoice_row(doc_id) if doc_id else None
        values = [str(row.get(h, "")) for h in INVOICE_HEADERS]

        if row_idx:
            self.invoice_ws.update(f"A{row_idx}", [values], value_input_option="USER_ENTERED")
        else:
            self.invoice_ws.append_row(values, value_input_option="USER_ENTERED")

    def update_invoice_field(self, doc_id, field, value):
        row_idx = self.find_invoice_row(doc_id)
        if not row_idx:
            return False
        col_idx = INVOICE_HEADERS.index(field) + 1
        self.invoice_ws.update_cell(row_idx, col_idx, value)
        return True

    def update_invoice_fields_by_case(self, case_id, fields: dict):
        """同じ案件IDを持つ全行に対して、複数フィールドをまとめて更新する（3点セット状態の反映用）"""
        all_values = self.invoice_ws.get_all_values()
        if not all_values:
            return 0
        header = all_values[0]
        case_col = header.index("案件ID")
        updated = 0
        for i, row_vals in enumerate(all_values[1:], start=2):
            if len(row_vals) > case_col and row_vals[case_col] == case_id:
                for field, value in fields.items():
                    col_idx = header.index(field) + 1
                    self.invoice_ws.update_cell(i, col_idx, value)
                updated += 1
        return updated

    def get_all_invoices(self):
        return self.invoice_ws.get_all_records()

    def get_invoices_for_month(self, yyyymm):
        return [r for r in self.get_all_invoices() if r.get("対象月") == yyyymm]

    def get_pending_invoices(self):
        return [r for r in self.get_all_invoices() if r.get("ステータス") in (STATUS_PENDING, STATUS_NEEDS_REVIEW)]

    # ---------- 固定支払い先マスタ ----------

    def get_fixed_vendors(self):
        rows = self.vendor_ws.get_all_records()
        return [r for r in rows if str(r.get("有効", "TRUE")).strip().upper() != "FALSE"]

    def seed_fixed_vendors_if_empty(self, vendors):
        """初回のみ：固定支払い先マスタが空ならシードデータを投入"""
        existing = self.vendor_ws.get_all_values()
        if len(existing) > 1:
            return False
        for v in vendors:
            self.vendor_ws.append_row(
                [v.get("取引先名", ""), v.get("頻度", "毎月"), v.get("概算金額", ""), v.get("備考", ""), "TRUE"],
                value_input_option="USER_ENTERED",
            )
        return True

    # ---------- 月次サマリ ----------

    def write_monthly_summary(self, row: dict):
        values = [str(row.get(h, "")) for h in SUMMARY_HEADERS]
        self.summary_ws.append_row(values, value_input_option="USER_ENTERED")

    def get_summary_for_month(self, yyyymm):
        rows = self.summary_ws.get_all_records()
        matches = [r for r in rows if r.get("対象月") == yyyymm]
        return matches[-1] if matches else None

    def update_summary_final_check(self, yyyymm, value):
        """指定月の最新サマリ行の「最終確認」列を更新する（月末の人間による最終目視チェック用）"""
        all_values = self.summary_ws.get_all_values()
        if not all_values:
            return False
        header = all_values[0]
        month_col = header.index("対象月")
        check_col = header.index("最終確認") + 1

        target_row = None
        for i, row_vals in enumerate(all_values[1:], start=2):
            if len(row_vals) > month_col and row_vals[month_col] == yyyymm:
                target_row = i
        if not target_row:
            return False

        self.summary_ws.update_cell(target_row, check_col, value)
        return True
