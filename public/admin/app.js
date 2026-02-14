// State management
const state = {
    token: localStorage.getItem('adminToken'),
    currentTab: 'dashboard',
    models: [],
    keys: [],
    settings: {},
    dashboard: {}
};

// API helper
async function apiRequest(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }

    const response = await fetch(endpoint, {
        ...options,
        headers
    });

    if (response.status === 401) {
        logout();
        throw new Error('Unauthorized');
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }

    return data;
}

// Alert helpers
function showAlert(elementId, message, type = 'success') {
    const alert = document.getElementById(elementId);
    alert.textContent = message;
    alert.className = `alert alert-${type} active`;
    setTimeout(() => {
        alert.classList.remove('active');
    }, 5000);
}

function hideAlert(elementId) {
    const alert = document.getElementById(elementId);
    alert.classList.remove('active');
}

// Auth functions
async function login(password) {
    const loginBtn = document.getElementById('loginBtnText');
    const loginLoading = document.getElementById('loginBtnLoading');

    try {
        loginBtn.classList.add('hidden');
        loginLoading.classList.remove('hidden');
        hideAlert('loginAlert');

        const data = await apiRequest('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ password })
        });

        state.token = data.token;
        localStorage.setItem('adminToken', data.token);

        showMainApp();
        loadDashboard();
    } catch (error) {
        showAlert('loginAlert', error.message, 'error');
    } finally {
        loginBtn.classList.remove('hidden');
        loginLoading.classList.add('hidden');
    }
}

function logout() {
    state.token = null;
    localStorage.removeItem('adminToken');
    showLoginPage();
}

function showLoginPage() {
    document.getElementById('loginPage').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
}

function showMainApp() {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
}

// Tab navigation
function switchTab(tabName) {
    // Update nav buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');

    state.currentTab = tabName;

    // Load tab data
    switch (tabName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'models':
            loadModels();
            break;
        case 'keys':
            loadKeys();
            break;
        case 'settings':
            loadSettings();
            break;
    }
}

// Dashboard functions
async function loadDashboard() {
    try {
        const data = await apiRequest('/api/admin/dashboard');
        state.dashboard = data;
        renderDashboard();
    } catch (error) {
        console.error('Failed to load dashboard:', error);
    }
}

