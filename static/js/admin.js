import { setStatus, escapeHtml } from './utils.js';
import { listUsers, createUser, updateUserRole, setUserActive, resetUserPassword, deleteUser } from './api.js';

let currentUserId = null;

function setAdminStatus(message, type = '') {
  const line = document.getElementById('adminStatus');
  if (!line) return;
  line.className = 'status-line' + (type === 'err' ? ' error' : type === 'ok' ? ' ok' : '');
  line.textContent = message;
}

function roleLabel(role) {
  return role === 'admin' ? 'Admin' : role === 'editor' ? 'Editor' : 'Viewer';
}

function renderUsersTable(users) {
  const body = document.getElementById('usersBody');
  if (!body) return;

  if (!users.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No users yet.</div></td></tr>';
    return;
  }

  body.innerHTML = users.map((user) => {
    const isSelf = user.id === currentUserId;
    return `
      <tr data-user-id="${user.id}">
        <td><b>${escapeHtml(user.username)}</b>${isSelf ? ' <span class="mu">(you)</span>' : ''}</td>
        <td>
          <select class="role-select" data-action="role" data-user-id="${user.id}" ${isSelf ? 'disabled title="You can\'t change your own role"' : ''}>
            <option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>Viewer</option>
            <option value="editor" ${user.role === 'editor' ? 'selected' : ''}>Editor</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </td>
        <td>
          <span class="${user.is_active ? 'status-active' : 'status-inactive'}">
            ${user.is_active ? '● Active' : '○ Deactivated'}
          </span>
        </td>
        <td class="mu">${escapeHtml(user.created_at || '—')}</td>
        <td>
          <div class="row-actions">
            <button data-action="reset-password" data-user-id="${user.id}">Reset password</button>
            <button data-action="toggle-active" data-user-id="${user.id}" data-active="${user.is_active ? '0' : '1'}" ${isSelf ? 'disabled title="You can\'t deactivate your own account"' : ''}>
              ${user.is_active ? 'Deactivate' : 'Reactivate'}
            </button>
            <button class="danger" data-action="delete" data-user-id="${user.id}" ${isSelf ? 'disabled title="You can\'t delete your own account"' : ''}>Delete</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

export async function refreshUsersTable() {
  try {
    const users = await listUsers();
    renderUsersTable(users);
  } catch (error) {
    setAdminStatus(`✗ ${error.message}`, 'err');
  }
}

export function initAdminTab(loggedInUserId) {
  currentUserId = loggedInUserId;

  const body = document.getElementById('usersBody');
  const addButton = document.getElementById('btnAddUser');

  body?.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.dataset.action !== 'role') return;
    const userId = Number(target.dataset.userId);
    const role = target.value;
    try {
      const users = await updateUserRole(userId, role);
      renderUsersTable(users);
      setAdminStatus(`✓ Role updated to ${roleLabel(role)}`, 'ok');
    } catch (error) {
      setAdminStatus(`✗ ${error.message}`, 'err');
      refreshUsersTable();
    }
  });

  body?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const userId = Number(button.dataset.userId);
    const action = button.dataset.action;

    if (action === 'toggle-active') {
      const nextActive = button.dataset.active === '1';
      try {
        const users = await setUserActive(userId, nextActive);
        renderUsersTable(users);
        setAdminStatus(`✓ User ${nextActive ? 'reactivated' : 'deactivated'}`, 'ok');
      } catch (error) {
        setAdminStatus(`✗ ${error.message}`, 'err');
      }
      return;
    }

    if (action === 'delete') {
      if (!confirm('Delete this user permanently? This can\'t be undone.')) return;
      try {
        const users = await deleteUser(userId);
        renderUsersTable(users);
        setAdminStatus('✓ User deleted', 'ok');
      } catch (error) {
        setAdminStatus(`✗ ${error.message}`, 'err');
      }
      return;
    }

    if (action === 'reset-password') {
      const newPassword = prompt('Enter a new password for this user (min. 6 characters):');
      if (!newPassword) return;
      try {
        await resetUserPassword(userId, newPassword);
        setAdminStatus('✓ Password reset', 'ok');
      } catch (error) {
        setAdminStatus(`✗ ${error.message}`, 'err');
      }
      return;
    }
  });

  addButton?.addEventListener('click', async () => {
    const nameInput = document.getElementById('newUserName');
    const passwordInput = document.getElementById('newUserPassword');
    const roleSelect = document.getElementById('newUserRole');

    const username = nameInput?.value.trim();
    const password = passwordInput?.value || '';
    const role = roleSelect?.value || 'viewer';

    if (!username || !password) {
      setAdminStatus('Enter a username and password.', 'err');
      return;
    }

    try {
      const users = await createUser(username, password, role);
      renderUsersTable(users);
      setAdminStatus(`✓ ${username} added as ${roleLabel(role)}`, 'ok');
      if (nameInput) nameInput.value = '';
      if (passwordInput) passwordInput.value = '';
    } catch (error) {
      setAdminStatus(`✗ ${error.message}`, 'err');
    }
  });

  refreshUsersTable();
}