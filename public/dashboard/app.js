const state = {
    apiKey: localStorage.getItem('userApiKey'),
    status: null,
    recentPage: 1,
    refreshInterval: null,
};

async function api(endpoint, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`;
    const res = await fetch(endpoint, { ...opts, headers });
    if (res.status === 401) { logout(); throw new Error('Key không hợp lệ'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi');
    return data;
}

function showAlert(id, msg, type = 'error') {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = `alert alert-${type} active`;
    setTimeout(() => el.classList.remove('active'), 5000);
}

function fmt(n) { return n.toLocaleString('vi-VN'); }
function fmtMoney(n) { return '$' + n.toFixed(n < 1 ? 4 : 2); }
function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return fmt(n);
}

// Auth
async function login() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) return;
    const btn = document.getElementById('loginBtnText');
    const spin = document.getElementById('loginSpinner');
    btn.classList.add('hidden'); spin.classList.remove('hidden');
    try {
        state.apiKey = key;
        localStorage.setItem('userApiKey', key);
        await api('/api/user/status');
        showApp();
    } catch (e) {
        state.apiKey = null;
        localStorage.removeItem('userApiKey');
        showAlert('loginAlert', e.message);
    } finally {
        btn.classList.remove('hidden'); spin.classList.add('hidden');
    }
}

function logout() {
    state.apiKey = null;
    localStorage.removeItem('userApiKey');
    if (state.refreshInterval) { clearInterval(state.refreshInterval); state.refreshInterval = null; }
    document.getElementById('loginPage').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
}

function copyKey() {
    if (state.apiKey) {
        navigator.clipboard.writeText(state.apiKey).then(() => {
            showAlert('dashAlert', 'Đã copy API key', 'success');
        });
    }
}

function showApp() {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    loadAll();
    // Auto-refresh mỗi 30 giây
    if (state.refreshInterval) clearInterval(state.refreshInterval);
    state.refreshInterval = setInterval(() => loadAll(), 30000);
}

async function loadAll() {
    await loadStatus();
    loadChart();
    loadSummary();
    loadRecent();
}

// PLACEHOLDER_FUNCTIONS

// Status
async function loadStatus() {
    try {
        const d = await api('/api/user/status');
        state.status = d;
        document.getElementById('headerName').textContent = d.name;
        document.getElementById('headerKey').textContent = d.key_masked;
        renderCards(d);
        renderPlan(d);
    } catch (e) {
        showAlert('dashAlert', 'Không tải được thông tin: ' + e.message);
    }
}

function renderCards(d) {
    const isRate = d.plan_type === 'rate';
    let balanceHtml;
    if (isRate) {
        const rem = d.rate_limit_window_remaining ?? d.rate_limit_amount;
        balanceHtml = `${fmtMoney(rem)} / ${fmtMoney(d.rate_limit_amount)}`;
    } else {
        balanceHtml = fmtMoney(d.balance ?? 0);
    }

    let expiryHtml, expiryClass = '';
    if (!d.expiry) {
        expiryHtml = 'Không giới hạn';
        expiryClass = 'color:var(--text-dim)';
    } else if (d.expired) {
        expiryHtml = 'Đã hết hạn';
        expiryClass = 'color:var(--danger)';
    } else if (d.days_remaining <= 3) {
        expiryHtml = `Còn ${d.days_remaining} ngày`;
        expiryClass = 'color:var(--warning)';
    } else {
        expiryHtml = `Còn ${d.days_remaining} ngày`;
        expiryClass = 'color:var(--success)';
    }

    const totalTokens = (d.total_input_tokens || 0) + (d.total_output_tokens || 0);

    document.getElementById('statsCards').innerHTML = `
        <div class="card">
            <div class="card-label">Số dư</div>
            <div class="card-value">${balanceHtml}</div>
            <div class="card-sub">${isRate ? 'Budget window hiện tại' : 'Flat balance'}</div>
        </div>
        <div class="card">
            <div class="card-label">Tổng chi tiêu</div>
            <div class="card-value">${fmtMoney(d.total_spent)}</div>
            <div class="card-sub">Từ trước tới giờ</div>
        </div>
        <div class="card">
            <div class="card-label">Tổng Tokens</div>
            <div class="card-value">${fmtTokens(totalTokens)}</div>
            <div class="card-sub">Input: ${fmtTokens(d.total_input_tokens)} / Output: ${fmtTokens(d.total_output_tokens)}</div>
        </div>
        <div class="card">
            <div class="card-label">Thời hạn</div>
            <div class="card-value" style="${expiryClass}">${expiryHtml}</div>
            <div class="card-sub">${d.expiry ? new Date(d.expiry).toLocaleDateString('vi-VN') : '—'}</div>
        </div>
    `;
}

function renderPlan(d) {
    const isRate = d.plan_type === 'rate';
    let html = '<div style="padding:20px;">';

    if (isRate) {
        const spent = d.rate_limit_window_spent || 0;
        const total = d.rate_limit_amount;
        const pct = Math.min(100, (spent / total) * 100);
        const resetAt = d.rate_limit_window_resets_at
            ? new Date(d.rate_limit_window_resets_at).toLocaleString('vi-VN')
            : '—';
        const barColor = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--accent)';

        html += `
            <div style="margin-bottom:12px;">
                <strong>Rate Plan:</strong> ${fmtMoney(total)} / ${d.rate_limit_interval_hours} giờ
            </div>
            <div style="font-size:13px;color:var(--text-dim);margin-bottom:4px;">
                Đã dùng: ${fmtMoney(spent)} / ${fmtMoney(total)} (${pct.toFixed(1)}%)
            </div>
            <div class="progress"><div class="progress-fill" style="width:${pct}%;background:${barColor}"></div></div>
            <div style="font-size:12px;color:var(--text-dim);">Reset lúc: ${resetAt}</div>
        `;
    } else {
        html += `<div><strong>Flat Balance:</strong> ${fmtMoney(d.balance ?? 0)}</div>`;
    }

    html += `<div style="margin-top:12px;font-size:13px;color:var(--text-dim);">Key: <code>${d.key_masked}</code></div>`;
    html += '</div>';
    document.getElementById('planSection').innerHTML = `
        <div class="section-header"><h3>Thông tin gói</h3></div>
        ${html}
    `;
}

// Chart
async function loadChart() {
    const days = document.getElementById('chartDays').value;
    try {
        const { chart } = await api(`/api/user/usage/chart?days=${days}`);
        renderChart(chart);
    } catch (e) {
        document.getElementById('chartWrap').innerHTML = '<div class="empty">Không có dữ liệu</div>';
    }
}

function renderChart(data) {
    const wrap = document.getElementById('chartWrap');
    if (!data.length) { wrap.innerHTML = '<div class="empty">Chưa có dữ liệu chi tiêu</div>'; return; }
    const maxCost = Math.max(...data.map(d => d.cost), 0.01);
    const bars = data.map(d => {
        const h = Math.max(4, (d.cost / maxCost) * 150);
        const label = d.date.slice(5); // MM-DD
        return `<div class="chart-bar-col">
            <div class="chart-bar" style="height:${h}px">
                <div class="chart-bar-tip">${d.date}<br>${fmtMoney(d.cost)} · ${d.requests} req</div>
            </div>
            <div class="chart-bar-label">${label}</div>
        </div>`;
    }).join('');
    wrap.innerHTML = `<div class="chart-bars">${bars}</div>`;
}

// Summary
async function loadSummary() {
    const days = document.getElementById('summaryDays').value;
    try {
        const { summary, totals } = await api(`/api/user/usage/summary?days=${days}`);
        renderSummary(summary, totals);
    } catch (e) {
        document.getElementById('summaryTable').innerHTML = '<tr><td colspan="5" class="empty">Lỗi tải dữ liệu</td></tr>';
    }
}

function renderSummary(summary, totals) {
    const tbody = document.getElementById('summaryTable');
    if (!summary.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Chưa có dữ liệu</td></tr>';
        document.getElementById('summaryTotals').innerHTML = '';
        return;
    }
    tbody.innerHTML = summary.map(s => `
        <tr>
            <td><strong>${s.model}</strong></td>
            <td>${fmt(s.total_requests)}</td>
            <td>${fmtTokens(s.total_input_tokens)}</td>
            <td>${fmtTokens(s.total_output_tokens)}</td>
            <td>${fmtMoney(s.total_cost)}</td>
        </tr>
    `).join('');
    document.getElementById('summaryTotals').innerHTML = `
        <tr>
            <td>Tổng</td>
            <td>${fmt(totals.requests)}</td>
            <td>${fmtTokens(totals.input_tokens)}</td>
            <td>${fmtTokens(totals.output_tokens)}</td>
            <td>${fmtMoney(totals.cost)}</td>
        </tr>
    `;
}

// Recent
async function loadRecent(page) {
    if (page) state.recentPage = page;
    try {
        const { logs, pagination } = await api(`/api/user/usage/recent?page=${state.recentPage}&limit=15`);
        renderRecent(logs, pagination);
    } catch (e) {
        document.getElementById('recentTable').innerHTML = '<tr><td colspan="5" class="empty">Lỗi tải dữ liệu</td></tr>';
    }
}

function renderRecent(logs, pg) {
    const tbody = document.getElementById('recentTable');
    if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Chưa có lịch sử</td></tr>';
        document.getElementById('pagination').innerHTML = '';
        return;
    }
    tbody.innerHTML = logs.map(l => `
        <tr>
            <td>${new Date(l.created_at).toLocaleString('vi-VN')}</td>
            <td>${l.model_display}</td>
            <td>${fmtTokens(l.input_tokens)}</td>
            <td>${fmtTokens(l.output_tokens)}</td>
            <td>${fmtMoney(l.total_cost)}</td>
        </tr>
    `).join('');

    // Pagination
    const pagEl = document.getElementById('pagination');
    if (pg.total_pages <= 1) { pagEl.innerHTML = ''; return; }
    let btns = '';
    btns += `<button ${pg.page <= 1 ? 'disabled' : ''} onclick="loadRecent(${pg.page - 1})">‹</button>`;
    const start = Math.max(1, pg.page - 2);
    const end = Math.min(pg.total_pages, pg.page + 2);
    for (let i = start; i <= end; i++) {
        btns += `<button class="${i === pg.page ? 'active' : ''}" onclick="loadRecent(${i})">${i}</button>`;
    }
    btns += `<button ${pg.page >= pg.total_pages ? 'disabled' : ''} onclick="loadRecent(${pg.page + 1})">›</button>`;
    pagEl.innerHTML = btns;
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    if (state.apiKey) {
        showApp();
    }
    document.getElementById('loginForm').addEventListener('submit', e => {
        e.preventDefault();
        login();
    });
});
