import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { api, setToken, clearToken, getToken } from './api';
import Sparkline from './Sparkline';
import Tip from './Tooltip';
import WaterTank from './WaterTank';
import { nextMistWindow, feedForecast, fungicideForecast } from './forecast';

export default function App() {
  const [token, setTok] = useState(getToken());
  if (!token) return <Login onLoggedIn={(t) => { setToken(t); setTok(t); }} />;
  return <Shell onLogout={() => { clearToken(); setTok(null); }} />;
}

function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(email, password);
      onLoggedIn(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1>🌿 Plant Automation</h1>
        <p className="muted">Sign in to manage your farms and units.</p>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        {error && <div className="error">{error}</div>}
        <button disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function isOnline(unit) {
  if (!unit.last_seen_at) return false;
  return Date.now() - new Date(unit.last_seen_at).getTime() < 90 * 1000;
}

function avgReadings(list) {
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  // Filter out null/undefined (no reading yet) *before* coercing to Number —
  // Number(null) is 0, not NaN, so a never-synced unit would otherwise drag
  // the average toward zero instead of being excluded.
  const humidity = list.map((u) => u.humidity).filter((v) => v != null).map(Number);
  const tempC = list.map((u) => u.temp_c).filter((v) => v != null).map(Number);
  if (!humidity.length && !tempC.length) return null;
  return {
    humidity: humidity.length ? avg(humidity) : null,
    tempC: tempC.length ? avg(tempC) : null,
  };
}

function AvgBadge({ units }) {
  const avg = avgReadings(units);
  if (!avg) return null;
  return (
    <Tip text={`Average across ${units.length} unit${units.length === 1 ? '' : 's'} with a live reading`}>
      <span className="avg-badge">
        {avg.humidity != null ? `${avg.humidity.toFixed(0)}%` : '—'} · {avg.tempC != null ? `${avg.tempC.toFixed(0)}°C` : '—'}
      </span>
    </Tip>
  );
}

const ACTIVITY_LABEL = {
  misting: 'Misting now',
  feeding: 'Feeding now',
  fungicide: 'Dosing fungicide',
  filling: 'Filling tank',
  dechlorinating: 'Dechlorinating',
  overflow: 'Overflow — check tank',
  idle: 'Idle',
};
const MIST_CONFIRM_SECONDS = 6;

function ActivityBadge({ activity, compact }) {
  if (activity === 'idle' || !activity) {
    return compact ? null : <span className="badge idle">Idle</span>;
  }
  return (
    <span className={`badge live ${activity}`}>
      <span className="pulse-dot" />
      {ACTIVITY_LABEL[activity]}
    </span>
  );
}

function Shell({ onLogout }) {
  const [view, setView] = useState('units');
  const [farms, setFarms] = useState([]);
  const [units, setUnits] = useState([]);
  const [selection, setSelection] = useState(null); // { type: 'farm'|'room'|'unit', id }
  const [modal, setModal] = useState(null); // { type: 'farm' } | { type: 'room', farmId } | { type: 'unit', roomId }
  const socket = useMemo(() => io('/', { auth: { token: getToken() } }), []);

  const refresh = useCallback(() => {
    api.units().then(setUnits).catch(console.error);
    api.farms().then(setFarms).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!units.length || selection) return;
    setSelection({ type: 'unit', id: units[0].id });
  }, [units, selection]);

  useEffect(() => {
    function onTelemetry(row) {
      setUnits((prev) => prev.map((u) => (u.id === row.unit_id
        ? {
            ...u, humidity: row.humidity, temp_c: row.temp_c, raining: row.raining,
            water_low: row.water_low, water_full: row.water_full, water_overflow: row.water_overflow,
            last_reading_at: row.recorded_at, last_seen_at: row.recorded_at,
          }
        : u)));
    }
    function onStatus(row) {
      setUnits((prev) => prev.map((u) => (u.id === row.unitId ? { ...u, activity: row.activity } : u)));
    }
    socket.on('telemetry', onTelemetry);
    socket.on('status', onStatus);
    units.forEach((u) => socket.emit('subscribe', u.id));
    return () => {
      socket.off('telemetry', onTelemetry);
      socket.off('status', onStatus);
    };
  }, [socket, units.map((u) => u.id).join(',')]);

  const unassigned = units.filter((u) => !u.room_id);
  const selectedUnit = selection?.type === 'unit' ? units.find((u) => u.id === selection.id) : null;
  const selectedFarm = selection?.type === 'farm' ? farms.find((f) => f.id === selection.id) : null;
  const selectedRoom = selection?.type === 'room'
    ? farms.flatMap((f) => f.rooms.map((r) => ({ ...r, farmId: f.id, farmName: f.name }))).find((r) => r.id === selection.id)
    : null;

  return (
    <div className="shell">
      <div className="topnav">
        <div className="brand">🌿 Plant Automation</div>
        <nav>
          <button className={`tab ${view === 'units' ? 'active' : ''}`} onClick={() => setView('units')}>Units</button>
          <button className={`tab ${view === 'templates' ? 'active' : ''}`} onClick={() => setView('templates')}>Variety templates</button>
        </nav>
        <Tip text="Sign out of this session"><button className="ghost" onClick={onLogout}>Sign out</button></Tip>
      </div>

      {view === 'templates' ? (
        <main className="main"><TemplatesPage /></main>
      ) : (
        <div className="units-view">
          <aside className="sidebar">
            <div className="sidebar-head">
              <h2>Farms</h2>
              <Tip text="Add a new farm — a top-level property or site"><button className="ghost small-btn" onClick={() => setModal({ type: 'farm' })}>+ Farm</button></Tip>
            </div>

            {farms.map((farm) => (
              <div className="farm-block" key={farm.id}>
                <div className="farm-name">
                  <span className="row gap center-y">
                    <Tip text={`Show everything under ${farm.name}`}>
                      <button className={`crumb-link ${selection?.type === 'farm' && selection.id === farm.id ? 'active' : ''}`}
                        onClick={() => setSelection({ type: 'farm', id: farm.id })}>🏡 {farm.name}</button>
                    </Tip>
                    <AvgBadge units={units.filter((u) => u.farm_id === farm.id)} />
                  </span>
                  <Tip text={`Add a greenhouse room to ${farm.name}`}>
                    <button className="ghost tiny-btn" onClick={() => setModal({ type: 'room', farmId: farm.id })}>+ Room</button>
                  </Tip>
                </div>
                {farm.rooms.map((room) => (
                  <div className="room-block" key={room.id}>
                    <div className="room-name">
                      <span className="row gap center-y">
                        <Tip text={`Show everything in ${room.name}`}>
                          <button className={`crumb-link ${selection?.type === 'room' && selection.id === room.id ? 'active' : ''}`}
                            onClick={() => setSelection({ type: 'room', id: room.id })}>🏠 {room.name}</button>
                        </Tip>
                        <AvgBadge units={units.filter((u) => u.room_id === room.id)} />
                      </span>
                      <Tip text={`Pair a new unit into ${room.name}`}>
                        <button className="ghost tiny-btn" onClick={() => setModal({ type: 'unit', roomId: room.id })}>+ Unit</button>
                      </Tip>
                    </div>
                    {units.filter((u) => u.room_id === room.id).map((u) => (
                      <UnitListItem key={u.id} unit={u}
                        selected={selection?.type === 'unit' && selection.id === u.id}
                        onClick={() => setSelection({ type: 'unit', id: u.id })} />
                    ))}
                    {room.unitCount === 0 && <p className="muted small indent">No units yet.</p>}
                  </div>
                ))}
                {farm.rooms.length === 0 && (
                  <p className="muted small indent">No rooms yet — add one to start pairing units.</p>
                )}
              </div>
            ))}

            {unassigned.length > 0 && (
              <div className="farm-block">
                <div className="farm-name"><span>📦 Unassigned</span></div>
                {unassigned.map((u) => (
                  <UnitListItem key={u.id} unit={u}
                    selected={selection?.type === 'unit' && selection.id === u.id}
                    onClick={() => setSelection({ type: 'unit', id: u.id })} />
                ))}
              </div>
            )}

            {farms.length === 0 && <p className="muted small">Add a farm to get started.</p>}
          </aside>

          <main className="main">
            {selectedUnit && (
              <UnitDetail key={selectedUnit.id} unit={selectedUnit} socket={socket} onChanged={refresh} />
            )}
            {selectedFarm && (
              <FarmOverview farm={selectedFarm} units={units.filter((u) => u.farm_id === selectedFarm.id)}
                onSelectRoom={(id) => setSelection({ type: 'room', id })}
                onSelectUnit={(id) => setSelection({ type: 'unit', id })} />
            )}
            {selectedRoom && (
              <RoomOverview room={selectedRoom} units={units.filter((u) => u.room_id === selectedRoom.id)}
                onSelectUnit={(id) => setSelection({ type: 'unit', id })} />
            )}
            {!selectedUnit && !selectedFarm && !selectedRoom && (
              <p className="muted">Select a farm, room, or unit to get started.</p>
            )}
          </main>
        </div>
      )}

      {modal?.type === 'farm' && (
        <SimpleModal title="Add a farm" placeholder="Kadawatha Farm" onClose={() => setModal(null)}
          onSubmit={async (name) => { await api.createFarm(name); refresh(); setModal(null); }} />
      )}
      {modal?.type === 'room' && (
        <SimpleModal title="Add a greenhouse room" placeholder="Greenhouse Room 2" onClose={() => setModal(null)}
          onSubmit={async (name) => { await api.createRoom(modal.farmId, name); refresh(); setModal(null); }} />
      )}
      {modal?.type === 'unit' && (
        <AddUnitModal roomId={modal.roomId} onClose={() => setModal(null)}
          onCreated={() => { setModal(null); refresh(); }} />
      )}
    </div>
  );
}

