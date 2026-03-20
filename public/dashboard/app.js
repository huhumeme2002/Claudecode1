const state = {
    apiKey: localStorage.getItem('userApiKey'),
    status: null,
    recentPage: 1,
    refreshInterval: null,
};

async function api(endpoint, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (state.apiKey) headers['Authorization'] = `Bearer ${state.apiKey}`;
    const res = await fetch(endpoint, { ...opts, headers, cache: 'no-store' });
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
function fmtMoney(n) { return n.toFixed(n < 1 ? 4 : 2) + ' credits'; }
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
    // Auto-refresh mỗi 2 phút (giảm tải DB)
    if (state.refreshInterval) clearInterval(state.refreshInterval);
    state.refreshInterval = setInterval(() => loadAll(), 120000);
}

async function loadAll() {
    // Load status first (fast, no heavy DB query)
    await loadStatus();
    // Stagger heavy queries to avoid DB connection stampede
    // Each query can saturate the connection pool — spreading them reduces peak load
    setTimeout(loadRecent, 50);
    setTimeout(loadChart, 150);
    setTimeout(loadSummary, 300);
}

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
            <div class="card-icon">💰</div>
            <div class="card-label">Số dư</div>
            <div class="card-value">${balanceHtml}</div>
            <div class="card-sub">${isRate ? 'Budget window hiện tại' : 'Flat balance'}</div>
        </div>
        <div class="card">
            <div class="card-icon">📊</div>
            <div class="card-label">Tổng chi tiêu</div>
            <div class="card-value">${fmtMoney(d.total_spent)}</div>
            <div class="card-sub">Từ trước tới giờ</div>
        </div>
        <div class="card">
            <div class="card-icon">🔢</div>
            <div class="card-label">Tổng Tokens</div>
            <div class="card-value">${fmtTokens(totalTokens)}</div>
            <div class="card-sub">Input: ${fmtTokens(d.total_input_tokens)} / Output: ${fmtTokens(d.total_output_tokens)}</div>
        </div>
        <div class="card">
            <div class="card-icon">⏰</div>
            <div class="card-label">Thời hạn</div>
            <div class="card-value" style="${expiryClass}">${expiryHtml}</div>
            <div class="card-sub">${d.expiry ? new Date(d.expiry).toLocaleDateString('vi-VN') : '—'}</div>
        </div>
    `;
}

function renderPlan(d) {
    const isRate = d.plan_type === 'rate';
    let html = '<div style="padding:24px;">';

    if (isRate) {
        const spent = d.rate_limit_window_spent || 0;
        const total = d.rate_limit_amount;
        const pct = Math.min(100, (spent / total) * 100);
        const resetAt = d.rate_limit_window_resets_at
            ? new Date(d.rate_limit_window_resets_at).toLocaleString('vi-VN')
            : '—';

        let barGradient = 'var(--gradient-1)';
        if (pct > 90) barGradient = 'var(--gradient-2)';
        else if (pct > 70) barGradient = 'var(--gradient-5)';

        html += `
            <div style="margin-bottom:16px;">
                <strong style="font-size:15px;">Rate Plan:</strong>
                <span style="color:var(--accent);font-weight:600;">${fmtMoney(total)} / ${d.rate_limit_interval_hours} giờ</span>
            </div>
            <div style="font-size:13px;color:var(--text-dim);margin-bottom:8px;">
                Đã dùng: <strong>${fmtMoney(spent)}</strong> / ${fmtMoney(total)}
                <span style="color:var(--accent);font-weight:600;">(${pct.toFixed(1)}%)</span>
            </div>
            <div class="progress">
                <div class="progress-fill" style="width:${pct}%;background:${barGradient}"></div>
            </div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:8px;">
                🔄 Reset lúc: <strong>${resetAt}</strong>
            </div>
        `;
    } else {
        html += `
            <div style="font-size:15px;">
                <strong>Flat Balance:</strong>
                <span style="color:var(--accent);font-weight:700;font-size:18px;">${fmtMoney(d.balance ?? 0)}</span>
            </div>
        `;
    }

    html += `
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--text-dim);">
            🔑 Key: <code style="background:rgba(99,102,241,0.1);padding:4px 8px;border-radius:6px;color:var(--accent);font-family:monospace;">${d.key_masked}</code>
        </div>
    `;
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
            <td><strong>${fmtMoney(s.total_cost)}</strong></td>
        </tr>
    `).join('');
    document.getElementById('summaryTotals').innerHTML = `
        <tr>
            <td><strong>Tổng</strong></td>
            <td><strong>${fmt(totals.requests)}</strong></td>
            <td><strong>${fmtTokens(totals.input_tokens)}</strong></td>
            <td><strong>${fmtTokens(totals.output_tokens)}</strong></td>
            <td><strong>${fmtMoney(totals.cost)}</strong></td>
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
            <td><strong>${l.model_display}</strong></td>
            <td>${fmtTokens(l.input_tokens)}</td>
            <td>${fmtTokens(l.output_tokens)}</td>
            <td><strong>${fmtMoney(l.total_cost)}</strong></td>
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

// Tab switching
function switchDashTab(tab) {
    document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.querySelector(`.dash-tab[onclick*="${tab}"]`).classList.add('active');
    if (tab === 'guide-claude') updateGuideKey();
    if (tab === 'guide-openclaw') updateGuideKey();
    if (tab === 'upgrade') renderUpgradeGrid();
}

// Guide copy
function gcopy(btn) {
    var code = btn.parentElement.textContent.replace('Copy','').replace('Đã copy!','').trim();
    var ta = document.createElement('textarea');
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Đã copy!';
    setTimeout(function(){ btn.textContent = 'Copy'; }, 2000);
}

function updateGuideKey() {
    var preview = document.getElementById('guideKeyPreview');
    if (preview && state.apiKey) {
        preview.textContent = state.apiKey.substring(0, 10) + '...';
    }
    // Update code examples with actual API key
    var keySlots = ['guideKeyPython', 'guideKeyNode', 'guideKeyCurl'];
    keySlots.forEach(function(id) {
        var el = document.getElementById(id);
        if (el && state.apiKey) el.textContent = state.apiKey;
    });
}

// Upgrade / Renew
const upgradePlans = [
    { id: 'trial', name: 'Dùng thử', price: 50000, priceLabel: '50.000đ', detail: '20 credit/5h • 1 ngày' },
    { id: 'week', name: 'Gói Tuần', price: 150000, priceLabel: '150.000đ', detail: '50 credit/5h • 7 ngày' },
    { id: 'pro', name: 'Pro', price: 159000, priceLabel: '159.000đ', detail: '20 credit/5h • 1 tháng' },
    { id: 'max5x', name: 'Max 5x', price: 250000, priceLabel: '250.000đ', detail: '50 credit/5h • 1 tháng' },
    { id: 'max20x', name: 'Max 20x', price: 450000, priceLabel: '450.000đ', detail: '100 credit/5h • 1 tháng' },
];

function renderUpgradeGrid() {
    var grid = document.getElementById('upgradeGrid');
    if (!grid) return;
    grid.innerHTML = upgradePlans.map(function(p) {
        return '<div class="upgrade-card" onclick="selectUpgrade(\'' + p.id + '\')">' +
            '<div class="upgrade-card-name">' + p.name + '</div>' +
            '<div class="upgrade-card-price">' + p.priceLabel + '</div>' +
            '<div class="upgrade-card-detail">' + p.detail + '</div>' +
            '<div class="upgrade-card-badge" style="background:rgba(99,102,241,0.1);color:var(--accent);">Chọn gói này</div>' +
            '</div>';
    }).join('');
}

var selectedUpgradePlan = null;

function selectUpgrade(planId) {
    selectedUpgradePlan = upgradePlans.find(function(p) { return p.id === planId; });
    if (!selectedUpgradePlan) return;

    // Highlight selected card
    document.querySelectorAll('.upgrade-card').forEach(function(c) { c.style.borderColor = ''; });
    event.currentTarget.style.borderColor = 'var(--accent)';

    // Show checkout form
    var form = document.getElementById('upgradeForm');
    document.getElementById('upgradePlanName').textContent = selectedUpgradePlan.name;
    document.getElementById('upgradePlanPrice').textContent = selectedUpgradePlan.priceLabel;
    document.getElementById('upgradePlanDetail').textContent = selectedUpgradePlan.detail;
    document.getElementById('upgradeError').style.display = 'none';
    document.getElementById('upgradeSubmitBtn').textContent = 'Thanh toán ' + selectedUpgradePlan.priceLabel;
    document.getElementById('upgradeSubmitBtn').disabled = false;
    form.style.display = 'block';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitUpgrade() {
    if (!selectedUpgradePlan) return;
    var name = document.getElementById('upgradeName').value.trim();
    var email = document.getElementById('upgradeEmail').value.trim();
    var phone = document.getElementById('upgradePhone').value.trim();
    var errEl = document.getElementById('upgradeError');
    var btn = document.getElementById('upgradeSubmitBtn');

    if (!name) { errEl.style.display = 'block'; errEl.textContent = 'Vui lòng nhập họ tên'; return; }
    if (!email) { errEl.style.display = 'block'; errEl.textContent = 'Vui lòng nhập email'; return; }
    errEl.style.display = 'none';
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Đang xử lý...';

    try {
        var res = await fetch('/checkout/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan_id: selectedUpgradePlan.id, customer_name: name, customer_email: email, customer_phone: phone, existing_api_key: state.apiKey }),
            cache: 'no-store'
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lỗi');

        var form = document.createElement('form');
        form.method = 'POST';
        form.action = data.actionUrl;
        for (var k in data.params) {
            var input = document.createElement('input');
            input.type = 'hidden';
            input.name = k;
            input.value = String(data.params[k]);
            form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
    } catch (e) {
        errEl.style.display = 'block';
        errEl.textContent = e.message || 'Đã xảy ra lỗi';
        btn.disabled = false;
        btn.textContent = origText;
    }
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
