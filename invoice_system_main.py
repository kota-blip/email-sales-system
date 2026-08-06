#!/usr/bin/env python3
"""
請求書集計システム メインアプリ（払う側の請求書を毎月自動集計する）

- Gmail監視: 添付PDF（見積書/納品書/請求書）を検出 → Claudeで構造化抽出 → Sheetsに記録
- ダブルチェック: 抽出結果をTelegramに通知し、人間が承認/修正/却下（AI抽出→人間が1回承認）
- 漏れ検知: 固定支払い先マスタとの突合＋3点セット（見積書/納品書/請求書）の充足チェック
- 月次集計: 自動（月初）/手動（Telegramコマンド）でサマリを生成し、最終目視確認を依頼
"""

import threading
import time
from datetime import date, datetime, timedelta

from flask import Flask, jsonify, request

from claude_handler import ClaudeHandler
from config import Config
from gmail_handler import GmailHandler
from invoice_extractor import InvoiceExtractor, extract_pdf_text
from invoice_matcher import InvoiceMatcher, find_missing_fixed_vendors, make_doc_id
from sheets_client import (
    STATUS_APPROVED,
    STATUS_NEEDS_REVIEW,
    STATUS_PENDING,
    STATUS_REJECTED,
    SheetsClient,
)
from telegram_handler import CB_APPROVE, CB_CONFIRM_MONTH, CB_EDIT, CB_REJECT, TelegramHandler

# ========== 初期化 ==========

config = Config()
config.validate_for_invoice_system()

gmail = GmailHandler(config)
claude = ClaudeHandler(config)
telegram = TelegramHandler(config)
sheets = SheetsClient(config)
extractor = InvoiceExtractor(claude)
matcher = InvoiceMatcher(
    window_days=config.INVOICE_MATCH_WINDOW_DAYS,
    amount_tolerance=config.INVOICE_MATCH_AMOUNT_TOLERANCE,
)

app = Flask(__name__)

# chat_id -> 修正待ちの書類ID（プロセス内メモリ管理のため gunicorn は -w 1 を想定）
awaiting_correction = {}


# ========== ユーティリティ ==========

def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def target_month_from(document_date_str):
    """document_dateがあればその月、無ければ今月をYYYY-MM形式で返す"""
    if document_date_str:
        try:
            d = datetime.strptime(document_date_str, "%Y-%m-%d")
            return d.strftime("%Y-%m")
        except ValueError:
            pass
    return datetime.now().strftime("%Y-%m")


def previous_month_str(base=None):
    base = base or date.today()
    first_of_this_month = base.replace(day=1)
    last_month_end = first_of_this_month - timedelta(days=1)
    return last_month_end.strftime("%Y-%m")


def yes_no(flag):
    return "TRUE" if flag else "FALSE"


def format_amount(value):
    try:
        return f"¥{int(float(value)):,}"
    except (TypeError, ValueError):
        return "(不明)"


def _to_number(value):
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _adjacent_months(yyyymm):
    """対象月の前後1か月を含む3か月分を返す（3点セットが月をまたぐケースを拾うため）"""
    y, m = map(int, yyyymm.split("-"))
    months = set()
    for delta in (-1, 0, 1):
        mm = m + delta
        yy = y
        if mm < 1:
            mm += 12
            yy -= 1
        elif mm > 12:
            mm -= 12
            yy += 1
        months.add(f"{yy:04d}-{mm:02d}")
    return months


# ========== 請求書取り込み ==========

