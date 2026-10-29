/* ════════════════════════════════════════════════════════════════
   VENTAS DEL TURNO · DEVOLUCIONES · CAMBIOS
   Cárgalo DESPUÉS de app.js:
     <script src="devoluciones.js?v=..."></script>

   ─ El vendedor ve SOLO las ventas de su turno abierto (si el negocio
     no usa turnos: solo las suyas de hoy). Puede reimprimir el ticket
     y hacer devoluciones o cambios. El dueño, además, desde el
     historial del panel puede devolver cualquier venta.
   ─ Devolución en efectivo: se registra como una venta NEGATIVA
     (sale dinero del cajón). Así el corte, las métricas, el historial y
     el inventario se cuadran solos, con o sin internet.
   ─ Cambio: lo devuelto entra al carrito como «saldo a favor» y el
     cajero agrega lo nuevo; se cobra (o se entrega) la diferencia.
   ─ Lo devuelto regresa al inventario (salvo que esté dañado) y queda
     anotado en la venta original para no devolverlo dos veces.
   ─ Con tarjeta también se devuelve en EFECTIVO (decisión del negocio).
════════════════════════════════════════════════════════════════ */

const VT = { lista: [], sel: null, cargando: false };
const DV = { sale: null, qty: {}, regresa: true };
const DEV_MOTIVOS = ['Producto dañado', 'Caducado', 'Se equivocó de producto', 'No le gustó', 'Cobro equivocado'];

const folioVenta = s => String(s?.localId || s?.id || '').slice(-6).toUpperCase();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const horaVenta = s => {
  const d = s?.tsISO ? new Date(s.tsISO) : (s?.timestamp?.toDate?.() || null);
  return d ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
};
const fechaVenta = s => {
  const d = s?.tsISO ? new Date(s.tsISO) : (s?.timestamp?.toDate?.() || null);
  return d ? d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};
const metodoVenta = s => (s.total || 0) < 0 && !(s.items || []).some(i => !i.isCredit) ? '↩️ Devolución'
  : s.payMethod === 'card' ? (s.tipoTarjeta === 'vales' ? '🎫 Vales' : '💳 Tarjeta')
  : s.payMethod === 'mixed' ? '🔀 Mixto' : '💵 Efectivo';

/* ════════════════════════════════════
   LISTA: ventas de mi turno
════════════════════════════════════ */
async function abrirVentasTurno(){
  if(!S.user){ showLoginModal(); return; }
  g('ventasTurnoModal').classList.remove('hidden');
  g('vt_buscar').value = '';
  VT.sel = null;
  pintarVentasTurno();
  await cargarVentasTurno();
}
function cerrarVentasTurno(){ g('ventasTurnoModal')?.classList.add('hidden'); }

