/* ════════════════════════════════════════════════════════════════
   MERCADO PAGO POINT — cobro con terminal física
   Multi-negocio (TENANT) y multi-caja (device_id en localStorage).

   Cárgalo DESPUÉS de app.js:
     <script src="mp-point.js?v=20261010i"></script>

   Usa los globales de app.js: S, TENANT, MOD, dbRoot, FS, g, fmt,
   showToast, beep, confirmAction, horaSegura, isOnline, nombreNegocio,
   nombreCajeroActual, renderCart, showPaymentModal, hidePayModal,
   openHardwareModal y finalizarVenta.

   Flujo:
     processPayment()  ── tarjeta/mixto ──►  iniciarCobroTerminal(pago)
        └► crea negocios/{TENANT}/payment_intents/{id} (status: pending)
        └► Cloud Function lo manda a la terminal (status: sent)
        └► Webhook de MP lo marca paid / rejected / canceled…
        └► onSnapshot aquí: paid → finalizarVenta() → ticket
════════════════════════════════════════════════════════════════ */

const MP_PEND_KEY        = 'posMpPendiente_v1';   // cobros sin resolver (sobreviven a recargar la página)
const MP_FINALES         = ['paid','rejected','canceled','error','expired'];
const MP_EN_CURSO        = ['pending','sending','sent'];
const MP_ID_RE           = /^[A-Za-z0-9_-]{6,80}$/;
const MP_OCULTAR_TRAS_MS = 45000;                 // a los 45 s se ofrece "seguir sin esperar"

S.mpCobro       = null;       // cobro que tiene la caja bloqueada ahora: {id, deviceId, amount, pago, desde}
S.mpUltimo      = null;       // último cobro terminado sin éxito (para mostrar el resultado)
S.mpUltimoDato  = null;       // último snapshot del cobro activo
S.mpUnsubs      = {};         // listeners por cobro
S.mpRegistrados = new Set();  // cobros ya convertidos en venta en esta sesión

const mpCol    = () => dbRoot.collection('negocios').doc(TENANT).collection('payment_intents');
const mpDevKey = () => 'posMpDevice_v1:' + (TENANT || '');   // por negocio: el mismo navegador puede entrar a otro
function mpModuloActivo(){ return !!(MOD && MOD.mercadopago === true); }

