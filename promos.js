/* ════════════════════════════════════════════════════════════════
   PROMOCIONES — Admin → Promociones
   Cárgalo DESPUÉS de app.js:
     <script src="promos.js?v=..."></script>

   Una promoción es un precio especial para varios productos juntos:
     «Caguamas 2x60» = 2 × Caguama Tecate por $60
     «Combo carne asada» = 1 kg arrachera + 1 carbón + 1 Coca 2L por $250
   Se guarda en negocios/{TENANT}/promos/{id}:
     { name, code, price, items:[{barcode, name, qty}], active }

   En la caja (app.js) la promo se busca por nombre o código, entra al
   carrito como UN renglón y al cobrar descuenta del inventario cada
   producto que trae. El dueño la crea aquí; el vendedor solo la vende.
════════════════════════════════════════════════════════════════ */

const PM = { id:null, items:[] };   // promo que se está editando

/* ── Datos en vivo (lo usan la caja y el panel) ── */
function subscribePromos(){
  if(S.promoUnsub || !TENANT) return;
  S.promoUnsub = db.collection('promos').onSnapshot(snap=>{
    S.promos = snap.docs.map(d=>({id:d.id, ...d.data()}))
      .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''), 'es'));
    if(g('admin-promos') && !g('admin-promos').classList.contains('hidden')) renderPromosTable();
    const q = g('searchInput')?.value;
    if(q && document.activeElement === g('searchInput')) handleSearchInput(q);
  }, err=>{
    console.warn('Promociones:', err.code || err.message);
    S.promoUnsub = null;
    if(err.code !== 'permission-denied') setTimeout(()=>{ if(TENANT) subscribePromos(); }, 5000);
  });
}

/* Precio normal (sumando los productos sueltos) */
function precioNormalPromo(items){
  return (items||[]).reduce((s,c)=>{
    const p = S.products.find(x=>x.barcode===c.barcode);
    return s + (Number(p?.price)||0) * (Number(c.qty)||0);
  }, 0);
}