function UnitListItem({ unit, selected, onClick }) {
  return (
    <button className={`unit-list-item ${selected ? 'active' : ''}`} onClick={onClick}>
      <span className={`dot ${isOnline(unit) ? 'online' : 'offline'}`} />
      <span className="unit-name">{unit.name}</span>
      <ActivityBadge activity={unit.activity} compact />
    </button>
  );
}

function UnitSummaryCard({ unit, subtitle, onClick }) {
  const online = isOnline(unit);
  return (
    <button className="card unit-summary-card" onClick={onClick}>
      <div className="row wrap gap" style={{ justifyContent: 'space-between' }}>
        <span className="unit-summary-name">{unit.name}</span>
        <span className={`dot ${online ? 'online' : 'offline'}`} />
      </div>
      {subtitle && <div className="muted small">{subtitle}</div>}
      <div className="row gap wrap" style={{ marginTop: 8 }}>
        <span className="muted small">{unit.humidity != null ? `${unit.humidity}% RH` : '— RH'}</span>
        <span className="muted small">{unit.temp_c != null ? `${unit.temp_c}°C` : '—°C'}</span>
      </div>
      <div style={{ marginTop: 6 }}><ActivityBadge activity={unit.activity} /></div>
    </button>
  );
}

function FleetStats({ units }) {
  const online = units.filter(isOnline).length;
  const active = units.filter((u) => u.activity && u.activity !== 'idle').length;
  return (
    <section className="stat-row">
      <div className="card stat"><div className="muted small">Units</div><div className="stat-value">{units.length}</div></div>
      <div className="card stat"><div className="muted small">Online</div><div className="stat-value">{online}/{units.length}</div></div>
      <div className="card stat"><div className="muted small">Active right now</div><div className="stat-value">{active}</div></div>
    </section>
  );
}