/* ════════════════════════════════════
   1-2) TERMINAL ASIGNADA A ESTA CAJA
════════════════════════════════════ */
function leerTerminalMP(){
  try{ return (localStorage.getItem(mpDevKey()) || '').trim(); }catch(e){ return ''; }
}
function guardarTerminalMP(){
  if(!TENANT){ showToast('Inicia sesión primero','warning'); return; }

  /* Comisiones por pago con tarjeta (débito/crédito y vales): solo el dueño las cambia */
  let pctMsg = '';
  if(S.isAdmin && g('mp_comision')){
    const leer = id => {
      const raw = String(g(id)?.value || '').trim().replace(',', '.');
      const n = raw === '' ? 0 : Number(raw);
      return (isFinite(n) && n >= 0 && n <= COMISION_TARJETA_MAX) ? Math.round(n * 100) / 100 : null;
    };
    const pctT = leer('mp_comision');
    const pctV = g('mp_comisionVales') ? leer('mp_comisionVales') : comisionValesPct();
    if(pctT === null || pctV === null){
      showToast('Cada comisión debe ser un número entre 0 y ' + COMISION_TARJETA_MAX + ' %','error'); beep('error'); return;
    }
    try{
      localStorage.setItem(comisionTarjetaKey(), String(pctT));
      localStorage.setItem(comisionValesKey(),   String(pctV));
    }catch(e){ showToast('No se pudo guardar en este navegador','error'); return; }
    pctMsg = ' · tarjeta ' + pctT + ' % · vales ' + pctV + ' %';
  }

  const v = (g('mp_deviceId').value || '').replace(/\s+/g,'');
  if(!v){
    try{ localStorage.removeItem(mpDevKey()); }catch(e){}
    pintarTerminalMP();
    showToast(pctMsg ? 'Guardado' + pctMsg + '. Esta caja no tiene terminal asignada.' : 'Esta caja ya no tiene terminal asignada','info');
    return;
  }
  if(!MP_ID_RE.test(v) || !v.includes('__')){
    showToast('Ese ID no parece de una terminal. Formato: MODELO__NUMERODESERIE','error'); beep('error'); return;
  }
  try{ localStorage.setItem(mpDevKey(), v); }
  catch(e){ showToast('No se pudo guardar en este navegador','error'); return; }
  pintarTerminalMP();
  showToast('Terminal asignada a esta caja' + pctMsg + ' ✅','success');
}
function olvidarTerminalMP(){
  try{ localStorage.removeItem(mpDevKey()); }catch(e){}
  if(g('mp_deviceId')) g('mp_deviceId').value = '';
  pintarTerminalMP();
  showToast('Esta caja ya no tiene terminal asignada','info');
}
function pintarTerminalMP(){
  const box = g('mpTerminalBox'); if(!box) return;
  const on = mpModuloActivo();
  box.classList.toggle('hidden', !on);
  if(!on) return;
  const dev = leerTerminalMP();
  const inp = g('mp_deviceId');
  if(inp && document.activeElement !== inp) inp.value = dev;
  const st = g('mpTerminalStatus');
  st.textContent = dev
    ? 'Asignada a esta caja. Las ventas con tarjeta y mixtas se cobran en ella.'
    : 'Sin terminal: esta caja no podrá cobrar con tarjeta ni mixto.';
  st.className = 'text-xs ' + (dev ? 'text-emerald-600' : 'text-amber-600');
  g('mpTerminalDot').className = 'w-2.5 h-2.5 rounded-full shrink-0 ' + (dev ? 'bg-emerald-400' : 'bg-gray-300');

  /* Comisiones: el dueño las edita; el vendedor solo las ve */
  [['mp_comision', comisionTarjetaPct()], ['mp_comisionVales', comisionValesPct()]].forEach(([id, val]) => {
    const inp = g(id); if(!inp) return;
    if(document.activeElement !== inp) inp.value = val;
    inp.disabled = !S.isAdmin;
    inp.classList.toggle('opacity-60', !S.isAdmin);
  });
  const hint = g('mp_comisionHint');
  if(hint){
    hint.textContent = S.isAdmin
      ? 'Al cobrar, el cajero elige «Débito / crédito» o «Vales» y se suma ese porcentaje (en mixto, solo a la parte con tarjeta). Pon 0 para no cobrar comisión.'
      : 'Solo el dueño del negocio puede cambiar estos porcentajes.';
  }
}

/* Cobros pendientes en este dispositivo */
function leerPendMP(){ try{ return JSON.parse(localStorage.getItem(MP_PEND_KEY) || '{}') || {}; }catch(e){ return {}; } }
function guardarPendMP(id, data){
  const p = leerPendMP();
  if(data) p[id] = data; else delete p[id];
  try{ localStorage.setItem(MP_PEND_KEY, JSON.stringify(p)); }catch(e){}
}