/* ════════════════════════════════════
   TABLA
════════════════════════════════════ */
function renderPromosTable(){
  const body = g('promosTableBody'); if(!body) return;
  const lista = S.promos || [];
  g('promosCount') && (g('promosCount').textContent = lista.length ? `(${lista.length})` : '');
  if(!lista.length){
    body.innerHTML = `<tr><td colspan="5" class="text-center py-10 text-slate-400">
      <i class="fa-solid fa-tags text-3xl block mb-2 text-slate-300"></i>
      Aún no hay promociones. Toca <b>Nueva promoción</b> para crear la primera (ej. Caguamas 2x60).</td></tr>`;
    return;
  }
  body.innerHTML = lista.map(pr=>{
    const pp = promoComoProducto(pr);
    const normal = precioNormalPromo(pp.items);
    const ahorro = normal - pp.price;
    const st = promoStock(pp);
    const faltan = pp.items.filter(c=>!S.products.some(x=>x.barcode===c.barcode && x.active!==false));
    const activa = pr.active !== false;
    return `<tr class="${activa?'':'opacity-50'}">
      <td class="px-3 sm:px-4 py-3">
        <p class="font-semibold text-slate-800 break-anywhere">${esc(pp.name)}</p>
        <p class="text-[11px] text-slate-400 font-mono">${esc(pp.code || '—')}</p>
      </td>
      <td class="px-3 sm:px-4 py-3 text-xs text-slate-600">
        ${esc(contenidoPromo(pp)) || '<span class="text-red-500">Sin productos</span>'}
        ${faltan.length ? `<p class="text-[11px] text-red-500 mt-0.5"><i class="fa-solid fa-triangle-exclamation"></i> Producto borrado o desactivado: ${esc(faltan.map(c=>c.name||c.barcode).join(', '))}</p>` : ''}
      </td>
      <td class="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
        <p class="font-black text-indigo-700 num">${fmt(pp.price)}</p>
        ${normal>0 ? `<p class="text-[11px] num ${ahorro>0?'text-emerald-600':'text-amber-600'}">${ahorro>0 ? 'Ahorra '+fmt(ahorro) : 'Normal '+fmt(normal)}</p>` : ''}
      </td>
      <td class="px-3 sm:px-4 py-3 text-center">
        ${!activa ? '<span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Pausada</span>'
          : st===null ? '<span class="text-xs px-2 py-0.5 rounded-full badge-ok">Activa</span>'
          : st<=0 ? '<span class="text-xs px-2 py-0.5 rounded-full badge-low">Sin existencias</span>'
          : `<span class="text-xs px-2 py-0.5 rounded-full ${st<=3?'badge-mid':'badge-ok'}">Alcanza para ${st}</span>`}
      </td>
      <td class="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
        <button onclick="abrirPromo('${esc(pr.id)}')" title="Editar" class="text-indigo-500 hover:text-indigo-700 p-2 min-w-[36px] min-h-[36px]"><i class="fa-solid fa-pen"></i></button>
        <button onclick="togglePromo('${esc(pr.id)}')" title="${activa?'Pausar':'Activar'}" class="${activa?'text-amber-500 hover:text-amber-700':'text-emerald-500 hover:text-emerald-700'} p-2 min-w-[36px] min-h-[36px]"><i class="fa-solid ${activa?'fa-pause':'fa-play'}"></i></button>
        <button onclick="borrarPromo('${esc(pr.id)}')" title="Borrar" class="text-red-400 hover:text-red-600 p-2 min-w-[36px] min-h-[36px]"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

/* ════════════════════════════════════
   VENTANA: crear / editar
════════════════════════════════════ */
function abrirPromo(id){
  if(!S.isAdmin){ showToast('Solo el dueño puede crear promociones','error'); return; }
  const pr = id ? (S.promos||[]).find(x=>x.id===id) : null;
  PM.id = pr ? pr.id : null;
  PM.items = pr ? (pr.items||[]).map(c=>({barcode:c.barcode, name:c.name||'', qty:Number(c.qty)||1})) : [];
  g('promoModalTitle').textContent = pr ? 'Editar promoción' : 'Nueva promoción';
  g('pm_name').value  = pr ? (pr.name||'') : '';
  g('pm_code').value  = pr ? (pr.code||'') : '';
  g('pm_price').value = pr ? (pr.price ?? '') : '';
  g('pm_active').checked = pr ? pr.active !== false : true;
  g('pm_buscar').value = '';
  g('pm_resultados').classList.add('hidden');
  g('pm_err').classList.add('hidden');
  pintarPromoItems();
  g('promoModal').classList.remove('hidden');
  setTimeout(()=>g('pm_name').focus(), 50);
}
function hidePromoModal(){ g('promoModal')?.classList.add('hidden'); }

/* Buscador de productos para armar la promo */
function pmBuscar(q){
  const box = g('pm_resultados');
  q = sinAcentos(String(q||'').trim());
  if(!q){ box.classList.add('hidden'); return; }
  const lista = S.products.filter(p=>p.active!==false && (sinAcentos(p.name).includes(q) || sinAcentos(p.barcode).includes(q))).slice(0, 8);
  box.innerHTML = lista.length ? lista.map(p=>`
    <button type="button" onclick="pmAgregar('${esc(p.barcode)}')" class="w-full text-left px-3 py-2.5 hover:bg-indigo-50 flex justify-between items-center gap-2 border-b border-slate-100 last:border-0">
      <span class="min-w-0"><span class="block text-sm font-semibold text-slate-800 truncate">${esc(p.name)}</span>
        <span class="block text-[10px] text-slate-400 font-mono truncate">${esc(p.barcode)}</span></span>
      <span class="text-sm font-bold text-indigo-600 num shrink-0">${fmt(p.price)}${p.isBulk?'/kg':''}</span>
    </button>`).join('')
    : '<p class="px-3 py-3 text-sm text-slate-400">Ningún producto coincide.</p>';
  box.classList.remove('hidden');
}
/* Enter en el buscador: agrega el primero (sirve con lector de código de barras) */
function pmBuscarEnter(e){
  if(e.key!=='Enter') return;
  e.preventDefault(); e.stopPropagation();
  const q = String(g('pm_buscar').value||'').trim();
  if(!q) return;
  const exacto = S.products.find(p=>p.active!==false && variantesCodigo(q).includes(p.barcode));
  const qn = sinAcentos(q);
  const p = exacto || S.products.find(p=>p.active!==false && (sinAcentos(p.name).includes(qn) || sinAcentos(p.barcode).includes(qn)));
  if(p) pmAgregar(p.barcode); else showToast('No encontré ese producto','warning');
}
function pmAgregar(barcode){
  const p = S.products.find(x=>x.barcode===barcode); if(!p) return;
  const ya = PM.items.find(c=>c.barcode===barcode);
  if(ya) ya.qty = round3(ya.qty + 1);
  else PM.items.push({barcode, name:p.name, qty:1});
  g('pm_buscar').value = '';
  g('pm_resultados').classList.add('hidden');
  pintarPromoItems();
  g('pm_buscar').focus();
}
function pmCantidad(i, v){
  const c = PM.items[i]; if(!c) return;
  const p = S.products.find(x=>x.barcode===c.barcode);
  let n = Number(String(v).replace(',', '.'));
  if(!(n>0)) n = p?.isBulk ? 0.001 : 1;
  c.qty = p?.isBulk ? round3(n) : Math.max(1, Math.round(n));
  pintarPromoItems(true);
}
function pmMas(i, d){
  const c = PM.items[i]; if(!c) return;
  pmCantidad(i, (Number(c.qty)||0) + d);
  pintarPromoItems();
}
function pmQuitar(i){ PM.items.splice(i, 1); pintarPromoItems(); }

/* Lista de productos + resumen (precio normal, ahorro, ganancia) */
function pintarPromoItems(soloResumen){
  const box = g('pm_items');
  if(!soloResumen){
    box.innerHTML = PM.items.length ? PM.items.map((c,i)=>{
      const p = S.products.find(x=>x.barcode===c.barcode);
      return `<div class="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-2">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold text-slate-800 truncate">${esc(p?.name || c.name || c.barcode)}</p>
          <p class="text-[10px] ${p?'text-slate-400':'text-red-500'} truncate">${p ? fmt(p.price)+(p.isBulk?' / kg':' c/u')+(typeof p.stock==='number'?' · hay '+round3(p.stock):'') : 'Este producto ya no existe'}</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${p?.isBulk ? '' : `<button type="button" onclick="pmMas(${i},-1)" class="w-8 h-8 rounded-full bg-white border border-slate-200 font-bold">−</button>`}
          <input type="number" inputmode="decimal" min="${p?.isBulk?'0.001':'1'}" step="${p?.isBulk?'0.001':'1'}" value="${c.qty}"
            onchange="pmCantidad(${i}, this.value)" class="w-16 text-center border border-slate-200 rounded-lg py-1.5 text-sm font-bold num" aria-label="Cantidad">
          ${p?.isBulk ? '<span class="text-xs text-slate-500">kg</span>' : `<button type="button" onclick="pmMas(${i},1)" class="w-8 h-8 rounded-full bg-white border border-slate-200 font-bold">+</button>`}
          <button type="button" onclick="pmQuitar(${i})" aria-label="Quitar" class="w-8 h-8 text-red-400 hover:text-red-600"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>`;
    }).join('') : '<p class="text-xs text-slate-400 text-center py-3 border border-dashed border-slate-200 rounded-xl">Busca arriba los productos que trae la promoción.</p>';
  }
  const normal = precioNormalPromo(PM.items);
  const precio = Number(String(g('pm_price').value||'').replace(',', '.')) || 0;
  const costo  = costoPromo({items:PM.items});
  const r = g('pm_resumen');
  if(!PM.items.length){ r.innerHTML = ''; return; }
  const ahorro = normal - precio;
  r.innerHTML = `
    <div class="flex justify-between"><span>Precio normal (por separado)</span><span class="num font-semibold">${fmt(normal)}</span></div>
    ${precio>0 ? `<div class="flex justify-between ${ahorro>0?'text-emerald-600':'text-amber-600'}"><span>${ahorro>0?'El cliente ahorra':'Ojo: la promo no es más barata'}</span><span class="num font-bold">${fmt(Math.abs(ahorro))}</span></div>` : ''}
    ${costo>0 && precio>0 ? `<div class="flex justify-between ${precio-costo>=0?'text-slate-500':'text-red-600'}"><span>${precio-costo>=0?'Ganancia':'Pierdes'} por promo</span><span class="num font-semibold">${fmt(Math.abs(precio-costo))}</span></div>` : ''}`;
}

async function guardarPromo(){
  if(!S.isAdmin){ showToast('Solo el dueño puede crear promociones','error'); return; }
  const err = m=>{ const e=g('pm_err'); e.textContent=m; e.classList.remove('hidden'); beep('error'); };
  const name  = String(g('pm_name').value||'').trim().slice(0, 120);
  const price = Math.round((Number(String(g('pm_price').value||'').replace(',', '.'))||0) * 100) / 100;
  let code    = codigoSeguro(g('pm_code').value || '');
  const items = PM.items.filter(c=>c.barcode && Number(c.qty)>0)
                        .map(c=>({barcode:c.barcode, name:(S.products.find(x=>x.barcode===c.barcode)?.name || c.name || '').slice(0,120), qty:Number(c.qty)}));

  if(!name) return err('Ponle un nombre (ej. Caguamas 2x60).');
  if(!(price>0)) return err('El precio de la promoción debe ser mayor a $0.');
  if(!items.length) return err('Agrega al menos un producto a la promoción.');
  if(items.length===1 && items[0].qty===1) return err('Con 1 sola pieza no es promoción: cambia el precio del producto, o sube la cantidad (ej. 2).');

  /* Código: opcional. Si lo dejan vacío se arma uno. No puede chocar con un producto ni con otra promo. */
  if(!code) code = 'PROMO-' + Math.floor(1000 + Math.random()*9000);
  const cn = sinAcentos(code);
  if(S.products.some(p=>sinAcentos(p.barcode)===cn)) return err(`El código «${code}» ya es de un producto. Usa otro.`);
  if((S.promos||[]).some(p=>p.id!==PM.id && sinAcentos(p.code||'')===cn)) return err(`Ya hay otra promoción con el código «${code}».`);

  const data = { name, code, price, items, active: !!g('pm_active').checked,
                 updatedAt: FS.FieldValue.serverTimestamp() };
  const btn = g('pm_btn'); btn.disabled = true;
  try{
    const ref = PM.id ? db.collection('promos').doc(PM.id) : db.collection('promos').doc();
    if(!PM.id) data.createdAt = FS.FieldValue.serverTimestamp();
    await withTimeout(ref.set(data, {merge:true}), 15000);
    hidePromoModal();
    showToast('Promoción ' + (PM.id ? 'actualizada' : 'creada') + ' ✅','success');
  }catch(e){
    err('No se pudo guardar: ' + (e.code === 'permission-denied' ? 'sin permiso (revisa las reglas de Firestore).' : e.message));
  }finally{ btn.disabled = false; }
}

async function togglePromo(id){
  const pr = (S.promos||[]).find(x=>x.id===id); if(!pr || !S.isAdmin) return;
  try{
    await db.collection('promos').doc(id).update({active: pr.active===false, updatedAt: FS.FieldValue.serverTimestamp()});
    showToast(pr.active===false ? 'Promoción activada' : 'Promoción pausada: ya no aparece en la caja','success');
  }catch(e){ showToast('Error: '+e.message,'error'); }
}
async function borrarPromo(id){
  const pr = (S.promos||[]).find(x=>x.id===id); if(!pr || !S.isAdmin) return;
  const ok = await confirmAction({ title:'¿Borrar la promoción?',
    msg:`«${pr.name}» dejará de aparecer en la caja. Las ventas que ya se hicieron con ella no cambian.\n\nSi solo quieres quitarla un tiempo, mejor páusala.`,
    okLabel:'Borrar', icon:'🏷️' });
  if(!ok) return;
  try{ await db.collection('promos').doc(id).delete(); showToast('Promoción borrada','success'); }
  catch(e){ showToast('Error: '+e.message,'error'); }
}

/* Cierra la lista de resultados al tocar fuera */
document.addEventListener('click', e=>{
  if(!e.target.closest('#pm_buscarWrap')) g('pm_resultados')?.classList.add('hidden');
});