#!/usr/bin/env python3
"""
請求書マッチング・漏れ検知ロジック

- 見積書・納品書・請求書を「取引先名＋金額＋時期の近さ」で同一案件（3点セット）に紐付け
- 固定支払い先マスタと突合し、今月来ていない取引先を検知（漏れ検知の中核）

3点セットの紐付けは完全一致IDが無い前提のヒューリスティック（推定）です。
誤マッチ・未マッチは自動で確定せず、Telegramでの人間確認（ダブルチェック）に必ず回します。
"""

import difflib
import hashlib
from datetime import datetime

DOC_TYPES = ("見積書", "納品書", "請求書")


def normalize_vendor_name(name):
    if not name:
        return ""
    name = str(name).strip()
    for junk in ["株式会社", "（株）", "(株)", "有限会社", "合同会社", "御中", "様"]:
        name = name.replace(junk, "")
    return name.strip().lower()


def vendor_similarity(a, b):
    return difflib.SequenceMatcher(None, normalize_vendor_name(a), normalize_vendor_name(b)).ratio()


def amount_close(a, b, tolerance=0.15):
    if a is None or b is None:
        return False
    try:
        a, b = float(a), float(b)
    except (TypeError, ValueError):
        return False
    if a == 0 and b == 0:
        return True
    base = max(abs(a), abs(b), 1)
    return abs(a - b) / base <= tolerance


def make_doc_id(gmail_message_id, filename):
    """物理ドキュメント（添付ファイル）を一意に識別する安定ID。再スキャン時の重複防止に使う。"""
    key = f"{gmail_message_id}|{filename}"
    return "doc_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]


def _parse_date(value):
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except (ValueError, TypeError):
            continue
    return None


def _doc_amount(doc):
    return doc.get("amount_with_tax") if doc.get("amount_with_tax") is not None else doc.get("amount_without_tax")


class InvoiceMatcher:
    """複数の抽出済みドキュメントを「案件」単位でグルーピングし、3点セット状態を判定する"""

    def __init__(self, window_days=60, amount_tolerance=0.15):
        self.window_days = window_days
        self.amount_tolerance = amount_tolerance

    def group_into_cases(self, docs):
        """
        docs: [{"doc_type", "vendor_name", "amount_with_tax", "amount_without_tax",
                 "document_date", ...}, ...]

        戻り値: [{
            "case_id": str,
            "vendor_name": str,
            "documents": [doc, ...],
            "has_quote": bool, "has_delivery": bool, "has_invoice": bool,
            "is_complete_set": bool,
        }, ...]
        """
        cases = []
        for doc in docs:
            target = self._find_matching_case(cases, doc)
            if target is not None:
                target["documents"].append(doc)
            else:
                cases.append({"vendor_name": doc.get("vendor_name"), "documents": [doc]})

        for case in cases:
            docs_in_case = case["documents"]
            case["has_quote"] = any(d.get("doc_type") == "見積書" for d in docs_in_case)
            case["has_delivery"] = any(d.get("doc_type") == "納品書" for d in docs_in_case)
            case["has_invoice"] = any(d.get("doc_type") == "請求書" for d in docs_in_case)
            case["is_complete_set"] = case["has_quote"] and case["has_delivery"] and case["has_invoice"]
            case["case_id"] = self._make_case_id(case)

        return cases

    def _find_matching_case(self, cases, doc):
        best_case, best_score = None, 0.0
        for case in cases:
            score = vendor_similarity(case["vendor_name"], doc.get("vendor_name"))
            if score < 0.6:
                continue
            if not self._within_window(case, doc):
                continue
            if not self._amount_matches(case, doc):
                continue
            if score > best_score:
                best_case, best_score = case, score
        return best_case

    def _within_window(self, case, doc):
        doc_date = _parse_date(doc.get("document_date"))
        if not doc_date:
            return True  # 日付不明なら日付だけでは弾かない
        for d in case["documents"]:
            existing_date = _parse_date(d.get("document_date"))
            if existing_date and abs((doc_date - existing_date).days) > self.window_days:
                return False
        return True

    def _amount_matches(self, case, doc):
        doc_amount = _doc_amount(doc)
        if doc_amount is None:
            return True  # 金額不明なら金額だけでは弾かない
        for d in case["documents"]:
            existing_amount = _doc_amount(d)
            if existing_amount is not None and not amount_close(doc_amount, existing_amount, self.amount_tolerance):
                return False
        return True

    @staticmethod
    def _make_case_id(case):
        dates = sorted(filter(None, (_parse_date(d.get("document_date")) for d in case["documents"])))
        anchor = dates[0].isoformat() if dates else "unknown-date"
        key = f"{normalize_vendor_name(case['vendor_name'])}|{anchor}"
        return "case_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]


def find_missing_fixed_vendors(fixed_vendors, month_invoices):
    """
    固定支払い先マスタのうち、当月の請求書ログに一致する取引先が無いものを返す（＝漏れ候補）

    fixed_vendors: [{"取引先名": ..., "頻度": ..., ...}, ...]
    month_invoices: [{"取引先名": ..., ...}, ...]  (SheetsClient.get_invoices_for_month の結果)
    """
    seen_names = [inv.get("取引先名", "") for inv in month_invoices]
    missing = []
    for vendor in fixed_vendors:
        vendor_name = vendor.get("取引先名", "")
        if not vendor_name:
            continue
        matched = any(vendor_similarity(vendor_name, seen) >= 0.6 for seen in seen_names)
        if not matched:
            missing.append(vendor)
    return missing