/* ════════════════════════════════════
   2) INICIAR EL COBRO (lo llama processPayment)
════════════════════════════════════ */
async function iniciarCobroTerminal(pago){
  if(S.mpCobro){ mostrarEsperaMP(); return; }

  const deviceId = leerTerminalMP();
  if(!deviceId){
    beep('error');
    showToast('Esta caja no tiene terminal de Mercado Pago. Asígnala en Hardware o cobra en efectivo.','warning');
    openHardwareModal();
    return;
  }
  if(!isOnline()){
    beep('error');
    showToast('Sin internet no se puede cobrar con la terminal. Cobra en efectivo o espera la conexión.','error');
    return;
  }
  const amount = Math.round((Number(pago.cardPortion) || 0) * 100) / 100;
  if(!(amount >= 1)){ showToast('El monto con tarjeta debe ser de al menos $1','warning'); return; }

  const ref = mpCol().doc();
  const id  = ref.id;
  pago.localId = 'mp_' + id;   // la venta usará este id: si algo se repite, no se duplica

  /* Se guarda ANTES de escribir en Firestore: si se recarga la página
     a media espera, el cobro se retoma y la venta no se pierde. */
  guardarPendMP(id, { id, tenant:TENANT, deviceId, amount, pago, ts:Date.now() });
  S.mpCobro = { id, deviceId, amount, pago, desde:Date.now() };
  S.mpUltimo = null; S.mpUltimoDato = { status:'pending' };
  mostrarEsperaMP();
  escucharCobroMP(id);

  /* Sin await: con la persistencia offline la promesa no resuelve hasta que el
     servidor confirma. El listener ya refleja el estado; aquí solo se atrapa
     un rechazo real (por ejemplo, reglas de Firestore). */
  ref.set({
    status:'pending',
    amount, deviceId,
    payMethod: pago.payMethod,
    total: pago.total,
    cashPortion: pago.cashPortion || 0,
    description: ('Venta ' + nombreNegocio()).slice(0, 140),
    createdBy: S.user.uid,
    createdByName: nombreCajeroActual() || S.user.email || '',
    branchId: S.userBranchId || null,
    branchName: S.userBranchName || null,
    caja: S.tid || null,
    clientTs: Math.round(horaSegura() || Date.now()),   // hora del servidor, no la del dispositivo
    cancelRequested: false,
    createdAt: FS.FieldValue.serverTimestamp()
  }).catch(e => {
    console.error('payment_intent:', e);
    terminarCobroMP(id, { status:'error', error: e.code === 'permission-denied'
      ? 'Las reglas de Firestore no permiten crear el cobro (payment_intents).'
      : 'No se pudo enviar el cobro: ' + e.message });
  });
}

/* ════════════════════════════════════
   5) LISTENER EN TIEMPO REAL
════════════════════════════════════ */
function escucharCobroMP(id){
  if(S.mpUnsubs[id]) return;
  S.mpUnsubs[id] = mpCol().doc(id).onSnapshot(snap => {
    if(!snap.exists) return;
    const d = snap.data();
    if(S.mpCobro && S.mpCobro.id === id){ S.mpUltimoDato = d; pintarEsperaMP(d); }
    if(d.status === 'paid') registrarCobroMP(id, d, false);
    else if(MP_FINALES.includes(d.status)) terminarCobroMP(id, d);
    /* 'review' se queda escuchando: el webhook todavía puede confirmarlo */
  }, err => console.warn('Cobro con terminal:', err.code || err.message));
}
function soltarCobroMP(id){
  try{ S.mpUnsubs[id] && S.mpUnsubs[id](); }catch(e){}
  delete S.mpUnsubs[id];
}

/* paid → registrar la venta con la lógica existente + ticket */
async function registrarCobroMP(id, d, manual){
  if(S.mpRegistrados.has(id)) return;
  const pend = leerPendMP()[id];
  soltarCobroMP(id);
  const esActual = !!(S.mpCobro && S.mpCobro.id === id);
  if(!pend){                                   // ya se había registrado antes (otra pestaña / recarga)
    if(esActual){ S.mpCobro = null; ocultarModalMP(); }
    return;
  }
  S.mpRegistrados.add(id);
  if(esActual){ S.mpCobro = null; ocultarModalMP(); }

  const pago = { ...pend.pago, mp: {
    intentId: id, mpId: d.mpId || null, api: d.mpApi || null,
    paymentId: d.paymentId || null, deviceId: pend.deviceId,
    monto: pend.amount, tarjeta: d.tipoTarjeta || null, manual: !!manual
  }};
  if(!esActual) showToast('La terminal aprobó un cobro pendiente: venta registrada ✅','success');

  /* Mismo camino que una venta normal: outbox, stock, turno, pantalla al cliente,
     recibo e impresión automática (si la impresora está conectada). */
  await finalizarVenta(pago, { limpiarCarrito: esActual });
  guardarPendMP(id, null);
}

