function token() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${path} failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  units: () => request('/units'),
  createUnit: (data) => request('/units', { method: 'POST', body: JSON.stringify(data) }),
  moveUnit: (id, data) => request(`/units/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  unit: (id) => request(`/units/${id}`),
  schedule: (id) => request(`/units/${id}/schedule`),
  updateSchedule: (id, data) => request(`/units/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  history: (id) => request(`/units/${id}/history`),
  command: (id, type) => request(`/units/${id}/command`, { method: 'POST', body: JSON.stringify({ type }) }),

  templates: () => request('/templates'),
  updateTemplate: (id, data) => request(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  farms: () => request('/farms'),
  createFarm: (name) => request('/farms', { method: 'POST', body: JSON.stringify({ name }) }),
  createRoom: (farmId, name) => request(`/farms/${farmId}/rooms`, { method: 'POST', body: JSON.stringify({ name }) }),

  maintenance: (unitId) => request(`/units/${unitId}/maintenance`),
  completeMaintenance: (unitId, taskId) => request(`/units/${unitId}/maintenance/${taskId}/complete`, { method: 'POST' }),

  async downloadHistoryCsv(id, filename) {
    const res = await fetch(`/api/units/${id}/history.csv`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!res.ok) throw new Error('export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'events.csv';
    a.click();
    URL.revokeObjectURL(url);
  },
};

export function setToken(t) {
  localStorage.setItem('token', t);
}
export function clearToken() {
  localStorage.removeItem('token');
}
export function getToken() {
  return token();
}