def process_new_documents():
    """Gmailを検索し、未処理のPDF添付を抽出・Sheets記録・Telegram通知する"""
    print("🔍 請求書メールをスキャン中...")
    mail_items = gmail.search_pdf_attachments(config.INVOICE_GMAIL_QUERY, max_results=30)

    new_doc_count = 0
    for item in mail_items:
        for att in item["attachments"]:
            doc_id = make_doc_id(item["msg_id"], att["filename"])
            if sheets.find_invoice_row(doc_id):
                continue  # 既に処理済み

            pdf_text = extract_pdf_text(att["data"])
            extracted = extractor.extract(pdf_text, filename=att["filename"])

            row = build_invoice_row(doc_id, item, att["filename"], extracted)
            sheets.upsert_invoice(row)
            new_doc_count += 1

            notify_new_document(row, extracted)
            regroup_cases(row["対象月"])

    if new_doc_count:
        print(f"✅ 新規{new_doc_count}件の書類を処理しました")
    else:
        print("   新規の書類はありませんでした")


def build_invoice_row(doc_id, mail_item, filename, extracted):
    target_month = target_month_from(extracted.get("document_date"))
    return {
        "書類ID": doc_id,
        "案件ID": "",  # regroup_cases が設定する
        "検出日時": now_iso(),
        "対象月": target_month,
        "発行日": extracted.get("document_date") or "",
        "取引先名": extracted.get("vendor_name") or "(取引先不明)",
        "書類種別": extracted.get("doc_type") or "不明",
        "金額(税込)": extracted.get("amount_with_tax") if extracted.get("amount_with_tax") is not None else "",
        "金額(税抜)": extracted.get("amount_without_tax") if extracted.get("amount_without_tax") is not None else "",
        "支払期日": extracted.get("due_date") or "",
        "請求書番号": extracted.get("invoice_number") or "",
        "インボイス登録番号": extracted.get("registration_number") or "",
        "Gmailメッセージ ID": mail_item["msg_id"],
        "添付ファイル名": filename,
        "見積書有無": "FALSE",
        "納品書有無": "FALSE",
        "請求書有無": "FALSE",
        "ステータス": STATUS_NEEDS_REVIEW if extracted.get("confidence") == "low" else STATUS_PENDING,
        "承認者": "",
        "承認日時": "",
        "備考": extracted.get("raw_note") or "",
    }


def notify_new_document(row, extracted):
    lines = [
        "📄 <b>新しい書類を検出しました</b>",
        "",
        f"種別: {row['書類種別']}",
        f"取引先: {row['取引先名']}",
        f"金額(税込): {format_amount(row['金額(税込)'])}",
        f"支払期日: {row['支払期日'] or '(記載なし)'}",
        f"添付: {row['添付ファイル名']}",
    ]
    if extracted.get("confidence") == "low":
        lines.append("⚠️ 読み取り確信度が低いです。内容を確認してください。")
    if row.get("備考"):
        lines.append(f"備考: {row['備考']}")
    lines.append("")
    lines.append(f"書類ID: <code>{row['書類ID']}</code>")

    telegram.send_invoice_approval(row["書類ID"], "\n".join(lines))


def regroup_cases(target_month):
    """対象月の前後1か月を含めて再グルーピングし、案件ID・3点セットフラグをSheetsへ反映する"""
    months = _adjacent_months(target_month)
    all_invoices = sheets.get_all_invoices()
    invoices = [r for r in all_invoices if r.get("対象月") in months]
    if not invoices:
        return

    docs = []
    for inv in invoices:
        docs.append({
            "doc_type": inv.get("書類種別"),
            "vendor_name": inv.get("取引先名"),
            "amount_with_tax": _to_number(inv.get("金額(税込)")),
            "amount_without_tax": _to_number(inv.get("金額(税抜)")),
            "document_date": inv.get("発行日") or None,
            "_doc_id": inv.get("書類ID"),
        })

    cases = matcher.group_into_cases(docs)

    for case in cases:
        doc_ids = [d["_doc_id"] for d in case["documents"]]
        for doc_id in doc_ids:
            sheets.update_invoice_field(doc_id, "案件ID", case["case_id"])
        sheets.update_invoice_fields_by_case(case["case_id"], {
            "見積書有無": yes_no(case["has_quote"]),
            "納品書有無": yes_no(case["has_delivery"]),
            "請求書有無": yes_no(case["has_invoice"]),
        })