/* rejected / canceled / error / expired → liberar la caja y mostrar el motivo */
function terminarCobroMP(id, d){
  soltarCobroMP(id);
  guardarPendMP(id, null);
  if(S.mpCobro && S.mpCobro.id === id){
    S.mpUltimo = S.mpCobro;
    S.mpCobro = null;
    mostrarEsperaMP(d);
    beep('error');
  } else if(d.status !== 'canceled'){
    showToast('Un cobro pendiente con terminal no se completó: ' + (MP_UI[d.status] || MP_UI.error).t, 'warning');
  }
}

/* ════════════════════════════════════
   VENTANA DE ESPERA
════════════════════════════════════ */
const MP_UI = {
  pending : { t:'Enviando a la terminal…',            m:'Conectando con Mercado Pago.',                                    i:'fa-spinner fa-spin',        c:'bg-sky-100 text-sky-600' },
  sent    : { t:'Pasa la tarjeta en la terminal',      m:'Si el cobro no aparece en la pantalla, toca «Cobrar» en la terminal.', i:'fa-credit-card',       c:'bg-sky-100 text-sky-600' },
  paid    : { t:'Pago aprobado',                       m:'Registrando la venta…',                                           i:'fa-circle-check',           c:'bg-emerald-100 text-emerald-600' },
  rejected: { t:'Pago rechazado',                      m:'Pide otra tarjeta o cobra con otra forma de pago.',               i:'fa-circle-xmark',           c:'bg-red-100 text-red-600' },
  canceled: { t:'Cobro cancelado',                     m:'No se cobró nada.',                                               i:'fa-ban',                    c:'bg-slate-100 text-slate-500' },
  error   : { t:'No se pudo cobrar',                   m:'',                                                                i:'fa-triangle-exclamation',   c:'bg-red-100 text-red-600' },
  expired : { t:'El cobro expiró',                     m:'No se cobró nada. Vuelve a intentarlo.',                          i:'fa-clock',                  c:'bg-amber-100 text-amber-600' },
  review  : { t:'Revisa la pantalla de la terminal',   m:'Mercado Pago no confirmó el resultado. Antes de volver a cobrar, mira en la terminal si el pago salió aprobado.', i:'fa-eye', c:'bg-amber-100 text-amber-600' }
};
MP_UI.sending = MP_UI.pending;

function mostrarEsperaMP(d){
  g('mpWaitModal').classList.remove('hidden');
  pintarEsperaMP(d || S.mpUltimoDato || { status:'pending' });
}
function ocultarModalMP(){ g('mpWaitModal')?.classList.add('hidden'); }

