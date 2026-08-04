#!/usr/bin/env python3
"""
営業進捗管理画面
Flask ベースの Web UI
"""

from flask import Flask, render_template, request, jsonify
import json
import os
from datetime import datetime
from config import Config
from claude_handler import ClaudeHandler

app = Flask(__name__)
config = Config()
claude = ClaudeHandler(config)

# ========== データストレージ ==========

def load_sales_data():
    """営業進捗データを読み込み"""
    if os.path.exists('sales_data.json'):
        with open('sales_data.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        "deals": [],
        "tasks": [],
        "budget": {"total": 0, "allocated": 0}
    }

def save_sales_data(data):
    """営業進捗データを保存"""
    with open('sales_data.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_emails_log():
    """メールログを読み込み"""
    if os.path.exists(config.EMAILS_LOG_FILE):
        with open(config.EMAILS_LOG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

# ========== API エンドポイント ==========

@app.route('/')
def dashboard():
    """メインダッシュボード"""
    return render_template('dashboard.html')

@app.route('/api/sales', methods=['GET'])
def get_sales():
    """営業進捗データを取得"""
    data = load_sales_data()
    return jsonify(data)

@app.route('/api/sales/deal', methods=['POST'])
def add_deal():
    """新しいディールを追加"""
    data = load_sales_data()
    deal = request.json
    deal['id'] = len(data['deals']) + 1
    deal['created_at'] = datetime.now().isoformat()
    deal['status'] = 'prospect'  # prospect, negotiation, closed_won, closed_lost
    data['deals'].append(deal)
    save_sales_data(data)
    return jsonify(deal)

@app.route('/api/sales/deal/<int:deal_id>', methods=['PUT'])
def update_deal(deal_id):
    """ディール更新"""
    data = load_sales_data()
    for deal in data['deals']:
        if deal['id'] == deal_id:
            deal.update(request.json)
            deal['updated_at'] = datetime.now().isoformat()
            save_sales_data(data)
            return jsonify(deal)
    return jsonify({"error": "not found"}), 404

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    """タスク一覧を取得"""
    data = load_sales_data()
    return jsonify(data['tasks'])

@app.route('/api/tasks', methods=['POST'])
def add_task():
    """新しいタスクを追加"""
    data = load_sales_data()
    task = request.json
    task['id'] = len(data['tasks']) + 1
    task['created_at'] = datetime.now().isoformat()
    task['done'] = False
    data['tasks'].append(task)
    save_sales_data(data)
    return jsonify(task)

@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    """タスク更新"""
    data = load_sales_data()
    for task in data['tasks']:
        if task['id'] == task_id:
            task.update(request.json)
            save_sales_data(data)
            return jsonify(task)
    return jsonify({"error": "not found"}), 404

@app.route('/api/budget', methods=['GET'])
def get_budget():
    """予算情報を取得"""
    data = load_sales_data()
    return jsonify(data['budget'])

@app.route('/api/budget', methods=['PUT'])
def update_budget():
    """予算情報を更新"""
    data = load_sales_data()
    data['budget'].update(request.json)
    save_sales_data(data)
    return jsonify(data['budget'])

@app.route('/api/email-suggestion', methods=['GET'])
def get_email_suggestion():
    """過去のメール分析から次に送るべきメール提案を生成"""
    emails = load_emails_log()
    
    if not emails:
        return jsonify({
            "suggestion": "メール履歴がありません。まずメールを送ってください。",
            "type": "info"
        })
    
    # 過去のメールを分析
    suggestion = claude.analyze_past_emails_for_suggestion(emails)
    
    return jsonify({
        "suggestion": suggestion,
        "type": "suggestion"
    })

@app.route('/api/stats', methods=['GET'])
def get_stats():
    """営業統計を計算"""
    data = load_sales_data()
    
    total_deals = len(data['deals'])
    won_deals = len([d for d in data['deals'] if d.get('status') == 'closed_won'])
    negotiating = len([d for d in data['deals'] if d.get('status') == 'negotiation'])
    prospects = len([d for d in data['deals'] if d.get('status') == 'prospect'])
    
    total_value = sum([d.get('value', 0) for d in data['deals']])
    won_value = sum([d.get('value', 0) for d in data['deals'] if d.get('status') == 'closed_won'])
    
    pending_tasks = len([t for t in data['tasks'] if not t.get('done')])
    
    stats = {
        'total_deals': total_deals,
        'won_deals': won_deals,
        'negotiating': negotiating,
        'prospects': prospects,
        'total_value': total_value,
        'won_value': won_value,
        'win_rate': round((won_deals / total_deals * 100) if total_deals > 0 else 0, 1),
        'pending_tasks': pending_tasks,
        'budget_used': data['budget'].get('allocated', 0),
        'budget_total': data['budget'].get('total', 0)
    }
    
    return jsonify(stats)

# ========== テンプレート ==========

def create_html_template():
    """ダッシュボード HTML を作成"""
    html = """
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>営業進捗管理ダッシュボード</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        h1 {
            color: #333;
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .subtitle {
            color: #666;
            font-size: 1.1em;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            border-left: 4px solid #667eea;
        }
        
        .stat-card h3 {
            color: #666;
            font-size: 0.9em;
            text-transform: uppercase;
            margin-bottom: 10px;
        }
        
        .stat-card .value {
            font-size: 2.5em;
            color: #333;
            font-weight: bold;
        }
        
        .stat-card .unit {
            font-size: 0.9em;
            color: #999;
            margin-top: 5px;
        }
        
        .main-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
            margin-bottom: 30px;
        }
        
        @media (max-width: 1024px) {
            .main-grid {
                grid-template-columns: 1fr;
            }
        }
        
        .panel {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        .panel h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        
        .deal-item {
            padding: 15px;
            border-left: 4px solid #667eea;
            margin-bottom: 15px;
            background: #f8f9ff;
            border-radius: 5px;
        }
        
        .deal-item .title {
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }
        
        .deal-item .details {
            font-size: 0.9em;
            color: #666;
        }
        
        .deal-item .status {
            display: inline-block;
            padding: 5px 10px;
            border-radius: 20px;
            font-size: 0.8em;
            margin-top: 10px;
            font-weight: bold;
        }
        
        .status.prospect { background: #e3f2fd; color: #1976d2; }
        .status.negotiation { background: #fff3e0; color: #f57c00; }
        .status.closed_won { background: #e8f5e9; color: #388e3c; }
        .status.closed_lost { background: #ffebee; color: #d32f2f; }
        
        .task-item {
            padding: 15px;
            margin-bottom: 10px;
            background: #f5f5f5;
            border-radius: 5px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .task-item input[type="checkbox"] {
            cursor: pointer;
            width: 20px;
            height: 20px;
        }
        
        .task-item.done {
            opacity: 0.6;
            text-decoration: line-through;
        }
        
        .suggestion-box {
            background: #e8f5e9;
            border-left: 4px solid #4caf50;
            padding: 20px;
            border-radius: 5px;
            margin-top: 20px;
        }
        
        .suggestion-box .title {
            font-weight: bold;
            color: #2e7d32;
            margin-bottom: 10px;
        }
        
        .suggestion-box .content {
            color: #1b5e20;
            line-height: 1.6;
        }
        
        .button {
            background: #667eea;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 1em;
            margin-top: 15px;
        }
        
        .button:hover {
            background: #764ba2;
        }
        
        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
        }
        
        .input-group input,
        .input-group textarea {
            flex: 1;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 5px;
            font-family: inherit;
        }
        
        .progress-bar {
            width: 100%;
            height: 25px;
            background: #e0e0e0;
            border-radius: 10px;
            overflow: hidden;
            margin-top: 10px;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 0.8em;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📊 営業進捗管理ダッシュボード</h1>
            <p class="subtitle">営業パイプライン＆タスク管理＆予算管理</p>
        </header>
        
        <div class="stats-grid" id="statsGrid">
            <!-- 統計情報がここに入ります -->
        </div>
        
        <div class="main-grid">
            <!-- 左カラム：ディール管理 -->
            <div class="panel">
                <h2>💼 営業パイプライン</h2>
                <div id="dealsList"></div>
                <div class="input-group">
                    <input type="text" id="dealName" placeholder="クライアント名">
                    <input type="number" id="dealValue" placeholder="金額">
                </div>
                <button class="button" onclick="addDeal()">+ ディール追加</button>
            </div>
            
            <!-- 右カラム：タスク管理 -->
            <div class="panel">
                <h2>✅ タスク管理</h2>
                <div id="tasksList"></div>
                <div class="input-group">
                    <input type="text" id="taskText" placeholder="タスク内容">
                </div>
                <button class="button" onclick="addTask()">+ タスク追加</button>
                
                <div class="suggestion-box">
                    <div class="title">💡 次に送るべきメール提案</div>
                    <div class="content" id="emailSuggestion">
                        読み込み中...
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 予算管理 -->
        <div class="panel">
            <h2>💰 予算管理</h2>
            <div class="input-group">
                <input type="number" id="budgetTotal" placeholder="予算総額">
                <input type="number" id="budgetAllocated" placeholder="配分済み">
            </div>
            <button class="button" onclick="updateBudget()">予算更新</button>
            <div class="progress-bar">
                <div class="progress-fill" id="budgetProgress" style="width: 0%">0%</div>
            </div>
        </div>
    </div>
    
    <script>
        // 統計情報を読み込み
        async function loadStats() {
            const res = await fetch('/api/stats');
            const stats = await res.json();
            
            const html = `
                <div class="stat-card">
                    <h3>総ディール数</h3>
                    <div class="value">${stats.total_deals}</div>
                </div>
                <div class="stat-card">
                    <h3>成約済み</h3>
                    <div class="value">${stats.won_deals}</div>
                    <div class="unit">勝率: ${stats.win_rate}%</div>
                </div>
                <div class="stat-card">
                    <h3>交渉中</h3>
                    <div class="value">${stats.negotiating}</div>
                </div>
                <div class="stat-card">
                    <h3>見込み客</h3>
                    <div class="value">${stats.prospects}</div>
                </div>
                <div class="stat-card">
                    <h3>成約金額</h3>
                    <div class="value">¥${stats.won_value.toLocaleString()}</div>
                </div>
                <div class="stat-card">
                    <h3>待機中タスク</h3>
                    <div class="value">${stats.pending_tasks}</div>
                </div>
            `;
            document.getElementById('statsGrid').innerHTML = html;
        }
        
        // ディール一覧を読み込み
        async function loadDeals() {
            const res = await fetch('/api/sales');
            const data = await res.json();
            
            let html = '';
            for (const deal of data.deals) {
                html += `
                    <div class="deal-item">
                        <div class="title">${deal.name}</div>
                        <div class="details">
                            金額: ¥${(deal.value || 0).toLocaleString()} | 
                            <span class="status ${deal.status}">${deal.status}</span>
                        </div>
                    </div>
                `;
            }
            document.getElementById('dealsList').innerHTML = html || '<p>ディールがありません</p>';
        }
        
        // ディール追加
        async function addDeal() {
            const name = document.getElementById('dealName').value;
            const value = parseInt(document.getElementById('dealValue').value) || 0;
            
            if (!name) return;
            
            await fetch('/api/sales/deal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, value })
            });
            
            document.getElementById('dealName').value = '';
            document.getElementById('dealValue').value = '';
            
            loadDeals();
            loadStats();
        }
        
        // タスク一覧を読み込み
        async function loadTasks() {
            const res = await fetch('/api/tasks');
            const tasks = await res.json();
            
            let html = '';
            for (const task of tasks) {
                html += `
                    <div class="task-item ${task.done ? 'done' : ''}">
                        <input type="checkbox" ${task.done ? 'checked' : ''} 
                               onchange="updateTask(${task.id}, !${task.done})">
                        <span>${task.title}</span>
                    </div>
                `;
            }
            document.getElementById('tasksList').innerHTML = html || '<p>タスクがありません</p>';
        }
        
        // タスク追加
        async function addTask() {
            const title = document.getElementById('taskText').value;
            if (!title) return;
            
            await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title })
            });
            
            document.getElementById('taskText').value = '';
            loadTasks();
            loadStats();
        }
        
        // タスク更新
        async function updateTask(id, done) {
            await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ done })
            });
            loadTasks();
        }
        
        // 予算更新
        async function updateBudget() {
            const total = parseInt(document.getElementById('budgetTotal').value) || 0;
            const allocated = parseInt(document.getElementById('budgetAllocated').value) || 0;
            
            await fetch('/api/budget', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ total, allocated })
            });
            
            loadStats();
        }
        
        // メール提案を読み込み
        async function loadEmailSuggestion() {
            const res = await fetch('/api/email-suggestion');
            const data = await res.json();
            document.getElementById('emailSuggestion').innerText = data.suggestion;
        }
        
        // 定期的にリロード
        setInterval(() => {
            loadStats();
            loadDeals();
            loadTasks();
            loadEmailSuggestion();
        }, 5000);
        
        // 初期読み込み
        loadStats();
        loadDeals();
        loadTasks();
        loadEmailSuggestion();
    </script>
</body>
</html>
    """
    return html

# テンプレートディレクトリにHTMLを保存
os.makedirs('templates', exist_ok=True)
with open('templates/dashboard.html', 'w', encoding='utf-8') as f:
    f.write(create_html_template())

if __name__ == '__main__':
    print("🚀 営業ダッシュボード起動: http://localhost:5001")
    app.run(host='0.0.0.0', port=5001, debug=False)