# ========== 月次集計（漏れ検知の要） ==========

def generate_monthly_report(yyyymm, notify=True):
    """指定月の集計を行い、固定支払い先の未着・3点セット未完了・未承認件数を洗い出す"""
    invoices = sheets.get_invoices_for_month(yyyymm)
    fixed_vendors = sheets.get_fixed_vendors()
    missing_vendors = find_missing_fixed_vendors(fixed_vendors, invoices)

    # 案件単位で重複排除（同一案件内の行は3点セットフラグが同じ）
    cases = {}
    for inv in invoices:
        case_key = inv.get("案件ID") or inv.get("書類ID")
        cases[case_key] = inv

    incomplete_cases = [
        c for c in cases.values()
        if not (c.get("見積書有無") == "TRUE" and c.get("納品書有無") == "TRUE" and c.get("請求書有無") == "TRUE")
    ]

    invoice_docs = [r for r in invoices if r.get("書類種別") == "請求書"]
    total_amount = sum((_to_number(r.get("金額(税込)")) or 0) for r in invoice_docs)
    pending = [r for r in invoices if r.get("ステータス") in (STATUS_PENDING, STATUS_NEEDS_REVIEW)]

    summary_row = {
        "対象月": yyyymm,
        "集計日時": now_iso(),
        "件数": len(invoice_docs),
        "合計金額(税込)": total_amount,
        "3点セット未完了件数": len(incomplete_cases),
        "固定支払い先の未着": "、".join(v.get("取引先名", "") for v in missing_vendors) or "なし",
        "未承認件数": len(pending),
        "最終確認": "未確認",
    }
    sheets.write_monthly_summary(summary_row)

    if notify:
        text = build_monthly_report_text(yyyymm, summary_row, missing_vendors, pending)
        telegram.send_month_end_confirmation(yyyymm, text)

    return summary_row


def build_monthly_report_text(yyyymm, summary, missing_vendors, pending):
    lines = [
        f"📊 <b>{yyyymm} 月次請求書集計</b>",
        "",
        f"請求書件数: {summary['件数']}件",
        f"合計金額(税込): {format_amount(summary['合計金額(税込)'])}",
        f"未承認・要確認: {summary['未承認件数']}件",
        f"3点セット未完了: {summary['3点セット未完了件数']}件",
    ]

    if missing_vendors:
        lines.append("")
        lines.append("⚠️ <b>固定支払い先で今月まだ届いていないもの:</b>")
        for v in missing_vendors:
            lines.append(f"・{v.get('取引先名')}（{v.get('頻度', '')}）")
    else:
        lines.append("")
        lines.append("✅ 固定支払い先はすべて確認できました")

    if pending:
        lines.append("")
        lines.append(f"🔸 未承認/要確認の書類が{len(pending)}件あります。「一覧」で確認してください。")

    lines.append("")
    lines.append("すべて目視確認できたら、下のボタンで今月分を確定してください。")
    return "\n".join(lines)


# ========== Telegram Webhook ==========

@app.route("/telegram_webhook", methods=["POST"])
def telegram_webhook():
    data = request.get_json(force=True, silent=True) or {}
    event = TelegramHandler.parse_update(data)

    if event["type"] == "callback_query":
        handle_callback(event)
    elif event["type"] == "message":
        handle_message(event)

    return jsonify({"ok": True})


