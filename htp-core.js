/* ============================================================
   HTP — Núcleo compartido
   Conexión Firebase (Firestore), acceso a datos en tiempo real,
   cálculos operacionales y utilidades de interfaz.
   Requiere que firebase-config.js se cargue antes que este archivo,
   junto a los SDK compat de Firebase (app + firestore).
   ============================================================ */

const HTP = (() => {

  let db = null;
  const _turnoCache = {};
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

  // Firestore no garantiza el orden de un mapa al leerlo — sin esto, las
  // bodegas podían aparecer en orden distinto cada vez que se recargaba.
  // Siempre usar esto (nunca Object.values directo) para mostrar bodegas.
  function bodegasOrdenadas(buque) {
    if (!buque || !buque.bodegas) return [];
    return Object.values(buque.bodegas).sort((a, b) => {
      const na = parseInt((a.id || '').replace(/\D/g, ''), 10) || 0;
      const nb = parseInt((b.id || '').replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
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

  // ¿La hora digitada corresponde a la ventana nominal del turno elegido?
  // (1: 00-08, 2: 08-16, 3: 16-00). Evita que un viaje quede mezclado en el
  // turno equivocado por un error de tipeo en la hora.
  // Un ISO guardado (ej. "2026-07-03T07:26:00.000Z") está en UTC. Para
  // agrupar/mostrar por hora hay que usar la hora LOCAL del navegador
  // (Chile), nunca cortar el string ISO directo — si no, todo aparece
  // corrido según el huso horario.
  function claveHoraLocal(iso) {
    const d = new Date(iso);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    return `${y}-${m}-${day}T${h}`;
  }
  function horaLocalNum(iso) { return new Date(iso).getHours(); }
  function fechaLocalCorta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function horaFueraDeTurno(turnoNum, horaStr) {
    if (!horaStr) return false;
    const h = parseInt(horaStr.split(':')[0], 10);
    if (isNaN(h)) return false;
    const rangos = { 1: [0, 8], 2: [8, 16], 3: [16, 24] };
    const [ini, fin] = rangos[turnoNum] || [0, 24];
    return !(h >= ini && h < fin);
  }
  function rangoTurnoTexto(turnoNum) {
    return { 1: '00:00–08:00', 2: '08:00–16:00', 3: '16:00–00:00' }[turnoNum] || '';
  }

  // Corregir un registro: revierte el anterior (bodega/cancha) y crea uno
  // nuevo con los campos corregidos (ej: fecha/hora mal digitada).
  async function editarRegistro(turnoId, buqueId, registroViejo, camposNuevos) {
    await eliminarRegistro(turnoId, registroViejo, buqueId);
    const nuevo = { ...registroViejo, ...camposNuevos };
    delete nuevo.id;
    if (nuevo.tipo === 'camion_cancha') {
      return await agregarRegistroCancha(turnoId, nuevo);
    }
    const reg = await agregarRegistro(turnoId, nuevo);
    if (nuevo.bodegaId && buqueId) {
      await ajustarBodega(buqueId, nuevo.bodegaId, Number(nuevo.toneladas) || 0, nuevo.pctRestante ?? null);
    }
    return reg;
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

  // Elimina un turno completo, revirtiendo antes todo el tonelaje que sus
  // registros hayan sumado a las bodegas del buque.
  async function eliminarTurnoCompleto(turnoId, buqueId) {
    const doc = await col('turnos').doc(turnoId).get();
    if (!doc.exists) return;
    const t = doc.data();
    for (const r of (t.registros || [])) {
      if (r.bodegaId && buqueId) {
        await ajustarBodega(buqueId, r.bodegaId, -(Number(r.toneladas) || 0), null);
      }
    }
    await col('turnos').doc(turnoId).delete();
  }

  // Botón "✏️ Abrir turno" del resumen: si la pantalla registró un manejador
  // (Supervisor lo hace, para llevarte a Tarja manual con ese turno ya
  // abierto y todas sus tarjas listas para corregir), se usa ese. Si no hay
  // manejador registrado (ej. Gerencia, aunque ahí el botón no se muestra),
  // cae de respaldo al modal simple de horas/observación.
  function editarTurnoUI(fecha, turnoNum, buqueId, turnoId) {
    if (typeof window.HTP_onEditarTurno === 'function') {
      window.HTP_onEditarTurno(fecha, turnoNum, buqueId, turnoId || null);
      return;
    }
    if (turnoId) abrirModalEditarTurnoPorId(turnoId, buqueId);
  }

  // Modal autocontenido para editar (horas efectivas / observación) o
  // eliminar un turno completo, usable desde cualquier pantalla (Supervisor,
  // Gerencia) sin tener que reimplementar el modal en cada una.
  function abrirModalEditarTurnoPorId(turnoId, buqueId) {
    const t = _turnoCache[turnoId];
    if (!t) return;
    openModal(`
      <div class="modal-head"><h3>Turno ${t.turno} · ${t.fecha}</h3><button class="modal-close" onclick="HTP.closeModal()">✕</button></div>
      <p class="muted" style="font-size:13px; margin-bottom:14px;">${fmtTon(t.totalToneladas)} MT · ${t.viajes || 0} viajes · estado: ${t.estado}</p>
      <div class="field"><label>Horas efectivas</label><input id="etHoras" class="mono" type="number" step="0.1" value="${t.horasEfectivas ?? ''}" placeholder="Vacío = 8h por defecto"></div>
      <div class="field"><label>Observación</label><input id="etObs" value="${(t.observacionCierre || '').replace(/"/g, '&quot;')}"></div>
      <button class="btn btn-accent btn-block" onclick="HTP.guardarEdicionTurno('${turnoId}')">Guardar cambios</button>
      <div class="divider"></div>
      <button class="btn btn-bad btn-block" onclick="HTP.confirmarEliminarTurno('${turnoId}','${buqueId || ''}')">🗑 Eliminar este turno completo</button>
    `);
  }
  async function guardarEdicionTurno(turnoId) {
    const horasVal = document.getElementById('etHoras').value;
    const obs = document.getElementById('etObs').value.trim();
    await col('turnos').doc(turnoId).update({
      horasEfectivas: horasVal === '' ? null : Number(horasVal),
      observacionCierre: obs
    });
    closeModal();
    toast('Turno actualizado', 'ok');
  }
  async function confirmarEliminarTurno(turnoId, buqueId) {
    if (!confirmar('¿Eliminar este turno completo? Se descuenta todo su tonelaje de la(s) bodega(s). Esta acción no se puede deshacer.')) return;
    await eliminarTurnoCompleto(turnoId, buqueId || null);
    closeModal();
    toast('Turno eliminado', 'ok');
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

  function listenTodasDetenciones(cb) {
    return col('detenciones').onSnapshot(snap => {
      trackSnapshotLiveness(snap);
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
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
      manos: Number(data.manos) || 1,
      creadoPor: data.creadoPor || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }
  async function editarDetencion(id, cambios) {
    await col('detenciones').doc(id).update(cambios);
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

  // Agrupa los turnos por DÍA (más reciente primero) y dentro de cada día
  // por TURNO (1, 2, 3 en orden). Dentro de cada turno, los bloques de hora
  // se separan también por BODEGA (evita mezclar bodegas distintas en la
  // misma fila cuando un turno trabajó más de una).
  function totalesPorBodega(registros, buque) {
    const porBodega = {};
    (registros || []).forEach(r => {
      const id = r.bodegaId || '—';
      const nombre = (buque && buque.bodegas && buque.bodegas[id]) ? buque.bodegas[id].nombre : id;
      if (!porBodega[id]) porBodega[id] = { nombre, camiones: 0, toneladas: 0 };
      porBodega[id].camiones++;
      porBodega[id].toneladas += Number(r.toneladas) || 0;
    });
    return Object.values(porBodega).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  function resumenPorDia(turnos, buque, detenciones) {
    const porDia = {};
    (turnos || []).forEach(t => {
      if (!t.fecha) return;
      if (!porDia[t.fecha]) porDia[t.fecha] = {};
      porDia[t.fecha][t.turno] = t;
    });
    const rateMetaHora = buque && buque.rateMeta > 0 ? buque.rateMeta / 24 : 0;
    return Object.keys(porDia).sort().reverse().map(fecha => {
      const docsDia = [1, 2, 3].map(n => porDia[fecha][n]).filter(Boolean);
      // Junta TODOS los registros del día (sin importar en qué turno quedaron
      // guardados) y los reordena según la hora real de cada uno — así una
      // hora mal tipeada en el turno equivocado igual aparece en su turno real.
      const registrosDia = [];
      docsDia.forEach(t => (t.registros || []).forEach(r => registrosDia.push({ ...r, _turnoOrigen: t.turno })));
      const porTurnoReal = { 1: [], 2: [], 3: [] };
      registrosDia.forEach(r => {
        if (!r.ts) { porTurnoReal[r._turnoOrigen] && porTurnoReal[r._turnoOrigen].push(r); return; }
        const h = horaLocalNum(r.ts);
        const n = h < 8 ? 1 : h < 16 ? 2 : 3;
        porTurnoReal[n].push(r);
      });
      const bloquesPorTurno = [1, 2, 3].filter(n => porTurnoReal[n].length || docsDia.some(t => t.turno === n)).map(n => {
        const regsTodos = porTurnoReal[n];
        const regs = regsTodos.filter(r => r.tipo !== 'camion_cancha'); // cancha no cuenta como carga embarcada
        const tDoc = docsDia.find(t => t.turno === n) || null;
        const buckets = {};
        regs.forEach(r => {
          if (!r.ts) return;
          const bodNombre = (r.bodegaId && buque && buque.bodegas && buque.bodegas[r.bodegaId]) ? buque.bodegas[r.bodegaId].nombre : (r.bodegaId || '—');
          const claveHora = claveHoraLocal(r.ts);
          const key = claveHora + '|' + (r.bodegaId || '');
          if (!buckets[key]) buckets[key] = { key, hora: claveHora, bodega: bodNombre, count: 0, toneladas: 0, reasignado: r._turnoOrigen !== n };
          buckets[key].count++;
          buckets[key].toneladas += Number(r.toneladas) || 0;
        });
        const bloques = Object.values(buckets).sort((a, b) => a.key.localeCompare(b.key));
        const horas = tDoc ? horasDefaultTurno(tDoc, detenciones) : 8;
        const ton = regs.reduce((s, r) => s + (Number(r.toneladas) || 0), 0);
        const viajes = regs.length;
        const rateReal = horas > 0 ? ton / horas : 0;
        const cumplimiento = rateMetaHora > 0 ? (rateReal / rateMetaHora) * 100 : null;
        const totBodegas = totalesPorBodega(regs, buque);
        const bodegaNombres = totBodegas.map(x => x.nombre);
        const huboReasignados = bloques.some(b => b.reasignado);
        return { turno: { turno: n, fecha, estado: tDoc ? tDoc.estado : 'abierto', id: tDoc ? tDoc.id : null, horasEfectivas: tDoc ? tDoc.horasEfectivas : null, observacionCierre: tDoc ? tDoc.observacionCierre : '', totalToneladas: ton, viajes }, bloques, horas, ton, rateReal, cumplimiento, bodegaNombres, totBodegas, viajes, huboReasignados };
      });
      const totalCamiones = bloquesPorTurno.reduce((s, bt) => s + bt.viajes, 0);
      const totalToneladas = bloquesPorTurno.reduce((s, bt) => s + bt.ton, 0);
      const totalHoras = bloquesPorTurno.reduce((s, bt) => s + bt.horas, 0);
      const rateRealDia = totalHoras > 0 ? totalToneladas / totalHoras : 0;
      const registrosValidos = registrosDia.filter(r => r.tipo !== 'camion_cancha');
      const totBodegasDia = totalesPorBodega(registrosValidos, buque);
      return { fecha, bloquesPorTurno, totalCamiones, totalToneladas, totalHoras, rateRealDia, rateMetaHora, totBodegasDia };
    });
  }

  // Resumen general del buque (arriba de todo el detalle): rate real vs
  // esperado, hora a hora y por día, con el cumplimiento en %. Mismo
  // lenguaje visual que el resumen por turno, para que se lea igual en
  // Supervisor, Gerencia e Histórico.
  function resumenBuqueKpisHTML(r) {
    const cumplClass = !r.rateMetaHora ? 'badge-muted' : r.productividad >= 100 ? 'badge-ok' : r.productividad >= 70 ? 'badge-warn' : 'badge-bad';
    return `
    <div class="cph-turno-kpis" style="grid-template-columns:repeat(5,1fr);">
      <div><span class="l">Rate real (MT/h)</span><span class="v mono">${fmtRate(r.rate)}</span></div>
      <div><span class="l">Rate esp. (MT/h)</span><span class="v mono">${r.rateMetaHora ? fmtRate(r.rateMetaHora) : '—'}</span></div>
      <div><span class="l">Rate real / día</span><span class="v mono">${fmtRate(r.rate * 24)}</span></div>
      <div><span class="l">Horas efectivas</span><span class="v mono">${fmtDuracion(r.horas * 60)}</span></div>
      <div><span class="l">Cumpl.</span><span class="badge ${cumplClass}" style="font-size:13px;">${r.rateMetaHora ? r.productividad.toFixed(0) + '%' : '—'}</span></div>
    </div>`;
  }

  function tablaTotalesBodegaHTML(totBodegas, totCamiones, totToneladas, titulo) {
    if (!totBodegas.length) return '';
    const filas = totBodegas.map(x => `<tr><td>${x.nombre}</td><td class="mono">${x.camiones}</td><td class="mono">${fmtTon(x.toneladas)}</td></tr>`).join('');
    return `
      <table class="cph-table cph-totales">
        <thead><tr><th colspan="3">${titulo}</th></tr><tr><th>Bodega</th><th>Camiones</th><th>Ton</th></tr></thead>
        <tbody>${filas}<tr class="cph-total-row"><td>Total</td><td class="mono">${totCamiones}</td><td class="mono">${fmtTon(totToneladas)}</td></tr></tbody>
      </table>`;
  }

  function tablaCamionesPorHoraHTML(turnos, buque, detenciones, soloLectura) {
    const dias = resumenPorDia(turnos, buque, detenciones);
    if (!dias.length) return '<p class="muted" style="font-size:12.5px; padding:6px 0;">Aún sin turnos registrados</p>';
    const rangosTurno = { 1: '00:00–08:00', 2: '08:00–16:00', 3: '16:00–00:00' };
    return dias.map(dia => {
      const fechaFmt = new Date(dia.fecha + 'T00:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: '2-digit', month: 'long' });
      const cumplDiaPct = dia.rateMetaHora ? (dia.rateRealDia / dia.rateMetaHora * 100) : null;
      const cumplDiaClass = cumplDiaPct === null ? 'badge-muted' : cumplDiaPct >= 100 ? 'badge-ok' : cumplDiaPct >= 70 ? 'badge-warn' : 'badge-bad';
      const turnosHtml = dia.bloquesPorTurno.map(bt => {
        const rows = bt.bloques.map(b => {
          const h = parseInt(b.hora.slice(11, 13), 10);
          const rango = `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
          let cumplHtml = '<span class="faint">—</span>';
          if (dia.rateMetaHora > 0) {
            const cumpl = (b.toneladas / dia.rateMetaHora) * 100;
            const cls = cumpl >= 100 ? 'badge-ok' : cumpl >= 70 ? 'badge-warn' : 'badge-bad';
            cumplHtml = `<span class="badge ${cls}">${cumpl.toFixed(0)}%</span>`;
          }
          const alerta = b.reasignado ? ' <span title="Este viaje se guardó en otro turno, se muestra aquí por su hora real">↺</span>' : '';
          return `<tr><td>${rango}${alerta}</td><td>${b.bodega}</td><td class="mono">${b.count}</td><td class="mono">${fmtTon(b.toneladas)}</td><td class="mono faint">${dia.rateMetaHora ? fmtTon(dia.rateMetaHora) : '—'}</td><td>${cumplHtml}</td></tr>`;
        }).join('');
        const cumplClass = bt.cumplimiento === null ? 'badge-muted' : bt.cumplimiento >= 100 ? 'badge-ok' : bt.cumplimiento >= 70 ? 'badge-warn' : 'badge-bad';
        const n = bt.turno.turno;
        return `
        <div class="cph-turno">
          <div class="cph-turno-head">
            <div>
              <span class="cph-turno-n">Turno ${n}</span>
              <span class="faint" style="font-size:11.5px;"> · ${rangosTurno[n] || ''} ${bt.bodegaNombres.length ? '· ' + bt.bodegaNombres.join(', ') : ''}</span>
              ${bt.huboReasignados ? '<span class="badge badge-warn" style="margin-left:6px;" title="Algún viaje quedó guardado en otro turno; aquí se muestra ordenado por su hora real">↺ reordenado</span>' : ''}
            </div>
            <div style="display:flex; gap:6px;">
              ${soloLectura ? '' : `<button class="btn btn-ghost btn-xs" onclick="HTP.editarTurnoUI('${dia.fecha}',${n},'${buque ? buque.id : ''}','${bt.turno.id || ''}')">✏️ Abrir turno</button>`}
            </div>
          </div>
          <div class="cph-turno-kpis">
            <div><span class="l">Rate real (MT/h)</span><span class="v mono">${fmtRate(bt.rateReal)}</span></div>
            <div><span class="l">Rate esp. (MT/h)</span><span class="v mono">${dia.rateMetaHora ? fmtRate(dia.rateMetaHora) : '—'}</span></div>
            <div><span class="l">Horas</span><span class="v mono">${bt.horas.toFixed(1)}</span></div>
            <div><span class="l">Cumpl.</span><span class="badge ${cumplClass}">${bt.cumplimiento === null ? '—' : bt.cumplimiento.toFixed(0) + '%'}</span></div>
          </div>
          ${rows ? `<table class="cph-table"><thead><tr><th>Hora</th><th>Bodega</th><th>Camiones</th><th>Ton</th><th>Rate esp.</th><th>Cumpl.</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted" style="font-size:12px; padding:6px 0;">Sin viajes con hora registrada</p>'}
          ${tablaTotalesBodegaHTML(bt.totBodegas, bt.viajes, bt.ton, 'Totales del turno por bodega')}
        </div>`;
      }).join('');
      return `
      <div class="cph-dia">
        <div class="cph-dia-head">
          <span class="cph-fecha">${fechaFmt}</span>
          <span class="cph-total mono">${dia.totalCamiones} camiones · ${fmtTon(dia.totalToneladas)} MT</span>
        </div>
        <div class="cph-resumen-dia">
          <div class="cph-mini-title">Resumen del día</div>
          <table class="cph-table">
            <thead><tr><th>Rate real día (MT/h)</th><th>Rate esperado día (MT/h)</th><th>Horas día</th><th>Cumpl. día</th></tr></thead>
            <tbody><tr>
              <td class="mono">${fmtRate(dia.rateRealDia)}</td>
              <td class="mono faint">${dia.rateMetaHora ? fmtRate(dia.rateMetaHora) : '—'}</td>
              <td class="mono">${dia.totalHoras.toFixed(1)}</td>
              <td><span class="badge ${cumplDiaClass}">${cumplDiaPct === null ? '—' : cumplDiaPct.toFixed(0) + '%'}</span></td>
            </tr></tbody>
          </table>
          ${tablaTotalesBodegaHTML(dia.totBodegasDia, dia.totalCamiones, dia.totalToneladas, 'Totales del día por bodega')}
        </div>
        ${turnosHtml}
      </div>`;
    }).join('');
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
    if (b.remate && b.remate.fecha) return 'rematada';
    if (!b.tonAcumulado) return 'pendiente';
    if (avanceBodega(b) >= 100) return 'finalizada';
    return 'trabajando';
  }

  async function marcarBodegaRemate(buqueId, bodegaId, fechaISO) {
    const patch = {};
    patch[`bodegas.${bodegaId}.remate`] = { fecha: fechaISO || new Date().toISOString() };
    await col('buques').doc(buqueId).update(patch);
  }
  async function quitarBodegaRemate(buqueId, bodegaId) {
    const patch = {};
    patch[`bodegas.${bodegaId}.remate`] = null;
    await col('buques').doc(buqueId).update(patch);
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

  // ETC de una bodega específica (para planificar cuándo conviene cambiar de
  // bodega): usa el rate general que se está llevando en el buque como
  // referencia — si sigue así de rápido, esta bodega se acaba en X horas.
  function calcularProyeccionBodega(bodega, rateGeneralMTh) {
    const objetivo = Number(bodega.tonObjetivo) || 0;
    const acumulado = Number(bodega.tonAcumulado) || 0;
    const restante = Math.max(0, objetivo - acumulado);
    if (bodega.remate && bodega.remate.fecha) return { restante: 0, horasRestantes: 0, etc: null, rematada: true };
    if (!rateGeneralMTh || rateGeneralMTh <= 0 || restante <= 0) return { restante, horasRestantes: restante > 0 ? null : 0, etc: null, rematada: false };
    const horasRestantes = restante / rateGeneralMTh;
    const etc = new Date(Date.now() + horasRestantes * 3600000).toISOString();
    return { restante, horasRestantes, etc, rematada: false };
  }

  function fmtProyeccionBadge(diferenciaHoras) {
    if (diferenciaHoras === null) return '';
    const h = Math.abs(diferenciaHoras).toFixed(1);
    return diferenciaHoras >= 0
      ? `<span class="badge badge-ok">+${h} h adelanto</span>`
      : `<span class="badge badge-bad">-${h} h atraso</span>`;
  }

  // Un buque no puede estar "operando" si todavía no atraca — antes de eso
  // no hay rate, atraso ni ETC que tengan sentido.
  function estaAtracado(buque) {
    return !!(buque && buque.atraque && buque.atraque.fecha);
  }
  function badgeEstadoBuque(buque) {
    if (buque.estado === 'gira') return '<span class="badge badge-warn">En gira</span>';
    if (!estaAtracado(buque)) return '<span class="badge badge-muted">⏳ Sin atracar</span>';
    return '<span class="badge badge-ok">Operando</span>';
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

  // Si un turno no tiene horas efectivas cargadas manualmente, se asumen las
  // 8 horas del turno — salvo que el primer registro real sea más tarde que
  // el inicio nominal del turno (partió atrasado), y se descuentan las
  // detenciones que afecten rate y se solapen con la ventana del turno.
  // Mientras el turno sigue abierto, se cuenta hasta el ÚLTIMO REGISTRO real
  // (no hasta "ahora"), para no inflar las horas con tiempo de espera del
  // próximo camión — ej: si el último viaje fue a las 06:30, son 6.5h
  // trabajadas, no las horas que hayan pasado desde entonces hasta ahora.
  function horasDefaultTurno(t, detenciones) {
    if (t.horasEfectivas !== null && t.horasEfectivas !== undefined && t.horasEfectivas !== '') return Number(t.horasEfectivas);
    const inicios = { 1: '00:00', 2: '08:00', 3: '16:00' };
    const nominalInicio = new Date(t.fecha + 'T' + (inicios[t.turno] || '00:00') + ':00');
    const nominalFin = new Date(nominalInicio.getTime() + 8 * 3600000);
    const tsRegistros = (t.registros || []).map(r => new Date(r.ts)).filter(d => !isNaN(d)).sort((a, b) => a - b);
    const primerTs = tsRegistros[0];
    const ultimoTs = tsRegistros[tsRegistros.length - 1];
    const inicioEfectivo = (primerTs && primerTs > nominalInicio) ? primerTs : nominalInicio;
    let fin;
    if (t.estado === 'abierto') {
      if (!ultimoTs) return 0; // turno abierto sin ningún registro aún: nada que contar todavía
      fin = ultimoTs > inicioEfectivo ? ultimoTs : inicioEfectivo;
    } else {
      fin = nominalFin;
    }
    let horas = Math.max(0, Math.min((fin - inicioEfectivo) / 3600000, 8));
    if (detenciones && detenciones.length) {
      const minutos = detenciones.filter(d => d.afectaRate).reduce((s, d) => {
        const di = new Date(d.horaInicio);
        const df = d.horaTermino ? new Date(d.horaTermino) : fin;
        const solapIni = di > inicioEfectivo ? di : inicioEfectivo;
        const solapFin = df < fin ? df : fin;
        const mins = Math.max(0, (solapFin - solapIni) / 60000);
        const manos = Number(d.manos) || 1; // 2 manos trabajando en paralelo: solo se pierde la mitad de la capacidad
        return s + (mins / manos);
      }, 0);
      horas = Math.max(0, horas - minutos / 60);
    }
    return horas;
  }

  // Rendimiento "real" del puerto: suma de toneladas y horas efectivas por turno
  // (igual metodología que la planilla de rendimiento bruto/neto en papel).
  // Incluye turnos abiertos (en curso) para que el rendimiento se vea al momento,
  // no solo una vez cerrado y aprobado el turno. `detenciones` es opcional.
  function calcularRendimientoPorTurnos(buque, turnos, detenciones) {
    const validos = (turnos || []).filter(t => t.estado === 'aprobado' || t.estado === 'pendiente' || t.estado === 'abierto');
    const ton = validos.reduce((s, t) => s + (Number(t.totalToneladas) || 0), 0);
    const horas = validos.reduce((s, t) => s + horasDefaultTurno(t, detenciones), 0);
    const rate = horas > 0 ? ton / horas : 0;
    const rateMetaHora = buque && buque.rateMeta > 0 ? buque.rateMeta / 24 : 0;
    const productividad = rateMetaHora > 0 ? (rate / rateMetaHora) * 100 : 0;
    return { ton, horas, rate, rateMetaHora, productividad, turnos: validos.length };
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
    BODEGAS_BASE, bodegasIniciales, bodegasOrdenadas, nuevaBodega,
    listenBuques, listenBuque, crearBuque, actualizarBuque, ajustarBodega, setBodegaAbsoluto,
    cerrarBuque, reabrirBuque, pausarGira, reanudarDeGira, eliminarBuque,
    turnoDocId, listenTurnosDeBuque, listenTurnosAbiertos, listenTodosTurnos, abrirTurno, agregarRegistro, agregarRegistroCancha, eliminarRegistro, editarRegistro, horaDuplicada, horaFueraDeTurno, rangoTurnoTexto, cerrarTurno, aprobarTurno, cerrarYAprobarTurno, rechazarTurno, crearTurnoHistorico, eliminarTurnoCompleto, editarTurnoUI, abrirModalEditarTurnoPorId, guardarEdicionTurno, confirmarEliminarTurno,
    listenCamiones, guardarCamion, eliminarCamion,
    listenDetenciones, listenTodasDetenciones, crearDetencion, editarDetencion, cerrarDetencion, eliminarDetencion,
    totalToneladas, sumarAcero, avanceBodega, estadoBodega, marcarBodegaRemate, quitarBodegaRemate, calcularTiempos, calcularRates, calcularRendimientoPorTurnos, calcularProyeccion, calcularProyeccionBodega, fmtProyeccionBadge, estaAtracado, badgeEstadoBuque, camionesPorHora, resumenPorDia, tablaCamionesPorHoraHTML, resumenBuqueKpisHTML,
    fmtTon, fmtRate, fmtPct, fmtDuracion, fmtFechaHora, fmtHora, fmtBloqueHora, fechaLocalCorta, hoyISO, turnoActualNum, wireHorasRapidas,
    toast, openModal, closeModal, confirmar
  };
})();
