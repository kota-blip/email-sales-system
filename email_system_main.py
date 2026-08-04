#!/usr/bin/env python3
"""
Gmail × LINE × Claude API メール返信システム
"""

import os
import json
import time
import threading
from datetime import datetime
from flask import Flask, request
from line_bot_sdk import LineBotApi, WebhookParser
from line_bot_sdk.exceptions import InvalidSignatureError
from line_bot_sdk.models.events import MessageEvent, TextMessage
from line_bot_sdk.models.send_messages import TextSendMessage

# 自作モジュール
from gmail_handler import GmailHandler
from claude_handler import ClaudeHandler
from config import Config

# ========== 設定 ==========
config = Config()
gmail = GmailHandler(config)
claude = ClaudeHandler(config)
line_bot_api = LineBotApi(config.LINE_CHANNEL_ACCESS_TOKEN)
parser = WebhookParser(config.LINE_CHANNEL_SECRET)

# グローバル変数：修正ループ用
pending_emails = {}  # メールID: {draft_info}
draft_storage = {}   # メールID: {メール本文}

# Flask アプリ
app = Flask(__name__)

# ========== ユーティリティ ==========

def send_line_message(user_id, message):
    """LINEにメッセージを送信"""
    try:
        line_bot_api.push_message(
            user_id=user_id,
            messages=TextSendMessage(text=message)
        )
    except Exception as e:
        print(f"❌ LINE送信エラー: {e}")

def save_draft(email_id, subject, to, body):
    """下書きをローカルに保存"""
    drafts = {}
    if os.path.exists('drafts.json'):
        with open('drafts.json', 'r', encoding='utf-8') as f:
            drafts = json.load(f)
    
    drafts[email_id] = {
        'subject': subject,
        'to': to,
        'body': body,
        'timestamp': datetime.now().isoformat()
    }
    
    with open('drafts.json', 'w', encoding='utf-8') as f:
        json.dump(drafts, f, ensure_ascii=False, indent=2)
    
    print(f"✅ 下書き保存: {email_id}")

# ========== LINE Webhook ==========

