#!/usr/bin/env python3
"""
Claude API ハンドラー
返信案作成・修正・メール分析機能
"""

import anthropic

class ClaudeHandler:
    def __init__(self, config):
        self.config = config
        self.client = anthropic.Anthropic(api_key=config.CLAUDE_API_KEY)
        self.model = "claude-3-5-sonnet-20241022"
    
    def create_reply(self, from_email, subject, body):
        """メール返信案を作成"""
        
        prompt = f"""あなたはプロの営業アシスタントです。
以下のメールに対して、適切で丁寧な返信メールを作成してください。

【受信メール】
From: {from_email}
Subject: {subject}
Body:
{body}

【返信案の条件】
- 件名の「Re: 」は含めない（別途追加されます）
- 本文だけを返してください
- 署名は含めずに本文のみ
- 丁寧で親切で、相手に好感を持たれるトーン
- 実際に送信できる内容にしてください
- 日本語で

返信案の本文のみを出力してください（「返信案：」などのプレフィックスなし）
"""
        
        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=1000,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            
            reply = message.content[0].text.strip()
            return reply
        
        except Exception as e:
            print(f"❌ Claude API エラー: {e}")
            return "申し訳ございません。返信案の作成に失敗しました。"
    
    def revise_email(self, original_draft, modification):
        """返信案を修正"""
        
        prompt = f"""以下のメール本文を、指定の修正内容に従って修正してください。

【元の本文】
{original_draft}

【修正内容】
{modification}

【修正後の出力】
- 修正後の本文のみを出力してください
- 「修正後：」などのプレフィックスなし
- 本文のみ出力
- 日本語で

修正後の本文のみを出力してください：
"""
        
        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=1000,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            
            revised = message.content[0].text.strip()
            return revised
        
        except Exception as e:
            print(f"❌ Claude 修正エラー: {e}")
            return original_draft
    
    def analyze_past_emails_for_suggestion(self, past_emails):
        """過去のメールを分析して、次に送るべきメール提案を生成
        
        Args:
            past_emails: [{"date": "2024-01-15", "to": "name@example.com", "subject": "...", "body": "..."}]
        
        Returns:
            提案メッセージ
        """
        
        emails_text = "\n\n".join([
            f"【{e['date']}】\nTo: {e['to']}\nSubject: {e['subject']}\nBody: {e['body'][:200]}..."
            for e in past_emails[-10:]  # 直近10件
        ])
        
        prompt = f"""あなたはプロの営業マネージャーです。
以下は過去のメール履歴です。この営業の傾向を分析して、
「そろそろこのクライアントに連絡した方がいい」というメール提案をしてください。

【過去のメール】
{emails_text}

【分析結果】
1. 最後の連絡からどのくらい時間が経っているか
2. クライアントとの関係性
3. 次にすべき提案内容

【提案】
- 誰にメールすべきか（相手のメール）
- どんな内容のメールを送るべきか（簡潔に）
- 理由は何か

結果を以下のフォーマットで出力してください：
---
📧 提案: [メールアドレス]
📝 内容: [簡潔な提案内容（30字以内）]
💡 理由: [理由（50字以内）]
---
"""
        
        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=500,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            
            suggestion = message.content[0].text.strip()
            return suggestion
        
        except Exception as e:
            print(f"❌ Claude 分析エラー: {e}")
            return "分析失敗"
