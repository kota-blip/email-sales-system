#!/usr/bin/env python3
"""
Gmail API ハンドラー
メール取得・送信・マーク機能
"""

import base64
import pickle
import os
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.api_core.exceptions import InvalidArgument
import googleapiclient.discovery

SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

class GmailHandler:
    def __init__(self, config):
        self.config = config
        self.service = None
        self.authenticate()
    
    def authenticate(self):
        """Gmail API の認証"""
        creds = None
        
        # token.pickle がある場合は読み込み
        if os.path.exists('token.pickle'):
            with open('token.pickle', 'rb') as token:
                creds = pickle.load(token)
        
        # 認証情報がない場合は新規作成
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    'credentials.json', SCOPES)
                creds = flow.run_local_server(port=0)
            
            # token.pickle に保存
            with open('token.pickle', 'wb') as token:
                pickle.dump(creds, token)
        
        # Gmail API サービス作成
        self.service = googleapiclient.discovery.build('gmail', 'v1', credentials=creds)
        print("✅ Gmail認証成功")
    
    def get_unread_emails(self):
        """未読メールを取得"""
        try:
            results = self.service.users().messages().list(
                userId='me',
                q='is:unread',
                maxResults=5
            ).execute()
            
            messages = results.get('messages', [])
            email_data = {}
            
            for msg in messages:
                msg_id = msg['id']
                msg_data = self.service.users().messages().get(
                    userId='me',
                    id=msg_id,
                    format='full'
                ).execute()
                
                headers = msg_data['payload']['headers']
                subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '(No Subject)')
                from_email = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
                
                # 本文取得
                body = self._get_message_body(msg_data)
                
                email_data[msg_id] = {
                    'from': from_email,
                    'subject': subject,
                    'body': body
                }
            
            return email_data
        
        except Exception as e:
            print(f"❌ メール取得エラー: {e}")
            return {}
    
    def _get_message_body(self, message):
        """メール本文を抽出"""
        try:
            if 'parts' in message['payload']:
                for part in message['payload']['parts']:
                    if part['mimeType'] == 'text/plain':
                        if 'data' in part['body']:
                            return base64.urlsafe_b64decode(part['body']['data']).decode('utf-8')
            else:
                if 'data' in message['payload']['body']:
                    return base64.urlsafe_b64decode(message['payload']['body']['data']).decode('utf-8')
        except Exception as e:
            print(f"⚠️ 本文抽出エラー: {e}")
        
        return "(本文取得失敗)"
    
    def send_email(self, to, subject, body):
        """メールを送信"""
        try:
            message = {
                'raw': base64.urlsafe_b64encode(
                    f"To: {to}\r\nSubject: {subject}\r\n\r\n{body}".encode()
                ).decode()
            }
            
            self.service.users().messages().send(
                userId='me',
                body=message
            ).execute()
            
            print(f"✅ メール送信: {to}")
            return True
        
        except Exception as e:
            print(f"❌ 送信エラー: {e}")
            return False
    
    def mark_as_read(self, msg_id):
        """メールを既読にする"""
        try:
            self.service.users().messages().modify(
                userId='me',
                id=msg_id,
                body={'removeLabelIds': ['UNREAD']}
            ).execute()
        except Exception as e:
            print(f"⚠️ 既読マーク失敗: {e}")

    def search_pdf_attachments(self, query, max_results=20):
        """指定したGmail検索クエリでメールを検索し、PDF添付ファイルを取得する
        （請求書集計システム用）

        Returns: [{'msg_id', 'from', 'subject', 'date', 'attachments': [{'filename', 'data'}]}]
        """
        try:
            results = self.service.users().messages().list(
                userId='me',
                q=query,
                maxResults=max_results
            ).execute()

            messages = results.get('messages', [])
            output = []

            for msg in messages:
                msg_id = msg['id']
                msg_data = self.service.users().messages().get(
                    userId='me',
                    id=msg_id,
                    format='full'
                ).execute()

                headers = msg_data['payload']['headers']
                subject = next((h['value'] for h in headers if h['name'] == 'Subject'), '(No Subject)')
                from_email = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
                date_header = next((h['value'] for h in headers if h['name'] == 'Date'), '')

                attachments = self._extract_pdf_attachments(msg_id, msg_data['payload'])
                if attachments:
                    output.append({
                        'msg_id': msg_id,
                        'from': from_email,
                        'subject': subject,
                        'date': date_header,
                        'attachments': attachments,
                    })

            return output

        except Exception as e:
            print(f"❌ 請求書メール検索エラー: {e}")
            return []

    def _extract_pdf_attachments(self, msg_id, payload):
        """メールのpayloadからPDF添付ファイルのバイナリを再帰的に取得"""
        attachments = []
        stack = list(payload.get('parts', []) or [])

        while stack:
            part = stack.pop()
            if part.get('parts'):
                stack.extend(part['parts'])

            filename = part.get('filename')
            if not filename or not filename.lower().endswith('.pdf'):
                continue

            body = part.get('body', {})
            data = body.get('data')
            attachment_id = body.get('attachmentId')

            try:
                if data:
                    file_data = base64.urlsafe_b64decode(data)
                elif attachment_id:
                    att = self.service.users().messages().attachments().get(
                        userId='me', messageId=msg_id, id=attachment_id
                    ).execute()
                    file_data = base64.urlsafe_b64decode(att['data'])
                else:
                    continue
            except Exception as e:
                print(f"⚠️ 添付ファイル取得失敗 ({filename}): {e}")
                continue

            attachments.append({'filename': filename, 'data': file_data})

        return attachments