function renderDashboard() {
    const data = state.dashboard;

    // Render stats cards
    const statsGrid = document.getElementById('statsGrid');
    statsGrid.innerHTML = `
        <div class="stat-card">
            <h3>Total API Keys</h3>
            <div class="value">${data.totalKeys || 0}</div>
        </div>
        <div class="stat-card">
            <h3>Active Keys</h3>
            <div class="value">${data.activeKeys || 0}</div>
        </div>
        <div class="stat-card">
            <h3>Total Models</h3>
            <div class="value">${data.totalModels || 0}</div>
        </div>
        <div class="stat-card">
            <h3>Total Requests</h3>
            <div class="value">${data.totalRequests || 0}</div>
        </div>
        <div class="stat-card">
            <h3>Total Revenue</h3>
            <div class="value">$${(data.totalRevenue || 0).toFixed(2)}</div>
        </div>
    `;

    // Render recent usage table
    const usageTable = document.getElementById('recentUsageTable');
    const recentUsage = data.recentUsage || [];
    if (recentUsage.length === 0) {
        usageTable.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                    No usage data available
                </td>
            </tr>
        `;
    } else {
        usageTable.innerHTML = recentUsage.map(row => `
            <tr>
                <td>${row.date}</td>
                <td>${row.requests}</td>
                <td>${row.tokens.toLocaleString()}</td>
                <td>-</td>
                <td>$${row.cost.toFixed(4)}</td>
            </tr>
        `).join('');
    }
}

// Models functions
async function loadModels() {
    try {
        const data = await apiRequest('/api/admin/models/list');
        state.models = Array.isArray(data) ? data : (data.models || []);
        renderModels();
    } catch (error) {
        showAlert('modelsAlert', 'Failed to load models: ' + error.message, 'error');
    }
}

function renderModels() {
    const table = document.getElementById('modelsTable');

    if (state.models.length === 0) {
        table.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                    No models configured. Click "Add Model" to get started.
                </td>
            </tr>
        `;
        return;
    }

    table.innerHTML = state.models.map(model => `
        <tr>
            <td><strong>${model.displayName}</strong></td>
            <td>${model.actualModel}</td>
            <td><span class="badge badge-${model.apiFormat === 'openai' ? 'success' : 'danger'}">${model.apiFormat}</span></td>
            <td>$${model.inputPrice.toFixed(2)}</td>
            <td>$${model.outputPrice.toFixed(2)}</td>
            <td>
                <span class="badge badge-${model.enabled ? 'success' : 'danger'}">
                    ${model.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </td>
            <td>
                <div class="actions">
                    <button class="btn btn-sm btn-secondary" onclick="editModel('${model.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteModel('${model.id}', '${model.displayName}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openModelModal(model = null) {
    const modal = document.getElementById('modelModal');
    const title = document.getElementById('modelModalTitle');
    const form = document.getElementById('modelForm');

    if (model) {
        title.textContent = 'Edit Model';
        document.getElementById('modelId').value = model.id;
        document.getElementById('displayName').value = model.displayName;
        document.getElementById('actualModel').value = model.actualModel;
        document.getElementById('apiUrl').value = model.apiUrl;
        document.getElementById('apiKey').value = model.apiKey;
        document.getElementById('apiFormat').value = model.apiFormat;
        document.getElementById('inputPrice').value = model.inputPrice;
        document.getElementById('outputPrice').value = model.outputPrice;
        document.getElementById('systemPrompt').value = model.systemPrompt || '';
        document.getElementById('disableSystem').checked = model.disableSystem || false;
        document.getElementById('enabled').checked = model.enabled;
    } else {
        title.textContent = 'Add Model';
        form.reset();
        document.getElementById('modelId').value = '';
        document.getElementById('enabled').checked = true;
    }

    modal.classList.add('active');
}

function closeModelModal() {
    document.getElementById('modelModal').classList.remove('active');
    document.getElementById('modelForm').reset();
}

function editModel(id) {
    const model = state.models.find(m => m.id === id);
    if (model) {
        openModelModal(model);
    }
}

async function deleteModel(id, name) {
    if (!confirm(`Are you sure you want to delete model "${name}"?`)) {
        return;
    }

    try {
        await apiRequest('/api/admin/models/delete', {
            method: 'DELETE',
            body: JSON.stringify({ id })
        });
        showAlert('modelsAlert', 'Model deleted successfully', 'success');
        loadModels();
    } catch (error) {
        showAlert('modelsAlert', 'Failed to delete model: ' + error.message, 'error');
    }
}

async function saveModel(formData) {
    const modelBtn = document.getElementById('modelBtnText');
    const modelLoading = document.getElementById('modelBtnLoading');

    try {
        modelBtn.classList.add('hidden');
        modelLoading.classList.remove('hidden');

        const id = formData.get('id');
        const endpoint = id ? '/api/admin/models/update' : '/api/admin/models/create';

        const payload = {
            displayName: formData.get('displayName'),
            actualModel: formData.get('actualModel'),
            apiUrl: formData.get('apiUrl'),
            apiKey: formData.get('apiKey'),
            apiFormat: formData.get('apiFormat'),
            inputPrice: parseFloat(formData.get('inputPrice')),
            outputPrice: parseFloat(formData.get('outputPrice')),
            systemPrompt: formData.get('systemPrompt') || null,
            disableSystem: formData.get('disableSystem') === 'on',
            enabled: formData.get('enabled') === 'on'
        };

        if (id) {
            payload.id = id;
        }

        await apiRequest(endpoint, {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify(payload)
        });

        showAlert('modelsAlert', `Model ${id ? 'updated' : 'created'} successfully`, 'success');
        closeModelModal();
        loadModels();
    } catch (error) {
        showAlert('modelsAlert', `Failed to save model: ${error.message}`, 'error');
    } finally {
        modelBtn.classList.remove('hidden');
        modelLoading.classList.add('hidden');
    }
}

// API Keys functions
async function loadKeys() {
    try {
        const data = await apiRequest('/api/admin/keys/list');
        state.keys = Array.isArray(data) ? data : (data.keys || []);
        renderKeys();
    } catch (error) {
        showAlert('keysAlert', 'Failed to load API keys: ' + error.message, 'error');
    }
}

function renderKeys() {
    const table = document.getElementById('keysTable');

    if (state.keys.length === 0) {
        table.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--text-secondary);">
                    No API keys created. Click "Create Key" to get started.
                </td>
            </tr>
        `;
        return;
    }

    table.innerHTML = state.keys.map(key => `
        <tr>
            <td><strong>${key.name}</strong></td>
            <td><code>${key.key}</code></td>
            <td>$${key.balance.toFixed(2)}</td>
            <td>$${key.totalSpent.toFixed(2)}</td>
            <td>
                <span class="badge badge-${key.enabled ? 'success' : 'danger'}">
                    ${key.enabled ? 'Active' : 'Disabled'}
                </span>
            </td>
            <td>
                <div class="actions">
                    <button class="btn btn-sm btn-success" onclick="addBalance('${key.id}', '${key.name}')">Add Balance</button>
                    <button class="btn btn-sm btn-secondary" onclick="setBalance('${key.id}', '${key.name}')">Set Balance</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteKey('${key.id}', '${key.name}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function maskKey(key) {
    if (key.length <= 8) return key;
    return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function openCreateKeyModal() {
    document.getElementById('createKeyModal').classList.add('active');
}

function closeCreateKeyModal() {
    document.getElementById('createKeyModal').classList.remove('active');
    document.getElementById('createKeyForm').reset();
}

async function createKey(formData) {
    const createKeyBtn = document.getElementById('createKeyBtnText');
    const createKeyLoading = document.getElementById('createKeyBtnLoading');

    try {
        createKeyBtn.classList.add('hidden');
        createKeyLoading.classList.remove('hidden');

        const data = await apiRequest('/api/admin/keys/create', {
            method: 'POST',
            body: JSON.stringify({
                name: formData.get('name'),
                balance: parseFloat(formData.get('balance'))
            })
        });

        closeCreateKeyModal();
        showNewKey(data.key);
        loadKeys();
    } catch (error) {
        showAlert('keysAlert', 'Failed to create key: ' + error.message, 'error');
    } finally {
        createKeyBtn.classList.remove('hidden');
        createKeyLoading.classList.add('hidden');
    }
}

function showNewKey(key) {
    document.getElementById('newKeyValue').value = key;
    document.getElementById('showKeyModal').classList.add('active');
}

function closeShowKeyModal() {
    document.getElementById('showKeyModal').classList.remove('active');
}

function copyKey() {
    const input = document.getElementById('newKeyValue');
    input.select();
    document.execCommand('copy');
    showAlert('keysAlert', 'API key copied to clipboard', 'success');
}

async function addBalance(id, name) {
    const amount = prompt(`Enter amount to add to "${name}" balance ($):`);
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
        return;
    }

    try {
        await apiRequest('/api/admin/keys/add-balance', {
            method: 'POST',
            body: JSON.stringify({
                id,
                amount: parseFloat(amount)
            })
        });
        showAlert('keysAlert', 'Balance added successfully', 'success');
        loadKeys();
    } catch (error) {
        showAlert('keysAlert', 'Failed to add balance: ' + error.message, 'error');
    }
}

async function setBalance(id, name) {
    const amount = prompt(`Enter new balance for "${name}" ($):`);
    if (!amount || isNaN(amount) || parseFloat(amount) < 0) {
        return;
    }

    try {
        await apiRequest('/api/admin/keys/set-balance', {
            method: 'POST',
            body: JSON.stringify({
                id,
                balance: parseFloat(amount)
            })
        });
        showAlert('keysAlert', 'Balance updated successfully', 'success');
        loadKeys();
    } catch (error) {
        showAlert('keysAlert', 'Failed to set balance: ' + error.message, 'error');
    }
}

async function deleteKey(id, name) {
    if (!confirm(`Are you sure you want to delete API key "${name}"?`)) {
        return;
    }

    try {
        await apiRequest('/api/admin/keys/delete', {
            method: 'DELETE',
            body: JSON.stringify({ id })
        });
        showAlert('keysAlert', 'API key deleted successfully', 'success');
        loadKeys();
    } catch (error) {
        showAlert('keysAlert', 'Failed to delete key: ' + error.message, 'error');
    }
}

// Settings functions
async function loadSettings() {
    try {
        const data = await apiRequest('/api/admin/settings/get');
        state.settings = data;
        renderSettings();
    } catch (error) {
        showAlert('settingsAlert', 'Failed to load settings: ' + error.message, 'error');
    }
}

function renderSettings() {
    document.getElementById('systemPromptEnabled').checked = state.settings.systemPromptEnabled === 'true';
    document.getElementById('globalSystemPrompt').value = state.settings.globalSystemPrompt || '';
}

async function saveSettings(formData) {
    const settingsBtn = document.getElementById('settingsBtnText');
    const settingsLoading = document.getElementById('settingsBtnLoading');

    try {
        settingsBtn.classList.add('hidden');
        settingsLoading.classList.remove('hidden');

        await apiRequest('/api/admin/settings/save', {
            method: 'POST',
            body: JSON.stringify({
                settings: {
                    systemPromptEnabled: formData.get('systemPromptEnabled') === 'on' ? 'true' : 'false',
                    globalSystemPrompt: formData.get('globalSystemPrompt') || ''
                }
            })
        });

        showAlert('settingsAlert', 'Settings saved successfully', 'success');
        loadSettings();
    } catch (error) {
        showAlert('settingsAlert', 'Failed to save settings: ' + error.message, 'error');
    } finally {
        settingsBtn.classList.remove('hidden');
        settingsLoading.classList.add('hidden');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Check auth state
    if (state.token) {
        showMainApp();
        loadDashboard();
    } else {
        showLoginPage();
    }

    // Login form
    document.getElementById('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        login(formData.get('password'));
    });

    // Logout button
    document.getElementById('logoutBtn').addEventListener('click', logout);

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // Models
    document.getElementById('addModelBtn').addEventListener('click', () => {
        openModelModal();
    });

    document.getElementById('modelForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        saveModel(formData);
    });

    // API Keys
    document.getElementById('createKeyBtn').addEventListener('click', openCreateKeyModal);

    document.getElementById('createKeyForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        createKey(formData);
    });

    // Settings
    document.getElementById('settingsForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        saveSettings(formData);
    });

    // Close modals on background click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
});
