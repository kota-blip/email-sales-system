#!/usr/bin/env python3
"""
設定管理
すべての秘密情報（APIキー・トークン等）は環境変数（.env）から読み込みます。
リポジトリに実際の値をコミットしないでください。
"""

import os

# .env があれば読み込む（本番環境では環境変数を直接設定してもOK）
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # python-dotenv 未インストールでも環境変数が既に設定されていれば動作する
    pass


def _get_env(key, default=None, required=False):
    value = os.environ.get(key, default)
    if required and not value:
        raise RuntimeError(
            f"環境変数 {key} が設定されていません。.env.example を参考に .env を作成してください。"
        )
    return value


class Config:
    # ===== LINE API（メール返信システム用） =====
    LINE_CHANNEL_ACCESS_TOKEN = _get_env("LINE_CHANNEL_ACCESS_TOKEN")
    LINE_CHANNEL_SECRET = _get_env("LINE_CHANNEL_SECRET")
    LINE_USER_ID = _get_env("LINE_USER_ID")

    # ===== Claude API =====
    CLAUDE_API_KEY = _get_env("CLAUDE_API_KEY")
    CLAUDE_MODEL = _get_env("CLAUDE_MODEL", "claude-3-5-sonnet-20241022")

    # ===== Telegram API（請求書集計システムの通知・承認用） =====
    TELEGRAM_BOT_TOKEN = _get_env("TELEGRAM_BOT_TOKEN")
    TELEGRAM_CHAT_ID = _get_env("TELEGRAM_CHAT_ID")

    # ===== Google Sheets / Gmail 連携 =====
    GOOGLE_SERVICE_ACCOUNT_FILE = _get_env("GOOGLE_SERVICE_ACCOUNT_FILE", "service_account.json")
    GOOGLE_SPREADSHEET_ID = _get_env("GOOGLE_SPREADSHEET_ID")  # 未設定なら新規作成
    GOOGLE_SHEET_SHARE_EMAIL = _get_env("GOOGLE_SHEET_SHARE_EMAIL")  # 新規作成時の共有先

    # ===== ローカルファイル（メール返信システム） =====
    DRAFTS_FILE = "drafts.json"
    EMAILS_LOG_FILE = "emails_log.json"

    # ===== システム（メール返信システム） =====
    GMAIL_CHECK_INTERVAL = int(_get_env("GMAIL_CHECK_INTERVAL", "30"))
    WEBHOOK_PORT = int(_get_env("WEBHOOK_PORT", "5000"))
    MAX_EMAILS_PER_CHECK = int(_get_env("MAX_EMAILS_PER_CHECK", "5"))

    # ===== 請求書集計システム =====
    INVOICE_CHECK_INTERVAL = int(_get_env("INVOICE_CHECK_INTERVAL", "3600"))  # 秒（デフォルト1時間ごと）
    INVOICE_WEBHOOK_PORT = int(_get_env("INVOICE_WEBHOOK_PORT", "5002"))
    INVOICE_GMAIL_QUERY = _get_env(
        "INVOICE_GMAIL_QUERY",
        "has:attachment filename:pdf (請求書 OR invoice OR 見積書 OR 納品書 OR quotation OR delivery)",
    )
    # 3点セット（見積書・納品書・請求書）を同一案件として紐付ける際の許容日数
    INVOICE_MATCH_WINDOW_DAYS = int(_get_env("INVOICE_MATCH_WINDOW_DAYS", "60"))
    # 金額が近いとみなす許容誤差（税抜/税込差異などを吸収するための割合）
    INVOICE_MATCH_AMOUNT_TOLERANCE = float(_get_env("INVOICE_MATCH_AMOUNT_TOLERANCE", "0.15"))
    INVOICE_LOG_FILE = _get_env("INVOICE_LOG_FILE", "invoices_log.json")

    def validate_for_invoice_system(self):
        """請求書集計システム起動前の必須設定チェック"""
        missing = []
        for key in ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "CLAUDE_API_KEY"]:
            if not getattr(self, key):
                missing.append(key)
        if missing:
            raise RuntimeError(
                "請求書集計システムに必要な環境変数が不足しています: " + ", ".join(missing)
            )
