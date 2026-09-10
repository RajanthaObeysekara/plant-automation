import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import { api, setToken, clearToken, getToken } from './api';
import Sparkline from './Sparkline';
import Tip from './Tooltip';
import WaterTank from './WaterTank';
import FarmPipeline from './FarmPipeline';
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
        <p className="muted">Sign in to manage your farms and rooms.</p>
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

function isOnline(entity) {
  if (!entity?.last_seen_at) return false;
  return Date.now() - new Date(entity.last_seen_at).getTime() < 90 * 1000;
}

function dechlorRemaining(farm) {
  if (!farm || farm.tank_activity !== 'dechlorinating' || !farm.tank_filled_at || !farm.dechlorinate_hours) return null;
  const readyAt = new Date(farm.tank_filled_at).getTime() + farm.dechlorinate_hours * 3600000;
  const msLeft = readyAt - Date.now();
  if (msLeft <= 0) return null;
  const h = Math.floor(msLeft / 3600000);
  const m = Math.round((msLeft % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

function timeAgo(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// What a room is actually doing right now, folding in the farm's shared
// fertigation rig when it happens to be servicing this room's feed cycle.
function roomActivity(room, farm) {
  if (room.activity && room.activity !== 'idle') return room.activity;
  if (farm && farm.fert_activity !== 'idle' && farm.fert_activity_room_id === room.id) return farm.fert_activity;
  return 'idle';
}

function avgReadings(list) {
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const humidity = list.map((r) => r.humidity).filter((v) => v != null).map(Number);
  const tempC = list.map((r) => r.temp_c).filter((v) => v != null).map(Number);
  if (!humidity.length && !tempC.length) return null;
  return {
    humidity: humidity.length ? avg(humidity) : null,
    tempC: tempC.length ? avg(tempC) : null,
  };
}

function AvgBadge({ rooms }) {
  const avg = avgReadings(rooms);
  if (!avg) return null;
  return (
    <Tip text={`Average across ${rooms.length} room${rooms.length === 1 ? '' : 's'} with a live reading`}>
      <span className="avg-badge">
        {avg.humidity != null ? `${avg.humidity.toFixed(0)}%` : '—'} · {avg.tempC != null ? `${avg.tempC.toFixed(0)}°C` : '—'}
      </span>
    </Tip>
  );
}

function clampPct(v) {
  return Math.max(2, Math.min(98, v));
}

const ACTIVITY_LABEL = {
  misting: 'Misting now',
  mixing: 'Mixing fertilizer',
  stirring: 'Stirring tank',
  filtering: 'Filtering feed',
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
  const [rooms, setRooms] = useState([]);
  const [benches, setBenches] = useState([]);
  const [selection, setSelection] = useState(null); // { type: 'farm'|'room', id }
  const [modal, setModal] = useState(null); // { type: 'farm' } | { type: 'room', farmId } | { type: 'bench', roomId }
  const socket = useMemo(() => io('/', { auth: { token: getToken() } }), []);

  const refresh = useCallback(() => {
    api.rooms().then(setRooms).catch(console.error);
    api.farms().then(setFarms).catch(console.error);
    api.benches().then(setBenches).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!rooms.length || selection) return;
    setSelection({ type: 'room', id: rooms[0].id });
  }, [rooms, selection]);

  // Sidebar collapse state — farms default open, rooms default closed.
  const [collapsedFarms, setCollapsedFarms] = useState(() => new Set());
  const [expandedRooms, setExpandedRooms] = useState(() => new Set());
  const toggleInSet = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleFarm = toggleInSet(setCollapsedFarms);
  const toggleRoom = toggleInSet(setExpandedRooms);

  useEffect(() => {
    if (!selection) return;
    if (selection.type === 'room') {
      const r = rooms.find((x) => x.id === selection.id);
      if (!r) return;
      setCollapsedFarms((prev) => (prev.has(r.farm_id) ? new Set([...prev].filter((id) => id !== r.farm_id)) : prev));
      setExpandedRooms((prev) => (prev.has(r.id) ? prev : new Set(prev).add(r.id)));
    }
    if (selection.type === 'farm') {
      setCollapsedFarms((prev) => (prev.has(selection.id) ? new Set([...prev].filter((id) => id !== selection.id)) : prev));
    }
  }, [selection, rooms]);

  useEffect(() => {
    function onRoomTelemetry(row) {
      setRooms((prev) => prev.map((r) => (r.id === row.room_id
        ? { ...r, humidity: row.humidity, temp_c: row.temp_c, raining: row.raining, last_reading_at: row.recorded_at, last_seen_at: row.recorded_at }
        : r)));
    }
    function onRoomStatus(row) {
      setRooms((prev) => prev.map((r) => (r.id === row.roomId ? { ...r, activity: row.activity, last_seen_at: new Date().toISOString() } : r)));
    }
    function onFarmTelemetry(row) {
      setFarms((prev) => prev.map((f) => (f.id === row.farm_id
        ? {
            ...f, water_low: row.water_low, water_full: row.water_full, water_overflow: row.water_overflow,
            raw_water_counts: row.raw_water_counts ?? f.raw_water_counts,
            raw_fertilizer_early_counts: row.raw_fertilizer_early_counts ?? f.raw_fertilizer_early_counts,
            raw_fertilizer_late_counts: row.raw_fertilizer_late_counts ?? f.raw_fertilizer_late_counts,
            raw_fungicide_counts: row.raw_fungicide_counts ?? f.raw_fungicide_counts,
            last_seen_at: new Date().toISOString(),
          }
        : f)));
    }
    function onFarmTankStatus(row) {
      setFarms((prev) => prev.map((f) => (f.id === row.farmId ? { ...f, tank_activity: row.activity, last_seen_at: new Date().toISOString() } : f)));
    }
    function onFarmFertStatus(row) {
      setFarms((prev) => prev.map((f) => (f.id === row.farmId
        ? { ...f, fert_activity: row.activity, fert_activity_room_id: row.roomId, fert_activity_source: row.source, last_seen_at: new Date().toISOString() }
        : f)));
    }
    function onBenchPosition({ benchId, posX, posY }) {
      setBenches((prev) => prev.map((b) => (b.id === benchId ? { ...b, pos_x: posX, pos_y: posY } : b)));
    }
    socket.on('room_telemetry', onRoomTelemetry);
    socket.on('room_status', onRoomStatus);
    socket.on('farm_telemetry', onFarmTelemetry);
    socket.on('farm_tank_status', onFarmTankStatus);
    socket.on('farm_fert_status', onFarmFertStatus);
    socket.on('bench_position', onBenchPosition);
    rooms.forEach((r) => socket.emit('subscribe_room', r.id));
    farms.forEach((f) => socket.emit('subscribe_farm', f.id));
    return () => {
      socket.off('room_telemetry', onRoomTelemetry);
      socket.off('room_status', onRoomStatus);
      socket.off('farm_telemetry', onFarmTelemetry);
      socket.off('farm_tank_status', onFarmTankStatus);
      socket.off('farm_fert_status', onFarmFertStatus);
      socket.off('bench_position', onBenchPosition);
    };
  }, [socket, rooms.map((r) => r.id).join(','), farms.map((f) => f.id).join(',')]);

  const selectedRoom = selection?.type === 'room' ? rooms.find((r) => r.id === selection.id) : null;
  const selectedFarm = selection?.type === 'farm' ? farms.find((f) => f.id === selection.id) : null;
  const selectedRoomFarm = selectedRoom ? farms.find((f) => f.id === selectedRoom.farm_id) : null;

  return (
    <div className="shell">
      <div className="topnav">
        <div className="brand">🌿 Plant Automation</div>
        <nav>
          <button className={`tab ${view === 'units' ? 'active' : ''}`} onClick={() => setView('units')}>Farms</button>
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
              <Tip text="Add a new farm — a site with its own shared water tank + fertilizer rig"><button className="ghost small-btn" onClick={() => setModal({ type: 'farm' })}>+ Farm</button></Tip>
            </div>

            {farms.map((farm) => {
              const farmOpen = !collapsedFarms.has(farm.id);
              const farmRooms = rooms.filter((r) => r.farm_id === farm.id);
              return (
                <div className="farm-block" key={farm.id}>
                  <div className="farm-name">
                    <span className="row gap center-y">
                      <button className="chevron-btn" aria-label={farmOpen ? 'Collapse farm' : 'Expand farm'}
                        onClick={() => toggleFarm(farm.id)}>
                        <span className={`chevron ${farmOpen ? 'open' : ''}`}>▸</span>
                      </button>
                      <Tip text={`Show ${farm.name}'s shared tank + fertilizer rig`}>
                        <button className={`crumb-link ${selection?.type === 'farm' && selection.id === farm.id ? 'active' : ''}`}
                          onClick={() => setSelection({ type: 'farm', id: farm.id })}>🏡 {farm.name}</button>
                      </Tip>
                      <AvgBadge rooms={farmRooms} />
                    </span>
                    <Tip text={`Add a greenhouse room to ${farm.name}`}>
                      <button className="ghost tiny-btn" onClick={() => setModal({ type: 'room', farmId: farm.id })}>+ Room</button>
                    </Tip>
                  </div>
                  {farmOpen && farmRooms.map((room) => {
                    const roomOpen = expandedRooms.has(room.id);
                    const roomBenches = benches.filter((b) => b.room_id === room.id);
                    const activity = roomActivity(room, farm);
                    return (
                      <div className="room-block" key={room.id}>
                        <div className="room-name">
                          <span className="row gap center-y">
                            <button className="chevron-btn" aria-label={roomOpen ? 'Collapse room' : 'Expand room'}
                              onClick={() => toggleRoom(room.id)}>
                              <span className={`chevron ${roomOpen ? 'open' : ''}`}>▸</span>
                            </button>
                            <button className={`unit-list-item ${selection?.type === 'room' && selection.id === room.id ? 'active' : ''}`}
                              style={{ padding: '3px 6px' }}
                              onClick={() => setSelection({ type: 'room', id: room.id })}>
                              <span className={`dot ${isOnline(room) ? 'online' : 'offline'}`} />
                              <span className="unit-name">🏠 {room.name}</span>
                              <ActivityBadge activity={activity} compact />
                            </button>
                          </span>
                        </div>
                        {roomOpen && (
                          <div className="bench-list">
                            {roomBenches.map((b) => (
                              <button key={b.id} className="bench-list-item"
                                onClick={() => setSelection({ type: 'room', id: room.id })}>
                                🪴 {b.name}{b.variety ? <span className="muted small"> · {b.variety}</span> : null}
                              </button>
                            ))}
                            <Tip text={`Add a bench to ${room.name}`}>
                              <button className="ghost tiny-btn" onClick={() => setModal({ type: 'bench', roomId: room.id })}>+ Bench</button>
                            </Tip>
                            {roomBenches.length === 0 && <p className="muted small indent">No benches placed yet.</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {farmOpen && farmRooms.length === 0 && (
                    <p className="muted small indent">No rooms yet — add one to start pairing benches.</p>
                  )}
                </div>
              );
            })}

            {farms.length === 0 && <p className="muted small">Add a farm to get started.</p>}
          </aside>

          <main className="main">
            {selectedRoom && (
              <RoomDetail key={selectedRoom.id} room={selectedRoom} farm={selectedRoomFarm}
                benches={benches.filter((b) => b.room_id === selectedRoom.id)} socket={socket}
                onChanged={refresh} onGoToFarm={() => setSelection({ type: 'farm', id: selectedRoom.farm_id })} />
            )}
            {selectedFarm && (
              <FarmDetail key={selectedFarm.id} farm={selectedFarm}
                rooms={rooms.filter((r) => r.farm_id === selectedFarm.id)}
                benches={benches} socket={socket} onChanged={refresh}
                onSelectRoom={(id) => setSelection({ type: 'room', id })} />
            )}
            {!selectedRoom && !selectedFarm && (
              <p className="muted">Select a farm or room to get started.</p>
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
      {modal?.type === 'bench' && (
        <AddBenchModal roomId={modal.roomId} onClose={() => setModal(null)}
          onCreated={() => { setModal(null); refresh(); }} />
      )}
    </div>
  );
}

function SimpleModal({ title, placeholder, onClose, onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(err.message);
    }
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

function AddBenchModal({ roomId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [variety, setVariety] = useState('');
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.createBench({ roomId, name, variety: variety || undefined });
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Add a bench</h3>
        <p className="muted small">Just a named, positioned spot on this room's map — it shares the room's sensor and the farm's tank/fertilizer supply.</p>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Bench 6" autoFocus />
        <label>Variety <span className="muted">(optional)</span></label>
        <input value={variety} onChange={(e) => setVariety(e.target.value)} placeholder="Bangkok Peach" />
        {error && <div className="error">{error}</div>}
        <div className="row gap">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit">Add bench</button>
        </div>
      </form>
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
        Defaults applied when setting up a new room's schedule. Editing a template does not change rooms already
        using it — re-apply the template from a room's schedule panel if you want it to pick up the new numbers.
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

// ---------- Room detail: the room's own sensor + shared misting ----------
function RoomDetail({ room, farm, benches, socket, onChanged, onGoToFarm }) {
  const [history, setHistory] = useState({ telemetry: [], events: [] });
  const [schedule, setSchedule] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [busyCommand, setBusyCommand] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [tick, setTick] = useState(0);
  const [mistCountdown, setMistCountdown] = useState(null);
  const mistTimerRef = useRef(null);
  const mistStartingRef = useRef(false);
  const [maintenance, setMaintenance] = useState([]);
  const [completingTaskId, setCompletingTaskId] = useState(null);
  const [plan, setPlan] = useState(null);

  const loadMaintenance = useCallback(() => {
    api.maintenance(room.id).then(setMaintenance).catch(console.error);
  }, [room.id]);
  const loadPlan = useCallback(() => {
    api.plan(room.id).then(setPlan).catch(console.error);
  }, [room.id]);

  useEffect(() => {
    api.history(room.id).then(setHistory).catch(console.error);
    api.schedule(room.id).then(setSchedule).catch(console.error);
    api.templates().then(setTemplates).catch(console.error);
    loadMaintenance();
    loadPlan();
  }, [room.id, loadMaintenance, loadPlan]);

  async function completeTask(taskId) {
    setCompletingTaskId(taskId);
    try {
      await api.completeMaintenance(room.id, taskId);
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
    socket.emit('subscribe_room', room.id);
    function onTelemetry(row) {
      if (row.room_id !== room.id) return;
      setHistory((h) => ({ ...h, telemetry: [...h.telemetry.slice(-199), row] }));
    }
    function onEvent(row) {
      if (row.room_id !== room.id) return;
      setHistory((h) => ({ ...h, events: [...h.events.slice(-199), row] }));
    }
    socket.on('room_telemetry', onTelemetry);
    socket.on('room_event', onEvent);
    return () => {
      socket.off('room_telemetry', onTelemetry);
      socket.off('room_event', onEvent);
    };
  }, [socket, room.id]);

  useEffect(() => () => { if (mistTimerRef.current) clearInterval(mistTimerRef.current); }, []);

  function startMistCountdown() {
    if (mistStartingRef.current) return;
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
      await api.command(room.id, type);
      if (type === 'pause' || type === 'resume' || type === 'skip_feed') loadPlan();
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
      const updated = await api.updateSchedule(room.id, schedule);
      setSchedule(updated);
      loadPlan(); // schedule_version just bumped server-side — the 7-day plan changed too
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
  const online = isOnline(room);
  const activity = roomActivity(room, farm);
  const beingFedByFarm = farm && farm.fert_activity !== 'idle' && farm.fert_activity_room_id === room.id;
  const tankBlocked = farm && (farm.water_low || farm.tank_activity === 'dechlorinating' || farm.tank_activity === 'filling');
  const overdueMaintenance = maintenance.filter((t) => t.overdue);
  const synced = schedule && schedule.schedule_version === room.synced_schedule_version;

  // One verdict, worst-first — this is meant to answer "does this room need
  // me?" before any card below it does, so only one banner ever shows.
  let verdict;
  if (!online) {
    verdict = { tone: 'crit', title: 'Offline', detail: "Hasn't checked in for over 90 seconds — running on its last-synced schedule until it reconnects." };
  } else if (fungicide?.overdue) {
    verdict = { tone: 'crit', title: 'Needs attention', detail: `Fungicide spray is overdue by ${Math.abs(fungicide.daysLeft)} day(s) — always sprayed by hand, never automated.` };
  } else if (overdueMaintenance.length > 0) {
    verdict = { tone: 'warn', title: 'Needs attention', detail: `${overdueMaintenance.length} overdue maintenance task${overdueMaintenance.length === 1 ? '' : 's'}: ${overdueMaintenance[0].title}${overdueMaintenance.length > 1 ? `, +${overdueMaintenance.length - 1} more` : ''}.` };
  } else if (schedule?.paused) {
    verdict = { tone: 'warn', title: 'Paused', detail: "Automation is paused on this room — it will not mist or feed until resumed." };
  } else if (tankBlocked) {
    verdict = { tone: 'warn', title: 'Tank not ready', detail: `${farm.name}'s shared tank is ${farm.water_low ? 'low' : farm.tank_activity} — misting here may be held back until it clears.` };
  } else {
    const bits = ['Misting on schedule.'];
    if (feed && !feed.isToday) bits.push(`Next feed ${feed.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} (week ${feed.weekNumber}/${feed.cycleWeeks}).`);
    else if (feed?.isToday) bits.push(`Feed due today (week ${feed.weekNumber}/${feed.cycleWeeks}).`);
    if (overdueMaintenance.length === 0 && maintenance.length > 0) bits.push('No overdue maintenance.');
    verdict = { tone: 'good', title: 'Running normally', detail: bits.join(' ') };
  }

  return (
    <div className="unit-detail">
      <div className={`verdict-strip verdict-strip--${verdict.tone}`}>
        <div className="verdict-main">
          <div className="crumb muted small mono">{(farm?.name || 'UNASSIGNED').toUpperCase()} / {room.name.toUpperCase()}</div>
          <div className="verdict-title">
            <span className={`verdict-dot verdict-dot--${verdict.tone}`} />
            <span>{verdict.title}</span>
          </div>
          <div className="verdict-detail">{verdict.detail}</div>
        </div>

        <div className="verdict-sync">
          <div className="row gap" style={{ alignItems: 'center' }}>
            <span className={`verdict-dot verdict-dot--${synced ? 'good' : 'warn'}`} style={{ width: 6, height: 6 }} />
            <span className="mono small" style={{ fontWeight: 500 }}>
              {synced ? `Synced to v${room.synced_schedule_version}` : `Sync pending (v${room.synced_schedule_version ?? '—'} → v${schedule?.schedule_version ?? '—'})`}
            </span>
          </div>
          <div className="muted mono verdict-sync-meta">
            {room.last_config_sync_at ? `CHECK-IN ${timeAgo(room.last_config_sync_at).toUpperCase()}` : 'NEVER SYNCED'}
            {room.last_boot_at && <><br />REBOOT {timeAgo(room.last_boot_at).toUpperCase()}</>}
          </div>
        </div>

        <div className="verdict-actions">
          {mistCountdown != null ? (
            <div className="row gap mist-confirm">
              <span className="badge warn"><span className="pulse-dot" />Starting in {mistCountdown}s…</span>
              <Tip text="Stop this before it actually mists">
                <button className="ghost small-btn" onClick={cancelMistCountdown}>Cancel</button>
              </Tip>
            </div>
          ) : (
            <Tip text="Mists every bench in this room together, a few seconds from now, with a chance to cancel">
              <button disabled={busyCommand} onClick={startMistCountdown}>💧 Mist now</button>
            </Tip>
          )}
          <div className="row gap">
            <Tip text={schedule?.paused ? 'Resume automatic misting and feeding' : 'Pause all automatic misting and feeding until resumed'}>
              <button disabled={busyCommand} className="ghost" style={{ flex: 1 }} onClick={() => sendCommand(schedule?.paused ? 'resume' : 'pause')}>
                {schedule?.paused ? 'Resume' : 'Pause'}
              </button>
            </Tip>
            <Tip text="Skip the next scheduled feed step, if one is due today">
              <button disabled={busyCommand} className="ghost" style={{ flex: 1 }} onClick={() => sendCommand('skip_feed')}>Skip feed</button>
            </Tip>
          </div>
          <Tip text="Download the full mist/feed event history as a CSV file">
            <button className="ghost small-btn" onClick={() => api.downloadHistoryCsv(room.id, `${room.name.replace(/\s+/g, '-')}-events.csv`)}>⬇ Export CSV</button>
          </Tip>
        </div>
      </div>

      <div className="row gap wrap" style={{ margin: '2px 0 14px' }}>
        <ActivityBadge activity={activity} />
        <span className="muted small">{benches.length} bench{benches.length === 1 ? '' : 'es'}</span>
        {beingFedByFarm && (
          <span className="muted small">
            🧪 {farm.name}'s rig is {ACTIVITY_LABEL[farm.fert_activity]?.toLowerCase()} for this room ·{' '}
            <button className="crumb-link" onClick={onGoToFarm}>view rig →</button>
          </span>
        )}
        {tankBlocked && (
          <button className="crumb-link small" onClick={onGoToFarm}>View farm supply →</button>
        )}
      </div>

      <section className="stat-row">
        <Stat label="Humidity" value={room.humidity != null ? `${room.humidity}%` : '—'} tip="Latest reading from this room's single environment sensor — shared by every bench in it">
          <Sparkline points={humidityPoints} min={30} max={95} color="var(--water)" />
        </Stat>
        <Stat label="Temperature" value={room.temp_c != null ? `${room.temp_c}°C` : '—'} tip="Latest temperature reading">
          <Sparkline points={tempPoints} min={20} max={38} color="var(--warn)" />
        </Stat>
        <Stat label="Rain" value={room.raining ? 'Raining — locked out' : 'Clear'} tip="While raining, misting is locked out even if thresholds are met" />
        <Stat label="Water used (recent)" value={`${(totalWaterMl / 1000).toFixed(2)} L`} tip="Sum of mist + feed volume across the events currently loaded, from the farm's shared tank" />
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
                  <Tip text="The room always mists once inside this window regardless of thresholds"><label>AM window start</label></Tip>
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
                  <Tip text="Concentrate mixed into the feed batch, per liter of water — mixed by the farm's shared rig"><label>Fertilizer mix ratio (mL / L)</label></Tip>
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
              <p className="muted small-note">= {schedule.dose_ml} mL fertilizer concentrate dosed on a feed day, via the farm's rig</p>

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
                  ⚠️ Fungicide is injected into the same water line and sprayed through the regular fogging nozzles — flush the line with plain water straight after dosing so wettable-powder residue doesn't sit in the fine nozzles and clog them.
                </div>
              )}

              <button type="submit">{savedFlash ? 'Saved ✓' : 'Save schedule'}</button>
            </form>
          ) : <p className="muted">Loading…</p>}
        </div>

        <div className="stack">
          {farm && (
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3>Shared tank</h3>
                <button className="crumb-link small" onClick={onGoToFarm}>{farm.name} →</button>
              </div>
              <WaterTank
                waterLow={farm.water_low}
                waterFull={farm.water_full}
                activity={farm.tank_activity === 'idle' ? undefined : farm.tank_activity}
                dechlorLeftLabel={dechlorRemaining(farm)}
              />
            </div>
          )}

          <div className="card">
            <h3>Live &amp; upcoming</h3>
            <ul className="upcoming-list">
              <li>
                <span className="upcoming-label">Right now</span>
                <span><ActivityBadge activity={activity} /></span>
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
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3>7-Day Plan</h3>
              <span className="muted small mono">SERVER-COMPUTED{plan ? ` · CACHED ON DEVICE v${plan.scheduleVersion}` : ''}</span>
            </div>
            {plan ? (
              <div className="plan-grid">
                {plan.days.map((d, i) => {
                  const date = new Date(d.date + 'T00:00:00');
                  const isToday = i === 0;
                  const kind = d.isFeedDay ? 'feed' : d.fungicideDue ? 'fungicide' : 'plain';
                  return (
                    <Tip key={d.date} text={
                      d.isFeedDay ? `${d.doseMl} mL feed dose` : d.fungicideDue ? 'Fungicide due — always sprayed by hand' : 'Mist only, threshold-driven'
                    }>
                      <div className={`plan-day plan-day--${kind}`}>
                        <div className="plan-day-label">{isToday ? 'TODAY' : date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()} {date.getDate()}</div>
                        <div className="plan-day-kind">{d.isFeedDay ? 'Feed' : d.fungicideDue ? 'Fungicide' : 'Mist only'}</div>
                        {d.isFeedDay && <div className="plan-day-detail">{d.doseMl} mL</div>}
                        {d.fungicideDue && <div className="plan-day-detail">MANUAL</div>}
                      </div>
                    </Tip>
                  );
                })}
              </div>
            ) : <p className="muted">Loading…</p>}
          </div>

          <div className="card">
            <h3>Maintenance</h3>
            <p className="muted small">This room's own equipment (fogging nozzles) — the farm's shared tank/rig has its own maintenance list on the farm page.</p>
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
              {maintenance.length === 0 && <p className="muted small">No maintenance tasks set up for this room.</p>}
            </ul>
          </div>

          <div className="card">
            <h3>Bench layout</h3>
            <RoomMap benches={benches} height={220} />
          </div>

          <div className="card">
            <h3>Activity</h3>
            <p className="muted small">Mist/feed events and incoming sensor readings, most recent first.</p>
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
              {activityFeed.length === 0 && <p className="muted small">Nothing yet — waiting on the room's first sync.</p>}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------- Farm detail: the one shared water tank + fertigation rig ----------
function commandTone(type) {
  if (type.includes('feed') || type.includes('mix') || type.includes('stir') || type.includes('filter')) return 'feed';
  if (type.includes('fungicide')) return 'fungicide';
  return 'water';
}

function FarmDetail({ farm, rooms, benches, socket, onChanged, onSelectRoom }) {
  const [history, setHistory] = useState({ tank: [], events: [] });
  const [maintenance, setMaintenance] = useState([]);
  const [completingTaskId, setCompletingTaskId] = useState(null);
  const [tankForm, setTankForm] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [viewMode, setViewMode] = useState('map');
  const [calibrations, setCalibrations] = useState([]);
  const [busyValveRoomId, setBusyValveRoomId] = useState(null);
  const [commands, setCommands] = useState([]);

  async function openBranchValve(roomId) {
    setBusyValveRoomId(roomId);
    try {
      await api.command(roomId, 'mist_now');
      onChanged();
      loadCommands();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyValveRoomId(null);
    }
  }

  const loadMaintenance = useCallback(() => {
    api.farmMaintenance(farm.id).then(setMaintenance).catch(console.error);
  }, [farm.id]);
  const loadCalibrations = useCallback(() => {
    api.tankCalibrations(farm.id).then(setCalibrations).catch(console.error);
  }, [farm.id]);
  const loadCommands = useCallback(() => {
    api.farmCommands(farm.id).then(setCommands).catch(console.error);
  }, [farm.id]);

  useEffect(() => {
    api.farmHistory(farm.id).then(setHistory).catch(console.error);
    loadMaintenance();
    loadCalibrations();
    loadCommands();
    setTankForm({
      autofillEnabled: farm.autofill_enabled,
      dechlorinateHours: farm.dechlorinate_hours,
      pumpFlowLpm: farm.pump_flow_lpm,
    });
  }, [farm.id, loadMaintenance, loadCalibrations, loadCommands]);

  useEffect(() => {
    socket.emit('subscribe_farm', farm.id);
    function onTelemetry(row) {
      if (row.farm_id !== farm.id) return;
      setHistory((h) => ({ ...h, tank: [...h.tank.slice(-199), row] }));
    }
    function onEvent(row) {
      if (row.farm_id !== farm.id) return;
      setHistory((h) => ({ ...h, events: [...h.events.slice(-199), row] }));
    }
    socket.on('farm_telemetry', onTelemetry);
    socket.on('farm_event', onEvent);
    return () => {
      socket.off('farm_telemetry', onTelemetry);
      socket.off('farm_event', onEvent);
    };
  }, [socket, farm.id]);

  async function completeTask(taskId) {
    setCompletingTaskId(taskId);
    try {
      await api.completeFarmMaintenance(farm.id, taskId);
      loadMaintenance();
    } catch (err) {
      alert(err.message);
    } finally {
      setCompletingTaskId(null);
    }
  }

  async function saveTankForm(e) {
    e.preventDefault();
    try {
      await api.updateFarmTank(farm.id, tankForm);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onChanged();
    } catch (err) {
      alert(err.message);
    }
  }

  const online = isOnline(farm);
  const online_ = rooms.filter(isOnline).length;

  const activityFeed = [
    ...history.events.map((e) => ({ kind: 'event', ...e, at: e.occurred_at })),
    ...history.tank.map((t) => ({ kind: 'reading', ...t, at: t.recorded_at })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  function scrollToId(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="unit-detail">
      <header className="unit-header">
        <div>
          <div className="crumb muted small mono">Farm</div>
          <h2>🏡 {farm.name}</h2>
          <div className="row gap wrap">
            <Tip text={online ? "The tank controller synced in the last 90 seconds" : "The tank controller hasn't synced in over 90 seconds"}>
              <span className={`badge ${online ? 'ok' : 'offline'}`}>
                {online && <span className="pulse-dot" />}
                {online ? 'Tank rig online' : 'Tank rig offline'}
              </span>
            </Tip>
            <span className="muted small mono">{rooms.length} ROOM{rooms.length === 1 ? '' : 'S'} · {online_}/{rooms.length} ONLINE</span>
          </div>
        </div>
        <div className="row gap">
          <Tip text="Jump to load-cell calibration and manual fill/drain controls for this farm's tanks">
            <button className="ghost" onClick={() => scrollToId('tank-calibration')}>⚖️ Calibrate tanks</button>
          </Tip>
          <Tip text="Recent commands sent to this farm's tank controller and its rooms">
            <button className="ghost" onClick={() => scrollToId('command-history')}>🕘 Command history</button>
          </Tip>
        </div>
      </header>

      <section className="card farm-hero" style={{ marginBottom: 16 }}>
        <div className="row wrap gap" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Water &amp; fertigation — live</h3>
          <span className="muted small mono">EVERY ELEMENT DRIVEN BY REPORTED STATE · GREY = NO DATA</span>
        </div>
        <p className="muted small">
          Tanks, pipes, valves, limit switches and nozzles for this farm, animated from real activity —
          not decorative. Fill levels use your saved calibration where available.
        </p>
        <FarmPipeline farm={farm} rooms={rooms} calibrations={calibrations} />
      </section>

      <section id="command-history" className="card" style={{ marginBottom: 16 }}>
        <h3>Command history</h3>
        <p className="muted small">Every command sent to this farm's tank controller and its rooms — most recent first.</p>
        <ul className="event-log">
          {commands.slice(0, 40).map((c) => (
            <li key={c.id}>
              <span className="muted small mono">{new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className={`event-type event-type--${commandTone(c.type)}`}>{c.type.replace(/_/g, ' ')}</span>
              {c.room_name && <span className="muted small">{c.room_name}</span>}
              <span className="muted small mono command-status">{c.status}{c.status === 'delivered' && c.delivered_at ? ` · ${timeAgo(c.delivered_at)}` : ''}</span>
            </li>
          ))}
          {commands.length === 0 && <p className="muted small">No commands sent yet.</p>}
        </ul>
      </section>

      <section id="tank-calibration" className="card" style={{ marginTop: 16 }}>
        <h3>Tank calibration &amp; manual controls</h3>
        <p className="muted small">
          2-point load-cell calibration for each physical tank — tare it empty, then record the raw
          reading with a known weight on it. "Fill now" / "Drain now" are manual overrides for
          starting a calibration pass from a known state. Not required for the app to run
          (misting/feeding still use the low/full sensors), but this is where those numbers live
          once a scale is wired in.
        </p>
        <div className="calibration-grid">
          {calibrations.map((c) => (
            <TankCalibrationCard key={c.tank_key} calibration={c}
              liveRaw={farm[`raw_${c.tank_key}_counts`]}
              onSave={async (data) => {
                await api.saveTankCalibration(farm.id, c.tank_key, data);
                loadCalibrations();
              }}
              onCommand={async (type) => {
                await api.farmCommand(farm.id, `${type}_${c.tank_key}`);
                loadCommands();
              }} />
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Room branch valves</h3>
        <p className="muted small">
          One normally-closed valve per room, tee'd off the trunk main — each room waters
          independently of the others. This is the same valve each room's own "Mist room now"
          opens; triggering it here just saves the trip to that room's page.
        </p>
        <ul className="valve-list">
          {rooms.map((room) => {
            const open = room.activity === 'misting';
            return (
              <li key={room.id} className={open ? 'open' : ''}>
                <span className={`dot ${isOnline(room) ? 'online' : 'offline'}`} />
                <span className="valve-list-name">{room.name}</span>
                <span className={`badge ${open ? 'live misting' : 'idle'}`}>
                  {open ? <><span className="pulse-dot" />Open — misting</> : 'Closed'}
                </span>
                <Tip text={`Opens only ${room.name}'s branch valve — the other rooms stay shut`}>
                  <button className="ghost small-btn" disabled={busyValveRoomId === room.id || open}
                    onClick={() => openBranchValve(room.id)}>
                    {busyValveRoomId === room.id ? '…' : open ? 'Watering…' : '💧 Open & water'}
                  </button>
                </Tip>
              </li>
            );
          })}
          {rooms.length === 0 && <p className="muted small">No rooms yet in this farm.</p>}
        </ul>
      </section>

      <section className="grid-2">
        <div className="card">
          <h3>Tank settings</h3>
          {tankForm ? (
            <form onSubmit={saveTankForm} className="schedule-form">
              <label className="switch-row">
                <input type="checkbox" checked={!!tankForm.autofillEnabled}
                  onChange={(e) => setTankForm((s) => ({ ...s, autofillEnabled: e.target.checked }))} />
                <Tip text="Requires a low + full water level sensor pair and an inlet valve on the main tank"><span>Auto-fill the main water tank</span></Tip>
              </label>
              <div className="row gap">
                <div>
                  <Tip text="Mains water is chlorinated — the tank stands open and misting is held back this long after every fill, so chlorine can off-gas before it touches the orchids"><label>Dechlorination hold (days)</label></Tip>
                  <input type="number" step="0.5" min="0" value={(tankForm.dechlorinateHours ?? 24) / 24}
                    onChange={(e) => setTankForm((s) => ({ ...s, dechlorinateHours: Math.round(Number(e.target.value) * 24) }))} />
                </div>
                <div>
                  <Tip text="Actual flow rate of the misting pump — used to estimate water volume used per mist run"><label>Pump flow rate (L/min)</label></Tip>
                  <input type="number" step="0.1" min="0" value={tankForm.pumpFlowLpm ?? 4.5}
                    onChange={(e) => setTankForm((s) => ({ ...s, pumpFlowLpm: Number(e.target.value) }))} />
                </div>
              </div>
              <button type="submit">{savedFlash ? 'Saved ✓' : 'Save tank settings'}</button>
            </form>
          ) : <p className="muted">Loading…</p>}
        </div>

        <div className="stack">
          <div className="card">
            <h3>Maintenance</h3>
            <p className="muted small">Shared rig equipment — tank, dosing pump, inline filter.</p>
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
              {maintenance.length === 0 && <p className="muted small">No maintenance tasks set up for this farm.</p>}
            </ul>
          </div>

          <div className="card">
            <h3>Activity</h3>
            <p className="muted small">Tank refills, feed dosing across all rooms, and maintenance — most recent first.</p>
            <ul className="event-log">
              {activityFeed.slice(0, 40).map((item, i) => (
                item.kind === 'event' ? (
                  <li key={i}>
                    <span className={`event-type ${item.type}`}>{item.type.replace(/_/g, ' ')}</span>
                    {item.room_name && <span className="muted small">{item.room_name}</span>}
                    <span className="muted small">{new Date(item.at).toLocaleString()}</span>
                    {item.volume_ml && <span className="muted small">{Math.round(item.volume_ml)} mL</span>}
                  </li>
                ) : (
                  <li key={i} className="reading-row">
                    <span className="event-type reading">tank reading</span>
                    <span className="muted small">{new Date(item.at).toLocaleString()}</span>
                    <span className="muted small">{item.water_low ? 'low' : item.water_full ? 'full' : 'ok'}</span>
                  </li>
                )
              ))}
              {activityFeed.length === 0 && <p className="muted small">Nothing yet.</p>}
            </ul>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row wrap gap" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Rooms</h3>
          <div className="row gap">
            <button className={`tab ${viewMode === 'map' ? 'active' : ''}`} onClick={() => setViewMode('map')}>🗺️ Map</button>
            <button className={`tab ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>☰ List</button>
          </div>
        </div>
        {rooms.length === 0 && <p className="muted">No rooms yet in this farm.</p>}
        {rooms.map((room) => {
          const roomBenches = benches.filter((b) => b.room_id === room.id);
          return (
            <div key={room.id} style={{ marginBottom: 14 }}>
              <div className="row wrap gap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <Tip text={`Open ${room.name}`}>
                  <button className="crumb-link" onClick={() => onSelectRoom(room.id)}>
                    <span className={`dot ${isOnline(room) ? 'online' : 'offline'}`} style={{ marginRight: 6 }} />
                    🏠 {room.name}
                  </button>
                </Tip>
                <span className="muted small">{roomBenches.length} bench{roomBenches.length === 1 ? '' : 'es'} · {room.humidity != null ? `${room.humidity}%` : '—'} · {room.temp_c != null ? `${room.temp_c}°C` : '—'}</span>
              </div>
              {viewMode === 'map' && <RoomMap benches={roomBenches} height={180} onSelectBench={() => onSelectRoom(room.id)} />}
            </div>
          );
        })}
      </section>
    </div>
  );
}

const TANK_LABELS = {
  water: { label: 'Water Tank', hint: 'The one shared water tank for this farm.' },
  fertilizer_early: { label: 'Early-Phase Fertilizer Tank', hint: 'Root/bloom starter concentrate — weeks 1–2 of the rotation. Own stock tank; only meets the late-phase product inside the shared mixing tank, one at a time.' },
  fertilizer_late: { label: 'Late-Phase Fertilizer Tank', hint: 'All-purpose concentrate — weeks 3+ of the rotation. Own stock tank, same shared mixing rig.' },
  fungicide: { label: 'Fungicide Tank', hint: 'Injects into the same water line and sprays through the regular fogging nozzles — flush with plain water right after dosing.' },
};

// 2-point calibration: tare the tank empty, then record the raw reading with
// a known weight on it. scale_factor (raw counts / gram) is computed
// server-side from those two points so this stays a single source of truth.
function TankCalibrationCard({ calibration, liveRaw, onSave, onCommand }) {
  const meta = TANK_LABELS[calibration.tank_key] || { label: calibration.tank_key, hint: '' };
  const [form, setForm] = useState(() => ({
    tareRaw: calibration.tare_raw ?? '',
    knownWeightG: calibration.known_weight_g ?? '',
    rawAtKnownWeight: calibration.raw_at_known_weight ?? '',
    capacityL: calibration.capacity_l ?? '',
    densityGPerMl: calibration.density_g_per_ml ?? 1.0,
  }));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busyCommand, setBusyCommand] = useState(null);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function runCommand(type) {
    setBusyCommand(type);
    try {
      await onCommand(type);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyCommand(null);
    }
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        tareRaw: form.tareRaw === '' ? null : Number(form.tareRaw),
        knownWeightG: form.knownWeightG === '' ? null : Number(form.knownWeightG),
        rawAtKnownWeight: form.rawAtKnownWeight === '' ? null : Number(form.rawAtKnownWeight),
        capacityL: form.capacityL === '' ? null : Number(form.capacityL),
        densityGPerMl: form.densityGPerMl === '' ? null : Number(form.densityGPerMl),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const scaleFactor = calibration.scale_factor != null ? Number(calibration.scale_factor) : null;
  const tareRaw = calibration.tare_raw != null ? Number(calibration.tare_raw) : null;
  const capacityL = calibration.capacity_l != null ? Number(calibration.capacity_l) : null;
  const density = calibration.density_g_per_ml != null ? Number(calibration.density_g_per_ml) : 1.0;

  // Reference raw thresholds an operator (or the firmware) could use for
  // "low"/"full", mirroring the app's existing 16%/88% low/full convention.
  let rawLow = null, rawFull = null;
  if (scaleFactor && tareRaw != null && capacityL) {
    const capacityG = capacityL * 1000 * density;
    rawLow = Math.round(tareRaw + capacityG * 0.16 * scaleFactor);
    rawFull = Math.round(tareRaw + capacityG * 0.88 * scaleFactor);
  }

  const hasLive = liveRaw != null;

  return (
    <form className="card calibration-card" onSubmit={save}>
      <h4>{meta.label}</h4>
      <p className="muted small">{meta.hint}</p>

      <div className="calibration-live">
        <span className={`dot ${hasLive ? 'online' : 'offline'}`} />
        <span className="muted small">Live raw reading</span>
        <span className="calibration-live-value">{hasLive ? Math.round(liveRaw).toLocaleString() : '—'}</span>
      </div>

      <Tip text="Raw ADC reading from the HX711 with the tank empty">
        <label>1. Tare — raw reading, empty</label>
      </Tip>
      <div className="row gap center-y">
        <input type="number" step="any" value={form.tareRaw} onChange={(e) => set('tareRaw', e.target.value)} placeholder="e.g. 8412050" />
        <Tip text="Copy the current live reading in — make sure the tank is actually empty first">
          <button type="button" className="ghost small-btn" disabled={!hasLive} onClick={() => set('tareRaw', Math.round(liveRaw))}>Capture</button>
        </Tip>
      </div>

      <Tip text="A reference weight placed on/in the tank — a measured volume of water works well (1 L ≈ 1000 g)">
        <label>2. Known weight (g)</label>
      </Tip>
      <input type="number" step="any" value={form.knownWeightG} onChange={(e) => set('knownWeightG', e.target.value)} placeholder="e.g. 2000" />

      <label>Raw reading with the known weight on</label>
      <div className="row gap center-y">
        <input type="number" step="any" value={form.rawAtKnownWeight} onChange={(e) => set('rawAtKnownWeight', e.target.value)} placeholder="e.g. 8459800" />
        <Tip text="Copy the current live reading in — make sure the known weight is actually on/in the tank first">
          <button type="button" className="ghost small-btn" disabled={!hasLive} onClick={() => set('rawAtKnownWeight', Math.round(liveRaw))}>Capture</button>
        </Tip>
      </div>

      <div className="row gap">
        <div>
          <Tip text="Used to derive reference low/full raw thresholds below"><label>Tank capacity (L)</label></Tip>
          <input type="number" step="any" value={form.capacityL} onChange={(e) => set('capacityL', e.target.value)} placeholder="e.g. 50" />
        </div>
        <div>
          <Tip text="Water ≈ 1.0. Check the product label for concentrate, or weigh 100 mL yourself."><label>Density (g/mL)</label></Tip>
          <input type="number" step="0.01" value={form.densityGPerMl} onChange={(e) => set('densityGPerMl', e.target.value)} />
        </div>
      </div>

      <div className="calibration-result">
        <div>
          <span className="muted small">Scale factor</span>
          <div className="calibration-result-value">{scaleFactor ? `${scaleFactor.toFixed(3)} counts/g` : '—'}</div>
        </div>
        <div>
          <span className="muted small">Formula</span>
          <div className="calibration-result-value mono">weight_g = (raw − {tareRaw ?? 'tare'}) / {scaleFactor ? scaleFactor.toFixed(3) : 'scale'}</div>
        </div>
        {(rawLow != null || rawFull != null) && (
          <div>
            <span className="muted small">Reference thresholds</span>
            <div className="calibration-result-value mono">low ≈ {rawLow} &nbsp;·&nbsp; full ≈ {rawFull}</div>
          </div>
        )}
      </div>

      <div className="row gap" style={{ marginTop: 10 }}>
        <Tip text="Manually opens this tank's inlet/refill so you can start a calibration pass from a known-full state">
          <button type="button" className="ghost small-btn" disabled={!!busyCommand}
            onClick={() => runCommand('fill')}>{busyCommand === 'fill' ? 'Filling…' : '⤒ Fill now'}</button>
        </Tip>
        <Tip text="Software-only reset to 0% — there's no automated drain valve in the physical build. Use this right before a fresh tare.">
          <button type="button" className="ghost small-btn" disabled={!!busyCommand}
            onClick={() => runCommand('drain')}>{busyCommand === 'drain' ? 'Draining…' : '⤓ Drain now'}</button>
        </Tip>
      </div>

      <div className="row gap center-y" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <span className="muted small">
          {calibration.calibrated_at ? `Last calibrated ${new Date(calibration.calibrated_at).toLocaleString()}` : 'Not calibrated yet'}
        </span>
        <button type="submit" disabled={saving}>{savedFlash ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

// Draggable floor-plan for a room's benches. Benches have no device data of
// their own, so every pin shares the same look — position is all that's
// editable here.
function RoomMap({ benches, height = 420, onSelectBench }) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const [positions, setPositions] = useState({});
  const [dragId, setDragId] = useState(null);

  const posKey = benches.map((b) => `${b.id}:${b.pos_x}:${b.pos_y}`).join('|');
  useEffect(() => {
    setPositions((prev) => {
      const next = { ...prev };
      benches.forEach((b) => {
        if (dragRef.current?.id === b.id) return;
        next[b.id] = { x: Number(b.pos_x ?? 50), y: Number(b.pos_y ?? 50) };
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posKey]);

  function onPointerDown(e, bench) {
    dragRef.current = { id: bench.id, startX: e.clientX, startY: e.clientY, moved: false };
    setDragId(bench.id);
  }
  function onContainerPointerMove(e) {
    const d = dragRef.current;
    if (!d || !containerRef.current) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.moved = true;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clampPct(((e.clientX - rect.left) / rect.width) * 100);
    const y = clampPct(((e.clientY - rect.top) / rect.height) * 100);
    setPositions((prev) => ({ ...prev, [d.id]: { x, y } }));
  }
  function onContainerPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    if (!d) return;
    if (d.moved) {
      const pos = positions[d.id];
      if (pos) {
        api.moveBench(d.id, { posX: Math.round(pos.x * 10) / 10, posY: Math.round(pos.y * 10) / 10 }).catch(console.error);
      }
    } else if (onSelectBench) {
      onSelectBench(d.id);
    }
  }

  return (
    <div className="room-map" ref={containerRef} style={{ height }}
      onPointerMove={onContainerPointerMove} onPointerUp={onContainerPointerUp} onPointerLeave={onContainerPointerUp}>
      {benches.length === 0 && <p className="muted small map-empty">No benches placed here yet.</p>}
      {benches.map((b) => {
        const pos = positions[b.id] || { x: 50, y: 50 };
        return (
          <button key={b.id}
            className={`bench-pin ${dragId === b.id ? 'dragging' : ''}`}
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            onPointerDown={(e) => onPointerDown(e, b)}
            title={`${b.name}${b.variety ? ' · ' + b.variety : ''} — drag to reposition`}>
            <span className="bench-pin-dot" />
            <span className="bench-pin-label">{b.name}</span>
          </button>
        );
      })}
    </div>
  );
}