function pintarEsperaMP(d){
  d = d || {};
  const c = S.mpCobro || S.mpUltimo; if(!c) return;
  const st = d.status || 'pending';
  const ui = MP_UI[st] || MP_UI.sent;
  const activo  = !!(S.mpCobro && S.mpCobro.id === c.id);
  const enCurso = MP_EN_CURSO.includes(st);

  const cancelando  = enCurso && !!d.cancelRequested;
  const espera      = Date.now() - c.desde;
  const consultando = !!S.mpVerificando && Date.now() - S.mpVerificando < 8000;

  let msg = st === 'error' ? (d.error || 'Error desconocido.') : ui.m;
  if(st === 'rejected' && d.statusDetail) msg += ' (' + d.statusDetail + ')';
  if(d.nota) msg += ' ' + d.nota;
  if(cancelando) msg = d.cancelError || d.cancelNota || 'Cancelando el cobro…';
  else if(enCurso && d.cancelError) msg = d.cancelError;
  if(enCurso && consultando) msg = 'Consultando a Mercado Pago…';

  g('mpWaitIcon').className = 'w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl mb-3 ' + ui.c;
  g('mpWaitIcon').innerHTML = '<i class="fa-solid ' + ui.i + '"></i>';
  g('mpWaitTitle').textContent  = ui.t;
  g('mpWaitMsg').textContent    = msg;
  g('mpWaitAmount').textContent = fmt(c.amount);
  g('mpWaitDevice').textContent = (c.pago.payMethod === 'mixed' ? 'Efectivo aparte: ' + fmt(c.pago.cashPortion) + ' · ' : '')
                                + 'Terminal ' + c.deviceId;

  const ver = (id, on) => g(id)?.classList.toggle('hidden', !on);
  ver('mpWaitCancel',  activo && enCurso && !d.cancelRequested);
  /* "Ya lo cancelé" / "Verificar": le pide al servidor que le pregunte a Mercado Pago.
     Solo tiene sentido cuando el cobro ya llegó a Mercado Pago (status sent). */
  ver('mpWaitCheck',   activo && st === 'sent' && (cancelando || espera > 20000));
  if(g('mpWaitCheckLbl')) g('mpWaitCheckLbl').textContent = cancelando ? 'Ya lo cancelé en la terminal' : 'Verificar con Mercado Pago';
  if(g('mpWaitCheck')) g('mpWaitCheck').disabled = consultando;
  ver('mpWaitManual',  activo && st === 'review');
  ver('mpWaitDiscard', activo && st === 'review');
  ver('mpWaitRetry',   !activo && st !== 'paid');
  ver('mpWaitClose',   !activo && st !== 'paid');
  /* Salida que nunca falta: si se pidió cancelar, de inmediato; si no, a los 45 s */
  ver('mpWaitHide',    activo && enCurso && (cancelando || espera > MP_OCULTAR_TRAS_MS));
  if(g('mpWaitHideLbl')) g('mpWaitHideLbl').textContent = cancelando
    ? 'Cerrar y cobrar de otra forma'
    : 'La terminal no responde · seguir sin esperar';
}
/* Revisa cada 5 s para mostrar el botón de "seguir sin esperar" */
setInterval(() => {
  if(S.mpCobro && !g('mpWaitModal')?.classList.contains('hidden')) pintarEsperaMP(S.mpUltimoDato);
}, 5000);

/* ── Botones ── */
async function cancelarCobroMP(){
  const c = S.mpCobro; if(!c) return;
  try{
    await mpCol().doc(c.id).update({ cancelRequested:true, cancelRequestedAt: FS.FieldValue.serverTimestamp() });
  }catch(e){ showToast('No se pudo pedir la cancelación: ' + (e.code || e.message),'error'); }
}
/* "Ya lo cancelé en la terminal" / "Verificar con Mercado Pago" */
async function verificarCobroMP(){
  const c = S.mpCobro; if(!c) return;
  S.mpVerificando = Date.now();
  pintarEsperaMP(S.mpUltimoDato);
  try{
    await mpCol().doc(c.id).update({ checkRequestedAt: FS.FieldValue.serverTimestamp() });
  }catch(e){
    S.mpVerificando = 0;
    showToast('No se pudo consultar: ' + (e.code || e.message),'error');
  }
  setTimeout(() => { if(S.mpCobro && S.mpCobro.id === c.id) pintarEsperaMP(S.mpUltimoDato); }, 8200);
}
/* Tras un rechazo: volver a la ventana de cobro (que sigue abierta debajo) */
function reintentarCobroMP(){
  const c = S.mpUltimo; S.mpUltimo = null;
  ocultarModalMP();
  if(g('payModal').classList.contains('hidden') && S.cart.length) showPaymentModal(c?.pago?.payMethod || 'cash');
}
function cerrarEsperaMP(){ S.mpUltimo = null; ocultarModalMP(); }

