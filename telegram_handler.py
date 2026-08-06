#!/usr/bin/env python3
"""
Telegram Bot ハンドラー
請求書抽出結果の通知・承認/修正/却下（ダブルチェック）・月次サマリ通知を担当
"""

import requests

API_BASE = "https://api.telegram.org/bot{token}/{method}"

# callback_data のプレフィックス（Telegramの制限で64バイト以内に収める）
CB_APPROVE = "appr"
CB_EDIT = "edit"
CB_REJECT = "rej"
CB_CONFIRM_MONTH = "confm"
CB_PAYABLE_YES = "payy"
CB_PAYABLE_NO = "payn"


class TelegramHandler:
    def __init__(self, config):
        self.config = config
        self.token = config.TELEGRAM_BOT_TOKEN
        self.default_chat_id = config.TELEGRAM_CHAT_ID

    def _call(self, method, payload):
        url = API_BASE.format(token=self.token, method=method)
        try:
            resp = requests.post(url, json=payload, timeout=15)
            data = resp.json()
            if not data.get("ok"):
                print(f"❌ Telegram API エラー ({method}): {data}")
            return data
        except Exception as e:
            print(f"❌ Telegram 通信エラー ({method}): {e}")
            return {"ok": False, "error": str(e)}

    # ---------- 送信 ----------

    def send_message(self, text, chat_id=None, reply_markup=None):
        payload = {
            "chat_id": chat_id or self.default_chat_id,
            "text": text,
            "parse_mode": "HTML",
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return self._call("sendMessage", payload)

    def send_invoice_approval(self, case_id, text, chat_id=None, ask_payable=False):
        """抽出結果を通知し、承認/修正/却下ボタンを付ける（ダブルチェックの起点）

        ask_payable=True の場合、「これは支払うものですか？」の判定ボタンも上段に付ける
        （AIが支払対象を確信できなかったケース用）。
        """
        rows = []
        if ask_payable:
            rows.append([
                {"text": "💰 支払うものです", "callback_data": f"{CB_PAYABLE_YES}:{case_id}"},
                {"text": "🚫 対象外です", "callback_data": f"{CB_PAYABLE_NO}:{case_id}"},
            ])
        rows.append([
            {"text": "✅ 承認", "callback_data": f"{CB_APPROVE}:{case_id}"},
            {"text": "✏️ 修正", "callback_data": f"{CB_EDIT}:{case_id}"},
            {"text": "❌ 却下", "callback_data": f"{CB_REJECT}:{case_id}"},
        ])
        keyboard = {"inline_keyboard": rows}
        return self.send_message(text, chat_id=chat_id, reply_markup=keyboard)

    def send_month_end_confirmation(self, yyyymm, text, chat_id=None):
        """月末の最終目視チェック依頼（人間の最終承認ゲート）"""
        keyboard = {
            "inline_keyboard": [[
                {"text": "✅ 今月分を確認済みにする", "callback_data": f"{CB_CONFIRM_MONTH}:{yyyymm}"},
            ]]
        }
        return self.send_message(text, chat_id=chat_id, reply_markup=keyboard)

    def answer_callback_query(self, callback_query_id, text=""):
        return self._call("answerCallbackQuery", {
            "callback_query_id": callback_query_id,
            "text": text,
        })

    def edit_message_text(self, chat_id, message_id, text, reply_markup=None):
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "HTML",
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return self._call("editMessageText", payload)

    def clear_keyboard(self, chat_id, message_id):
        return self._call("editMessageReplyMarkup", {
            "chat_id": chat_id,
            "message_id": message_id,
            "reply_markup": {"inline_keyboard": []},
        })

    # ---------- Webhook 設定 ----------

    def set_webhook(self, url):
        return self._call("setWebhook", {"url": url})

    def delete_webhook(self):
        return self._call("deleteWebhook", {})

    # ---------- 受信パース ----------

    @staticmethod
    def parse_update(data):
        """Telegram webhook の update JSON を扱いやすい形に変換する"""
        if "callback_query" in data:
            cq = data["callback_query"]
            callback_data = cq.get("data", "")
            action, _, case_id = callback_data.partition(":")
            return {
                "type": "callback_query",
                "action": action,
                "case_id": case_id,
                "callback_query_id": cq["id"],
                "chat_id": cq["message"]["chat"]["id"],
                "message_id": cq["message"]["message_id"],
                "from_user": cq.get("from", {}).get("username") or cq.get("from", {}).get("first_name"),
            }
        if "message" in data and "text" in data["message"]:
            msg = data["message"]
            return {
                "type": "message",
                "text": msg["text"],
                "chat_id": msg["chat"]["id"],
                "from_user": msg.get("from", {}).get("username") or msg.get("from", {}).get("first_name"),
            }
        return {"type": "unknown"}