function FarmOverview({ farm, units, onSelectRoom, onSelectUnit }) {
  return (
    <div className="unit-detail">
      <header className="unit-header">
        <div>
          <div className="crumb muted small">Farm</div>
          <h2>🏡 {farm.name}</h2>
        </div>
      </header>
      <FleetStats units={units} />
      {farm.rooms.length === 0 && <p className="muted">No rooms yet in this farm.</p>}
      {farm.rooms.map((room) => (
        <div className="card" key={room.id} style={{ marginBottom: 14 }}>
          <div className="row wrap gap" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <Tip text={`Open ${room.name}`}>
              <button className="crumb-link" onClick={() => onSelectRoom(room.id)}>🏠 {room.name}</button>
            </Tip>
            <span className="muted small">{room.unitCount} unit{room.unitCount === 1 ? '' : 's'}</span>
          </div>
          <div className="summary-grid">
            {units.filter((u) => u.room_id === room.id).map((u) => (
              <UnitSummaryCard key={u.id} unit={u} onClick={() => onSelectUnit(u.id)} />
            ))}
            {units.filter((u) => u.room_id === room.id).length === 0 && (
              <p className="muted small">No units paired into this room yet.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RoomOverview({ room, units, onSelectUnit }) {
  return (
    <div className="unit-detail">
      <header className="unit-header">
        <div>
          <div className="crumb muted small">{room.farmName} › Room</div>
          <h2>🏠 {room.name}</h2>
        </div>
      </header>
      <FleetStats units={units} />
      <div className="summary-grid">
        {units.map((u) => (
          <UnitSummaryCard key={u.id} unit={u} subtitle={u.bench} onClick={() => onSelectUnit(u.id)} />
        ))}
      </div>
      {units.length === 0 && <p className="muted">No units paired into this room yet.</p>}
    </div>
  );
}

function SimpleModal({ title, placeholder, onClose, onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try { await onSubmit(value); } catch (err) { setError(err.message); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{title}</h3>
        <label>Name</label>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} required autoFocus />
        {error && <div className="error">{error}</div>}
        <div className="row gap"><button type="button" className="ghost" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </form>
    </div>
  );
}

function AddUnitModal({ roomId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [bench, setBench] = useState('');
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { api.templates().then(setTemplates).catch(console.error); }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      const unit = await api.createUnit({ name, bench, roomId, templateId: templateId || undefined });
      setCreated(unit);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <>
            <h3>Unit paired</h3>
            <p className="muted">Give this device key to the ESP32 (or a device-simulator container). It won't be shown again.</p>
            <code className="device-key">{created.deviceKey}</code>
            <button onClick={() => onCreated()}>Done</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h3>Pair a new unit</h3>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Kadawatha Bench 2" autoFocus />
            <label>Bench label <span className="muted">(optional, within the room)</span></label>
            <input value={bench} onChange={(e) => setBench(e.target.value)} placeholder="Bench B" />
            <label>Starting variety template</label>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Default</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {error && <div className="error">{error}</div>}
            <div className="row gap">
              <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              <button type="submit">Pair unit</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function TemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [savingId, setSavingId] = useState(null);
  const [savedId, setSavedId] = useState(null);

  const load = useCallback(() => { api.templates().then(setTemplates).catch(console.error); }, []);
  useEffect(load, [load]);

  async function save(t) {
    setSavingId(t.id);
    try {
      await api.updateTemplate(t.id, t);
      setSavedId(t.id);
      setTimeout(() => setSavedId(null), 1200);
    } finally {
      setSavingId(null);
    }
  }

  function patch(id, field, value) {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  return (
    <div>
      <h2>Variety templates</h2>
      <p className="muted">
        Defaults applied when pairing a new unit. Editing a template does not change units already using it —
        re-apply the template from a unit's schedule panel if you want it to pick up the new numbers.
      </p>
      <div className="template-grid">
        {templates.map((t) => (
          <div className="card template-card" key={t.id}>
            <h3>{t.name}</h3>
            <Tip text="Mist automatically when ambient humidity drops below this">
              <label>Humidity trigger (%)</label>
            </Tip>
            <input type="number" value={t.humidity_below} onChange={(e) => patch(t.id, 'humidity_below', Number(e.target.value))} />
            <Tip text="Mist automatically when canopy temperature rises above this">
              <label>Temperature trigger (°C)</label>
            </Tip>
            <input type="number" value={t.temp_above} onChange={(e) => patch(t.id, 'temp_above', Number(e.target.value))} />
            <div className="row gap">
              <div>
                <Tip text="Daily scheduled misting always runs inside this window"><label>AM window start</label></Tip>
                <input type="time" value={t.window_start} onChange={(e) => patch(t.id, 'window_start', e.target.value)} />
              </div>
              <div>
                <label>AM window end</label>
                <input type="time" value={t.window_end} onChange={(e) => patch(t.id, 'window_end', e.target.value)} />
              </div>
            </div>
            <Tip text="Length of the feed rotation — the last week is always a plain-water salt flush"><label>Feed cycle (weeks)</label></Tip>
            <input type="number" value={t.cycle_weeks} onChange={(e) => patch(t.id, 'cycle_weeks', Number(e.target.value))} />
            <Tip text="Fertilizer dose sprayed on a feed day"><label>Feed dose (mL)</label></Tip>
            <input type="number" value={t.dose_ml} onChange={(e) => patch(t.id, 'dose_ml', Number(e.target.value))} />
            <Tip text="Days between fungicide spray reminders"><label>Fungicide interval (days)</label></Tip>
            <input type="number" value={t.fungicide_interval_days} onChange={(e) => patch(t.id, 'fungicide_interval_days', Number(e.target.value))} />

            <div className="field-divider">Products</div>
            <label>Early-phase fertilizer (weeks 1–2)</label>
            <input value={t.feed_product_early || ''} onChange={(e) => patch(t.id, 'feed_product_early', e.target.value)} />
            <label>Late-phase fertilizer (weeks 3–4)</label>
            <input value={t.feed_product_late || ''} onChange={(e) => patch(t.id, 'feed_product_late', e.target.value)} />
            <label>Fungicide</label>
            <input value={t.fungicide_product || ''} onChange={(e) => patch(t.id, 'fungicide_product', e.target.value)} />

            <button disabled={savingId === t.id} onClick={() => save(t)}>
              {savedId === t.id ? 'Saved ✓' : savingId === t.id ? 'Saving…' : 'Save template'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function UnitDetail({ unit, socket, onChanged }) {
  const [history, setHistory] = useState({ telemetry: [], events: [] });
  const [schedule, setSchedule] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [busyCommand, setBusyCommand] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [tick, setTick] = useState(0); // re-render every minute so forecasts stay fresh
  const [mistCountdown, setMistCountdown] = useState(null);
  const mistTimerRef = useRef(null);
  const mistStartingRef = useRef(false); // ref, not state — closes the double-click race a state check can't
  const [maintenance, setMaintenance] = useState([]);
  const [completingTaskId, setCompletingTaskId] = useState(null);

  const loadMaintenance = useCallback(() => {
    api.maintenance(unit.id).then(setMaintenance).catch(console.error);
  }, [unit.id]);

  useEffect(() => {
    api.history(unit.id).then(setHistory).catch(console.error);
    api.schedule(unit.id).then(setSchedule).catch(console.error);
    api.templates().then(setTemplates).catch(console.error);
    loadMaintenance();
  }, [unit.id, loadMaintenance]);

  async function completeTask(taskId) {
    setCompletingTaskId(taskId);
    try {
      await api.completeMaintenance(unit.id, taskId);
      loadMaintenance();
    } catch (err) {
      alert(err.message);
    } finally {
      setCompletingTaskId(null);
    }
  }

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    socket.emit('subscribe', unit.id);
    function onTelemetry(row) {
      if (row.unit_id !== unit.id) return;
      setHistory((h) => ({ ...h, telemetry: [...h.telemetry.slice(-199), row] }));
    }
    function onEvent(row) {
      if (row.unit_id !== unit.id) return;
      setHistory((h) => ({ ...h, events: [...h.events.slice(-199), row] }));
    }
    socket.on('telemetry', onTelemetry);
    socket.on('event', onEvent);
    return () => {
      socket.off('telemetry', onTelemetry);
      socket.off('event', onEvent);
    };
  }, [socket, unit.id]);

  useEffect(() => () => { if (mistTimerRef.current) clearInterval(mistTimerRef.current); }, []);

  function startMistCountdown() {
    if (mistStartingRef.current) return; // already counting down — ignore repeat/mis-clicks
    mistStartingRef.current = true;
    setMistCountdown(MIST_CONFIRM_SECONDS);
    mistTimerRef.current = setInterval(() => {
      setMistCountdown((s) => {
        if (s <= 1) {
          clearInterval(mistTimerRef.current);
          mistTimerRef.current = null;
          fireMistNow();
          return null;
        }
        return s - 1;
      });
    }, 1000);
  }

  function cancelMistCountdown() {
    if (mistTimerRef.current) {
      clearInterval(mistTimerRef.current);
      mistTimerRef.current = null;
    }
    mistStartingRef.current = false;
    setMistCountdown(null);
  }

  async function fireMistNow() {
    mistStartingRef.current = false;
    await sendCommand('mist_now');
  }

  async function sendCommand(type) {
    setBusyCommand(type);
    try {
      await api.command(unit.id, type);
      onChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyCommand(null);
    }
  }

  async function saveSchedule(e) {
    e.preventDefault();
    try {
      const updated = await api.updateSchedule(unit.id, schedule);
      setSchedule(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onChanged();
    } catch (err) {
      alert(err.message);
    }
  }

  const humidityPoints = history.telemetry.map((t) => t.humidity).filter((v) => v != null).map(Number);
  const tempPoints = history.telemetry.map((t) => t.temp_c).filter((v) => v != null).map(Number);
  const totalWaterMl = history.events.filter((e) => e.type === 'mist' || e.type === 'feed')
    .reduce((sum, e) => sum + Number(e.volume_ml || 0), 0);

  const activityFeed = [
    ...history.events.map((e) => ({ kind: 'event', ...e, at: e.occurred_at })),
    ...history.telemetry.map((t) => ({ kind: 'reading', ...t, at: t.recorded_at })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  const mist = schedule ? nextMistWindow(schedule) : null;
  const feed = schedule ? feedForecast(schedule) : null;
  const fungicide = schedule ? fungicideForecast(schedule) : null;
  const online = isOnline(unit);
  const locationLabel = [unit.farm_name, unit.room_name, unit.bench].filter(Boolean).join(' › ');

  return (
    <div className="unit-detail">
      <header className="unit-header">
        <div>
          <div className="crumb muted small">{locationLabel || 'Unassigned'}</div>
          <h2>{unit.name}</h2>
          <div className="row gap wrap">
            <Tip text={online ? 'Synced with the backend in the last 90 seconds' : "Hasn't synced in over 90 seconds — check its Wi-Fi or power"}>
              <span className={`badge ${online ? 'ok' : 'offline'}`}>{online ? 'Online' : 'Offline'}</span>
            </Tip>
            <ActivityBadge activity={unit.activity} />
          </div>
        </div>
        <div className="row gap wrap">
          {mistCountdown != null ? (
            <div className="row gap mist-confirm">
              <span className="badge warn"><span className="pulse-dot" />Starting in {mistCountdown}s…</span>
              <Tip text="Stop this before it actually mists">
                <button className="ghost" onClick={cancelMistCountdown}>Cancel</button>
              </Tip>
            </div>
          ) : (
            <Tip text="Starts a few seconds from now, with a chance to cancel — protects against mis-clicks">
              <button disabled={busyCommand} onClick={startMistCountdown}>💧 Mist now</button>
            </Tip>
          )}
          <Tip text={schedule?.paused ? 'Resume automatic misting and feeding' : 'Pause all automatic misting and feeding until resumed'}>
            <button disabled={busyCommand} className="ghost" onClick={() => sendCommand(schedule?.paused ? 'resume' : 'pause')}>
              {schedule?.paused ? '▶ Resume' : '⏸ Pause'}
            </button>
          </Tip>
          <Tip text="Skip the next scheduled feed step, if one is due today">
            <button disabled={busyCommand} className="ghost" onClick={() => sendCommand('skip_feed')}>Skip today's feed</button>
          </Tip>
          <Tip text="Download the full mist/feed event history as a CSV file">
            <button className="ghost" onClick={() => api.downloadHistoryCsv(unit.id, `${unit.name.replace(/\s+/g, '-')}-events.csv`)}>⬇ Export CSV</button>
          </Tip>
        </div>
      </header>

      {schedule?.paused && (
        <div className="alert warn">⏸ Automation is paused on this unit — it will not mist or feed until resumed.</div>
      )}
      {fungicide?.overdue && (
        <div className="alert crit">🍄 Fungicide spray is overdue by {Math.abs(fungicide.daysLeft)} day(s). This is never automated — spray by hand.</div>
      )}
      {!online && (
        <div className="alert crit">📡 This unit hasn't reported in — it's running on its last-synced schedule until it reconnects.</div>
      )}

      <section className="stat-row">
        <Stat label="Humidity" value={unit.humidity != null ? `${unit.humidity}%` : '—'} tip="Latest canopy-height humidity reading from this unit's sensor">
          <Sparkline points={humidityPoints} min={30} max={95} color="var(--water)" />
        </Stat>
        <Stat label="Temperature" value={unit.temp_c != null ? `${unit.temp_c}°C` : '—'} tip="Latest canopy-height temperature reading">
          <Sparkline points={tempPoints} min={20} max={38} color="var(--fert)" />
        </Stat>
        <Stat label="Rain" value={unit.raining ? 'Raining — locked out' : 'Clear'} tip="While raining, misting is locked out even if thresholds are met" />
        <Stat label="Water used (recent)" value={`${(totalWaterMl / 1000).toFixed(2)} L`} tip="Sum of mist + feed volume across the events currently loaded, estimated from pump flow rate × run time" />
        <Stat label="Water Tank" value="" tip="Live low/full sensor state and dechlorination hold — real sensor data, not a simulated fill percentage">
          <WaterTank waterLow={unit.water_low} waterFull={unit.water_full} activity={unit.activity} />
        </Stat>
      </section>

      <section className="grid-2">
        <div className="card">
          <h3>Schedule</h3>
          {schedule ? (
            <form onSubmit={saveSchedule} className="schedule-form">
              <Tip text="Prefill every field below from one of the 5 variety defaults"><label>Apply template</label></Tip>
              <select onChange={(e) => {
                const t = templates.find((x) => String(x.id) === e.target.value);
                if (!t) return;
                setSchedule((s) => ({
                  ...s,
                  template_id: t.id,
                  humidity_below: t.humidity_below,
                  temp_above: t.temp_above,
                  window_start: t.window_start,
                  window_end: t.window_end,
                  cycle_weeks: t.cycle_weeks,
                  pre_water_wait_minutes: t.pre_water_wait_minutes,
                  dose_ml: t.dose_ml,
                  fungicide_interval_days: t.fungicide_interval_days,
                  feed_product_early: t.feed_product_early,
                  feed_product_late: t.feed_product_late,
                  fungicide_product: t.fungicide_product,
                  fungicide_dose_ml: t.fungicide_dose_ml,
                  fungicide_automated: t.fungicide_automated,
                  feed_mix_ratio_ml_per_l: t.feed_mix_ratio_ml_per_l,
                  feed_batch_water_l: t.feed_batch_water_l,
                  fungicide_mix_ratio_ml_per_l: t.fungicide_mix_ratio_ml_per_l,
                  fungicide_batch_water_l: t.fungicide_batch_water_l,
                }));
              }} defaultValue={schedule.template_id || ''}>
                <option value="">Custom</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>

              <div className="row gap">
                <div>
                  <Tip text="Mist fires if humidity drops below this, any time of day (never at night, never in rain)"><label>Mist if humidity below (%)</label></Tip>
                  <input type="number" value={schedule.humidity_below}
                    onChange={(e) => setSchedule((s) => ({ ...s, humidity_below: Number(e.target.value) }))} />
                </div>
                <div>
                  <Tip text="...or if temperature rises above this"><label>or temperature above (°C)</label></Tip>
                  <input type="number" value={schedule.temp_above}
                    onChange={(e) => setSchedule((s) => ({ ...s, temp_above: Number(e.target.value) }))} />
                </div>
              </div>

              <div className="row gap">
                <div>
                  <Tip text="The unit always mists once inside this window regardless of thresholds"><label>AM window start</label></Tip>
                  <input type="time" value={schedule.window_start}
                    onChange={(e) => setSchedule((s) => ({ ...s, window_start: e.target.value }))} />
                </div>
                <div>
                  <label>AM window end</label>
                  <input type="time" value={schedule.window_end}
                    onChange={(e) => setSchedule((s) => ({ ...s, window_end: e.target.value }))} />
                </div>
              </div>

              <div className="row gap">
                <div>
                  <Tip text="Any date already on this weekday — the rotation repeats from here"><label>Feed rotation start</label></Tip>
                  <input type="date" value={String(schedule.feed_start_date).slice(0, 10)}
                    onChange={(e) => setSchedule((s) => ({ ...s, feed_start_date: e.target.value }))} />
                </div>
                <div>
                  <Tip text="The final week of the cycle is always a plain-water salt flush"><label>Cycle length (weeks)</label></Tip>
                  <input type="number" value={schedule.cycle_weeks}
                    onChange={(e) => setSchedule((s) => ({ ...s, cycle_weeks: Number(e.target.value) }))} />
                </div>
              </div>

              <div className="row gap">
                <div>
                  <Tip text="How often a fungicide reminder is raised — spraying itself is always manual"><label>Fungicide interval (days)</label></Tip>
                  <input type="number" value={schedule.fungicide_interval_days}
                    onChange={(e) => setSchedule((s) => ({ ...s, fungicide_interval_days: Number(e.target.value) }))} />
                </div>
              </div>

              <div className="field-divider">Products in use</div>

              <Tip text="Applied weeks 1–2 of the rotation — root/bloom starter"><label>Early-phase fertilizer</label></Tip>
              <input value={schedule.feed_product_early || ''}
                onChange={(e) => setSchedule((s) => ({ ...s, feed_product_early: e.target.value }))} />

              <Tip text="Applied weeks 3–4 of the rotation — all-purpose"><label>Late-phase fertilizer</label></Tip>
              <input value={schedule.feed_product_late || ''}
                onChange={(e) => setSchedule((s) => ({ ...s, feed_product_late: e.target.value }))} />

              <div className="row gap">
                <div>
                  <Tip text="Concentrate mixed into the feed batch, per liter of water"><label>Fertilizer mix ratio (mL / L)</label></Tip>
                  <input type="number" step="0.1" value={schedule.feed_mix_ratio_ml_per_l ?? 5}
                    onChange={(e) => setSchedule((s) => {
                      const ratio = Number(e.target.value);
                      return { ...s, feed_mix_ratio_ml_per_l: ratio, dose_ml: Math.round(ratio * (s.feed_batch_water_l ?? 50)) };
                    })} />
                </div>
                <div>
                  <Tip text="Water volume the feed batch is mixed into"><label>Feed batch water (L)</label></Tip>
                  <input type="number" step="1" value={schedule.feed_batch_water_l ?? 50}
                    onChange={(e) => setSchedule((s) => {
                      const vol = Number(e.target.value);
                      return { ...s, feed_batch_water_l: vol, dose_ml: Math.round((s.feed_mix_ratio_ml_per_l ?? 5) * vol) };
                    })} />
                </div>
              </div>
              <p className="muted small-note">= {schedule.dose_ml} mL fertilizer concentrate dosed on a feed day</p>

              <div className="row gap">
                <div>
                  <label>Fungicide product</label>
                  <input value={schedule.fungicide_product || ''}
                    onChange={(e) => setSchedule((s) => ({ ...s, fungicide_product: e.target.value }))} />
                </div>
              </div>
              <div className="row gap">
                <div>
                  <Tip text="Concentrate mixed into the fungicide batch, per liter of water"><label>Fungicide mix ratio (mL / L)</label></Tip>
                  <input type="number" step="0.1" value={schedule.fungicide_mix_ratio_ml_per_l ?? 5}
                    onChange={(e) => setSchedule((s) => {
                      const ratio = Number(e.target.value);
                      return { ...s, fungicide_mix_ratio_ml_per_l: ratio, fungicide_dose_ml: Math.round(ratio * (s.fungicide_batch_water_l ?? 50)) };
                    })} />
                </div>
                <div>
                  <Tip text="Water volume the fungicide batch is mixed into"><label>Fungicide batch water (L)</label></Tip>
                  <input type="number" step="1" value={schedule.fungicide_batch_water_l ?? 50}
                    onChange={(e) => setSchedule((s) => {
                      const vol = Number(e.target.value);
                      return { ...s, fungicide_batch_water_l: vol, fungicide_dose_ml: Math.round((s.fungicide_mix_ratio_ml_per_l ?? 5) * vol) };
                    })} />
                </div>
              </div>
              <p className="muted small-note">= {schedule.fungicide_dose_ml || 0} mL fungicide concentrate dosed, if automated below</p>

              <label className="switch-row">
                <input type="checkbox" checked={!!schedule.fungicide_automated}
                  onChange={(e) => setSchedule((s) => ({ ...s, fungicide_automated: e.target.checked }))} />
                <span>Automate fungicide dosing</span>
              </label>
              {schedule.fungicide_automated && (
                <div className="alert warn small-alert">
                  ⚠️ Requires a dedicated 3rd pump/valve line with its own coarse nozzle — never route a wettable powder through the fine fogging manifold, it will clog.
                </div>
              )}

              <div className="field-divider">Water tank</div>

              <label className="switch-row">
                <input type="checkbox" checked={!!schedule.autofill_enabled}
                  onChange={(e) => setSchedule((s) => ({ ...s, autofill_enabled: e.target.checked }))} />
                <Tip text="Requires a low + full water level sensor pair and an inlet valve on the main tank"><span>Auto-fill the main water tank</span></Tip>
              </label>

              <div className="row gap">
                <div>
                  <Tip text="Mains water is chlorinated — the tank stands open and misting is held back this long after every fill, so chlorine can off-gas before it touches the orchids"><label>Dechlorination hold (days)</label></Tip>
                  <input type="number" step="0.5" min="0" value={(schedule.dechlorinate_hours ?? 24) / 24}
                    onChange={(e) => setSchedule((s) => ({ ...s, dechlorinate_hours: Math.round(Number(e.target.value) * 24) }))} />
                </div>
                <div>
                  <Tip text="Actual flow rate of the misting pump — used to estimate water volume used per mist run"><label>Pump flow rate (L/min)</label></Tip>
                  <input type="number" step="0.1" min="0" value={schedule.pump_flow_lpm ?? 4.5}
                    onChange={(e) => setSchedule((s) => ({ ...s, pump_flow_lpm: Number(e.target.value) }))} />
                </div>
              </div>

              <button type="submit">{savedFlash ? 'Saved ✓' : 'Save schedule'}</button>
            </form>
          ) : <p className="muted">Loading…</p>}
        </div>

        <div className="stack">
          <div className="card">
            <h3>Live &amp; upcoming</h3>
            <ul className="upcoming-list">
              <li>
                <span className="upcoming-label">Right now</span>
                <span><ActivityBadge activity={unit.activity} /></span>
              </li>
              {mist && (
                <li>
                  <Tip text="Scheduled daily misting window, regardless of sensor readings"><span className="upcoming-label">Next AM window</span></Tip>
                  <span>{mist.isToday ? 'today' : 'tomorrow'} · {mist.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–{mist.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              )}
              {feed && (
                <li>
                  <Tip text={`Week ${feed.weekNumber} of ${feed.cycleWeeks} in the rotation`}><span className="upcoming-label">Next feed</span></Tip>
                  <span>{feed.isToday ? 'today' : feed.date.toLocaleDateString()} · week {feed.weekNumber}/{feed.cycleWeeks}</span>
                </li>
              )}
              {fungicide && (
                <li>
                  <Tip text={schedule?.fungicide_automated ? 'Dosed automatically via the dedicated 3rd line' : 'Reminder only — always sprayed by hand'}>
                    <span className="upcoming-label">{schedule?.fungicide_automated ? 'Next fungicide dose' : 'Fungicide due'}</span>
                  </Tip>
                  <span className={fungicide.overdue ? 'crit-text' : ''}>
                    {fungicide.overdue ? `overdue ${Math.abs(fungicide.daysLeft)}d` : `in ${fungicide.daysLeft}d`} · {fungicide.dueDate.toLocaleDateString()}
                  </span>
                </li>
              )}
            </ul>
          </div>

          <div className="card">
            <h3>Maintenance</h3>
            <p className="muted small">Manual upkeep tasks — mark them done once you've actually done them.</p>
            <ul className="maintenance-list">
              {maintenance.map((task) => (
                <li key={task.id} className={task.overdue ? 'overdue' : ''}>
                  <div>
                    <div className="task-title">{task.title}</div>
                    <div className="muted small">
                      every {task.recurrence_days}d ·{' '}
                      {task.last_completed_at
                        ? (task.overdue ? `overdue ${Math.abs(task.daysLeft)}d` : `due in ${task.daysLeft}d`)
                        : 'never done — due now'}
                    </div>
                  </div>
                  <Tip text={`Mark "${task.title}" as done today`}>
                    <button className="ghost small-btn" disabled={completingTaskId === task.id}
                      onClick={() => completeTask(task.id)}>
                      {completingTaskId === task.id ? '…' : '✓ Done'}
                    </button>
                  </Tip>
                </li>
              ))}
              {maintenance.length === 0 && <p className="muted small">No maintenance tasks set up for this unit.</p>}
            </ul>
          </div>

          <div className="card">
            <h3>Activity</h3>
            <p className="muted small">Mist/feed events and incoming sensor readings from the node, most recent first.</p>
            <ul className="event-log">
              {activityFeed.slice(0, 40).map((item, i) => (
                item.kind === 'event' ? (
                  <li key={i}>
                    <span className={`event-type ${item.type}`}>{item.type.replace(/_/g, ' ')}</span>
                    <span className="muted small">{new Date(item.at).toLocaleString()}</span>
                    {item.volume_ml && <span className="muted small">{Math.round(item.volume_ml)} mL</span>}
                  </li>
                ) : (
                  <li key={i} className="reading-row">
                    <span className="event-type reading">reading</span>
                    <span className="muted small">{new Date(item.at).toLocaleString()}</span>
                    <span className="muted small">
                      {item.humidity != null ? `${Number(item.humidity).toFixed(1)}%` : '—'} · {item.temp_c != null ? `${Number(item.temp_c).toFixed(1)}°C` : '—'}
                      {item.raining ? ' · rain' : ''}
                    </span>
                  </li>
                )
              ))}
              {activityFeed.length === 0 && <p className="muted small">Nothing yet — waiting on the unit's first sync.</p>}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, children, tip }) {
  const content = (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {children}
    </div>
  );
  return tip ? <Tip text={tip} className="stat-tip">{content}</Tip> : content;
}