/* Estado "review": el cajero confirma lo que dice la pantalla de la terminal */
async function registrarManualMP(){
  const c = S.mpCobro; if(!c) return;
  const ok = await confirmAction({ title:'¿La terminal dice APROBADO?',
    msg:'Solo confírmalo si viste el pago aprobado en la pantalla de la terminal. La venta quedará marcada como confirmada a mano.',
    okLabel:'Sí, registrar venta', icon:'💳' });
  if(ok) registrarCobroMP(c.id, S.mpUltimoDato || {}, true);
}
async function descartarRevisionMP(){
  const c = S.mpCobro; if(!c) return;
  const ok = await confirmAction({ title:'¿La terminal NO cobró?',
    msg:'La caja se libera para cobrar de otra forma. Si después Mercado Pago confirma el pago, no se registrará solo.',
    okLabel:'No se cobró', icon:'🚫' });
  if(!ok) return;
  soltarCobroMP(c.id); guardarPendMP(c.id, null);
  S.mpCobro = null; ocultarModalMP();
}

/* La terminal no responde (webhook mal configurado, terminal apagada…) */
async function ocultarEsperaMP(){
  const c = S.mpCobro; if(!c) return;
  const p = leerPendMP();
  const marcarOculto = () => {
    if(p[c.id]){ p[c.id].oculto = true; try{ localStorage.setItem(MP_PEND_KEY, JSON.stringify(p)); }catch(e){} }
  };

  if(S.mpUltimoDato && S.mpUltimoDato.cancelRequested){
    /* Ya se pidió cancelar: se libera la caja SIN vaciar el carrito,
       para cobrar los mismos productos en efectivo o con otra tarjeta. */
    const ok = await confirmAction({ title:'¿Ya no aparece el cobro en la terminal?',
      msg:'Revisa que la pantalla de la terminal ya NO muestre el monto.\n\n'
        + 'La caja se libera para cobrar de otra forma. Si la terminal llegara a cobrar de todos modos, esa venta se registrará sola.',
      okLabel:'Sí, cobrar de otra forma', icon:'💳' });
    if(!ok) return;
    marcarOculto();
    S.mpCobro = null;          // el listener sigue vivo en segundo plano
    ocultarModalMP();          // la ventana de cobro sigue abierta debajo: elige Efectivo
    showToast('Caja liberada. Elige otra forma de pago.','info');
    return;
  }

  const ok = await confirmAction({ title:'¿Seguir sin esperar a la terminal?',
    msg:'El cobro queda pendiente: si la terminal lo aprueba, la venta se registra sola.\n\n'
      + 'Por seguridad se vacía el carrito. NO vuelvas a cobrar estos productos hasta revisar la terminal.',
    okLabel:'Seguir sin esperar', icon:'⏳' });
  if(!ok) return;
  marcarOculto();
  S.mpCobro = null;            // el listener sigue vivo en segundo plano
  ocultarModalMP(); hidePayModal();
  S.cart = []; S.discount = null; renderCart();
  showToast('Cobro en segundo plano. Te avisaremos cuando la terminal responda.','info');
}

/* ════════════════════════════════════
   REANUDAR al abrir el POS (página recargada a media espera)
════════════════════════════════════ */
function reanudarCobroTerminal(){
  if(!TENANT || window._phoneMode || window._displayMode) return;
  if(!S.user){ setTimeout(reanudarCobroTerminal, 800); return; }   // espera a que termine el login
  const ahora = Date.now();
  const mios = Object.values(leerPendMP()).filter(x => x && x.tenant === TENANT);
  mios.forEach(x => {
    if(ahora - x.ts > 24 * 3600e3){ guardarPendMP(x.id, null); return; }
    escucharCobroMP(x.id);
  });
  const ultimo = mios.filter(x => !x.oculto && ahora - x.ts <= 24 * 3600e3).sort((a,b) => b.ts - a.ts)[0];
  if(ultimo && !S.mpCobro){
    S.mpCobro = { id:ultimo.id, deviceId:ultimo.deviceId, amount:ultimo.amount, pago:ultimo.pago, desde:ultimo.ts };
    mostrarEsperaMP();
  }
}