@app.route("/callback", methods=['POST'])
def handle_callback():
    """LINEからのWebhookを処理"""
    signature = request.headers.get('X-Line-Signature')
    body = request.get_data(as_text=True)
    
    try:
        events = parser.parse(body, signature)
    except InvalidSignatureError:
        print("❌ LINE署名エラー")
        return "OK", 400
    
    for event in events:
        if not isinstance(event, MessageEvent):
            continue
        
        if not isinstance(event.message, TextMessage):
            continue
        
        user_id = event.source.user_id
        user_message = event.message.text
        
        # ========== 返信ロジック ==========
        
        # 1. 待機中のメール一覧
        if user_message == "一覧":
            if not pending_emails:
                send_line_message(user_id, "待機中のメールはありません")
            else:
                msg = "📬 待機中のメール:\n\n"
                for eid, info in pending_emails.items():
                    msg += f"【{info['subject'][:30]}...】\n"
                    msg += f"From: {info['from']}\n"
                    msg += f"返信案:\n{info['draft'][:100]}...\n\n"
                send_line_message(user_id, msg)
            return "OK", 200
        
        # 2. メール送信確定: "送信OK" または "OK"
        if user_message in ["送信OK", "OK"]:
            if not pending_emails:
                send_line_message(user_id, "確定するメールがありません")
            else:
                # 最後のメールを送信
                last_email_id = list(pending_emails.keys())[-1]
                info = pending_emails[last_email_id]
                
                try:
                    gmail.send_email(
                        to=info['to'],
                        subject=f"Re: {info['subject']}",
                        body=info['draft']
                    )
                    send_line_message(user_id, f"✅ 送信完了!\n\nTo: {info['to']}\n件名: Re: {info['subject']}")
                    del pending_emails[last_email_id]
                except Exception as e:
                    send_line_message(user_id, f"❌ 送信エラー: {e}")
            return "OK", 200
        
        # 3. 下書き保存: "下書き保存"
        if user_message == "下書き保存":
            if not pending_emails:
                send_line_message(user_id, "保存するメールがありません")
            else:
                last_email_id = list(pending_emails.keys())[-1]
                info = pending_emails[last_email_id]
                save_draft(last_email_id, info['subject'], info['to'], info['draft'])
                send_line_message(user_id, f"✅ 下書き保存完了\n\n編集後は Gmail のドラフトから送信できます")
                del pending_emails[last_email_id]
            return "OK", 200
        
        # 4. 修正依頼: "修正: ..."
        if user_message.startswith("修正:"):
            if not pending_emails:
                send_line_message(user_id, "修正するメールがありません")
            else:
                last_email_id = list(pending_emails.keys())[-1]
                info = pending_emails[last_email_id]
                modification = user_message.replace("修正:", "").strip()
                
                send_line_message(user_id, f"🔄 修正中...\n修正内容: {modification[:50]}...")
                
                try:
                    revised_draft = claude.revise_email(
                        original_draft=info['draft'],
                        modification=modification
                    )
                    
                    pending_emails[last_email_id]['draft'] = revised_draft
                    
                    send_line_message(user_id, f"修正完了:\n\n{revised_draft}\n\n---\n「送信OK」または「修正: ...」で指示してください")
                except Exception as e:
                    send_line_message(user_id, f"❌ 修正エラー: {e}")
            return "OK", 200
        
        # 5. その他（ヘルプ）
        send_line_message(user_id, """
📧 メール返信システム

コマンド:
「一覧」 - 待機中のメール一覧
「送信OK」 - メール送信
「下書き保存」 - 下書きに保存
「修正: ここをこう変えて」 - 返信案を修正

新しいメールが来たら自動通知します！
        """)
    
    return "OK", 200

# ========== Gmail監視（バックグラウンド）==========

def watch_gmail():
    """Gmailの新着メールを監視"""
    last_check = time.time()
    
    while True:
        try:
            time.sleep(30)  # 30秒ごとにチェック
            
            # 新しいメールを取得
            messages = gmail.get_unread_emails()
            
            for msg_id, msg_data in messages.items():
                if msg_id not in pending_emails:
                    # 新しいメール検出
                    print(f"📬 新しいメール: {msg_data['subject']}")
                    
                    # Claude APIで返信案作成
                    draft = claude.create_reply(
                        from_email=msg_data['from'],
                        subject=msg_data['subject'],
                        body=msg_data['body']
                    )
                    
                    # 待機リストに追加
                    pending_emails[msg_id] = {
                        'from': msg_data['from'],
                        'to': msg_data['from'],
                        'subject': msg_data['subject'],
                        'draft': draft
                    }
                    
                    # LINE通知
                    notification = f"""
📬 新しいメール来ました！

From: {msg_data['from']}
件名: {msg_data['subject']}

---
🤖 返信案:
{draft}

---
「送信OK」で送信
「修正: ○○」で修正依頼
「下書き保存」でGmailに保存
「一覧」で待機中のメール確認
                    """
                    send_line_message(config.LINE_USER_ID, notification)
        
        except Exception as e:
            print(f"❌ Gmail監視エラー: {e}")
            time.sleep(10)

# ========== メイン実行 ==========

if __name__ == '__main__':
    print("🚀 メール返信システム起動...")
    
    # Gmail監視をバックグラウンドで開始
    gmail_thread = threading.Thread(target=watch_gmail, daemon=True)
    gmail_thread.start()
    
    # Flask Webhook サーバー起動
    port = int(os.environ.get('PORT', 5000))
    print(f"📍 Webhookサーバー起動: http://0.0.0.0:{port}/callback")
    app.run(host='0.0.0.0', port=port, debug=False)
