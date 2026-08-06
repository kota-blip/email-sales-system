#!/usr/bin/env python3
"""
請求書PDF抽出モジュール

Gmail添付PDFからテキストを抽出し、Claude APIで
「書類種別（請求書/見積書/納品書）」「取引先名」「金額」「支払期日」等の
構造化データに変換する。
"""

import io
import json
import re

import pdfplumber


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """PDFバイト列からテキストを抽出する（画像PDFの場合は空文字になる）"""
    text_parts = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text() or ""
                text_parts.append(page_text)
    except Exception as e:
        print(f"⚠️ PDFテキスト抽出エラー: {e}")
    return "\n".join(text_parts).strip()


class InvoiceExtractor:
    """Claude APIを使って請求書/見積書/納品書PDFから構造化データを抽出する"""

    def __init__(self, claude_handler):
        self.claude = claude_handler

    def extract(self, pdf_text: str, filename: str = "") -> dict:
        """
        戻り値の例:
        {
            "doc_type": "請求書" | "見積書" | "納品書" | "不明",
            "vendor_name": "株式会社〇〇",
            "amount_with_tax": 110000,
            "amount_without_tax": 100000,
            "due_date": "2026-09-30",
            "document_date": "2026-08-05",
            "invoice_number": "INV-2026-0012",
            "registration_number": "T1234567890123",
            "confidence": "high" | "medium" | "low",
            "raw_note": "抽出時の注意点など",
            "filename": "invoice.pdf",
        }
        """
        if not pdf_text:
            return self._empty_result(
                filename, note="PDFからテキストを抽出できませんでした（画像スキャンPDFの可能性があります。要目視確認）"
            )

        prompt = f"""あなたは経理のプロフェッショナルです。
以下は請求書・見積書・納品書のいずれかのPDFから抽出したテキストです。
内容を読み取り、以下のJSON形式で JSONのみ を出力してください（説明文・コードフェンス不要）。

【ファイル名】{filename}
【PDFテキスト】
{pdf_text[:6000]}

【出力JSON形式】
{{
  "doc_type": "請求書 または 見積書 または 納品書 または 不明",
  "vendor_name": "取引先（発行元）の会社名・氏名",
  "amount_with_tax": 税込金額（数値のみ。不明ならnull）,
  "amount_without_tax": 税抜金額（数値のみ。不明ならnull）,
  "due_date": "支払期日（YYYY-MM-DD。請求書以外や不明ならnull）",
  "document_date": "発行日（YYYY-MM-DD。不明ならnull）",
  "invoice_number": "書類番号（不明ならnull）",
  "registration_number": "インボイス登録番号 T+13桁（記載が無ければnull）",
  "confidence": "high か medium か low（読み取り確信度）",
  "raw_note": "判読しづらかった点・注意点があれば簡潔に。無ければ空文字"
}}
"""
        try:
            message = self.claude.client.messages.create(
                model=self.claude.model,
                max_tokens=800,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = message.content[0].text.strip()
            data = self._parse_json(raw)
            data["filename"] = filename
            return data
        except Exception as e:
            print(f"❌ Claude 請求書抽出エラー: {e}")
            return self._empty_result(filename, note=f"抽出失敗: {e}")

    def revise(self, current_data: dict, modification_text: str) -> dict:
        """人間からの修正指示（自然文）を反映した抽出結果を再生成する"""
        prompt = f"""以下は請求書/見積書/納品書から抽出したデータです。
人間からの修正指示に従って値を修正し、同じJSON形式で修正後の全項目を出力してください。
指示にない項目は元の値のまま維持してください。JSONのみを出力してください。

【現在のデータ】
{json.dumps(current_data, ensure_ascii=False, indent=2)}

【修正指示】
{modification_text}

【出力JSON形式（現在のデータと同じキー構成）】
"""
        try:
            message = self.claude.client.messages.create(
                model=self.claude.model,
                max_tokens=800,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = message.content[0].text.strip()
            data = self._parse_json(raw)
            data["filename"] = current_data.get("filename", "")
            return data
        except Exception as e:
            print(f"❌ Claude 修正エラー: {e}")
            return current_data

    @staticmethod
    def _parse_json(raw: str) -> dict:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        json_str = match.group(0) if match else raw
        return json.loads(json_str)

    @staticmethod
    def _empty_result(filename, note=""):
        return {
            "doc_type": "不明",
            "vendor_name": None,
            "amount_with_tax": None,
            "amount_without_tax": None,
            "due_date": None,
            "document_date": None,
            "invoice_number": None,
            "registration_number": None,
            "confidence": "low",
            "raw_note": note,
            "filename": filename,
        }
