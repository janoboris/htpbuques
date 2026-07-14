/* ============================================================
   HTP — Núcleo compartido
   Conexión Firebase (Firestore), acceso a datos en tiempo real,
   cálculos operacionales y utilidades de interfaz.
   Requiere que firebase-config.js se cargue antes que este archivo,
   junto a los SDK compat de Firebase (app + firestore).
   ============================================================ */

const HTP = (() => {

  let db = null;
  let ready = false;
  const liveListeners = [];

  function init() {
    if (typeof firebase === 'undefined') {
      console.error('SDK de Firebase no cargado.');
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    try {
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    } catch (e) {}
    ready = true;
    window.addEventListener('online', () => setLive(true));
    window.addEventListener('offline', () => setLive(false));
  }

  function setLive(state) {
    liveListeners.forEach(cb => cb(state));
  }
  function onLiveChange(cb) { liveListeners.push(cb); cb(navigator.onLine); }
  function trackSnapshotLiveness(snap) {
    setLive(!snap.metadata.fromCache);
  }

  const col = (name) => db.collection(name);

  /* ---------------- Usuario (identificación, no autenticación) ---------------- */
  function getUsuario() {
    try { return JSON.parse(localStorage.getItem('htp_usuario') || 'null'); } catch (e) { return null; }
  }
  function setUsuario(nombre, perfil) {
    localStorage.setItem('htp_usuario', JSON.stringify({ nombre, perfil, ts: Date.now() }));
  }
  function logout() { localStorage.removeItem('htp_usuario'); }

  /* ==================================================================
     BUQUES
     ================================================================== */
  const BODEGAS_BASE = ['Bodega 1', 'Bodega 2', 'Bodega 3', 'Bodega 4', 'Bodega 5'];

  function nuevaBodega(id, nombre) {
    return { id, nombre, activa: false, tipo: 'carga', tonObjetivo: 0, tonAcumulado: 0, pctRestante: null };
  }

  function bodegasIniciales() {
    const obj = {};
    BODEGAS_BASE.forEach((n, i) => { const id = 'b' + (i + 1); obj[id] = nuevaBodega(id, n); });
    return obj;
  }

  function listenBuques(cb) {
    return col('buques').orderBy('createdAt', 'desc').onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error(err));
  }

  function listenBuque(id, cb) {
    return col('buques').doc(id).onSnapshot(d => {
      trackSnapshotLiveness(d);
      cb(d.exists ? { id: d.id, ...d.data() } : null);
    });
  }

  async function crearBuque(data) {
    const payload = {
      nombre: data.nombre,
      voyage: data.voyage || '',
      tipoOperacion: data.tipoOperacion,       // carga | descarga | mixto
      tipoGranel: data.tipoGranel,             // granel | acero
      rateMeta: Number(data.rateMeta) || 0,
      fechaInicioProgramado: data.fechaInicioProgramado || null,
      fechaInicioReal: data.fechaInicioReal || null,
      estado: 'abierto',
      bodegas: data.bodegas,
      fechaCierre: null,
      atraque: data.atraque || { fecha: null, practico: '' },
      desatraque: data.desatraque || { fecha: null, practico: '' },
      promedioTonCamion: Number(data.promedioTonCamion) || 30,
      esHistorico: !!data.esHistorico,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      creadoPor: data.creadoPor || null
    };
    const ref = await col('buques').add(payload);
    return ref.id;
  }

  async function actualizarBuque(id, patch) {
    await col('buques').doc(id).update(patch);
  }

  async function ajustarBodega(buqueId, bodegaId, deltaTon, pctRestante) {
    const patch = {};
    patch[`bodegas.${bodegaId}.tonAcumulado`] = firebase.firestore.FieldValue.increment(deltaTon);
    if (pctRestante !== null && pctRestante !== undefined) {
      patch[`bodegas.${bodegaId}.pctRestante`] = pctRestante;
    }
    await col('buques').doc(buqueId).update(patch);
  }

  async function setBodegaAbsoluto(buqueId, bodegaId, campo, valor) {
    const patch = {};
    patch[`bodegas.${bodegaId}.${campo}`] = valor;
    await col('buques').doc(buqueId).update(patch);
  }

  async function cerrarBuque(id) {
    await col('buques').doc(id).update({ estado: 'cerrado', fechaCierre: new Date().toISOString() });
  }
  async function reabrirBuque(id) {
    await col('buques').doc(id).update({ estado: 'abierto', fechaCierre: null });
  }
  async function pausarGira(id, motivo) {
    await col('buques').doc(id).update({ estado: 'gira', giraMotivo: motivo || '', giraInicio: new Date().toISOString() });
  }
  async function reanudarDeGira(id) {
    await col('buques').doc(id).update({ estado: 'abierto', giraMotivo: null, giraInicio: null });
  }
  async function eliminarBuque(id) {
    await col('buques').doc(id).delete();
  }

  /* ==================================================================
     TURNOS  (doc id determinístico: <buqueId>_<fecha>_<turno> evita duplicados)
     ================================================================== */
  function turnoDocId(buqueId, fecha, turnoNum) { return `${buqueId}_${fecha}_${turnoNum}`; }

  function listenTurnosDeBuque(buqueId, cb) {
    return col('turnos').where('buqueId', '==', buqueId).onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => (a.fecha + a.turno).localeCompare(b.fecha + b.turno));
      cb(arr);
    });
  }

  function listenTurnosAbiertos(cb) {
    return col('turnos').where('estado', 'in', ['abierto', 'pendiente']).onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }

  function listenTodosTurnos(cb) {
    return col('turnos').onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }

  async function abrirTurno(buqueId, fecha, turnoNum, usuario) {
    const id = turnoDocId(buqueId, fecha, turnoNum);
    const ref = col('turnos').doc(id);
    const snap = await ref.get();
    if (snap.exists) return id; // ya abierto por otro dispositivo, se reutiliza
    await ref.set({
      buqueId, fecha, turno: turnoNum,
      estado: 'abierto',
      horaInicio: new Date().toISOString(),
      horaTermino: null,
      horasEfectivas: null,
      registros: [],
      totalToneladas: 0,
      viajes: 0,
      viajesCancha: 0,
      toneladasCancha: 0,
      tarjaNombre: usuario || null,
      observacionCierre: '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return id;
  }

  async function agregarRegistro(turnoId, registro) {
    const reg = { ...registro, id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7), ts: registro.ts || new Date().toISOString() };
    await col('turnos').doc(turnoId).update({
      registros: firebase.firestore.FieldValue.arrayUnion(reg),
      totalToneladas: firebase.firestore.FieldValue.increment(Number(registro.toneladas) || 0),
      viajes: firebase.firestore.FieldValue.increment(1)
    });
    return reg;
  }

  // Embarque de granel: el camión descarga a cancha (acopio) y NO cuenta como
  // tonelaje embarcado todavía — eso lo registra por separado la grúa al cargar
  // la bodega (agregarRegistro normal). Esto evita contar el material dos veces.
  async function agregarRegistroCancha(turnoId, registro) {
    const reg = { ...registro, tipo: 'camion_cancha', id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7), ts: registro.ts || new Date().toISOString() };
    await col('turnos').doc(turnoId).update({
      registros: firebase.firestore.FieldValue.arrayUnion(reg),
      viajesCancha: firebase.firestore.FieldValue.increment(1),
      toneladasCancha: firebase.firestore.FieldValue.increment(Number(registro.toneladas) || 0)
    });
    return reg;
  }

  // Corrección de un registro mal cargado: lo saca del turno y revierte lo que
  // haya sumado a la bodega o a los contadores de cancha, para que el
  // tonelaje quede exacto otra vez.
  async function eliminarRegistro(turnoId, registro, buqueId) {
    const patch = { registros: firebase.firestore.FieldValue.arrayRemove(registro) };
    if (registro.tipo === 'camion_cancha') {
      patch.viajesCancha = firebase.firestore.FieldValue.increment(-1);
      patch.toneladasCancha = firebase.firestore.FieldValue.increment(-(Number(registro.toneladas) || 0));
    } else {
      patch.totalToneladas = firebase.firestore.FieldValue.increment(-(Number(registro.toneladas) || 0));
      patch.viajes = firebase.firestore.FieldValue.increment(-1);
    }
    await col('turnos').doc(turnoId).update(patch);
    if (registro.bodegaId && buqueId) {
      await ajustarBodega(buqueId, registro.bodegaId, -(Number(registro.toneladas) || 0), null);
    }
  }

  // Alarma simple: ¿ya existe un registro con exactamente la misma hora en
  // este turno? (suele indicar que se registró dos veces por error).
  function horaDuplicada(turno, horaISO) {
    if (!turno || !turno.registros || !horaISO) return false;
    return turno.registros.some(r => r.ts === horaISO);
  }

  async function cerrarTurno(turnoId, observacion, horasEfectivas) {
    const patch = {
      estado: 'pendiente',
      horaTermino: new Date().toISOString(),
      observacionCierre: observacion || ''
    };
    if (horasEfectivas !== undefined && horasEfectivas !== null && horasEfectivas !== '') {
      patch.horasEfectivas = Number(horasEfectivas);
    }
    await col('turnos').doc(turnoId).update(patch);
  }

  async function crearTurnoHistorico(data) {
    const id = turnoDocId(data.buqueId, data.fecha, data.turno) + '_hist_' + Date.now().toString(36);
    await col('turnos').doc(id).set({
      buqueId: data.buqueId, fecha: data.fecha, turno: data.turno,
      estado: 'aprobado',
      horaInicio: null, horaTermino: null,
      horasEfectivas: Number(data.horasEfectivas) || 0,
      registros: [],
      totalToneladas: Number(data.toneladas) || 0,
      viajes: 0,
      tarjaNombre: data.tarjaNombre || null,
      observacionCierre: data.observacion || '',
      esHistorico: true,
      aprobadoPor: data.creadoPor || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    if (data.bodegaId && data.toneladas) {
      await ajustarBodega(data.buqueId, data.bodegaId, Number(data.toneladas), null);
    }
    return id;
  }

  async function aprobarTurno(turnoId, supervisor) {
    await col('turnos').doc(turnoId).update({ estado: 'aprobado', aprobadoPor: supervisor || null, aprobadoEn: new Date().toISOString() });
  }

  // Usado por Supervisor al armar una tarja manual de un turno pasado: cierra
  // y aprueba en un solo paso, sin pasar por "pendiente".
  async function cerrarYAprobarTurno(turnoId, horasEfectivas, observacion, aprobadoPor) {
    await col('turnos').doc(turnoId).update({
      estado: 'aprobado',
      horaTermino: new Date().toISOString(),
      horasEfectivas: Number(horasEfectivas) || 0,
      observacionCierre: observacion || '',
      aprobadoPor: aprobadoPor || null,
      aprobadoEn: new Date().toISOString()
    });
  }
  async function rechazarTurno(turnoId, supervisor, motivo) {
    await col('turnos').doc(turnoId).update({ estado: 'abierto', horaTermino: null, motivoRechazo: motivo || '', rechazadoPor: supervisor || null });
  }

  /* ==================================================================
     CAMIONES (flota maestra — doc id = patente)
     ================================================================== */
  function listenCamiones(cb) {
    return col('camiones').orderBy('patente').onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }

  async function guardarCamion(patente, taraVacia, taraLlena) {
    const p = patente.trim().toUpperCase();
    const pesoNeto = Number(taraLlena) - Number(taraVacia);
    await col('camiones').doc(p).set({
      patente: p, taraVacia: Number(taraVacia), taraLlena: Number(taraLlena),
      pesoNeto, actualizadoEn: new Date().toISOString()
    }, { merge: true });
    return { patente: p, taraVacia: Number(taraVacia), taraLlena: Number(taraLlena), pesoNeto };
  }

  async function eliminarCamion(patente) { await col('camiones').doc(patente).delete(); }

  /* ==================================================================
     DETENCIONES
     ================================================================== */
  function listenDetenciones(buqueId, cb) {
    return col('detenciones').where('buqueId', '==', buqueId).onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      arr.sort((a, b) => new Date(b.horaInicio) - new Date(a.horaInicio));
      cb(arr);
    });
  }

  async function crearDetencion(data) {
    const ref = await col('detenciones').add({
      buqueId: data.buqueId,
      horaInicio: data.horaInicio || new Date().toISOString(),
      horaTermino: data.horaTermino || null,
      motivo: data.motivo,
      observacion: data.observacion || '',
      afectaRate: !!data.afectaRate,
      creadoPor: data.creadoPor || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }
  async function cerrarDetencion(id, horaTermino) {
    await col('detenciones').doc(id).update({ horaTermino: horaTermino || new Date().toISOString() });
  }
  async function eliminarDetencion(id) { await col('detenciones').doc(id).delete(); }

  /* ==================================================================
     CÁLCULOS OPERACIONALES
     ================================================================== */
  // Agrupa registros (de uno o varios turnos) por bloque de hora real, para
  // detectar horas con más/menos flujo de camiones y horas de espera.
  function camionesPorHora(turnos) {
    const registros = [];
    (turnos || []).forEach(t => (t.registros || []).forEach(r => registros.push(r)));
    if (!registros.length) return [];
    const buckets = {};
    registros.forEach(r => {
      if (!r.ts) return;
      const d = new Date(r.ts);
      const key = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      if (!buckets[key]) buckets[key] = { key, count: 0, toneladas: 0 };
      buckets[key].count++;
      buckets[key].toneladas += Number(r.toneladas) || 0;
    });
    return Object.values(buckets).sort((a, b) => a.key.localeCompare(b.key));
  }

  function fmtBloqueHora(key) {
    // key: YYYY-MM-DDTHH
    const d = new Date(key + ':00:00');
    return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' + String(d.getHours()).padStart(2, '0') + ':00';
  }

  function totalToneladas(buque) {
    if (!buque) return 0;
    const bodegas = buque.bodegas ? Object.values(buque.bodegas).reduce((s, b) => s + (Number(b.tonAcumulado) || 0), 0) : 0;
    const acero = Number(buque.aceroAcumulado) || 0;
    return bodegas + acero;
  }

  async function sumarAcero(buqueId, toneladas) {
    await col('buques').doc(buqueId).update({ aceroAcumulado: firebase.firestore.FieldValue.increment(Number(toneladas) || 0) });
  }

  function avanceBodega(b) {
    if (!b.tonObjetivo) return 0;
    return Math.min(100, (b.tonAcumulado / b.tonObjetivo) * 100);
  }

  function estadoBodega(b) {
    if (!b.activa) return 'inactiva';
    if (!b.tonAcumulado) return 'pendiente';
    if (avanceBodega(b) >= 100) return 'finalizada';
    return 'trabajando';
  }

  // Proyección: cuánto falta, ETC (fecha estimada de término al rate actual)
  // y cuántas horas de adelanto/atraso llevamos respecto al rate programado.
  function calcularProyeccion(buque, r) {
    const objetivo = buque && buque.bodegas ? Object.values(buque.bodegas).reduce((s, b) => s + (Number(b.tonObjetivo) || 0), 0) : 0;
    const restante = Math.max(0, objetivo - (r ? r.ton : 0));
    const horasRestantes = r && r.rate > 0 ? restante / r.rate : null;
    const etc = horasRestantes !== null ? new Date(Date.now() + horasRestantes * 3600000).toISOString() : null;
    const rateMetaHora = buque && buque.rateMeta > 0 ? buque.rateMeta / 24 : 0;
    let diferenciaHoras = null;
    if (rateMetaHora > 0 && r && r.horas > 0) {
      const avanceEsperado = rateMetaHora * r.horas;
      diferenciaHoras = (r.ton - avanceEsperado) / rateMetaHora;
    }
    return { objetivo, restante, horasRestantes, etc, diferenciaHoras };
  }

  function fmtProyeccionBadge(diferenciaHoras) {
    if (diferenciaHoras === null) return '';
    const h = Math.abs(diferenciaHoras).toFixed(1);
    return diferenciaHoras >= 0
      ? `<span class="badge badge-ok">+${h} h adelanto</span>`
      : `<span class="badge badge-bad">-${h} h atraso</span>`;
  }

  function calcularTiempos(buque, detenciones) {
    const inicio = buque.fechaInicioReal ? new Date(buque.fechaInicioReal) : null;
    if (!inicio) return { minutosBruto: 0, minutosDetenido: 0, minutosDetenidoInfo: 0, minutosNeto: 0, horasBruto: 0, horasNeto: 0 };
    const fin = (buque.estado === 'cerrado' && buque.fechaCierre) ? new Date(buque.fechaCierre) : new Date();
    const minutosBruto = Math.max(0, (fin - inicio) / 60000);

    let minutosDetenido = 0, minutosDetenidoInfo = 0;
    (detenciones || []).forEach(d => {
      const di = new Date(d.horaInicio);
      const dfRaw = d.horaTermino ? new Date(d.horaTermino) : fin;
      const df = dfRaw > fin ? fin : dfRaw;
      const mins = Math.max(0, (df - di) / 60000);
      if (d.afectaRate) minutosDetenido += mins; else minutosDetenidoInfo += mins;
    });

    const minutosNeto = Math.max(0, minutosBruto - minutosDetenido);
    return {
      minutosBruto, minutosDetenido, minutosDetenidoInfo, minutosNeto,
      horasBruto: minutosBruto / 60, horasNeto: minutosNeto / 60
    };
  }

  function calcularRates(buque, tiempos) {
    const ton = totalToneladas(buque);
    const rateBruto = tiempos.horasBruto > 0 ? ton / tiempos.horasBruto : 0;
    const rateNeto = tiempos.horasNeto > 0 ? ton / tiempos.horasNeto : 0;
    const productividad = buque.rateMeta > 0 ? (rateNeto / buque.rateMeta) * 100 : 0;
    return { ton, rateBruto, rateNeto, productividad };
  }

  // Rendimiento "real" del puerto: suma de toneladas y horas efectivas por turno
  // (igual metodología que la planilla de rendimiento bruto/neto en papel).
  function calcularRendimientoPorTurnos(buque, turnos) {
    const validos = (turnos || []).filter(t => t.estado === 'aprobado' || t.estado === 'pendiente');
    const ton = validos.reduce((s, t) => s + (Number(t.totalToneladas) || 0), 0);
    const horas = validos.reduce((s, t) => {
      if (t.horasEfectivas !== null && t.horasEfectivas !== undefined) return s + Number(t.horasEfectivas);
      if (t.horaInicio && t.horaTermino) return s + (new Date(t.horaTermino) - new Date(t.horaInicio)) / 3600000;
      return s;
    }, 0);
    const rate = horas > 0 ? ton / horas : 0;
    const productividad = buque && buque.rateMeta > 0 ? (rate / buque.rateMeta) * 100 : 0;
    return { ton, horas, rate, productividad, turnos: validos.length };
  }

  /* ==================================================================
     FORMATO
     ================================================================== */
  function fmtTon(n) { return (Number(n) || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmtRate(n) { return (Number(n) || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmtPct(n) { return (Number(n) || 0).toLocaleString('es-CL', { maximumFractionDigits: 0 }); }
  function fmtDuracion(min) {
    min = Math.round(Number(min) || 0);
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtFechaHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtHora(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function hoyISO() { return new Date().toISOString().slice(0, 10); }

  // Convierte un <input> de hora en digitación rápida: el tarja solo teclea
  // números (ej "0859") y se autoformatea a "08:59", sin selector nativo.
  function wireHoraRapida(id) {
    const el = document.getElementById(id);
    if (!el || el.dataset.horaRapidaListo) return;
    el.dataset.horaRapidaListo = '1';
    el.type = 'text';
    el.classList.add('mono', 'hora-rapida');
    el.setAttribute('inputmode', 'numeric');
    el.setAttribute('maxlength', '5');
    el.setAttribute('placeholder', 'HH:MM');
    el.addEventListener('input', () => {
      let v = el.value.replace(/[^\d]/g, '').slice(0, 4);
      if (v.length >= 3) v = v.slice(0, 2) + ':' + v.slice(2);
      el.value = v;
    });
  }
  function wireHorasRapidas(ids) { (ids || []).forEach(wireHoraRapida); }
  function turnoActualNum() {
    const h = new Date().getHours();
    if (h >= 0 && h < 8) return 1;
    if (h >= 8 && h < 16) return 2;
    return 3;
  }

  /* ==================================================================
     UI: toast / modal
     ================================================================== */
  function ensureToastHost() {
    if (!document.getElementById('toastHost')) {
      const d = document.createElement('div');
      d.id = 'toastHost';
      document.body.appendChild(d);
    }
    return document.getElementById('toastHost');
  }
  function toast(msg, type) {
    const host = ensureToastHost();
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2800);
  }

  function ensureModalHost() {
    if (!document.getElementById('modalVeil')) {
      const veil = document.createElement('div');
      veil.id = 'modalVeil';
      veil.className = 'modal-veil';
      veil.innerHTML = '<div class="modal-sheet" id="modalSheet"></div>';
      veil.addEventListener('click', (e) => { if (e.target === veil) closeModal(); });
      document.body.appendChild(veil);
    }
  }
  function openModal(html) {
    ensureModalHost();
    document.getElementById('modalSheet').innerHTML = html;
    document.getElementById('modalVeil').classList.add('show');
  }
  function closeModal() {
    const v = document.getElementById('modalVeil');
    if (v) v.classList.remove('show');
  }

  function confirmar(msg) { return window.confirm(msg); }

  return {
    init, onLiveChange, getUsuario, setUsuario, logout,
    BODEGAS_BASE, bodegasIniciales, nuevaBodega,
    listenBuques, listenBuque, crearBuque, actualizarBuque, ajustarBodega, setBodegaAbsoluto,
    cerrarBuque, reabrirBuque, pausarGira, reanudarDeGira, eliminarBuque,
    turnoDocId, listenTurnosDeBuque, listenTurnosAbiertos, listenTodosTurnos, abrirTurno, agregarRegistro, agregarRegistroCancha, eliminarRegistro, horaDuplicada, cerrarTurno, aprobarTurno, cerrarYAprobarTurno, rechazarTurno, crearTurnoHistorico,
    listenCamiones, guardarCamion, eliminarCamion,
    listenDetenciones, crearDetencion, cerrarDetencion, eliminarDetencion,
    totalToneladas, sumarAcero, avanceBodega, estadoBodega, calcularTiempos, calcularRates, calcularRendimientoPorTurnos, calcularProyeccion, fmtProyeccionBadge, camionesPorHora,
    fmtTon, fmtRate, fmtPct, fmtDuracion, fmtFechaHora, fmtHora, fmtBloqueHora, hoyISO, turnoActualNum, wireHorasRapidas,
    toast, openModal, closeModal, confirmar
  };
})();