def handle_callback(event):
    action = event["action"]
    key = event["case_id"]  # doc_id または yyyymm
    chat_id, message_id = event["chat_id"], event["message_id"]
    user = event.get("from_user") or "unknown"
    cq_id = event["callback_query_id"]

    if action == CB_APPROVE:
        sheets.update_invoice_field(key, "ステータス", STATUS_APPROVED)
        sheets.update_invoice_field(key, "承認者", user)
        sheets.update_invoice_field(key, "承認日時", now_iso())
        telegram.answer_callback_query(cq_id, "承認しました")
        telegram.clear_keyboard(chat_id, message_id)
        telegram.send_message(f"✅ 承認済みにしました\n書類ID: <code>{key}</code>", chat_id=chat_id)

    elif action == CB_REJECT:
        sheets.update_invoice_field(key, "ステータス", STATUS_REJECTED)
        sheets.update_invoice_field(key, "承認者", user)
        sheets.update_invoice_field(key, "承認日時", now_iso())
        telegram.answer_callback_query(cq_id, "却下しました")
        telegram.clear_keyboard(chat_id, message_id)
        telegram.send_message(f"❌ 却下にしました\n書類ID: <code>{key}</code>", chat_id=chat_id)

    elif action == CB_EDIT:
        awaiting_correction[chat_id] = key
        sheets.update_invoice_field(key, "ステータス", STATUS_NEEDS_REVIEW)
        telegram.answer_callback_query(cq_id, "修正内容を送ってください")
        telegram.send_message(
            "✏️ 修正内容をテキストで送信してください\n（例：「金額を12,000円に」「支払期日を9/30に」）",
            chat_id=chat_id,
        )

    elif action == CB_CONFIRM_MONTH:
        yyyymm = key
        sheets.update_summary_final_check(yyyymm, f"確認済み（{user}, {now_iso()}）")
        telegram.answer_callback_query(cq_id, "確定しました")
        telegram.clear_keyboard(chat_id, message_id)
        telegram.send_message(f"✅ {yyyymm} 分を確認済みとして確定しました。お疲れさまでした！", chat_id=chat_id)


def handle_message(event):
    chat_id = event["chat_id"]
    text = (event.get("text") or "").strip()

    # 修正待ち状態なら、これを修正指示として処理する
    if chat_id in awaiting_correction:
        doc_id = awaiting_correction.pop(chat_id)
        apply_correction(doc_id, text, chat_id)
        return

    if text.startswith("/集計") or text.startswith("集計") or text.startswith("/monthly"):
        parts = text.split()
        yyyymm = parts[1] if len(parts) > 1 else previous_month_str()
        telegram.send_message(f"🔄 {yyyymm} の集計を実行します...", chat_id=chat_id)
        generate_monthly_report(yyyymm, notify=True)
        return

    if text in ("一覧", "/list"):
        pending = sheets.get_pending_invoices()
        if not pending:
            telegram.send_message("未承認/要確認の書類はありません", chat_id=chat_id)
        else:
            lines = ["📋 未承認/要確認の書類:"]
            for r in pending[:15]:
                lines.append(
                    f"・{r.get('取引先名')} / {r.get('書類種別')} / "
                    f"{format_amount(r.get('金額(税込)'))} (ID:{r.get('書類ID')})"
                )
            telegram.send_message("\n".join(lines), chat_id=chat_id)
        return

    if text in ("/scan", "スキャン"):
        telegram.send_message("🔄 Gmailをスキャンします...", chat_id=chat_id)
        threading.Thread(target=process_new_documents, daemon=True).start()
        return

    telegram.send_message(
        "📧 請求書集計システム\n\n"
        "コマンド:\n"
        "「一覧」 - 未承認/要確認の書類一覧\n"
        "「集計 [YYYY-MM]」 - 月次集計を実行（省略時は先月分）\n"
        "「スキャン」 - Gmailを今すぐ確認\n\n"
        "新しい請求書/見積書/納品書を検出すると自動で通知します。",
        chat_id=chat_id,
    )