async function cargarVentasTurno(){
  if(VT.cargando) return;
  VT.cargando = true;
  const sh = S.currentShift;
  g('vt_sub').textContent = sh?.id
    ? 'Turno abierto ' + (sh.openISO ? 'desde las ' + new Date(sh.openISO).toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'}) : '')
    : 'Tus ventas de hoy';
  g('vt_lista').innerHTML = '<p class="text-center text-slate-400 py-10"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Cargando…</p>';
  try{
    const hoy = localDateStr();
    const q = sh?.id ? db.collection('sales').where('shiftId', '==', sh.id)
                     : db.collection('sales').where('date', '==', hoy);
    const snap = await withTimeout(q.get(), 15000);
    let lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(!sh?.id) lista = lista.filter(x => x.sellerId === S.user.uid);
    /* Ventas que siguen en el dispositivo (sin subir todavía) */
    const ids = new Set(lista.map(x => x.id));
    loadOutbox().filter(o => o.type === 'sale' && o.payload && !ids.has(o.id) && (
      sh?.id ? o.payload.shiftId === sh.id : (o.payload.sellerId === S.user.uid && o.payload.date === hoy)
    )).forEach(o => lista.push({ ...o.payload, id: o.id, _pendiente: !o.saleSaved }));
    lista.sort((a, b) => String(b.tsISO || '').localeCompare(String(a.tsISO || '')));
    VT.lista = lista;
  }catch(e){
    VT.lista = [];
    g('vt_lista').innerHTML = `<p class="text-center text-red-500 py-10 text-sm">No se pudieron cargar las ventas: ${esc(e.message)}.<br>Revisa el internet e intenta de nuevo.</p>`;
    VT.cargando = false;
    return;
  }
  VT.cargando = false;
  if(VT.sel) VT.sel = VT.lista.find(x => x.id === VT.sel.id) || null;
  pintarVentasTurno();
}

/* Unidades que quedan por devolver de un renglón */
function restanteDevolver(sale, idx){
  const it = (sale.items || [])[idx]; if(!it) return 0;
  const ya = Number((sale.devuelto || {})[idx]) || 0;
  /* lo que ya está en el carrito como saldo a favor (cambio a medias) */
  const enCarrito = S.cart.filter(c => c.isCredit && c.devolucion?.saleId === sale.id)
    .reduce((n, c) => n + (c.devolucion.items || []).filter(r => r.idx === idx).reduce((m, r) => m + (Number(r.qty) || 0), 0), 0);
  return round3(Math.max(0, (Number(it.quantity) || 0) - ya - enCarrito));
}
const esDevolvible = it => it && !it.isRecharge && !it.isCredit;
function puedeDevolver(sale){
  if(!sale || sale.voided) return false;
  return (sale.items || []).some((it, i) => esDevolvible(it) && restanteDevolver(sale, i) > 0);
}

function pintarVentasTurno(){
  const cont = g('vt_lista'); if(!cont) return;
  if(VT.sel){ pintarDetalleTurno(VT.sel); return; }
  g('vt_detalle').classList.add('hidden');
  g('vt_listaWrap').classList.remove('hidden');
  const q = sinAcentos(g('vt_buscar').value || '').trim();
  const lista = VT.lista.filter(s => !q
    || folioVenta(s).toLowerCase().includes(q)
    || String(s.total || '').includes(q)
    || (s.items || []).some(it => sinAcentos(it.name).includes(q)));
  const totalTurno = VT.lista.filter(s => !s.voided).reduce((n, s) => n + (Number(s.total) || 0), 0);
  g('vt_resumen').textContent = VT.lista.length ? `${VT.lista.length} movimiento${VT.lista.length === 1 ? '' : 's'} · ${fmt(totalTurno)}` : '';
  if(!lista.length){
    cont.innerHTML = `<p class="text-center text-slate-400 py-10 text-sm"><i class="fa-solid fa-receipt text-3xl block mb-2 text-slate-300"></i>${VT.lista.length ? 'Ninguna venta coincide.' : 'Todavía no hay ventas en este turno.'}</p>`;
    return;
  }
  cont.innerHTML = lista.map(s => {
    const devTotal = r2(s.montoDevuelto && !s.devolucion ? s.montoDevuelto : 0);
    const chips = [
      s.voided ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600">Anulada</span>' : '',
      s._pendiente ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Sin subir</span>' : '',
      s.devolucion ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">${(s.items||[]).some(i=>!i.isCredit) ? 'Cambio' : 'Devolución'}</span>` : '',
      devTotal > 0 ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Devuelto ${fmt(devTotal)}</span>` : ''
    ].join(' ');
    const resumen = (s.items || []).filter(i => !i.isCredit).map(i => i.name).join(', ') || (s.items || []).map(i => i.name).join(', ');
    return `<button type="button" onclick="verVentaTurno('${esc(s.id)}')" class="w-full text-left px-3 py-3 hover:bg-slate-50 border-b border-slate-100 flex items-center gap-3 ${s.voided ? 'opacity-60' : ''}">
      <div class="text-center shrink-0 w-14">
        <p class="text-sm font-bold text-slate-700 num">${horaVenta(s)}</p>
        <p class="text-[10px] text-slate-400 font-mono">#${esc(folioVenta(s))}</p>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm text-slate-700 truncate">${esc(resumen)}</p>
        <p class="text-[11px] text-slate-400">${metodoVenta(s)} ${chips}</p>
      </div>
      <p class="text-base font-black num shrink-0 ${(s.total || 0) < 0 ? 'text-red-600' : 'text-slate-900'}">${fmt(s.total || 0)}</p>
      <i class="fa-solid fa-chevron-right text-slate-300 text-xs"></i>
    </button>`;
  }).join('');
}

function verVentaTurno(id){
  VT.sel = VT.lista.find(x => x.id === id) || null;
  pintarVentasTurno();
}
function volverListaTurno(){ VT.sel = null; pintarVentasTurno(); }

function pintarDetalleTurno(s){
  g('vt_listaWrap').classList.add('hidden');
  const box = g('vt_detalle'); box.classList.remove('hidden');
  const filas = (s.items || []).map((it, i) => {
    const ya = Number((s.devuelto || {})[i]) || 0;
    return `<div class="flex justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
      <span class="min-w-0">${it.isPromo ? '<span class="text-[9px] font-black bg-amber-400 text-white px-1 rounded mr-1">PROMO</span>' : ''}${esc(it.name)}
        <span class="text-slate-400 whitespace-nowrap">× ${round3(it.quantity)}${it.isBulk ? ' kg' : ''}</span>
        ${ya > 0 ? `<span class="block text-[11px] text-emerald-700">Devuelto: ${round3(ya)}</span>` : ''}</span>
      <span class="font-semibold num shrink-0 ${(it.subtotal||0) < 0 ? 'text-red-600' : ''}">${fmt(it.subtotal || 0)}</span>
    </div>`;
  }).join('');
  const puede = puedeDevolver(s) && !s._pendiente;
  const motivoNo = s.voided ? 'Esta venta está anulada.'
    : s._pendiente ? 'Esta venta todavía no se sube a internet. Espera unos segundos y vuelve a abrirla.'
    : !puede ? 'Ya no hay nada que devolver de esta venta.' : '';
  box.innerHTML = `
    <button type="button" onclick="volverListaTurno()" class="text-sm text-indigo-600 font-semibold mb-3 min-h-[36px]"><i class="fa-solid fa-arrow-left mr-1"></i>Volver a la lista</button>
    <div class="flex items-start justify-between gap-3 mb-3">
      <div>
        <p class="font-black text-slate-800 text-lg">Venta #${esc(folioVenta(s))}</p>
        <p class="text-xs text-slate-400">${esc(fechaVenta(s))} · ${metodoVenta(s)} · ${esc(s.cashierName || s.sellerName || '')}</p>
      </div>
      <p class="text-xl font-black num ${(s.total || 0) < 0 ? 'text-red-600' : 'text-indigo-700'}">${fmt(s.total || 0)}</p>
    </div>
    <div class="bg-slate-50 rounded-xl px-3 py-1 mb-3">${filas}</div>
    ${motivoNo ? `<p class="text-xs text-slate-500 bg-slate-100 rounded-lg px-3 py-2 mb-3">${esc(motivoNo)}</p>` : ''}
    <div class="grid grid-cols-2 gap-2">
      <button type="button" onclick="reimprimirVentaTurno()" class="bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-semibold text-sm min-h-[48px]"><i class="fa-solid fa-print mr-1.5"></i>Reimprimir</button>
      <button type="button" onclick="abrirDevolucion(VT.sel)" ${puede ? '' : 'disabled'} class="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white py-3 rounded-xl font-bold text-sm min-h-[48px]"><i class="fa-solid fa-rotate-left mr-1.5"></i>Devolución / cambio</button>
    </div>`;
}
function reimprimirVentaTurno(){
  const s = VT.sel; if(!s) return;
  showReceiptModal(s, { imprimir: true });
}

/* ════════════════════════════════════
   VENTANA DE DEVOLUCIÓN
════════════════════════════════════ */
/* Precio real pagado por unidad (si la venta tuvo descuento, se reparte) */
function factorDescuento(sale){
  const bruto = (sale.items || []).filter(i => !i.isCredit).reduce((n, i) => n + (Number(i.subtotal) || 0), 0);
  const desc = Number(sale.discountAmt) || 0;
  return bruto > 0 && desc > 0 ? Math.max(0, (bruto - desc) / bruto) : 1;
}
function abrirDevolucion(sale){
  if(!sale) return;
  if(sale._pendiente){ showToast('Esa venta aún no se sube a internet. Espera unos segundos.','warning'); return; }
  if(!puedeDevolver(sale)){ showToast('Ya no hay nada que devolver de esa venta','info'); return; }
  if(S.mpCobro){ showToast('Espera a que termine el cobro con la terminal','warning'); return; }
  DV.sale = sale; DV.qty = {}; DV.regresa = true;
  g('dv_titulo').textContent = 'Devolución · venta #' + folioVenta(sale);
  g('dv_sub').textContent = `${fechaVenta(sale)} · pagó ${fmt(sale.total || 0)} ${metodoVenta(sale).replace(/^\S+\s/, 'con ').toLowerCase()}`;
  g('dv_regresa').checked = true;
  g('dv_motivo').value = '';
  g('dv_motivos').innerHTML = DEV_MOTIVOS.map(m =>
    `<button type="button" onclick="g('dv_motivo').value='${esc(m)}';pintarDevolucion()" class="text-xs px-2.5 py-1.5 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-slate-600">${esc(m)}</button>`).join('');
  g('dv_tarjeta').classList.toggle('hidden', !((Number(sale.cardPortion) || 0) > 0));
  g('dv_err').classList.add('hidden');
  /* Si solo hay un producto, se propone devolverlo completo */
  const idxs = (sale.items || []).map((it, i) => i).filter(i => esDevolvible(sale.items[i]) && restanteDevolver(sale, i) > 0);
  if(idxs.length === 1) DV.qty[idxs[0]] = restanteDevolver(sale, idxs[0]);
  pintarDevolucion();
  g('devModal').classList.remove('hidden');
}
function cerrarDevolucion(){ g('devModal')?.classList.add('hidden'); }

function dvCambiar(idx, d){
  const it = DV.sale.items[idx]; if(!it) return;
  const max = restanteDevolver(DV.sale, idx);
  let n = round3((Number(DV.qty[idx]) || 0) + d);
  DV.qty[idx] = Math.max(0, Math.min(max, it.isBulk ? n : Math.round(n)));
  pintarDevolucion();
}
function dvEscribir(idx, v){
  const it = DV.sale.items[idx]; if(!it) return;
  const max = restanteDevolver(DV.sale, idx);
  let n = Number(String(v).replace(',', '.')) || 0;
  DV.qty[idx] = Math.max(0, Math.min(max, it.isBulk ? round3(n) : Math.round(n)));
  pintarDevolucion();
}
function dvTodo(){
  (DV.sale.items || []).forEach((it, i) => { if(esDevolvible(it)) DV.qty[i] = restanteDevolver(DV.sale, i); });
  pintarDevolucion();
}

/* Renglones elegidos con su importe */
function dvSeleccion(){
  const s = DV.sale, f = factorDescuento(s);
  return (s.items || []).map((it, i) => {
    const qty = Number(DV.qty[i]) || 0;
    if(!(qty > 0) || !esDevolvible(it)) return null;
    const unit = r2((Number(it.price) || 0) * f);
    return {
      idx: i, barcode: it.barcode, name: it.name, qty: round3(qty), price: unit,
      monto: r2(unit * qty), costo: (Number(it.cost) || 0) * qty,
      isBulk: !!it.isBulk,
      ...(it.isPromo ? { isPromo: true, promoId: it.promoId || null, items: (it.items || []).map(c => ({ barcode: c.barcode, name: c.name, qty: c.qty })) } : {})
    };
  }).filter(Boolean);
}

function pintarDevolucion(){
  const s = DV.sale; if(!s) return;
  const f = factorDescuento(s);
  g('dv_items').innerHTML = (s.items || []).map((it, i) => {
    if(!esDevolvible(it)) return '';
    const max = restanteDevolver(s, i);
    const q = Number(DV.qty[i]) || 0;
    const unit = r2((Number(it.price) || 0) * f);
    return `<div class="flex items-center gap-2 border ${q > 0 ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'} rounded-xl px-2.5 py-2 ${max <= 0 ? 'opacity-50' : ''}">
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold text-slate-800 truncate">${it.isPromo ? '<span class="text-[9px] font-black bg-amber-400 text-white px-1 rounded mr-1">PROMO</span>' : ''}${esc(it.name)}</p>
        <p class="text-[11px] text-slate-400">${fmt(unit)}${it.isBulk ? ' / kg' : ' c/u'} · ${max > 0 ? 'puede devolver ' + round3(max) + (it.isBulk ? ' kg' : '') : 'ya se devolvió todo'}</p>
      </div>
      ${max > 0 ? (it.isBulk
        ? `<input type="number" inputmode="decimal" min="0" max="${max}" step="0.001" value="${q || ''}" placeholder="0" onchange="dvEscribir(${i}, this.value)" class="w-20 text-center border border-slate-200 rounded-lg py-1.5 text-sm font-bold num"><span class="text-xs text-slate-500">kg</span>`
        : `<div class="flex items-center gap-1 shrink-0">
            <button type="button" onclick="dvCambiar(${i},-1)" class="w-8 h-8 rounded-full bg-white border border-slate-200 font-bold">−</button>
            <span class="w-7 text-center font-black num">${q}</span>
            <button type="button" onclick="dvCambiar(${i},1)" class="w-8 h-8 rounded-full bg-white border border-slate-200 font-bold">+</button>
          </div>`) : ''}
    </div>`;
  }).join('');
  const sel = dvSeleccion();
  const total = r2(sel.reduce((n, r) => n + r.monto, 0));
  g('dv_total').textContent = fmt(total);
  g('dv_nota').textContent = f < 1 ? 'La venta tuvo descuento: se devuelve lo que realmente pagó por cada producto.' : '';
  const listo = total > 0;
  g('dv_btnDinero').disabled = !listo;
  g('dv_btnCambio').disabled = !listo;
  g('dv_btnDineroLbl').textContent = listo ? 'Devolver ' + fmt(total) + ' en efectivo' : 'Devolver dinero';
}

/* Arma el renglón de «saldo a favor» */
function dvCredito(tipo){
  const sel = dvSeleccion();
  const err = m => { const e = g('dv_err'); e.textContent = m; e.classList.remove('hidden'); beep('error'); return null; };
  if(!sel.length) return err('Elige qué productos devuelve.');
  const motivo = String(g('dv_motivo').value || '').trim().slice(0, 140);
  if(motivo.length < 3) return err('Escribe el motivo de la devolución (o toca uno de los de arriba).');
  const regresa = !!g('dv_regresa').checked;
  const monto = r2(sel.reduce((n, r) => n + r.monto, 0));
  const costo = regresa ? r2(sel.reduce((n, r) => n + r.costo, 0)) : 0;
  const s = DV.sale;
  return {
    barcode: 'DEV:' + s.id + ':' + Date.now().toString(36),
    name: 'Devolución venta #' + folioVenta(s),
    price: -monto, quantity: 1, subtotal: -monto,
    cost: -costo,                         // si regresa al inventario, se recupera el costo
    isCredit: true,
    devolucion: {
      saleId: s.id, folio: folioVenta(s), fechaVenta: s.tsISO || null,
      pagoOriginal: s.payMethod || null, tipo, motivo, regresa,
      porId: S.user?.uid || null, porNombre: nombreCajeroActual(),
      items: sel.map(({ costo, ...r }) => r)
    }
  };
}

/* Devolver dinero: sale del cajón en efectivo */
async function devolverDinero(){
  const credito = dvCredito('dinero'); if(!credito) return;
  const monto = -credito.subtotal;
  /* Mismas reglas que para cobrar: horario y caja contada */
  if(typeof estadoCobro === 'function'){ const st = estadoCobro(); if(!st.ok){ cerrarDevolucion(); mostrarBloqueo(st.motivo); return; } }
  if(typeof requiereConteo === 'function' && requiereConteo()){ cerrarDevolucion(); cerrarVentasTurno(); openShiftModal({ forzado: true }); return; }
  if(S.mpCobro){ showToast('Espera a que termine el cobro con la terminal','warning'); return; }
  let aviso = '';
  if(S.currentShift){
    const hay = shiftExpectedCash(S.currentShift);
    if(hay < monto) aviso = `\n\nOjo: según el sistema en la caja hay ${fmt(Math.max(0, hay))}.`;
  }
  const ok = await confirmAction({ title: '¿Entregar ' + fmt(monto) + ' al cliente?',
    msg: 'Sale en efectivo del cajón y queda registrado a tu nombre.' + (credito.devolucion.regresa ? '' : '\nLos productos NO regresan al inventario.') + aviso,
    okLabel: 'Sí, devolver', icon: '↩️' });
  if(!ok) return;
  const pago = {
    subtotal: -monto, discountAmt: 0, discount: null,
    total: -monto, paid: 0, cashPortion: -monto, cardPortion: 0,
    payMethod: 'cash', cart: [credito],
    comision: 0, comisionPct: 0, tipoTarjeta: null,
    imprimir: !!prnCfg().autoPrint
  };
  cerrarDevolucion(); cerrarVentasTurno();
  if(typeof hideSaleDetail === 'function') hideSaleDetail();
  await finalizarVenta(pago, { limpiarCarrito: false, abrirCajon: true });
  showToast('Devolución registrada: entrega ' + fmt(monto) + ' al cliente','success');
}

/* Cambio: lo devuelto queda como saldo a favor en la venta actual */
function hacerCambio(){
  const credito = dvCredito('cambio'); if(!credito) return;
  if(S.mpCobro){ showToast('Espera a que termine el cobro con la terminal','warning'); return; }
  S.cart.push(credito);
  S.lastAdded = credito.barcode;
  renderCart();
  cerrarDevolucion(); cerrarVentasTurno();
  if(typeof hideSaleDetail === 'function') hideSaleDetail();
  if(!g('adminPanel').classList.contains('hidden')) closeAdmin();
  showToast(`Saldo a favor de ${fmt(-credito.subtotal)} en la venta. Agrega lo que se lleva y cobra la diferencia.`,'success');
  const si = g('searchInput'); if(si && !isMobile()){ si.focus(); }
}

/* ════════════════════════════════════
   ANOTAR EN LA VENTA ORIGINAL
════════════════════════════════════ */
/* Al registrar la devolución/cambio (lo llama finalizarVenta) */
function marcarDevueltos(saleData){
  (saleData.items || []).filter(i => i.isCredit && i.devolucion?.saleId).forEach(c => {
    const dv = c.devolucion;
    const upd = {
      montoDevuelto: FS.FieldValue.increment(-(Number(c.subtotal) || 0)),
      devoluciones: FS.FieldValue.arrayUnion(saleData.localId),
      updatedAt: FS.FieldValue.serverTimestamp()
    };
    (dv.items || []).forEach(r => { upd['devuelto.' + r.idx] = FS.FieldValue.increment(Number(r.qty) || 0); });
    db.collection('sales').doc(dv.saleId).update(upd).catch(e => console.warn('No se pudo anotar la devolución en la venta original:', e.message));
    /* Copia local (para que la lista lo muestre al instante) */
    const loc = VT.lista.find(x => x.id === dv.saleId);
    if(loc){
      loc.devuelto = { ...(loc.devuelto || {}) };
      (dv.items || []).forEach(r => { loc.devuelto[r.idx] = round3((Number(loc.devuelto[r.idx]) || 0) + (Number(r.qty) || 0)); });
      loc.montoDevuelto = r2((loc.montoDevuelto || 0) - (Number(c.subtotal) || 0));
    }
  });
}
/* Si el dueño anula una devolución, la venta original vuelve a poder devolverse */
function revertirDevueltos(retSale){
  (retSale.items || []).filter(i => i.isCredit && i.devolucion?.saleId).forEach(c => {
    const dv = c.devolucion;
    const upd = {
      montoDevuelto: FS.FieldValue.increment(Number(c.subtotal) || 0),
      devoluciones: FS.FieldValue.arrayRemove(retSale.localId || retSale.id),
      updatedAt: FS.FieldValue.serverTimestamp()
    };
    (dv.items || []).forEach(r => { upd['devuelto.' + r.idx] = FS.FieldValue.increment(-(Number(r.qty) || 0)); });
    db.collection('sales').doc(dv.saleId).update(upd).catch(e => console.warn('Revertir devolución:', e.message));
  });
}

/* Botón en el detalle de venta del historial (dueño) */
function pintarBotonDevolucion(s){
  const box = g('saleDevArea'); if(!box) return;
  const extra = s.devolucion
    ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 mb-2"><i class="fa-solid fa-rotate-left mr-1"></i>Este movimiento es una devolución/cambio de: ${esc((s.devolucionDe || []).map(id => '#' + id.slice(-6).toUpperCase()).join(', '))}</p>` : '';
  const dev = s.montoDevuelto > 0 && !s.devolucion
    ? `<p class="text-xs text-slate-600 bg-slate-100 rounded-lg px-3 py-2 mb-2">Ya se devolvieron ${fmt(s.montoDevuelto)} de esta venta.</p>` : '';
  const puede = puedeDevolver(s);
  box.innerHTML = extra + dev + (puede ? `<button type="button" onclick="abrirDevolucion(_curSaleDetail)" class="w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 py-2.5 rounded-xl font-semibold text-sm min-h-[44px]"><i class="fa-solid fa-rotate-left mr-1.5"></i>Devolución / cambio</button>` : '');
  box.classList.toggle('hidden', !(extra || dev || puede));
}
