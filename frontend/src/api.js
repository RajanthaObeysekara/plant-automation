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

  // Rooms are the addressable device: one shared environment sensor + one
  // shared mist controller per greenhouse.
  rooms: () => request('/rooms'),
  room: (id) => request(`/rooms/${id}`),
  renameRoom: (id, name) => request(`/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  schedule: (id) => request(`/rooms/${id}/schedule`),
  updateSchedule: (id, data) => request(`/rooms/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  history: (id) => request(`/rooms/${id}/history`),
  command: (id, type) => request(`/rooms/${id}/command`, { method: 'POST', body: JSON.stringify({ type }) }),
  maintenance: (roomId) => request(`/rooms/${roomId}/maintenance`),
  completeMaintenance: (roomId, taskId) => request(`/rooms/${roomId}/maintenance/${taskId}/complete`, { method: 'POST' }),

  // Benches are just named, positioned spots on a room's map — no device of
  // their own.
  benches: () => request('/benches'),
  createBench: (data) => request('/benches', { method: 'POST', body: JSON.stringify(data) }),
  moveBench: (id, data) => request(`/benches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBench: (id) => request(`/benches/${id}`, { method: 'DELETE' }),

  templates: () => request('/templates'),
  updateTemplate: (id, data) => request(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  farms: () => request('/farms'),
  createFarm: (name) => request('/farms', { method: 'POST', body: JSON.stringify({ name }) }),
  createRoom: (farmId, name) => request(`/farms/${farmId}/rooms`, { method: 'POST', body: JSON.stringify({ name }) }),

  // The farm's shared water tank + fertigation rig.
  farmDetail: (id) => request(`/farms/${id}`),
  updateFarmTank: (id, data) => request(`/farms/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  farmHistory: (id) => request(`/farms/${id}/history`),
  farmMaintenance: (id) => request(`/farms/${id}/maintenance`),
  completeFarmMaintenance: (id, taskId) => request(`/farms/${id}/maintenance/${taskId}/complete`, { method: 'POST' }),
  farmCommand: (id, type) => request(`/farms/${id}/command`, { method: 'POST', body: JSON.stringify({ type }) }),

  // Load-cell calibration (tare + known-weight scale factor) for each of
  // the farm's 3 physical tanks.
  tankCalibrations: (farmId) => request(`/farms/${farmId}/calibration`),
  saveTankCalibration: (farmId, tankKey, data) =>
    request(`/farms/${farmId}/calibration/${tankKey}`, { method: 'PUT', body: JSON.stringify(data) }),

  async downloadHistoryCsv(id, filename) {
    const res = await fetch(`/api/rooms/${id}/history.csv`, {
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
