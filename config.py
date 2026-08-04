#!/usr/bin/env python3

class Config:
    # LINE API
    LINE_CHANNEL_ACCESS_TOKEN = "sPpOmPlQQw/AsEGWsw5dtbDaiPnZI6cDWmlu7uDwDNhI4HXq//uHLN6QdGR/kjy6bM1KGzVJWA2r+4XxHk/L2mb7pMolM/acOz5bAfCNabQN/+h4TftEbhYzyJ1orhSGkTaIRzwnEXGuJ7FZDqnl2QdB04t89/1O/w1cDnyilFU="
    LINE_CHANNEL_SECRET = "26616fb02cdcf62ca8d11a7f8d4c0891"
    LINE_USER_ID = "Ua2c3a9964055ac92ada1a287dbecb066"
    
    # Claude API
    CLAUDE_API_KEY = "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"
    
    # Database
    DRAFTS_FILE = 'drafts.json'
    EMAILS_LOG_FILE = 'emails_log.json'
    
    # System
    GMAIL_CHECK_INTERVAL = 30
    WEBHOOK_PORT = 5000
    MAX_EMAILS_PER_CHECK = 5