def apply_correction(doc_id, modification_text, chat_id):
    invoices = sheets.get_all_invoices()
    current = next((r for r in invoices if r.get("書類ID") == doc_id), None)
    if not current:
        telegram.send_message("対象の書類が見つかりませんでした", chat_id=chat_id)
        return

    revised = extractor.revise(_row_to_extracted(current), modification_text)

    updates = {
        "取引先名": revised.get("vendor_name") or current.get("取引先名"),
        "書類種別": revised.get("doc_type") or current.get("書類種別"),
        "金額(税込)": (
            revised.get("amount_with_tax")
            if revised.get("amount_with_tax") is not None
            else current.get("金額(税込)")
        ),
        "金額(税抜)": (
            revised.get("amount_without_tax")
            if revised.get("amount_without_tax") is not None
            else current.get("金額(税抜)")
        ),
        "支払期日": revised.get("due_date") or current.get("支払期日"),
        "発行日": revised.get("document_date") or current.get("発行日"),
        "請求書番号": revised.get("invoice_number") or current.get("請求書番号"),
        "インボイス登録番号": revised.get("registration_number") or current.get("インボイス登録番号"),
        "ステータス": STATUS_PENDING,
    }
    for field, value in updates.items():
        sheets.update_invoice_field(doc_id, field, str(value) if value is not None else "")

    regroup_cases(current.get("対象月"))

    updated_row = dict(current)
    updated_row.update(updates)
    updated_row["書類ID"] = doc_id
    telegram.send_message("✏️ 修正しました。内容を再確認してください。", chat_id=chat_id)
    notify_new_document(updated_row, revised)


def _row_to_extracted(row):
    return {
        "doc_type": row.get("書類種別"),
        "vendor_name": row.get("取引先名"),
        "amount_with_tax": _to_number(row.get("金額(税込)")),
        "amount_without_tax": _to_number(row.get("金額(税抜)")),
        "due_date": row.get("支払期日") or None,
        "document_date": row.get("発行日") or None,
        "invoice_number": row.get("請求書番号") or None,
        "registration_number": row.get("インボイス登録番号") or None,
        "confidence": "medium",
        "raw_note": row.get("備考", ""),
        "filename": row.get("添付ファイル名", ""),
    }


# ========== 補助エンドポイント ==========

@app.route("/health")
def health():
    return jsonify({"status": "ok", "time": now_iso()})


@app.route("/trigger/scan", methods=["POST"])
def trigger_scan():
    threading.Thread(target=process_new_documents, daemon=True).start()
    return jsonify({"status": "scan started"})


@app.route("/trigger/monthly/<yyyymm>", methods=["POST"])
def trigger_monthly(yyyymm):
    result = generate_monthly_report(yyyymm, notify=True)
    return jsonify(result)


# ========== バックグラウンドループ ==========

def gmail_watch_loop():
    while True:
        try:
            process_new_documents()
        except Exception as e:
            print(f"❌ 請求書監視エラー: {e}")
        time.sleep(config.INVOICE_CHECK_INTERVAL)


def monthly_auto_trigger_loop():
    """月初に前月分の集計を自動生成する（同月分の二重生成は避ける）"""
    while True:
        try:
            today = date.today()
            if today.day == 1:
                yyyymm = previous_month_str(today)
                already = sheets.get_summary_for_month(yyyymm)
                if not already:
                    print(f"📅 月初のため {yyyymm} の月次集計を自動生成します")
                    generate_monthly_report(yyyymm, notify=True)
        except Exception as e:
            print(f"❌ 月次自動集計エラー: {e}")
        time.sleep(6 * 60 * 60)  # 6時間ごとにチェック


# ========== メイン実行 ==========

if __name__ == "__main__":
    print("🚀 請求書集計システム起動...")

    threading.Thread(target=gmail_watch_loop, daemon=True).start()
    threading.Thread(target=monthly_auto_trigger_loop, daemon=True).start()

    port = config.INVOICE_WEBHOOK_PORT
    print(f"📍 Telegram Webhookサーバー起動: http://0.0.0.0:{port}/telegram_webhook")
    app.run(host="0.0.0.0", port=port, debug=False)
