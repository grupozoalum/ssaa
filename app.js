/* ── Firebase ── */
const FC = {
  apiKey: "AIzaSyCiSLtAQTFre5eqj5tB9lIOj97EKeKGQcg",
  authDomain: "saas-2c4ef.firebaseapp.com",
  projectId: "saas-2c4ef",
  storageBucket: "saas-2c4ef.firebasestorage.app",
  messagingSenderId: "790186047116",
  appId: "1:790186047116:web:5a490e45382c4c6c846da9",
  measurementId: "G-VRGTHDL06T"
};
firebase.initializeApp(FC);
const auth   = firebase.auth();
const dbRoot = firebase.firestore();
const FS     = firebase.firestore;

/* ════════════════════════════════════════════════════════
   CATÁLOGO MAESTRO: productos/{codigoDeBarras} →
     { nombre, marca, contenido, cantidad, unidad }
   Vive en el mismo proyecto que el resto del SaaS, así que se lee
   con la MISMA conexión (y la misma sesión) que todo lo demás.
   Las reglas piden sesión iniciada para leer 'productos'.
   Se lee documento por documento, cuando se escanea o se escribe
   un código: 1 lectura por consulta, nunca los 16 mil de golpe.
════════════════════════════════════════════════════════ */
const catalogoDb  = dbRoot;
const _catalogoCache = new Map();   // código → ficha | null

/* Convierte un documento del catálogo en una ficha uniforme.
   Tolera documentos viejos que solo traen "nombre". */
function fichaCatalogo(codigo, d){
  if(!d) return null;
  const txt = v => (v===undefined || v===null) ? '' : String(v).trim();
  const nombre = txt(d.nombre);
  if(!nombre) return null;
  const marca = txt(d.marca);
  const unidad = txt(d.unidad);
  const cantidad = (typeof d.cantidad==='number' && isFinite(d.cantidad)) ? d.cantidad
                 : (parseFloat(d.cantidad) || null);
  const contenido = txt(d.contenido) || (cantidad && unidad ? cantidad + unidad : '');
  return { codigo, nombre, marca, contenido, cantidad, unidad };
}

/* Nombre listo para vender: agrega marca y contenido si el nombre no los trae.
   "Skipper Arancia senza zuccheri aggiunti" → "Zuegg Skipper Arancia senza zuccheri aggiunti 700ml" */
function nombreParaVenta(f){
  if(!f) return '';
  const low = f.nombre.toLowerCase();
  let n = f.nombre;
  if(f.marca && !low.includes(f.marca.toLowerCase())) n = f.marca + ' ' + n;
  if(f.contenido && !low.replace(/\s+/g,'').includes(f.contenido.toLowerCase().replace(/\s+/g,''))) n = n + ' ' + f.contenido;
  return n;
}

/* "Zuegg · 700ml" */
function detalleCatalogo(f){
  return f ? [f.marca, f.contenido].filter(Boolean).join(' · ') : '';
}

/* Variantes del código: los lectores a veces quitan o agregan el 0
   inicial (UPC-A de 12 dígitos vs EAN-13 de 13). */
function variantesCodigo(code){
  const c = String(code||'').trim();
  const v = [c];
  if(/^\d+$/.test(c)){
    if(c.length===12) v.push('0'+c);
    if(c.length===13 && c.startsWith('0')) v.push(c.slice(1));
  }
  return [...new Set(v)];
}

/* Devuelve la ficha del producto en el catálogo, o null si no existe. */
async function buscarEnCatalogo(code){
  const c = String(code||'').trim();
  if(!c || c.includes('/')) return null;
  if(_catalogoCache.has(c)) return _catalogoCache.get(c);
  let ficha = null;
  try{
    for(const id of variantesCodigo(c)){
      const doc = await catalogoDb.collection('productos').doc(id).get();
      if(doc.exists){ ficha = fichaCatalogo(doc.id, doc.data()); if(ficha) break; }
    }
  }catch(e){
    console.warn('Catálogo no disponible:', e.code||e.message);
    return null;   // no se guarda en caché para reintentar después
  }
  _catalogoCache.set(c, ficha);
  return ficha;
}

/* Rellena el nombre en el formulario de producto si está vacío
   (o si lo había llenado el catálogo antes). */
let _pfNombreDelCatalogo = false;
async function autollenarNombreDesdeCatalogo(){
  const code = g('pf_barcode').value.trim();
  const hint = g('pf_nameHint');
  if(S.editingBarcode || !code){ hint?.classList.add('hidden'); return; }
  if(g('pf_name').value.trim() && !_pfNombreDelCatalogo) return;
  hint.textContent = 'Buscando en el catálogo…';
  hint.className = 'text-[11px] text-slate-400 mt-1';
  const ficha = await buscarEnCatalogo(code);
  if(g('pf_barcode').value.trim() !== code) return;   // el código cambió mientras buscaba
  if(ficha){
    g('pf_name').value = nombreParaVenta(ficha);
    _pfNombreDelCatalogo = true;
    const det = detalleCatalogo(ficha);
    hint.textContent = 'Tomado del catálogo' + (det ? ' (' + det + ')' : '') + '. Puedes cambiarlo.';
    hint.className = 'text-[11px] text-emerald-600 mt-1';
  }else{
    if(_pfNombreDelCatalogo){ g('pf_name').value=''; _pfNombreDelCatalogo=false; }
    hint.textContent = 'Este código no está en el catálogo. Escribe el nombre.';
    hint.className = 'text-[11px] text-slate-400 mt-1';
  }
}
let _pfCatalogoTimer = null;
function onBarcodeInput(){
  clearTimeout(_pfCatalogoTimer);
  _pfCatalogoTimer = setTimeout(autollenarNombreDesdeCatalogo, 450);
}

/* ════════════════════════════════════════════════════════
   CAPA MULTI-NEGOCIO
   Todo el POS sigue escribiendo db.collection('products'),
   db.collection('sales'), etc. Este objeto intercepta esas
   llamadas y las redirige a negocios/{TENANT}/products, ...
   El TENANT sale del login. Nunca de la URL.
════════════════════════════════════════════════════════ */
let TENANT = null;    // id del negocio
let PERFIL = null;    // negocios/{TENANT}/users/{uid} — vive DENTRO del negocio
let NEGOCIO = null;   // documento del negocio
let MOD = {};         // modulos que el admin god le activo

/* Colecciones que viven dentro de cada negocio */
const COLS_DEL_NEGOCIO = new Set([
  'products','sales','users','shifts','expenses',
  'terminals','branches','rechargeCarriers','inventoryEntries',
  'customers','counters','contratos'
]);

const db = {
  collection(nombre){
    if(COLS_DEL_NEGOCIO.has(nombre)){
      if(!TENANT) throw new Error('SIN_NEGOCIO');
      return dbRoot.collection('negocios').doc(TENANT).collection(nombre);
    }
    return dbRoot.collection(nombre);
  },
  enablePersistence(opts){ return dbRoot.enablePersistence(opts); }
};

/* Persistencia offline: permite seguir leyendo/escribiendo sin internet.
   Debe llamarse ANTES de cualquier otra operación de Firestore. */
db.enablePersistence({synchronizeTabs:true}).catch(err=>{
  console.warn('Persistencia offline no disponible:', err.code);
});

/* El rol ya no se escribe a mano: lo define el panel maestro al dar de alta
   el negocio. owner = dueño (ve el panel admin), vendedor = solo vende. */
const isAdminUid = uid => !!uid && !!PERFIL && PERFIL.uid === uid && PERFIL.role === 'owner';
const isMobile  = () => window.innerWidth < 768;

/* ── State ── */
const S = {
  user:null, isAdmin:false, isSeller:false,
  cart:[], curProduct:null, productsRaw:[],
  tid:null, termUnsub:null, prodUnsub:null,
  payMethod:'cash',
  scanInst:null, pfScanInst:null,
  lastScan:0,
  products:[], // real-time cache
  allSellers:[], editingBarcode:null,
  charts:{}, histSales:[],
  discount:null,      // {type:'pct'|'fixed', value:number}
  currentShift:null,  // open shift doc for current user
  lowStockOnly:false,
  soundOn:true,
  categories:['General','Bebidas','Alimentos','Snacks','Lácteos','Limpieza','Higiene Personal','Dulces','Panadería','Abarrotes'],
  remoteLastSeen:0,
  printer:{kind:null,port:null,writer:null,device:null,epOut:null,iface:null,connected:false,name:''},
  branches:[], branchUnsub:null,
  userBranchId:null, userBranchName:null,
  editingBranchId:null, reassignSellerUid:null,
  rechargeCarriers:[], carrierUnsub:null, editingCarrierId:null,
  rechargeSel:{carrierId:null, carrierName:'', commissionPct:0, amount:0},
  /* ── Inventario / gastos / offline ── */
  entryProduct:null, entries:[], expenses:[], editingExpenseId:null,
  shiftsCache:[], expenseCtx:{fromShift:false},
};

/* Categorías de gasto sugeridas */
const EXPENSE_CATEGORIES = ['Renta','Luz','Agua','Internet / Teléfono','Proveedores / Mercancía','Nómina','Mantenimiento','Limpieza','Transporte','Impuestos','Publicidad','Otros'];
const EXPENSE_COLORS = ['#ef4444','#f59e0b','#3b82f6','#8b5cf6','#10b981','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16','#06b6d4','#94a3b8'];
const EXPIRY_WARN_DAYS = 30;
const RECHARGE_AMOUNTS = [20,30,50,100,150,200,300,500];
const LOW_STOCK_THRESHOLD = 5;
const PARK_KEY = 'posParkedSales';
let _cdPushTimer=null; // throttle for customer-display cart push

/* ════════════════════════════════════
   PRODUCTS — real-time cache (makes search instant & offline-tolerant)
════════════════════════════════════ */
function subscribeProducts(){
  if(S.prodUnsub) return;
  S.prodUnsub = db.collection('products').onSnapshot(snap => {
    setServerProducts(snap.docs.map(d=>({barcode:d.id,...d.data()})));
  }, err => console.warn('Products snapshot error:', err));
}

/* ════════════════════════════════════
   EXISTENCIAS
   S.productsRaw = lo que dice Firebase.
   S.products    = lo de Firebase + lo que este dispositivo vendió o
                   ingresó y todavía no sube (cola local). Así el stock
                   que ve el cajero siempre descuenta las ventas
                   pendientes, aunque llegue un snapshot nuevo o no
                   haya internet.
════════════════════════════════════ */
const round3 = n => Math.round((Number(n)||0)*1000)/1000;

function setServerProducts(list){
  S.productsRaw = list || [];
  rebuildProducts();
}

/* Movimientos de stock que siguen en la cola local */
function pendingStockDeltas(){
  const out = {};
  const add = (b, k, v) => { (out[b] = out[b] || {stock:0, sales:0})[k] += v; };
  loadOutbox().forEach(item=>{
    if(item.type==='sale' && !item.sideDone){
      (item.stockDeltas||[]).forEach(d=>{ add(d.barcode,'stock',-d.qty); add(d.barcode,'sales',d.qty); });
    }
    if(item.type==='entry' && !item.sideDone && item.payload){
      const p = item.payload;
      add(p.productBarcode,'stock',p.quantity||0);
      if(p.updateCost && p.unitCost>0) out[p.productBarcode].cost = p.unitCost;
      if(p.expiry) (out[p.productBarcode].lots = out[p.productBarcode].lots||[]).push({expiry:p.expiry, qty:p.quantity, entryId:p.localId});
    }
  });
  return out;
}

function rebuildProducts(){
  const deltas = pendingStockDeltas();
  S.products = (S.productsRaw||[]).map(p=>{
    const d = deltas[p.barcode];
    if(!d) return p;
    const q = {...p};
    if(typeof q.stock==='number') q.stock = round3(q.stock + d.stock);
    q.salesCount = (q.salesCount||0) + d.sales;
    if(d.cost) q.cost = d.cost;
    if(d.lots) q.lots = [...(q.lots||[]), ...d.lots];
    return q;
  });
  cacheProductsLocally();
  renderQuickProducts();
  refreshCategoryList();
  updateStockBell();
  if(S.curProduct){
    const fresh = S.products.find(x=>x.barcode===S.curProduct.barcode);
    if(fresh){ S.curProduct = fresh; refreshProductStockUI(); }
  }
  if(g('admin-products') && !g('admin-products').classList.contains('hidden')) filterProdTable();
}

/* null = el producto no lleva control de inventario (se puede vender siempre) */
function stockOf(p){ return (p && typeof p.stock==='number' && isFinite(p.stock)) ? p.stock : null; }
function qtyInCart(barcode){
  return round3(S.cart.filter(i=>i.barcode===barcode && !i.isRecharge).reduce((s,i)=>s+(i.quantity||0),0));
}
/* Cuánto más se puede agregar al carrito (Infinity si no hay control) */
function availableToAdd(p){
  const st = stockOf(p);
  return st===null ? Infinity : round3(Math.max(0, st - qtyInCart(p.barcode)));
}
const qtyLabel = (p, n) => p && p.isBulk ? `${round3(n)} kg` : `${round3(n)} pza${round3(n)===1?'':'s'}`;

/* Revisa el carrito completo contra el stock actual.
   Devuelve la lista de productos que ya no alcanzan. */
function cartStockProblems(){
  const need = {};
  S.cart.forEach(i=>{ if(!i.isRecharge) need[i.barcode] = round3((need[i.barcode]||0) + i.quantity); });
  const problems = [];
  Object.entries(need).forEach(([barcode, qty])=>{
    const p = S.products.find(x=>x.barcode===barcode);
    if(!p) return;                      // producto fuera del catálogo local: no se puede validar aquí
    const st = stockOf(p);
    if(st!==null && qty > st + 1e-9) problems.push({barcode, name:p.name, qty, stock:Math.max(0,st), p});
  });
  return problems;
}

/* Ajusta el carrito a lo que realmente hay (quita agotados, recorta cantidades) */
function fitCartToStock(){
  cartStockProblems().forEach(pr=>{
    const item = S.cart.find(i=>i.barcode===pr.barcode && !i.isRecharge);
    if(!item) return;
    if(pr.stock<=0){ S.cart = S.cart.filter(i=>i!==item); return; }
    item.quantity = item.isBulk ? round3(pr.stock) : Math.floor(pr.stock);
    if(item.quantity<=0){ S.cart = S.cart.filter(i=>i!==item); return; }
    item.subtotal = item.price * item.quantity;
  });
  renderCart();
}

/* Muestra el aviso y devuelve false si el carrito pide más de lo que hay */
async function ensureCartStock(){
  const problems = cartStockProblems();
  if(!problems.length) return true;
  beep('error');
  const detalle = problems.map(pr =>
    `• ${pr.name}: pides ${qtyLabel(pr.p, pr.qty)}, ${pr.stock>0 ? 'solo hay '+qtyLabel(pr.p, pr.stock) : 'está agotado'}`
  ).join('\n');
  const ok = await confirmAction({
    title:'No hay suficientes existencias',
    msg: detalle + '\n\n¿Ajusto el carrito a lo que hay disponible?',
    okLabel:'Ajustar carrito', icon:'📦'
  });
  if(ok){ fitCartToStock(); showToast('Carrito ajustado al stock disponible','info'); }
  return false;
}

/* Merge default + discovered categories into the datalist */
function refreshCategoryList(){
  const found = new Set(S.categories);
  S.products.forEach(p=>{ if(p.category) found.add(p.category); });
  S.categories = [...found];
  const dl = g('categoryList');
  if(dl) dl.innerHTML = S.categories.map(c=>`<option value="${esc(c)}">`).join('');
}

/* Quick-access grid: favorites first, then best sellers */
function renderQuickProducts(){
  const card=g('quickProdsCard'), grid=g('quickProdsGrid');
  if(!card||!grid) return;
  if(!(S.isSeller||S.isAdmin) || !S.products.length){ card.classList.add('hidden'); return; }
  const favs = S.products.filter(p=>p.favorite && p.active!==false);
  const bySales = [...S.products].filter(p=>p.active!==false && !p.favorite).sort((a,b)=>(b.salesCount||0)-(a.salesCount||0));
  const list = [...favs, ...bySales].slice(0,10);
  if(!list.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  grid.innerHTML = list.map(p=>{
    const agotado = stockOf(p)!==null && stockOf(p)<=0;
    return `
    <button onclick="quickAdd('${esc(p.barcode)}')" class="quick-chip shrink-0 flex flex-col items-center justify-center w-[84px] h-[64px] ${agotado?'bg-slate-100 opacity-50':'bg-slate-50 hover:bg-indigo-50'} border border-slate-200 rounded-lg px-1.5 text-center">
      ${p.favorite?'<i class="fa-solid fa-star text-amber-400 text-[10px] mb-0.5"></i>':''}
      <span class="text-[11px] font-semibold text-slate-700 leading-tight line-clamp-2">${esc(p.name)}</span>
      ${agotado
        ? '<span class="text-[10px] font-black text-red-500">Agotado</span>'
        : `<span class="text-[11px] font-black text-indigo-600">${fmt(p.price)}</span>`}
    </button>`;
  }).join('');
}
function quickAdd(barcode){
  const p = S.products.find(x=>x.barcode===barcode);
  if(!p) return;
  S.curProduct = p;
  showProduct(p);
  /* Granel necesita que el cajero escriba el peso: solo se muestra */
  if(p.isBulk){ g('qtyInput').focus(); return; }
  addToCart();
}

/* ════════════════════════════════════
   LOW STOCK ALERT BELL
════════════════════════════════════ */
function getLowStockProducts(){
  return S.products.filter(p=>p.active!==false && typeof p.stock==='number' && p.stock<=LOW_STOCK_THRESHOLD);
}
function updateStockBell(){
  const bell=g('stockBell'), count=g('stockBellCount');
  if(!bell) return;
  if(!(S.isSeller||S.isAdmin)){ bell.classList.add('hidden'); return; }
  bell.classList.remove('hidden');
  const list=getLowStockProducts();
  if(list.length){
    count.textContent=list.length>99?'99+':list.length;
    count.classList.remove('hidden');
  } else count.classList.add('hidden');
}
function openStockAlerts(){
  const list=getLowStockProducts().sort((a,b)=>(a.stock||0)-(b.stock||0));
  const el=g('stockAlertsList');
  el.innerHTML = list.length ? list.map(p=>`
    <div class="flex items-center justify-between gap-2 border border-slate-200 rounded-xl p-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-slate-800 break-anywhere">${esc(p.name)}</p>
        <p class="text-xs text-slate-400 break-anywhere">${esc(p.barcode)}</p>
      </div>
      ${stockBadge(p)}
    </div>`).join('') : '<p class="text-slate-400 text-sm text-center py-8"><i class="fa-solid fa-circle-check text-emerald-400 text-2xl block mb-2"></i>Todo el inventario está en buen nivel</p>';
  g('stockAlertsModal').classList.remove('hidden');
}
function hideStockAlerts(){ g('stockAlertsModal').classList.add('hidden'); }

/* ════════════════════════════════════
   SUCURSALES (branches)
════════════════════════════════════ */
function subscribeBranches(){
  if(S.branchUnsub) return;
  S.branchUnsub = db.collection('branches').orderBy('name').onSnapshot(snap=>{
    S.branches = snap.docs.map(d=>({id:d.id,...d.data()}));
    refreshBranchSelects();
    if(g('admin-branches') && !g('admin-branches').classList.contains('hidden')) renderBranches();
    updateBranchTag();
  }, err=>console.warn('Branches snapshot error:', err));
}
function refreshBranchSelects(){
  const active = S.branches.filter(b=>b.active!==false);
  const opts = active.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
  const sf=g('sf_branch'); if(sf) sf.innerHTML='<option value="">Selecciona una sucursal…</option>'+opts;
  const rf=g('rf_branch'); if(rf) rf.innerHTML=opts;
  const hf=g('histBranchFilter'); if(hf) hf.innerHTML='<option value="">Todas las sucursales</option>'+opts;
  const mf=g('metricsBranchFilter'); if(mf) mf.innerHTML='<option value="">Todas las sucursales</option>'+opts;
}
function renderBranches(){
  const grid=g('branchesGrid');
  if(!S.branches.length){grid.innerHTML='<div class="col-span-3 py-12 text-center"><p class="text-slate-400 text-sm">No hay sucursales todavía</p><button onclick="showBranchModal()" class="mt-3 text-indigo-600 text-sm font-medium min-h-[44px] block mx-auto">+ Agregar primero</button></div>';return;}
  grid.innerHTML=S.branches.map(b=>{
    const sellerCount = S.allSellers.filter(s=>s.branchId===b.id).length;
    return `<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 sm:p-5">
    <div class="flex items-start justify-between mb-2">
      <div class="w-11 h-11 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
        <i class="fa-solid fa-store text-violet-600"></i>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full font-semibold ${b.active!==false?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-500'}">
        ${b.active!==false?'Activa':'Inactiva'}</span>
    </div>
    <p class="font-bold text-slate-800 text-sm">${esc(b.name)}</p>
    <p class="text-slate-400 text-xs mt-0.5 truncate">${esc(b.address||'Sin dirección registrada')}</p>
    <p class="text-slate-400 text-xs mt-1"><i class="fa-solid fa-users mr-1"></i>${sellerCount} vendedor${sellerCount!==1?'es':''}</p>
    <div class="flex gap-1.5 mt-3">
      <button onclick="editBranch('${b.id}')" class="flex-1 text-xs py-2.5 rounded-lg font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 min-h-[40px]"><i class="fa-solid fa-pen-to-square mr-1"></i>Editar</button>
      <button onclick="toggleBranch('${b.id}',${b.active!==false})" class="flex-1 text-xs py-2.5 rounded-lg font-semibold min-h-[40px] ${b.active!==false?'bg-red-50 text-red-600 hover:bg-red-100':'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}">
        <i class="fa-solid fa-${b.active!==false?'ban':'check'} mr-1"></i>${b.active!==false?'Desactivar':'Activar'}
      </button>
    </div>
  </div>`;
  }).join('');
}
function showBranchModal(){
  S.editingBranchId=null;
  g('branchModalTitle').textContent='Agregar Sucursal';
  g('bf_name').value=''; g('bf_address').value='';
  g('branchErr').classList.add('hidden');
  g('branchModal').classList.remove('hidden');
}
function editBranch(id){
  const b=S.branches.find(x=>x.id===id); if(!b) return;
  S.editingBranchId=id;
  g('branchModalTitle').textContent='Editar Sucursal';
  g('bf_name').value=b.name; g('bf_address').value=b.address||'';
  g('branchErr').classList.add('hidden');
  g('branchModal').classList.remove('hidden');
}
function hideBranchModal(){ g('branchModal').classList.add('hidden'); }
async function saveBranch(){
  const name=g('bf_name').value.trim(), address=g('bf_address').value.trim();
  const errEl=g('branchErr');
  if(!name){ errEl.textContent='El nombre es requerido'; errEl.classList.remove('hidden'); return; }
  try{
    if(S.editingBranchId){
      await db.collection('branches').doc(S.editingBranchId).update({name,address,updatedAt:FS.FieldValue.serverTimestamp()});
    } else {
      await db.collection('branches').add({name,address,active:true,createdAt:FS.FieldValue.serverTimestamp()});
    }
    hideBranchModal();
    showToast('Sucursal guardada ✅','success');
  }catch(e){ errEl.textContent='Error: '+e.message; errEl.classList.remove('hidden'); }
}
async function toggleBranch(id,active){
  if(active){
    const ok=await confirmAction({title:'¿Desactivar sucursal?', msg:'No podrá asignarse a nuevos vendedores.', okLabel:'Desactivar', icon:'🚫'});
    if(!ok) return;
  }
  try{ await db.collection('branches').doc(id).update({active:!active}); showToast('Sucursal '+(active?'desactivada':'activada'),'success'); }
  catch(e){ showToast('Error: '+e.message,'error'); }
}
function updateBranchTag(){
  const tag=g('branchTag'), nameEl=g('branchTagName');
  if(!tag) return;
  if(S.isSeller && S.userBranchName){
    nameEl.textContent=S.userBranchName;
    tag.classList.remove('hidden'); tag.classList.add('flex');
  } else {
    tag.classList.add('hidden'); tag.classList.remove('flex');
  }
}
function openReassignBranch(uid,name){
  S.reassignSellerUid=uid;
  g('reassignSellerName').textContent=name;
  const seller=S.allSellers.find(s=>s.uid===uid);
  refreshBranchSelects();
  if(seller?.branchId) g('rf_branch').value=seller.branchId;
  g('reassignBranchModal').classList.remove('hidden');
}
function hideReassignBranchModal(){ g('reassignBranchModal').classList.add('hidden'); }
async function saveReassignBranch(){
  const branchId=g('rf_branch').value;
  const branch=S.branches.find(b=>b.id===branchId);
  if(!branchId||!branch){ showToast('Selecciona una sucursal','warning'); return; }
  try{
    await db.collection('users').doc(S.reassignSellerUid).update({branchId, branchName:branch.name});
    hideReassignBranchModal(); loadSellers();
    showToast('Sucursal actualizada ✅','success');
  }catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ════════════════════════════════════
   RECARGAS CELULARES
════════════════════════════════════ */
function subscribeCarriers(){
  if(S.carrierUnsub) return;
  S.carrierUnsub = db.collection('rechargeCarriers').orderBy('name').onSnapshot(snap=>{
    S.rechargeCarriers = snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!g('rechargeModal').classList.contains('hidden')) renderCarrierChips();
    if(g('admin-recharges') && !g('admin-recharges').classList.contains('hidden')) renderCarriersTable();
  }, err=>console.warn('Carriers snapshot error:', err));
}
function openRechargeModal(){
  S.rechargeSel = {carrierId:null, carrierName:'', commissionPct:0, amount:0};
  g('rechargePhone').value=''; g('rechargeCustomAmount').value='';
  g('rechargeCommissionLine').classList.add('hidden');
  renderCarrierChips();
  renderAmountChips();
  g('rechargeModal').classList.remove('hidden');
}
function hideRechargeModal(){ g('rechargeModal').classList.add('hidden'); }
function renderCarrierChips(){
  const active = S.rechargeCarriers.filter(c=>c.active!==false);
  const el=g('rechargeCarrierChips');
  if(!active.length){ el.innerHTML='<p class="text-xs text-slate-400">No hay compañías configuradas. Pide al administrador que agregue una en Admin → Recargas.</p>'; return; }
  el.innerHTML = active.map(c=>`
    <button onclick="selectCarrier('${c.id}')" data-carrier="${c.id}"
      class="carrier-chip px-3.5 py-2 rounded-xl text-sm font-semibold border-2 ${S.rechargeSel.carrierId===c.id?'border-violet-500 bg-violet-50 text-violet-700':'border-slate-200 bg-slate-50 text-slate-600'}">
      ${esc(c.name)}
    </button>`).join('');
}
function selectCarrier(id){
  const c=S.rechargeCarriers.find(x=>x.id===id); if(!c) return;
  S.rechargeSel.carrierId=id; S.rechargeSel.carrierName=c.name; S.rechargeSel.commissionPct=c.commissionPct||0;
  renderCarrierChips();
  updateRechargePreview();
}
function renderAmountChips(){
  g('rechargeAmountChips').innerHTML = RECHARGE_AMOUNTS.map(a=>`
    <button onclick="selectRechargeAmount(${a})" data-amt="${a}"
      class="amt-chip py-2.5 rounded-xl text-sm font-bold border-2 ${S.rechargeSel.amount===a?'border-violet-500 bg-violet-50 text-violet-700':'border-slate-200 bg-slate-50 text-slate-600'}">
      $${a}
    </button>`).join('');
}
function selectRechargeAmount(a){
  S.rechargeSel.amount=a; g('rechargeCustomAmount').value='';
  renderAmountChips();
  updateRechargePreview();
}
function updateRechargePreview(){
  const custom = parseFloat(g('rechargeCustomAmount').value)||0;
  const amount = custom>0 ? custom : S.rechargeSel.amount;
  const line=g('rechargeCommissionLine');
  if(amount>0 && S.rechargeSel.commissionPct>0){
    const commission = amount*(S.rechargeSel.commissionPct/100);
    line.textContent = `Comisión estimada para la tienda: ${fmt(commission)} (${S.rechargeSel.commissionPct}%)`;
    line.classList.remove('hidden');
  } else line.classList.add('hidden');
}
function addRechargeToCart(){
  const phone = g('rechargePhone').value.trim();
  const custom = parseFloat(g('rechargeCustomAmount').value)||0;
  const amount = custom>0 ? custom : S.rechargeSel.amount;
  if(!S.rechargeSel.carrierId){ showToast('Selecciona una compañía','warning'); return; }
  if(!/^\d{10}$/.test(phone)){ showToast('Ingresa un número de celular válido (10 dígitos)','warning'); return; }
  if(!amount || amount<=0){ showToast('Selecciona o ingresa un monto','warning'); return; }
  S.cart.push({
    barcode:'RECARGA-'+Date.now(), name:`Recarga ${S.rechargeSel.carrierName} $${amount} · ${phone}`,
    price:amount, quantity:1, subtotal:amount, isRecharge:true,
    carrierId:S.rechargeSel.carrierId, carrierName:S.rechargeSel.carrierName, phone,
    commissionPct:S.rechargeSel.commissionPct,
  });
  renderCart();
  hideRechargeModal();
  showToast('Recarga agregada al carrito ✓','success');
  beep('add');
}

/* ── Admin: carriers CRUD ── */
function renderCarriersTable(){
  const tbody=g('carriersTableBody');
  if(!S.rechargeCarriers.length){ tbody.innerHTML='<tr><td colspan="4" class="py-8 text-center text-slate-400">Sin compañías registradas</td></tr>'; return; }
  tbody.innerHTML=S.rechargeCarriers.map(c=>`<tr class="hover:bg-slate-50 transition">
    <td class="px-3 sm:px-4 py-3 font-semibold text-slate-800 text-sm">${esc(c.name)}</td>
    <td class="px-3 sm:px-4 py-3 text-right text-sm">${(c.commissionPct||0)}%</td>
    <td class="px-3 sm:px-4 py-3 text-center">
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${c.active!==false?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-600'}">${c.active!==false?'Activa':'Inactiva'}</span>
    </td>
    <td class="px-3 sm:px-4 py-3 text-right">
      <button onclick="editCarrier('${c.id}')" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px]"><i class="fa-solid fa-pen-to-square"></i></button>
      <button onclick="toggleCarrier('${c.id}',${c.active!==false})" class="text-sm p-1 min-w-[32px] min-h-[32px] ml-1 ${c.active!==false?'text-red-400 hover:text-red-600':'text-emerald-500 hover:text-emerald-700'}"><i class="fa-solid fa-${c.active!==false?'ban':'check'}"></i></button>
    </td>
  </tr>`).join('');
}
function showCarrierModal(){
  S.editingCarrierId=null;
  g('carrierModalTitle').textContent='Agregar Compañía';
  g('cf_name').value=''; g('cf_commission').value='';
  g('carrierErr').classList.add('hidden');
  g('carrierModal').classList.remove('hidden');
}
function editCarrier(id){
  const c=S.rechargeCarriers.find(x=>x.id===id); if(!c) return;
  S.editingCarrierId=id;
  g('carrierModalTitle').textContent='Editar Compañía';
  g('cf_name').value=c.name; g('cf_commission').value=c.commissionPct||0;
  g('carrierErr').classList.add('hidden');
  g('carrierModal').classList.remove('hidden');
}
function hideCarrierModal(){ g('carrierModal').classList.add('hidden'); }
async function saveCarrier(){
  const name=g('cf_name').value.trim();
  const commissionPct=parseFloat(g('cf_commission').value)||0;
  const errEl=g('carrierErr');
  if(!name){ errEl.textContent='El nombre es requerido'; errEl.classList.remove('hidden'); return; }
  try{
    if(S.editingCarrierId){
      await db.collection('rechargeCarriers').doc(S.editingCarrierId).update({name,commissionPct,updatedAt:FS.FieldValue.serverTimestamp()});
    } else {
      await db.collection('rechargeCarriers').add({name,commissionPct,active:true,createdAt:FS.FieldValue.serverTimestamp()});
    }
    hideCarrierModal();
    showToast('Compañía guardada ✅','success');
  }catch(e){ errEl.textContent='Error: '+e.message; errEl.classList.remove('hidden'); }
}
async function toggleCarrier(id,active){
  try{ await db.collection('rechargeCarriers').doc(id).update({active:!active}); showToast('Compañía '+(active?'desactivada':'activada'),'success'); }
  catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ════════════════════════════════════
   AUTH
════════════════════════════════════ */
auth.onAuthStateChanged(async user => {
  /* Antes de nada: ¿a qué negocio pertenece este correo? */
  if(!(await resolverNegocio(user))) return;

  S.user = user;
  S.isAdmin  = isAdminUid(user?.uid);
  S.isSeller = !!(user && !S.isAdmin);

  if(user && PERFIL){
    /* La sucursal ya viene en la ficha que leímos al resolver el negocio.
       Aplica igual al dueño: su ticket también debe decir de qué sucursal
       salió, no quedarse sin rótulo. */
    S.userBranchId   = PERFIL.branchId   || null;
    S.userBranchName = PERFIL.branchName || null;
  } else {
    S.userBranchId = null; S.userBranchName = null;
  }

  const tag = g('modeTag');
  if(user){
    g('navLoginBtn').classList.add('hidden');
    g('navUserArea').classList.remove('hidden');
    g('navUserName').textContent = user.displayName || user.email;
    g('shiftBtn').classList.remove('hidden'); g('shiftBtn').classList.add('flex');
    g('hwBtn').classList.remove('hidden');
    restoreLocalCart();
    checkCurrentShift();
    if(S.isAdmin){
      tag.textContent='🔐 Admin';
      tag.className='text-[10px] sm:text-xs bg-yellow-400 text-yellow-900 font-bold px-2 py-0.5 rounded-full';
      showCart(true);
      g('navAdminBtn').classList.remove('hidden');
      openAdmin();
    } else {
      tag.textContent='💼 Modo Venta';
      tag.className='text-[10px] sm:text-xs bg-emerald-400 text-emerald-900 font-bold px-2 py-0.5 rounded-full';
      showCart(true);
    }
  } else {
    g('navLoginBtn').classList.remove('hidden');
    g('navUserArea').classList.add('hidden');
    g('navAdminBtn').classList.add('hidden');
    g('shiftBtn').classList.add('hidden'); g('shiftBtn').classList.remove('flex');
    g('hwBtn').classList.add('hidden');
    S.currentShift=null;
    tag.textContent='Consulta de Precios';
    tag.className='text-[10px] sm:text-xs bg-white/15 border border-white/20 px-2 py-0.5 rounded-full';
    showCart(false);
    g('adminPanel').classList.add('hidden');
  }
  renderQuickProducts();
  updateStockBell();
  updateBranchTag();
  aplicarModulos();
  aplicarBranding();
  if(!S.isAdmin) closeAdmin();
});

/* ════════════════════════════════════════════════════════
   ¿QUÉ NEGOCIO ES ESTE?
   Devuelve true si se puede seguir; false si ya pintó un bloqueo.
════════════════════════════════════════════════════════ */
async function resolverNegocio(user){
  if(!user){
    soltarNegocio();
    mostrarPuertaLogin();
    return false;
  }
  try{
    /* ¿En qué negocio está dado de alta este correo?
       Buscamos su ficha entre TODOS los negocios/{x}/users sin saber cuál es.
       Esto es una consulta de grupo de colecciones: no existe ninguna
       colección global de usuarios, la ficha vive dentro de su negocio. */
    const hallazgo = await dbRoot.collectionGroup('users')
                                 .where('uid','==',user.uid)
                                 .limit(5).get();

    if(hallazgo.empty){
      return bloquearAcceso('fa-user-slash text-slate-400','Esta cuenta no tiene negocio asignado',
        'Pídele a tu proveedor o al dueño de tu tienda que registre tu acceso.');
    }

    /* Debería haber exactamente una. Si aparecen varias, nos quedamos con la
       que coincide con el correo del token de sesión, que nadie puede falsificar. */
    let candidatas = hallazgo.docs;
    if(candidatas.length > 1){
      const porCorreo = candidatas.filter(d =>
        (d.data().email||'').toLowerCase() === (user.email||'').toLowerCase());
      if(porCorreo.length === 1){
        candidatas = porCorreo;
      } else {
        console.warn('Ficha duplicada en varios negocios para', user.uid);
        return bloquearAcceso('fa-triangle-exclamation text-amber-500','Tu correo aparece en más de un negocio',
          'No podemos saber en cuál debes entrar. Avísale a tu proveedor para que deje una sola alta.');
      }
    }

    const ficha = candidatas[0];
    /* users está dentro de negocios/{tenantId}: de ahí sale el identificador. */
    TENANT = ficha.ref.parent.parent.id;
    PERFIL = { uid:user.uid, ...ficha.data() };

    if(PERFIL.active === false){
      return bloquearAcceso('fa-ban text-rose-500','Tu acceso fue desactivado',
        'El administrador de tu negocio apagó esta cuenta.');
    }

    const n = await dbRoot.collection('negocios').doc(TENANT).get();
    if(!n.exists){
      TENANT = null;
      return bloquearAcceso('fa-store-slash text-slate-400','El negocio ya no existe',
        'Contacta a tu proveedor para recuperar el servicio.');
    }
    NEGOCIO = n.data();
    MOD = (NEGOCIO.configuracion && NEGOCIO.configuracion.modulos) || {};

    if(NEGOCIO.status_pago !== 'activo'){
      const nom = NEGOCIO.nombre || 'tu negocio';
      TENANT = null;
      return bloquearAcceso('fa-credit-card text-amber-500','Servicio suspendido',
        'El servicio de '+nom+' está pausado por falta de pago. Se reactiva en cuanto se regularice.');
    }

    /* Cada giro tiene su propio punto de venta. Si este negocio está
       marcado como barbería, no es aquí donde debe entrar. */
    const tipo = (NEGOCIO.configuracion && NEGOCIO.configuracion.tipo_pos) || 'tienda';
    if(tipo === 'barberia'){
      return bloquearAcceso('fa-shuffle text-indigo-500','Este negocio usa el punto de venta de barbería',
        'Te mandamos al que le corresponde.', [
          {texto:'Ir al POS de barbería', accion:"location.href='barberia.html'", estilo:'bg-slate-900 text-white'},
          {texto:'Cerrar sesión', accion:'gateSalir()', estilo:'bg-slate-100 text-slate-600'}
        ]);
    }

    cerrarPuerta();
    arrancarDatosDelNegocio();
    return true;

  }catch(e){
    console.error(e);
    /* La búsqueda entre negocios necesita un índice. Firebase imprime la liga
       para crearlo con un clic en la consola del navegador. */
    if(e && (e.code === 'failed-precondition' || /index/i.test(e.message||''))){
      return bloquearAcceso('fa-database text-indigo-500','Falta crear un índice',
        'Abre la consola del navegador (F12), copia la liga que imprimió Firebase y ábrela para crear el índice de users.uid. Es un clic y solo se hace una vez.');
    }
    return bloquearAcceso('fa-triangle-exclamation text-amber-500','No pudimos abrir tu negocio',
      'Revisa tu conexión e inténtalo otra vez.');
  }
}

function soltarNegocio(){
  [S.prodUnsub,S.branchUnsub,S.carrierUnsub,S.termUnsub].forEach(u=>{ try{ u && u(); }catch(e){} });
  S.prodUnsub=S.branchUnsub=S.carrierUnsub=S.termUnsub=null;
  S.products=[]; S.productsRaw=[]; S.branches=[]; S.rechargeCarriers=[]; S.allSellers=[];
  TENANT=null; PERFIL=null; NEGOCIO=null; MOD={};
}

let _datosArrancados = false;
function arrancarDatosDelNegocio(){
  if(_datosArrancados) return;
  _datosArrancados = true;
  try{ subscribeProducts(); }catch(e){ console.warn(e); }
  try{ subscribeBranches(); }catch(e){ console.warn(e); }
  try{ subscribeCarriers(); }catch(e){ console.warn(e); }
  try{ initTerminal(); }catch(e){ console.warn(e); }
}

/* ════════════════════════════════════════════════════════
   MÓDULOS — lo que el admin god prendió en su panel
════════════════════════════════════════════════════════ */
const MAPA_MODULOS = {
  inventario : ['tab-inventory','mtab-inventory'],
  gastos     : ['tab-expenses','mtab-expenses'],
  turnos     : ['tab-shifts','mtab-shifts','shiftBtn'],
  sucursales : ['tab-branches','mtab-branches'],
  recargas   : ['tab-recharges','mtab-recharges','rechargeCard'],
  hardware   : ['tab-hardware','mtab-hardware','hwBtn']
};

function aplicarModulos(){
  if(!S.user) return;
  Object.keys(MAPA_MODULOS).forEach(clave=>{
    /* Si la llave no existe (negocios viejos) se deja encendido. */
    const encendido = MOD[clave] !== false;
    MAPA_MODULOS[clave].forEach(id=>{
      const el = g(id);
      if(el && !encendido) el.classList.add('hidden');
    });
  });
}

/* ── De dónde sale el nombre en TODAS partes ──────────────
   Un solo lugar lo decide. Si mañana cambias el rótulo del
   negocio desde tu panel, cambia en el ticket, en la impresora,
   en el WhatsApp y en la pantalla al cliente sin tocar nada más. */
function nombreNegocio(){
  return (NEGOCIO && NEGOCIO.nombre) || 'Punto de venta';
}
function nombreSucursal(){
  return S.userBranchName || '';
}
function pieDeTicket(){
  return (NEGOCIO && NEGOCIO.configuracion && NEGOCIO.configuracion.ticket_pie)
         || '¡Gracias por su compra!';
}
/* Para reimprimir tickets viejos usamos lo que quedó guardado en la venta,
   no el nombre de hoy: si el negocio se renombró, el ticket sigue siendo fiel. */
function encabezadoTicket(venta){
  return {
    negocio : (venta && venta.storeName)  || nombreNegocio(),
    sucursal: (venta && venta.branchName) || nombreSucursal()
  };
}

function aplicarBranding(){
  const nom = nombreNegocio();
  const suc = nombreSucursal();

  const marca = g('brandName');
  if(marca) marca.textContent = nom;

  /* Pantalla al cliente */
  const cd = g('cdStoreName');
  if(cd) cd.textContent = suc ? nom + ' · ' + suc : nom;

  const cdGracias = g('cdThankYouMsg');
  if(cdGracias) cdGracias.textContent = pieDeTicket();

  document.title = 'POS · ' + nom;
}

/* ════════════════════════════════════════════════════════
   PUERTA DE ENTRADA — login y pantallas de bloqueo
════════════════════════════════════════════════════════ */
function mostrarPuertaLogin(){
  g('gateLogin').classList.remove('hidden');
  g('gateBlock').classList.add('hidden');
  g('saasGate').classList.remove('hidden');
  setTimeout(()=>{ const e=g('gateEmail'); if(e) e.focus(); },200);
}

function bloquearAcceso(icono, titulo, mensaje, acciones){
  g('gateLogin').classList.add('hidden');
  g('gateBlock').classList.remove('hidden');
  g('gateIcon').className = 'fa-solid ' + icono + ' text-5xl mb-4';
  g('gateTitle').textContent = titulo;
  g('gateMsg').textContent = mensaje;
  g('gateActions').innerHTML = (acciones && acciones.length)
    ? acciones.map(a=>`<button onclick="${a.accion}" class="w-full ${a.estilo} py-3 rounded-xl font-bold text-sm">${a.texto}</button>`).join('')
    : '<button onclick="gateSalir()" class="w-full bg-slate-900 hover:bg-slate-800 text-white py-3 rounded-xl font-bold text-sm">Cerrar sesión</button>';
  g('saasGate').classList.remove('hidden');
  return false;
}

function cerrarPuerta(){ g('saasGate').classList.add('hidden'); }

async function gateEntrar(){
  const email = g('gateEmail').value.trim();
  const pwd   = g('gatePwd').value;
  const err   = g('gateErr'), btn = g('gateBtn');
  err.classList.add('hidden');
  if(!email || !pwd){ err.textContent='Escribe tu correo y tu contraseña'; err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i>Entrando…';
  try{
    await auth.signInWithEmailAndPassword(email, pwd);
    g('gatePwd').value = '';
  }catch(e){
    const msgs = {
      'auth/invalid-credential':'Correo o contraseña incorrectos.',
      'auth/wrong-password':'Contraseña incorrecta.',
      'auth/user-not-found':'Ese correo no está registrado.',
      'auth/invalid-email':'El correo no tiene un formato válido.',
      'auth/too-many-requests':'Demasiados intentos. Espera unos minutos.',
      'auth/network-request-failed':'Sin conexión. Revisa tu internet.',
      'auth/user-disabled':'Esta cuenta fue deshabilitada.'
    };
    err.textContent = msgs[e.code] || 'No pudimos entrar. Verifica tus datos.';
    err.classList.remove('hidden');
  }finally{
    btn.disabled = false;
    btn.innerHTML = 'Entrar';
  }
}

async function gateOlvide(){
  const email = g('gateEmail').value.trim();
  const err = g('gateErr');
  if(!email){ err.textContent='Escribe tu correo primero'; err.classList.remove('hidden'); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    err.textContent = 'Te enviamos un correo para cambiar tu contraseña.';
    err.className = 'text-emerald-600 text-sm text-center';
    err.classList.remove('hidden');
  }catch(e){
    err.textContent = 'No pudimos enviar el correo.';
    err.classList.remove('hidden');
  }
}

async function gateSalir(){
  _datosArrancados = false;
  await auth.signOut();
  location.reload();
}

function showCart(on){
  // Solo mostramos la burbuja flotante (FAB) cuando está logueado
  g('cartFab').classList.toggle('hidden', !on);
  
  // Add to cart area
  g('addToCartArea').classList.toggle('hidden', !on);
  // Quick access + customer display link (seller/admin only)
  g('displayCard').classList.toggle('hidden', !on);
  g('rechargeCard').classList.toggle('hidden', !on);
  renderQuickProducts();
  refreshParkBadges();
  updateStockBell();
  updateBranchTag();
}

/* ── Mostrar / ocultar contraseña (ojito) ── */
function togglePwd(inputId, iconId){
  const inp = g(inputId); if(!inp) return;
  const show = inp.type === 'password';        // true = vamos a mostrarla
  inp.type = show ? 'text' : 'password';
  const ic = iconId ? g(iconId) : null;
  if(ic){
    ic.classList.toggle('fa-eye',      !show);
    ic.classList.toggle('fa-eye-slash', show);
    const btn = ic.closest('button');
    if(btn){
      const lbl = show ? 'Ocultar contraseña' : 'Mostrar contraseña';
      btn.setAttribute('aria-label', lbl); btn.title = lbl;
    }
  }
  /* Devuelve el foco al final del texto para poder seguir escribiendo */
  inp.focus();
  try{ const n = inp.value.length; inp.setSelectionRange(n, n); }catch(e){}
}
/* Vuelve el campo a estado oculto (al abrir/cerrar el modal) */
function resetPwdVisibility(inputId, iconId){
  const inp = g(inputId); if(!inp) return;
  inp.type = 'password';
  const ic = iconId ? g(iconId) : null;
  if(ic){ ic.classList.add('fa-eye'); ic.classList.remove('fa-eye-slash'); }
}
function showLoginModal(){
  g('loginModal').classList.remove('hidden');
  setTimeout(()=>g('loginEmail').focus(),150);
}
function hideLoginModal(){
  g('loginModal').classList.add('hidden');
  g('loginErr').classList.add('hidden');
  resetPwdVisibility('loginPwd','loginPwdIcon');
}
async function doLogin(){
  const email=g('loginEmail').value.trim();
  const pwd=g('loginPwd').value;
  const errEl=g('loginErr'); errEl.classList.add('hidden');
  const btn=g('loginSubmitBtn');
  if(!email||!pwd){errEl.textContent='Ingresa correo y contraseña';errEl.classList.remove('hidden');return;}
  btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin mr-1"></i>Entrando…';
  try{
    await auth.signInWithEmailAndPassword(email,pwd);
    hideLoginModal(); g('loginPwd').value='';
    showToast('¡Sesión iniciada!','success');
  }catch(e){
    const m={'auth/invalid-credential':'Correo o contraseña incorrectos','auth/wrong-password':'Correo o contraseña incorrectos','auth/user-not-found':'Usuario no encontrado','auth/too-many-requests':'Demasiados intentos. Espera un momento.','auth/invalid-email':'Correo inválido'};
    errEl.textContent = m[e.code]||('Error: '+e.message); errEl.classList.remove('hidden');
  } finally { btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-sign-in-alt mr-1.5"></i>Entrar'; }
}
async function logout(){
  await auth.signOut(); 
  S.cart=[]; S.discount=null; renderCart(); // Vaciar carrito silenciosamente al salir
  closeMobileCart();
  showToast('Sesión cerrada','info');
}

/* ── Persistencia del carrito actual ── */
function saveLocalCart() {
  try { localStorage.setItem('posActiveCart_v1', JSON.stringify({cart: S.cart, discount: S.discount})); } catch(e){}
}
function restoreLocalCart() {
  try {
    const raw = localStorage.getItem('posActiveCart_v1');
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.cart)){
        S.cart = parsed.cart;
        S.discount = parsed.discount || null;
        renderCart();
      }
    }
  } catch(e){}
}

/* ════════════════════════════════════
   SEARCH — uses local cache, no index needed
════════════════════════════════════ */
function handleSearchInput(q) {
  const dd = g('searchDropdown');
  if(!q) { dd.classList.add('hidden'); return; }
  q = q.toLowerCase();
  const matches = S.products.filter(p => p.active !== false && (p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q))).slice(0, 8);
  if(!matches.length) { dd.classList.add('hidden'); return; }
  dd.innerHTML = matches.map(p => `
    <div onclick="selectFromDropdown('${esc(p.barcode)}')" class="p-3 hover:bg-slate-50 cursor-pointer flex justify-between items-center transition">
      <div class="min-w-0 flex-1"><p class="text-sm font-semibold text-slate-800 truncate">${esc(p.name)}</p><p class="text-[10px] text-slate-400">${esc(p.barcode)}</p></div>
      <div class="text-right shrink-0 ml-2">
        <span class="text-sm font-black text-indigo-600 block">${fmt(p.price)}</span>
        ${stockOf(p)!==null && stockOf(p)<=0 ? '<span class="text-[10px] font-bold text-red-500">Agotado</span>' : ''}
      </div>
    </div>`).join('');
  dd.classList.remove('hidden');
}
function selectFromDropdown(barcode) {
  g('searchDropdown').classList.add('hidden');
  g('searchInput').value = barcode; doSearch(barcode);
}
document.addEventListener('click', e => { if(!e.target.closest('#searchWrapper')) g('searchDropdown')?.classList.add('hidden'); });
async function doSearch(queryOverride){
  const raw = (queryOverride || g('searchInput').value).trim();
  if(!raw) return;

  hide('stateWelcome'); hide('stateProduct'); hide('stateNotFound'); hide('stateLoading');
  show('stateLoading');

  /* If products not loaded yet, wait for snapshot */
  if(!S.products.length){
    await new Promise(res=>setTimeout(res,800));
  }

  hide('stateLoading');
  const q = raw.toLowerCase();

  /* 1. Exact barcode */
  const variantes = variantesCodigo(raw);
  let match = S.products.find(p => variantes.includes(p.barcode) && p.active !== false);

  /* 2. Barcode partial / name includes (case-insensitive) */
  if(!match){
    match = S.products.find(p => p.active !== false && (
      p.barcode?.toLowerCase() === q ||
      p.name?.toLowerCase().includes(q)
    ));
  }

  /* 3. If still not found, try direct Firestore lookup (catches barcode not yet in cache) */
  if(!match){
    try{
      const doc = await db.collection('products').doc(raw).get();
      if(doc.exists && doc.data().active !== false)
        match = {barcode:doc.id,...doc.data()};
    }catch(e){}
  }

  if(match) showProduct(match);
  else showNotFound(raw);
}

window._bulkUnit = 'kg';
function setBulkUnit(unit) {
  window._bulkUnit = unit;
  const act = 'flex-1 py-2 rounded-lg text-sm font-bold border-2 border-indigo-500 bg-indigo-50 text-indigo-700 transition';
  const inact = 'flex-1 py-2 rounded-lg text-sm font-bold border-2 border-slate-200 bg-slate-50 text-slate-500 transition';
  g('btnUnitKg').className = (unit === 'kg') ? act : inact;
  g('btnUnitG').className = (unit === 'g') ? act : inact;
  
  const qtyInp = g('qtyInput');
  qtyInp.placeholder = (unit === 'g') ? 'Ej: 500' : 'Ej: 1.5';
  qtyInp.focus();
}

function showProduct(p){
  S.curProduct = p;
  g('pdBarcode').textContent = 'Cód: '+p.barcode;
  g('pdName').textContent = p.name;
  g('pdCategory').textContent = p.category||'Sin categoría';
  
  const qtyInp = g('qtyInput');
  if(p.isBulk) {
    g('pdPrice').textContent = fmt(p.price) + ' / kg';
    g('bulkUnitArea').classList.remove('hidden');
    g('qtyMinusBtn').classList.add('hidden');
    g('qtyPlusBtn').classList.add('hidden');
    qtyInp.value = '';
    setBulkUnit('kg'); // Arranca en Kilos por defecto
  } else {
    g('pdPrice').textContent = fmt(p.price);
    g('bulkUnitArea').classList.add('hidden');
    g('qtyMinusBtn').classList.remove('hidden');
    g('qtyPlusBtn').classList.remove('hidden');
    qtyInp.value = 1;
    qtyInp.placeholder = '';
  }
  
  refreshProductStockUI();
  show('stateProduct'); hide('stateNotFound'); hide('stateWelcome'); hide('stateLoading');
  beep('scan');
}

/* Insignia de existencias + botón "Agregar" según lo que queda disponible
   (stock menos lo que ya está en el carrito). */
function refreshProductStockUI(){
  const p = S.curProduct; if(!p) return;
  const stockEl = g('pdStock'), btn = g('addToCartBtn');
  const st = stockOf(p);
  const base = 'text-xs px-2 py-0.5 rounded-full inline-block ml-1 ';
  if(st===null){
    stockEl.classList.add('hidden');
  } else {
    const libre = availableToAdd(p), enCarrito = qtyInCart(p.barcode);
    stockEl.classList.remove('hidden');
    if(st<=0){ stockEl.textContent='Agotado'; stockEl.className=base+'badge-low'; }
    else if(libre<=0){ stockEl.textContent=`Todo en el carrito (${qtyLabel(p, st)})`; stockEl.className=base+'badge-low'; }
    else {
      stockEl.textContent = `${qtyLabel(p, libre)} disponible${libre===1?'':'s'}` + (enCarrito?` · ${qtyLabel(p, enCarrito)} en carrito`:'');
      stockEl.className = base + (libre<=LOW_STOCK_THRESHOLD ? 'badge-mid' : 'badge-ok');
    }
  }
  if(btn){
    const sinNada = st!==null && availableToAdd(p)<=0;
    btn.disabled = sinNada;
    btn.innerHTML = sinNada
      ? '<i class="fa-solid fa-ban mr-1.5"></i>Sin existencias'
      : '<i class="fa-solid fa-cart-plus mr-1.5"></i>Agregar al carrito';
  }
}
function showNotFound(code){
  g('notFoundCode').textContent = 'Código: '+code;
  hide('notFoundCatalog');
  buscarEnCatalogo(code).then(ficha=>{
    if(!ficha || g('notFoundCode').textContent !== 'Código: '+code) return;
    const det = detalleCatalogo(ficha);
    g('notFoundCatalogName').innerHTML = esc(ficha.nombre)
      + (det ? '<span class="block text-[11px] font-normal text-slate-500">'+esc(det)+'</span>' : '');
    show('notFoundCatalog');
  });
  show('stateNotFound'); hide('stateProduct'); hide('stateWelcome'); hide('stateLoading');
  const btn = g('addFromScanBtn');
  if(S.isAdmin){ btn.classList.remove('hidden'); window._pendingBarcode=code; }
  else btn.classList.add('hidden');
}

/* ════════════════════════════════════
   CART
════════════════════════════════════ */
function addToCart(){
  if(!S.curProduct) return;
  
  const rawQty = g('qtyInput').value;
  if(S.curProduct.isBulk && !rawQty) {
    showToast('Ingresa el peso o cantidad', 'warning');
    g('qtyInput').focus();
    return;
  }
  
  // Si eligió 'g' (gramos), dividimos entre 1000 para que se calcule por kilo
  let parsedQty = parseFloat(rawQty) || 1;
  if (S.curProduct.isBulk && window._bulkUnit === 'g') {
    parsedQty = parsedQty / 1000;
  }
  
  if(!(parsedQty > 0)){ showToast('La cantidad debe ser mayor a cero','warning'); return; }

  const p = S.curProduct;
  /* Piezas: solo enteros. Granel: hasta 3 decimales (gramos). */
  const qty = p.isBulk ? round3(Math.max(0.001, parsedQty)) : Math.max(1, Math.round(parsedQty));
  const ex = S.cart.find(i=>i.barcode===p.barcode && !i.isRecharge);

  /* ── Candado de existencias ── */
  const st = stockOf(p);
  if(st!==null){
    const libre = availableToAdd(p);
    if(st<=0){
      showToast(`${p.name} está agotado. Registra una entrada de inventario para poder venderlo.`,'error');
      beep('error'); refreshProductStockUI(); return;
    }
    if(qty > libre + 1e-9){
      showToast(libre<=0
        ? `Ya tienes en el carrito todo el stock de ${p.name} (${qtyLabel(p, st)})`
        : `Solo puedes agregar ${qtyLabel(p, libre)} más de ${p.name}`, 'error');
      beep('error'); refreshProductStockUI(); return;
    }
  }

  if(ex){
    ex.quantity = round3(ex.quantity + qty);
    ex.subtotal = ex.price * ex.quantity;
  } else {
    S.cart.push({
      barcode: p.barcode, 
      name: p.name, 
      price: p.price, 
      cost: Number(p.cost)||0, 
      quantity: qty, 
      subtotal: p.price * qty, 
      isBulk: p.isBulk
    });
  }
  
  renderCart();
  showToast(p.name+' agregado ✓','success');
  beep('add');
  g('qtyInput').value = p.isBulk ? '' : 1;
  if(p.isBulk) g('qtyInput').focus();
  refreshProductStockUI();
  const fab=g('cartFab'); fab.classList.remove('pulse-add'); void fab.offsetWidth; fab.classList.add('pulse-add');
}
function removeCartItem(b){ S.cart=S.cart.filter(i=>i.barcode!==b); renderCart(); refreshProductStockUI(); }
function changeCartQty(b,d){
  const i=S.cart.find(x=>x.barcode===b);
  if(!i) return;
  /* Las recargas no tienen cantidad: siempre 1 */
  if(i.isRecharge) return;
  const min = i.isBulk ? 0.001 : 1;
  const next = round3(Math.max(min, i.quantity + d));
  if(d>0){
    const p = S.products.find(x=>x.barcode===b);
    const st = stockOf(p);
    if(st!==null && next > st + 1e-9){
      showToast(st<=0 ? `${i.name} está agotado` : `Solo hay ${qtyLabel(p, st)} de ${i.name}`,'error');
      beep('error');
      return;
    }
  }
  i.quantity = next;
  i.subtotal = i.price * i.quantity;
  renderCart();
  refreshProductStockUI();
}
async function clearCart(){
  if(S.cart.length){
    const ok = await confirmAction({title:'¿Vaciar carrito?', msg:'Se eliminarán todos los productos del carrito actual.', okLabel:'Vaciar', icon:'🗑️'});
    if(!ok) return;
  }
  S.cart=[]; S.discount=null; renderCart();
}
function changeQty(d){
  const el=g('qtyInput');
  let v = Math.max(1, Math.round((parseFloat(el.value)||1)+d));
  const p = S.curProduct;
  if(d>0 && p && stockOf(p)!==null){
    const libre = availableToAdd(p);
    if(v > libre){ v = Math.max(1, Math.floor(libre)); showToast(`Solo hay ${qtyLabel(p, libre)} disponibles`,'warning'); }
  }
  el.value = v;
}

const cartItemHTML = it => `
  <div class="bg-white rounded-xl p-2.5 border border-slate-100">
    <div class="flex justify-between items-start mb-1.5">
      <p class="text-xs font-semibold text-slate-800 flex-1 pr-2 leading-tight">${esc(it.name)}</p>
      <button onclick="removeCartItem('${it.barcode}')" class="text-red-300 hover:text-red-500 active:text-red-600 p-0.5 shrink-0 min-w-[24px] min-h-[24px] flex items-center justify-center">
        <i class="fa-solid fa-times text-xs"></i>
      </button>
    </div>
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-1">
        <button onclick="changeCartQty('${it.barcode}',-1)" class="w-6 h-6 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 rounded-full text-sm font-bold flex items-center justify-center">−</button>
        <span class="text-xs font-bold min-w-[24px] text-center">${it.quantity}${it.isBulk ? 'kg' : ''}</span>
        <button onclick="changeCartQty('${it.barcode}',1)" class="w-6 h-6 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 rounded-full text-sm font-bold flex items-center justify-center">+</button>
      </div>
      <p class="text-sm font-black text-indigo-700">${fmt(it.subtotal)}</p>
    </div>
  </div>`;

function computeDiscountAmount(subtotal){
  if(!S.discount) return 0;
  const amt = S.discount.type==='pct' ? subtotal*(S.discount.value/100) : S.discount.value;
  return Math.max(0, Math.min(subtotal, amt));
}
function cartTotals(){
  const subtotal = S.cart.reduce((s,i)=>s+i.subtotal,0);
  const discountAmt = computeDiscountAmount(subtotal);
  return {subtotal, discountAmt, total: subtotal-discountAmt};
}

function renderCart(){
  if(!S.cart.length) S.discount=null;
  const {subtotal, discountAmt, total} = cartTotals();
  const count = S.cart.reduce((s,i)=>s+i.quantity,0);
  const html  = S.cart.length ? S.cart.map(cartItemHTML).join('') : '<p class="text-slate-300 text-xs text-center py-6"><i class="fa-solid fa-cart-shopping block text-2xl mb-2"></i>Carrito vacío</p>';

  /* Desktop */
  g('cartListDesktop').innerHTML = html;
  g('cartBadge').textContent = count+' item'+(count!==1?'s':'');
  g('cartSubDesktop').textContent = fmt(subtotal);
  g('cartTotalDesktop').textContent = fmt(total);
  g('checkoutBtnDesktop').disabled = !S.cart.length;
  g('cartDiscRowDesktop').classList.toggle('hidden', !discountAmt);
  g('cartDiscRowDesktop').classList.toggle('flex', !!discountAmt);
  if(discountAmt) g('cartDiscDesktop').textContent='-'+fmt(discountAmt);

  /* Mobile sheet */
  g('cartListMobile').innerHTML = html;
  g('cartSubMobile').textContent = fmt(subtotal);
  g('cartTotalMobile').textContent = fmt(total);
  g('checkoutBtnMobile').disabled = !S.cart.length;
  g('cartDiscRowMobile').classList.toggle('hidden', !discountAmt);
  g('cartDiscRowMobile').classList.toggle('flex', !!discountAmt);
  if(discountAmt) g('cartDiscMobile').textContent='-'+fmt(discountAmt);

  /* FAB badge */
  const fab = g('cartFabCount');
  if(count > 0){ fab.textContent=count; fab.classList.remove('hidden'); }
  else fab.classList.add('hidden');

  refreshParkBadges();
  scheduleCustomerDisplayPush();
  saveLocalCart();
  refreshProductStockUI();
}

/* Toggle cart drawer/sheet for Mobile & PC */
function openMobileCart(){
  g('cartFab').classList.add('hidden'); // <-- Oculta la burbuja flotante
  g('cartBackdrop').classList.remove('hidden');
  
  if (window.innerWidth < 768) {
    // Modo móvil: Bottom sheet
    g('cartSheet').classList.add('open');
    document.body.style.overflow='hidden';
  } else {
    // Modo Escritorio: Slide panel lateral
    const dc = g('cartDesktop');
    dc.classList.remove('hidden');
    // Usamos requestAnimationFrame para que la transición sea fluida
    requestAnimationFrame(() => {
      dc.classList.remove('translate-x-full');
      dc.classList.add('translate-x-0');
    });
  }
}

function closeMobileCart(){
  g('cartFab').classList.remove('hidden'); // <-- Vuelve a mostrar la burbuja flotante
  g('cartBackdrop').classList.add('hidden');
  g('cartSheet').classList.remove('open');
  document.body.style.overflow='';
  
  const dc = g('cartDesktop');
  if (dc) {
    dc.classList.remove('translate-x-0');
    dc.classList.add('translate-x-full');
    
    // Lo ocultamos totalmente después de la animación para que no intercepte clics
    setTimeout(() => dc.classList.add('hidden'), 300);
  }
}

/* ════════════════════════════════════
   SCANNER (cámara)
════════════════════════════════════ */
async function openScanModal(){
  g('scanModal').classList.remove('hidden');
  await delay(150);
  startSc('scanReader','scanInst', async code => {
    await closeScanModal();
    g('searchInput').value = code;
    await doSearch(code);
    /* Phone mode: also push to terminal */
    if(window._phoneMode && window._targetTerminal)
      await pushToTerminal(code, window._targetTerminal);
  });
}
async function closeScanModal(){
  await stopSc('scanInst');
  g('scanModal').classList.add('hidden');
}

function startSc(containerId, instKey, onSuccess){
  if(S[instKey]){ try{S[instKey].stop();}catch(e){} }
  const fmts = [
    Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.QR_CODE,
  ];
  const sc = new Html5Qrcode(containerId);
  S[instKey] = sc;
  sc.start(
    {facingMode:'environment'},
    {fps:10, qrbox:{width:260,height:100}, formatsToSupport:fmts},
    code => {
      const now=Date.now();
      if(now-S.lastScan < 2000) return;
      S.lastScan = now;
      onSuccess(code);
    }
  ).catch(err => {
    console.error('Scanner error:', err);
    showToast('No se pudo acceder a la cámara','error');
  });
}
async function stopSc(instKey){
  try{ if(S[instKey]?.isScanning) await S[instKey].stop(); }catch(e){}
  S[instKey] = null;
}

/* ════════════════════════════════════
   EXTERNAL USB / BLUETOOTH BARCODE SCANNER (keyboard-wedge)
   Most hardware scanners emit keystrokes very fast and end with Enter.
   This global listener catches that pattern from anywhere in the app
   (no need to have the search box focused) and triggers a search.
════════════════════════════════════ */
const HW = { buffer:'', lastKeyTs:0, timer:null, MAX_GAP:60, MIN_LEN:3 };
function initHardwareScanner(){
  document.addEventListener('keydown', e => {
    if(window._displayMode) return;
    // Ignore modifier-only combos
    if(e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = document.activeElement?.tagName;
    const typingInField = ['INPUT','TEXTAREA','SELECT'].includes(tag) && document.activeElement.id !== 'searchInput';
    // Allow capture even if searchInput is focused (harmless) but skip other text fields
    if(typingInField) { resetHwBuffer(); return; }

    const now = Date.now();
    const gap = now - HW.lastKeyTs;
    HW.lastKeyTs = now;

    if(e.key === 'Enter'){
      if(HW.buffer.length >= HW.MIN_LEN){
        const code = HW.buffer;
        resetHwBuffer();
        flashHwBadge();
        g('searchInput').value = code;
        doSearch(code);
        if(navigator.vibrate) navigator.vibrate(30);
      }
      return;
    }
    if(e.key.length === 1){
      // Human typing is usually >80ms between keys; scanners are typically <30ms.
      if(gap > HW.MAX_GAP && HW.buffer.length > 0){
        // Too slow — likely human typing, restart buffer instead of treating as scan
        HW.buffer = e.key;
      } else {
        HW.buffer += e.key;
      }
      clearTimeout(HW.timer);
      HW.timer = setTimeout(resetHwBuffer, 400);
    }
  });
}
function resetHwBuffer(){ HW.buffer=''; }
function flashHwBadge(){
  const b=g('hwScanBadge'); if(!b) return;
  b.classList.remove('hidden');
  clearTimeout(HW._badgeTimer);
  HW._badgeTimer=setTimeout(()=>b.classList.add('hidden'),2500);
}

/* ════════════════════════════════════════════════════════════════
   IMPRESORA DE TICKETS — directo, SIN la ventana de impresión de Windows
   ─ USB (WebUSB): la forma principal. La app le manda los comandos
     ESC/POS a la impresora; el papel avanza solo lo que mide el ticket.
   ─ Bluetooth / puerto COM (Web Serial): para impresoras que aparecen
     como puerto serie.
   Funciona en Chrome / Edge (Windows, Mac, Linux, Android) con https.
   En Windows, la impresora USB necesita el driver WinUSB (ver Zadig en
   el modal de ayuda): con el driver de impresora de Windows el
   navegador no puede abrirla.
════════════════════════════════════════════════════════════════ */
const usbSupported    = () => 'usb' in navigator;
const serialSupported = () => 'serial' in navigator;
function printerSupported(){ return usbSupported() || serialSupported(); }
const PRN_LAST_KEY = 'posPrinterLast_v1';   // {kind, vendorId, productId} para reconectar solo

/* ── Configuración de impresión (persistente) ──
   density  1-5  → calor del cabezal (más alto = más oscuro)
   interval 1-6  → pausa entre líneas de puntos (más alto = menos borroso/manchado)
   doubleStrike  → imprime cada punto dos veces: mucho más nítido en papel barato
   baud          → debe coincidir con el que imprime el autotest de la impresora
   codepage      → 437 (default), 850 (multilingüe) o 1252 (Windows Latin)
   paper    58|80 → ancho del rollo. 58 mm = 32 columnas, 80 mm = 48 columnas
   bigFont       → TODO el ticket en letra doble (la mitad de columnas).
                   En "normal" solo el nombre del negocio y el TOTAL van grandes:
                   el ticket mide la mitad y gasta mucho menos papel.
   ending        → 'tear' = arrancar a mano (avanza feedLines renglones)
                   'cut'  = impresora con cortador (avanza justo hasta la cuchilla y corta) */
const PRN_KEY = 'posPrinterCfg_v2';
const PRN_DEFAULT = { baud:9600, density:4, interval:3, doubleStrike:true, codepage:437, useDC2:false,
                      paper:58, bigFont:false, ending:'tear', feedLines:3, autoPrint:true };
const paperMM = cfg => Number((cfg||prnCfg()).paper)===80 ? 80 : 58;
/* Columnas que caben en una línea con la letra normal de la impresora */
const prnBaseCols = cfg => paperMM(cfg)===80 ? 48 : 32;
/* Columnas reales del ticket según el tamaño de letra elegido */
const prnCols = cfg => {
  cfg = cfg||prnCfg();
  const size = PRN_SIZE || (cfg.bigFont ? 'big' : 'normal');
  return size==='big' ? prnBaseCols(cfg)/2 : prnBaseCols(cfg);
};
function prnCfg(){
  try{
    /* Hereda papel/densidad/baud de la versión anterior de la config */
    const old = JSON.parse(localStorage.getItem('posPrinterCfg_v1')||'{}');
    delete old.bigFont; delete old.width;
    return Object.assign({}, PRN_DEFAULT, old, JSON.parse(localStorage.getItem(PRN_KEY)||'{}'));
  }
  catch(e){ return Object.assign({}, PRN_DEFAULT); }
}
function savePrnCfg(patch){
  const cfg = Object.assign(prnCfg(), patch);
  localStorage.setItem(PRN_KEY, JSON.stringify(cfg));
  return cfg;
}

/* Botón principal "Conectar": USB si el navegador lo soporta, si no Bluetooth/COM */
async function connectPrinter(){
  if(usbSupported()) return connectPrinterUSB();
  if(serialSupported()) return connectPrinterSerial();
  showToast('Este navegador no puede imprimir directo. Usa Chrome o Edge.','warning');
}

async function connectPrinterUSB(){
  if(!usbSupported()){ showToast('Este navegador no soporta USB directo (usa Chrome o Edge)','warning'); return false; }
  let device;
  try{
    device = await navigator.usb.requestDevice({filters:[]});
  }catch(e){ return false; }                       // el usuario cerró la ventana
  try{
    await openUsbPrinter(device);
    showToast(`Impresora conectada: ${S.printer.name} ✅`,'success');
    return true;
  }catch(e){
    console.warn('USB:', e);
    try{ await device.close(); }catch(_){}
    showUsbHelp(e);
    return false;
  }
}

async function openUsbPrinter(device){
  if(S.printer.connected) await closePrinter();
  await device.open();
  if(device.configuration === null) await device.selectConfiguration(1);
  /* Busca la salida "bulk OUT" — de preferencia la interfaz de clase impresora (7) */
  let pick = null;
  for(const iface of device.configuration.interfaces){
    for(const alt of iface.alternates){
      const ep = alt.endpoints.find(e=>e.direction==='out' && e.type==='bulk');
      if(!ep) continue;
      if(!pick || (alt.interfaceClass===7 && pick.cls!==7))
        pick = {iface:iface.interfaceNumber, alt:alt.alternateSetting, ep:ep.endpointNumber, cls:alt.interfaceClass};
    }
  }
  if(!pick) throw Object.assign(new Error('Ese dispositivo USB no es una impresora'), {name:'NotPrinter'});
  await device.claimInterface(pick.iface);
  if(pick.alt) await device.selectAlternateInterface(pick.iface, pick.alt);
  Object.assign(S.printer, {kind:'usb', device, epOut:pick.ep, iface:pick.iface, connected:true,
                            name: device.productName || 'Impresora USB'});
  try{ localStorage.setItem(PRN_LAST_KEY, JSON.stringify({kind:'usb', vendorId:device.vendorId, productId:device.productId})); }catch(e){}
  await applyPrinterSettings();
  updatePrinterUI();
}

async function connectPrinterSerial(){
  if(!serialSupported()){ showToast('Este navegador no soporta puertos COM / Bluetooth (usa Chrome o Edge)','warning'); return false; }
  let port;
  try{ port = await navigator.serial.requestPort(); }catch(e){ return false; }
  try{
    await openSerialPrinter(port);
    showToast(`Impresora conectada a ${prnCfg().baud} baud ✅`,'success');
    return true;
  }catch(e){
    showToast('No se pudo abrir el puerto: '+e.message,'error');
    return false;
  }
}
async function openSerialPrinter(port){
  if(S.printer.connected) await closePrinter();
  const cfg = prnCfg();
  if(!port.writable) await port.open({baudRate:cfg.baud});
  Object.assign(S.printer, {kind:'serial', port, writer:port.writable.getWriter(), connected:true,
                            name:'Impresora Bluetooth / COM'});
  try{ localStorage.setItem(PRN_LAST_KEY, JSON.stringify({kind:'serial'})); }catch(e){}
  await applyPrinterSettings();
  updatePrinterUI();
}

async function closePrinter(){
  const P = S.printer;
  try{
    if(P.kind==='usb' && P.device){
      try{ await P.device.releaseInterface(P.iface); }catch(e){}
      await P.device.close();
    }
    if(P.kind==='serial'){
      if(P.writer) P.writer.releaseLock();
      if(P.port) await P.port.close();
    }
  }catch(e){}
  Object.assign(S.printer, {kind:null, port:null, writer:null, device:null, epOut:null, iface:null, connected:false, name:''});
  updatePrinterUI();
}
async function disconnectPrinter(){
  await closePrinter();
  try{ localStorage.removeItem(PRN_LAST_KEY); }catch(e){}   // que no se reconecte sola
  showToast('Impresora desconectada','info');
}
/* La impresora se desconectó o se apagó a medio trabajo */
function markPrinterLost(){
  Object.assign(S.printer, {connected:false, writer:null, epOut:null});
  updatePrinterUI();
}

/* Reconexión automática: al abrir el POS y al volver a enchufar la impresora.
   No pide permiso otra vez: usa la impresora que ya autorizaste antes. */
async function autoReconnectPrinter(){
  if(S.printer.connected) return true;
  let last = null;
  try{ last = JSON.parse(localStorage.getItem(PRN_LAST_KEY)||'null'); }catch(e){}
  if(!last) return false;
  try{
    if(last.kind==='usb' && usbSupported()){
      const devs = await navigator.usb.getDevices();
      const d = devs.find(x=>x.vendorId===last.vendorId && x.productId===last.productId) || devs[0];
      if(d){ await openUsbPrinter(d); return true; }
    }
    if(last.kind==='serial' && serialSupported()){
      const ports = await navigator.serial.getPorts();
      if(ports[0]){ await openSerialPrinter(ports[0]); return true; }
    }
  }catch(e){ console.warn('Reconexión de impresora:', e.message); }
  return false;
}
if(usbSupported()){
  navigator.usb.addEventListener('connect', ()=>{
    autoReconnectPrinter().then(ok=>{ if(ok) showToast('Impresora reconectada 🖨️','success'); });
  });
  navigator.usb.addEventListener('disconnect', e=>{
    if(S.printer.kind==='usb' && e.device===S.printer.device){
      markPrinterLost();
      showToast('Se desconectó la impresora','warning');
    }
  });
}
setTimeout(()=>{ autoReconnectPrinter(); }, 600);

/* Antes de imprimir: si no está conectada, intenta reconectar y si no,
   abre la ventana para elegirla (requiere que venga de un clic). */
async function ensurePrinter(){
  if(S.printer.connected) return true;
  if(await autoReconnectPrinter()) return true;
  return await connectPrinter();
}

/* Ayuda cuando Windows no deja abrir la impresora (driver de Windows) */
function showUsbHelp(err){
  const msg = err && err.name==='NotPrinter'
    ? 'Ese dispositivo no es una impresora. Vuelve a intentar y elige la que diga POS, Printer o el nombre de tu impresora.'
    : 'Windows tiene la impresora "apartada" con su propio driver, por eso el navegador no la puede abrir. Se arregla una sola vez:';
  const el = g('usbHelpMsg'); if(el) el.textContent = msg;
  const steps = g('usbHelpSteps'); if(steps) steps.classList.toggle('hidden', !!(err && err.name==='NotPrinter'));
  const det = g('usbHelpErr'); if(det) det.textContent = err ? `${err.name||'Error'}: ${err.message||''}` : '';
  g('usbHelpModal')?.classList.remove('hidden');
}
function hideUsbHelp(){ g('usbHelpModal')?.classList.add('hidden'); }

function updatePrinterUI(){
  const cfg = prnCfg();
  const lines = [g('printerStatusLine'), g('adminPrinterStatus')];
  lines.forEach(el=>{
    if(!el) return;
    el.textContent = S.printer.connected
      ? `${S.printer.name} (${S.printer.kind==='usb'?'USB':'Bluetooth/COM'}) · papel ${paperMM(cfg)} mm ✅`
      : printerSupported()
        ? 'No conectada — toca Conectar y elige tu impresora'
        : 'Este navegador no imprime directo: usa Chrome o Edge';
    el.className = (el.id==='printerStatusLine'?'text-xs mt-0.5 ':'text-xs font-semibold mb-3 ') + (S.printer.connected?'text-emerald-600':'text-slate-400');
  });
  /* Refleja la config guardada en los controles del panel Admin → Hardware */
  const set=(id,val)=>{ const el=g(id); if(el){ if(el.type==='checkbox') el.checked=!!val; else el.value=val; } };
  set('prn_baud', cfg.baud); set('prn_density', cfg.density); set('prn_interval', cfg.interval);
  set('prn_double', cfg.doubleStrike); set('prn_codepage', cfg.codepage);
  /* Papel y letra aparecen en dos lugares: Admin → Hardware y el modal de caja */
  ['prn_paper','hw_paper'].forEach(id=>set(id, paperMM(cfg)));
  ['prn_font','hw_font'].forEach(id=>set(id, cfg.bigFont?'big':'normal'));
  ['prn_end','hw_end'].forEach(id=>set(id, cfg.ending==='cut' ? 'cut' : 'tear'+cfg.feedLines));
  set('prn_auto', cfg.autoPrint);
  ['prn_colsHint','hw_colsHint'].forEach(id=>{ const el=g(id); if(el) el.textContent = cfg.bigFont
      ? `Todo en letra grande: ${prnCols(cfg)} letras por renglón (gasta más papel).`
      : `${prnBaseCols(cfg)} letras por renglón; nombre y TOTAL en grande.`; });
  document.querySelectorAll('[data-prn-on]').forEach(el=>el.classList.toggle('hidden', !S.printer.connected));
  document.querySelectorAll('[data-prn-off]').forEach(el=>el.classList.toggle('hidden', !!S.printer.connected));
  const dl=g('prn_densityLabel'); if(dl) dl.textContent = cfg.density+'/5';
  const il=g('prn_intervalLabel'); if(il) il.textContent = cfg.interval+'/6';
}
/* Papel (58/80 mm) y tamaño de letra: sirven igual para la impresora
   conectada y para la impresión desde el navegador. */
function onPaperChange(el){
  if(el.dataset.key==='paper') savePrnCfg({paper: Number(el.value)===80 ? 80 : 58});
  if(el.dataset.key==='font')  savePrnCfg({bigFont: el.value==='big'});
  if(el.dataset.key==='end'){
    if(el.value==='cut') savePrnCfg({ending:'cut'});
    else savePrnCfg({ending:'tear', feedLines: Number(el.value.replace('tear',''))||3});
  }
  if(el.dataset.key==='auto') savePrnCfg({autoPrint: !!el.checked});
  updatePrinterUI();
  showToast('Ajuste de impresión guardado','success');
}
/* Handler de los controles del panel */
async function onPrinterCfgChange(){
  savePrnCfg({
    baud        : Number(g('prn_baud')?.value)     || PRN_DEFAULT.baud,
    density     : Number(g('prn_density')?.value)  || PRN_DEFAULT.density,
    interval    : Number(g('prn_interval')?.value) || PRN_DEFAULT.interval,
    doubleStrike: !!g('prn_double')?.checked,
    codepage    : Number(g('prn_codepage')?.value) || PRN_DEFAULT.codepage
  });
  updatePrinterUI();
  if(S.printer.connected){
    await applyPrinterSettings().catch(()=>{});
    showToast('Ajustes aplicados. Imprime una prueba.','info');
  } else {
    showToast('Guardado. Se aplicará al conectar (el baud requiere reconectar).','info');
  }
}

const ESC = {
  INIT:new Uint8Array([0x1B,0x40]),
  CENTER:new Uint8Array([0x1B,0x61,0x01]),
  LEFT:new Uint8Array([0x1B,0x61,0x00]),
  CUT:new Uint8Array([0x1D,0x56,0x42,0x00]),
  FEED:new Uint8Array([0x0A,0x0A,0x0A]),
};

/* ── ESTILO DEL TEXTO ──────────────────────────────────────────────
   Muchas POS-58 cancelan el modo de tamaño doble en cuanto reciben un
   salto de línea. Por eso antes solo el TOTAL salía nítido: era la única
   línea que tenía el comando justo antes. La solución es reafirmar el
   estilo ANTES DE CADA LÍNEA, que es lo que hace writeToPrinter.
     ESC ! 0x38 → negrita + doble alto + doble ancho
     GS  ! 0x11 → doble alto + doble ancho (algunos clones solo respetan este)
     ESC E 1    → negritas
     ESC G n    → doble pasada (checkbox "Doble pasada")                    */
let PRN_RAW = false;   // true = escribir sin estilo (solo la prueba de densidades)
let PRN_SIZE = null;   // 'big' | 'normal' para la línea en curso (null = según config)
function prnStyleBytes(cfg){
  const big = (PRN_SIZE || (cfg.bigFont ? 'big' : 'normal')) === 'big';
  return [
    heatCmd(cfg),                                  // mismo calor → mismo tono en toda la hoja
    new Uint8Array([0x1B,0x21, big?0x38:0x08]),    // ESC ! negrita (+ doble alto/ancho si es letra grande)
    new Uint8Array([0x1D,0x21, big?0x11:0x00]),    // GS  ! doble alto + doble ancho / tamaño normal
    new Uint8Array([0x1B,0x45,0x01]),              // ESC E negritas
    new Uint8Array([0x1B,0x47, cfg.doubleStrike?1:0]), // ESC G doble pasada
  ];
}

/* ESC 7 n1 n2 n3 — puntos máx. / tiempo de calor / intervalo.
   Es EL comando que arregla los tickets pálidos o borrosos en las POS-58. */
function heatCmd(cfg){
  const heatTime = [60,100,140,180,230][Math.min(4,Math.max(0,(cfg.density|0)-1))];
  const interval = Math.min(15, Math.max(1, cfg.interval|0));
  return new Uint8Array([0x1B,0x37, 7, heatTime, interval]);
}
/* ESC t n — selecciona el code page para que ñ, á, ¿, ¡ salgan bien */
function codepageCmd(cp){
  const n = cp===1252 ? 16 : cp===850 ? 2 : 0;   // 0 = CP437
  return new Uint8Array([0x1B,0x74,n]);
}
async function applyPrinterSettings(){
  PRN_RAW = false;
  if(!S.printer.connected) return;
  const cfg = prnCfg();
  const parts = [ESC.INIT, codepageCmd(cfg.codepage), ...prnStyleBytes(cfg)];
  if(cfg.useDC2) parts.splice(3, 0, new Uint8Array([0x12,0x23, ((Math.min(7,cfg.density+2))<<5) | 0x0A]));
  await writeToPrinter(...parts);
}

/* ── Codificación: la impresora NO entiende UTF-8 ──
   Sin esto, "ñ", "ó" y "¡" salen como símbolos raros o basura. */
const CP437 = {'Ç':128,'ü':129,'é':130,'â':131,'ä':132,'à':133,'å':134,'ç':135,'ê':136,'ë':137,'è':138,'ï':139,'î':140,'ì':141,'Ä':142,'Å':143,'É':144,'æ':145,'Æ':146,'ô':147,'ö':148,'ò':149,'û':150,'ù':151,'ÿ':152,'Ö':153,'Ü':154,'¢':155,'£':156,'¥':157,'ƒ':159,'á':160,'í':161,'ó':162,'ú':163,'ñ':164,'Ñ':165,'ª':166,'º':167,'¿':168,'¬':170,'½':171,'¼':172,'¡':173,'«':174,'»':175,'°':248,'·':250,'²':253};
function encPrinter(str, cp){
  const out = [];
  for(const ch of String(str)){
    const c = ch.codePointAt(0);
    if(c < 128){ out.push(c); continue; }
    if(cp === 1252 || cp === 850){
      if(c <= 255){ out.push(c); continue; }              // Latin-1 directo
    } else if(CP437[ch] !== undefined){
      out.push(CP437[ch]); continue;
    }
    /* Último recurso: quita el acento o sustituye por '?' */
    const plain = ch.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if(plain && plain.charCodeAt(0) < 128) out.push(plain.charCodeAt(0));
    else if(c > 0x2000) { /* emoji / símbolo: se omite */ }
    else out.push(63);
  }
  return new Uint8Array(out);
}

/* ── Escritura por bloques + estilo por línea ──
   Las POS-58 baratas tienen un búfer chico: si le mandas todo de golpe
   pierde bytes y el ticket sale cortado o "movido". */
const sleep = ms => new Promise(r=>setTimeout(r,ms));
/* Envía bytes por el medio conectado.
   Serial/Bluetooth: bloques de 48 con pausa (no tienen control de flujo).
   USB: bloques grandes; el propio USB espera si el búfer de la impresora se llena. */
async function prnSend(bytes){
  const P = S.printer;
  if(!P.connected) throw new Error('Impresora no conectada');
  try{
    if(P.kind==='usb'){
      for(let i=0; i<bytes.length; i+=4096){
        const r = await P.device.transferOut(P.epOut, bytes.slice(i, i+4096));
        if(r.status!=='ok') throw new Error('USB '+r.status);
      }
    } else if(P.kind==='serial'){
      for(let i=0; i<bytes.length; i+=48){
        await P.writer.write(bytes.slice(i, i+48));
        if(bytes.length > 48) await sleep(12);
      }
    } else throw new Error('Impresora no conectada');
  }catch(e){
    markPrinterLost();
    throw e;
  }
}
/* Arma los bytes (texto + estilo antes de cada línea) y los manda de una vez */
async function writeToPrinter(...chunks){
  if(!S.printer.connected) throw new Error('Impresora no conectada');
  const cfg = prnCfg();
  const out = [];
  const push = b => out.push(b);
  const style = PRN_RAW ? [] : prnStyleBytes(cfg);
  for(const c of chunks){
    if(c instanceof Uint8Array){ push(c); continue; }
    if(PRN_RAW){ push(encPrinter(c, cfg.codepage)); continue; }
    /* Una línea a la vez, reafirmando el estilo antes de cada una */
    const parts = String(c).split('\n');
    for(let i=0; i<parts.length; i++){
      if(parts[i]){ style.forEach(push); push(encPrinter(parts[i], cfg.codepage)); }
      if(i < parts.length-1) push(new Uint8Array([0x0A]));
    }
  }
  const total = out.reduce((n,b)=>n+b.length, 0);
  const buf = new Uint8Array(total);
  let o = 0; out.forEach(b=>{ buf.set(b, o); o += b.length; });
  await prnSend(buf);
}
/* Un trabajo a la vez: si se pide imprimir dos veces seguidas, no se mezclan */
let PRN_QUEUE = Promise.resolve();
function prnJob(fn){
  const run = PRN_QUEUE.then(fn, fn);
  PRN_QUEUE = run.catch(()=>{});
  return run;
}
/* Final del ticket: arrancar a mano (avanza N renglones) o cortar */
function prnEndBytes(cfg){
  if(cfg.ending==='cut') return new Uint8Array([0x1D,0x56,0x42,0x00]);   // GS V 66 0: avanza a la cuchilla y corta
  const n = Math.max(0, Math.min(8, cfg.feedLines|0));
  return new Uint8Array(n).fill(0x0A);
}

/* ── Formato ──
   A doble ancho caben 16 caracteres por línea en una POS-58 (no 32). */
/* Las funciones de formato leen las columnas del papel elegido (58/80 mm)
   y del tamaño de letra. 58 mm: 32 normal / 16 grande. 80 mm: 48 / 24. */
function prnLine(ch='-'){ return ch.repeat(prnCols())+'\n'; }
function prnRow(left, right){
  const W = prnCols();
  left = String(left); right = String(right).slice(0, W);
  /* Si no caben juntos (letra grande en 58 mm), el texto va arriba y el
     importe abajo alineado a la derecha, en lugar de cortar la palabra. */
  if(left.length + 1 + right.length > W){
    return prnWrap(left, W, 2).join('\n') + '\n' + ' '.repeat(Math.max(0, W-right.length)) + right + '\n';
  }
  return left + ' '.repeat(W - left.length - right.length) + right + '\n';
}
function prnCenter(txt){
  const W = prnCols();
  return prnWrap(txt, W, 3).map(l=>{
    const pad = Math.max(0, Math.floor((W - l.length)/2));
    return ' '.repeat(pad) + l + '\n';
  }).join('');
}
/* Parte un texto en renglones por palabras, sin cortar a la mitad si se puede */
function prnWrap(txt, W, maxLines=2){
  const words = String(txt||'').trim().split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for(let w of words){
    while(w.length > W){                       // palabra más larga que la línea
      if(cur){ lines.push(cur); cur=''; }
      lines.push(w.slice(0, W)); w = w.slice(W);
    }
    if(!cur) cur = w;
    else if((cur+' '+w).length <= W) cur += ' '+w;
    else { lines.push(cur); cur = w; }
  }
  if(cur) lines.push(cur);
  return lines.length > maxLines ? lines.slice(0, maxLines) : (lines.length ? lines : ['']);
}
const noSym = n => fmt(n).replace(/^\$/,'');
const METODO_TICKET = {cash:'Efectivo', card:'Tarjeta', mixed:'Mixto'};

async function printEscPos(sale){
  await printLinesEscPos(ticketLines(sale));
}

async function testPrint(){
  if(!(await ensurePrinter())) return;
  try{
    await printEscPos({
      items:[{name:'Prueba ñÁ de un nombre largo',quantity:2,price:5,subtotal:10}],
      subtotal:10, discountAmt:0, total:10, payMethod:'cash', amountPaid:20, change:10
    });
    showToast('Ticket de prueba enviado','success');
  }catch(e){ showToast('Error al imprimir: '+e.message,'error'); }
}

/* ── Prueba de calibración: imprime la misma línea con las 5 densidades
     para que elijas a simple vista cuál se ve nítida en tu papel. ── */
async function testPrintDensity(){
  if(!(await ensurePrinter())) return;
  const cfg = prnCfg();
  try{ await prnJob(async()=>{
    PRN_RAW = true;   // sin estilo forzado: aquí sí queremos comparar normal vs doble
    await writeToPrinter(ESC.INIT, codepageCmd(cfg.codepage), ESC.CENTER,
      'PRUEBA DE DENSIDAD\n', ESC.LEFT, '-'.repeat(prnBaseCols(cfg))+'\n');
    for(let d=1; d<=5; d++){
      await writeToPrinter(new Uint8Array([0x1B,0x37,7,[60,100,140,180,230][d-1], Math.min(15,Math.max(1,cfg.interval))]));
      await writeToPrinter(new Uint8Array([0x1B,0x47,0x00]), `Densidad ${d} normal 0123 ABCabc\n`);
      await writeToPrinter(new Uint8Array([0x1B,0x47,0x01]), `Densidad ${d} doble  0123 ABCabc\n`);
    }
    await writeToPrinter(new Uint8Array([0x1B,0x47,0x00]), '-'.repeat(prnBaseCols(cfg))+'\n',
      'Elige la mas nitida.\n', prnEndBytes(cfg));
    PRN_RAW = false;
    await applyPrinterSettings();
  }); showToast('Prueba de densidad enviada','success'); }
  catch(e){ PRN_RAW = false; showToast('Error al imprimir: '+e.message,'error'); }
}

/* ════════════════════════════════════
   HARDWARE / SETTINGS MODAL
════════════════════════════════════ */
function openHardwareModal(){
  updatePrinterUI();
  updateHwRemoteLine();
  g('hardwareModal').classList.remove('hidden');
}
function hideHardwareModal(){ g('hardwareModal').classList.add('hidden'); }
function updateHwRemoteLine(){
  const dot=g('hwRemoteDot'), line=g('hwRemoteStatusLine');
  if(!dot) return;
  const secsAgo = S.remoteLastSeen ? Math.floor((Date.now()-S.remoteLastSeen)/1000) : null;
  if(secsAgo!==null && secsAgo<15){
    dot.className='w-2.5 h-2.5 rounded-full bg-emerald-400 live-dot shrink-0';
    line.textContent='Conectado — visto hace '+secsAgo+'s';
  } else if(secsAgo!==null){
    dot.className='w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0';
    line.textContent='Sin actividad reciente ('+secsAgo+'s)';
  } else {
    dot.className='w-2.5 h-2.5 rounded-full bg-gray-300 shrink-0';
    line.textContent='Sin dispositivo vinculado';
  }
}
setInterval(()=>{ if(!g('hardwareModal').classList.contains('hidden')) updateHwRemoteLine(); }, 1000);

/* ════════════════════════════════════
   TERMINAL SYNC (remote phone scanner)
════════════════════════════════════ */
function initTerminal(){
  let tid = localStorage.getItem('posTid');
  if(!tid){ tid='T'+Math.random().toString(36).substr(2,7).toUpperCase(); localStorage.setItem('posTid',tid); }
  S.tid = tid;
  g('terminalIdEl').textContent = tid;
  try{
    const qrEl=g('tqr'); qrEl.innerHTML='';
    new QRCode(qrEl,{text:scanUrl(tid),width:76,height:76,colorDark:'#1e293b'});
  }catch(e){}
  db.collection('terminals').doc(tid).set({active:true,ts:FS.FieldValue.serverTimestamp()},{merge:true});
  let lastTs=0;
  S.termUnsub = db.collection('terminals').doc(tid).onSnapshot(snap=>{
    const d=snap.data(); if(!d) return;
    if(d.deviceSeen){
      const seenMs = d.deviceSeen.toMillis?.() ?? 0;
      if(seenMs) S.remoteLastSeen = seenMs;
      updateTermPresence();
    }
    if(!d.lastScan) return;
    const ts=d.lastScan.timestamp?.toMillis?.()??0;
    if(ts<=lastTs) return; lastTs=ts;
    const code=d.lastScan.barcode;
    flashSync(true);
    g('searchInput').value = code;
    doSearch(code);
    showToast('📱 '+code,'info');
    setTimeout(()=>flashSync(false),3000);
  });
  setInterval(updateTermPresence, 3000);
}
function updateTermPresence(){
  const secsAgo = S.remoteLastSeen ? (Date.now()-S.remoteLastSeen)/1000 : null;
  const live = g('termLiveDot');
  const statusLine = g('termStatusLine');
  const online = secsAgo!==null && secsAgo<15;
  if(live) live.classList.toggle('hidden', !online);
  if(statusLine){
    statusLine.textContent = online
      ? 'Celular conectado y listo para escanear.'
      : (secsAgo!==null ? 'Último celular visto hace '+Math.floor(secsAgo)+'s.' : 'Escanea el QR con tu celular para usarlo como escáner inalámbrico.');
  }
}
function flashSync(on){
  g('syncDot').className='w-2 h-2 rounded-full inline-block '+(on?'bg-emerald-400 animate-pulse':'bg-gray-400');
  g('syncText').textContent = on?'Escaneo remoto':'Sin escáner remoto';
}
async function pushToTerminal(barcode,tid){
  const data={lastScan:{barcode,timestamp:FS.FieldValue.serverTimestamp()}};
  try{ await db.collection('terminals').doc(tid).update(data); }
  catch(e){ await db.collection('terminals').doc(tid).set({...data,active:true}); }
}
function scanUrl(tid){ return `${location.origin}${location.pathname}?scan=${tid}`; }
function copyScanLink(){
  const url=scanUrl(S.tid);
  navigator.clipboard?.writeText(url).then(()=>showToast('Enlace copiado!','success'))
    .catch(()=>prompt('Copia este enlace:',url));
  if(!navigator.clipboard) prompt('Copia este enlace:',url);
}
async function forgetRemoteDevice(){
  const ok = await confirmAction({title:'¿Olvidar celular vinculado?', msg:'Se generará un nuevo código QR y el celular actual dejará de estar vinculado a esta caja.', okLabel:'Olvidar', icon:'📵'});
  if(!ok) return;
  localStorage.removeItem('posTid');
  S.remoteLastSeen=0;
  location.reload();
}
function toggleTermCard(){
  const body=g('termCardBody'), ch=g('termChevron');
  const open=!body.classList.contains('hidden');
  body.classList.toggle('hidden',open);
  ch.style.transform=open?'rotate(-90deg)':'rotate(0deg)';
}
function checkPhoneMode(){
  const target=new URLSearchParams(location.search).get('scan');
  if(!target) return;
  window._phoneMode=true; window._targetTerminal=target;
  window._phoneScanCount=0;
  show('phoneBanner'); g('phoneTargetId').textContent=target;
  g('terminalCard').classList.add('hidden'); hide('stateWelcome');
  reportDevicePresence(target);
  setInterval(()=>reportDevicePresence(target), 8000);
  delay(500).then(()=>{
    const wrap=document.createElement('div');
    wrap.className='rounded-xl overflow-hidden bg-black'; wrap.style.height='340px';
    const inner=document.createElement('div'); inner.id='phoneScanReader'; inner.style.cssText='width:100%;height:100%';
    wrap.appendChild(inner);
    g('posContent').appendChild(wrap);
    startSc('phoneScanReader','phoneSc', async code=>{
      await pushToTerminal(code,target);
      window._phoneScanCount++;
      g('phoneScanCount').textContent = window._phoneScanCount;
      if(navigator.vibrate) navigator.vibrate(60);
      showToast('✅ Enviado: '+code,'success');
      beep('scan');
      doSearch(code);
    });
  });
}
function reportDevicePresence(tid){
  db.collection('terminals').doc(tid).set({deviceSeen:FS.FieldValue.serverTimestamp()},{merge:true}).catch(()=>{});
}

/* ════════════════════════════════════
   DISCOUNTS
════════════════════════════════════ */
let _discType='pct';
function openDiscountModal(){
  if(!S.cart.length){ showToast('El carrito está vacío','warning'); return; }
  _discType = S.discount?.type || 'pct';
  g('discountValueInput').value = S.discount?.value ?? '';
  setDiscountType(_discType);
  g('discountModal').classList.remove('hidden');
  setTimeout(()=>g('discountValueInput').focus(),150);
}
function hideDiscountModal(){ g('discountModal').classList.add('hidden'); }
function setDiscountType(t){
  _discType=t;
  const on='border-2 border-indigo-500 bg-indigo-50 text-indigo-700 py-2.5 rounded-xl font-semibold text-sm min-h-[44px]';
  const off='border-2 border-slate-200 bg-slate-50 text-slate-500 py-2.5 rounded-xl font-semibold text-sm min-h-[44px]';
  g('discTypeBtnPct').className = t==='pct'?on:off;
  g('discTypeBtnFixed').className = t==='fixed'?on:off;
  previewDiscount();
}
function previewDiscount(){
  const {subtotal} = cartTotals();
  const val = parseFloat(g('discountValueInput').value)||0;
  const amt = _discType==='pct' ? subtotal*(val/100) : val;
  const clamped = Math.max(0, Math.min(subtotal, amt));
  g('discountPreview').textContent = val>0
    ? `Descuento de ${fmt(clamped)} · Nuevo total: ${fmt(subtotal-clamped)}`
    : 'Ingresa un valor para ver el nuevo total';
}
function applyDiscount(){
  const val = parseFloat(g('discountValueInput').value)||0;
  if(val<=0){ removeDiscount(); hideDiscountModal(); return; }
  S.discount = {type:_discType, value:val};
  renderCart(); hideDiscountModal();
  showToast('Descuento aplicado','success');
}
function removeDiscount(){ S.discount=null; renderCart(); }

/* ════════════════════════════════════
   PARKED / HELD SALES (per-browser, localStorage)
════════════════════════════════════ */
function getParkedSales(){ try{ return JSON.parse(localStorage.getItem(PARK_KEY)||'[]'); }catch(e){ return []; } }
function setParkedSales(list){ localStorage.setItem(PARK_KEY, JSON.stringify(list)); refreshParkBadges(); }
function refreshParkBadges(){
  const n = getParkedSales().length;
  ['parkCountMobile','parkCountDesktop'].forEach(id=>{
    const el=g(id); if(!el) return;
    if(n>0){ el.textContent=n; el.classList.remove('hidden'); } else el.classList.add('hidden');
  });
}
function holdSale(){
  if(!S.cart.length){ showToast('El carrito está vacío','warning'); return; }
  const list = getParkedSales();
  list.push({id:'P'+Date.now(), ts:Date.now(), cart:[...S.cart], discount:S.discount, label:S.cart[0]?.name||'Venta'});
  setParkedSales(list);
  S.cart=[]; S.discount=null; renderCart();
  closeMobileCart();
  showToast('Venta guardada en espera','info');
}
function showParkedModal(){
  const list=getParkedSales();
  const el=g('parkedListEl');
  el.innerHTML = list.length ? list.map(p=>{
    const total=p.cart.reduce((s,i)=>s+i.subtotal,0);
    const count=p.cart.reduce((s,i)=>s+i.quantity,0);
    const when=new Date(p.ts).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'});
    return `<div class="border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-slate-800 truncate">${esc(p.label)} ${p.cart.length>1?'+ '+(p.cart.length-1)+' más':''}</p>
        <p class="text-xs text-slate-400">${count} items · ${fmt(total)} · ${when}</p>
      </div>
      <div class="flex gap-1.5 shrink-0">
        <button onclick="resumeParkedSale('${p.id}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 text-xs font-semibold px-3 py-2 rounded-lg min-h-[36px]">Retomar</button>
        <button onclick="deleteParkedSale('${p.id}')" class="text-red-400 hover:text-red-600 px-2 py-2 min-h-[36px]"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }).join('') : '<p class="text-slate-400 text-sm text-center py-8">No hay ventas en espera</p>';
  g('parkedModal').classList.remove('hidden');
}
function hideParkedModal(){ g('parkedModal').classList.add('hidden'); }
async function resumeParkedSale(id){
  if(S.cart.length){
    const ok = await confirmAction({title:'¿Reemplazar carrito actual?', msg:'Tu carrito actual se descartará al retomar esta venta en espera.', okLabel:'Retomar', icon:'🔄'});
    if(!ok) return;
  }
  const list=getParkedSales();
  const found=list.find(p=>p.id===id); if(!found) return;
  S.cart=found.cart; S.discount=found.discount||null;
  setParkedSales(list.filter(p=>p.id!==id));
  renderCart(); hideParkedModal();
  showToast('Venta retomada','success');
}
function deleteParkedSale(id){
  setParkedSales(getParkedSales().filter(p=>p.id!==id));
  showParkedModal();
}

/* ════════════════════════════════════
   GENERIC CONFIRM MODAL (Promise-based)
════════════════════════════════════ */
let _confirmCb=null;
function confirmAction({title='¿Estás seguro?', msg='Esta acción no se puede deshacer.', okLabel='Confirmar', icon='⚠️'}={}){
  g('confirmTitle').textContent=title;
  g('confirmMsg').textContent=msg;
  g('confirmOkBtn').textContent=okLabel;
  g('confirmIcon').textContent=icon;
  g('confirmModal').classList.remove('hidden');
  return new Promise(res=>{ _confirmCb=res; });
}
function _confirmResolve(val){
  g('confirmModal').classList.add('hidden');
  if(_confirmCb){ _confirmCb(val); _confirmCb=null; }
}

/* ════════════════════════════════════
   SOUND FEEDBACK (no external files — Web Audio beeps)
════════════════════════════════════ */
let _actx=null;
function toggleSound(){
  S.soundOn=!S.soundOn;
  localStorage.setItem('posSound', S.soundOn?'1':'0');
  g('soundBtn').innerHTML = `<i class="fa-solid fa-volume-${S.soundOn?'high':'xmark'}"></i>`;
  showToast(S.soundOn?'Sonido activado':'Sonido silenciado','info');
}
function beep(kind='add'){
  if(!S.soundOn) return;
  try{
    _actx = _actx || new (window.AudioContext||window.webkitAudioContext)();
    const map = {scan:[880,0.06], add:[660,0.08], success:[520,0.14], error:[180,0.18]};
    const [freq,dur] = map[kind]||map.add;
    const o=_actx.createOscillator(), gn=_actx.createGain();
    o.type='sine'; o.frequency.value=freq;
    gn.gain.setValueAtTime(0.12,_actx.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.001,_actx.currentTime+dur);
    o.connect(gn); gn.connect(_actx.destination);
    o.start(); o.stop(_actx.currentTime+dur);
  }catch(e){}
}

/* ════════════════════════════════════
   LIVE CLOCK
════════════════════════════════════ */
function initClock(){
  const tick=()=>{
    const s=new Date().toLocaleString('es-MX',{weekday:'short',hour:'2-digit',minute:'2-digit'});
    const navC=g('navClock'); if(navC) navC.textContent=s;
    const cdC=g('cdClock'); if(cdC) cdC.textContent=s;
  };
  tick(); setInterval(tick,15000);
}

/* ════════════════════════════════════
   CUSTOMER-FACING DISPLAY (second screen via ?display=TID)
════════════════════════════════════ */
function displayUrl(tid){ return `${location.origin}${location.pathname}?display=${tid}`; }
function toggleDisplayCard(){
  const body=g('displayCardBody'), ch=g('displayChevron');
  const open=!body.classList.contains('hidden');
  body.classList.toggle('hidden',open);
  ch.style.transform=open?'rotate(-90deg)':'rotate(0deg)';
  if(!open){
    try{ const el=g('cqr'); if(!el.dataset.rendered){ el.innerHTML=''; new QRCode(el,{text:displayUrl(S.tid),width:76,height:76,colorDark:'#4338ca'}); el.dataset.rendered='1'; } }catch(e){}
  }
}
function copyDisplayLink(){
  const url=displayUrl(S.tid);
  navigator.clipboard?.writeText(url).then(()=>showToast('Enlace copiado!','success')).catch(()=>prompt('Copia este enlace:',url));
  if(!navigator.clipboard) prompt('Copia este enlace:',url);
}
/* Cashier side: push current cart to the terminal doc, throttled */
function scheduleCustomerDisplayPush(){
  if(!S.tid || window._displayMode) return;
  clearTimeout(_cdPushTimer);
  _cdPushTimer=setTimeout(()=>{
    const {subtotal, discountAmt, total} = cartTotals();
    db.collection('terminals').doc(S.tid).set({
      currentCart:{items:S.cart.map(i=>({name:i.name,quantity:i.quantity,subtotal:i.subtotal})),subtotal,discountAmt,total,ts:Date.now()}
    },{merge:true}).catch(()=>{});
  },350);
}
function pushSaleCompletedToDisplay(total){
  if(!S.tid || window._displayMode) return;
  db.collection('terminals').doc(S.tid).set({
    lastCompletedSale:{total, ts:Date.now()},
    currentCart:{items:[],subtotal:0,discountAmt:0,total:0,ts:Date.now()}
  },{merge:true}).catch(()=>{});
}
/* Customer side: read-only screen */
function checkCustomerDisplayMode(){
  const target=new URLSearchParams(location.search).get('display');
  if(!target) return;
  window._displayMode=true;
  document.querySelectorAll('nav, #cartFab, #cartSheet, #cartBackdrop').forEach(el=>el?.classList.add('hidden'));
  show('customerDisplayScreen');
  document.body.classList.add('overflow-hidden');
  let lastCompletedTs=0;
  db.collection('terminals').doc(target).onSnapshot(snap=>{
    const d=snap.data(); if(!d) return;
    const completedTs = d.lastCompletedSale?.ts||0;
    if(completedTs>lastCompletedTs && completedTs>Date.now()-15000){
      lastCompletedTs=completedTs;
      showCdThankYou(d.lastCompletedSale.total);
      setTimeout(()=>showCdCart(d.currentCart),4000);
      return;
    }
    showCdCart(d.currentCart);
  }, err=>console.warn('Customer display snapshot error:',err));
}
function showCdCart(cc){
  hide('cdThankYou');
  const items = cc?.items||[];
  if(!items.length){ show('cdEmptyState'); hide('cdItemsArea'); hide('cdFooter'); return; }
  hide('cdEmptyState'); show('cdItemsArea'); show('cdFooter');
  g('cdItemsArea').innerHTML = items.map(it=>`
    <div class="cd-item flex justify-between items-center bg-white/10 rounded-xl px-4 py-3">
      <span class="font-medium">${esc(it.name)} <span class="text-white/50">×${it.quantity}</span></span>
      <span class="font-bold">${fmt(it.subtotal)}</span>
    </div>`).join('');
  g('cdTotalEl').textContent = fmt(cc.total);
}
function showCdThankYou(total){
  hide('cdEmptyState'); hide('cdItemsArea'); hide('cdFooter');
  show('cdThankYou');
  g('cdThankYouTotal').textContent = fmt(total);
}

/* ════════════════════════════════════
   PAYMENT
════════════════════════════════════ */
async function showPaymentModal(){
  if(!S.cart.length) return;
  /* Antes de cobrar: ¿todavía hay de todo lo que lleva el carrito? */
  if(!(await ensureCartStock())) return;
  if(!S.cart.length) return;
  const {subtotal, discountAmt, total} = cartTotals();
  g('payItemsSummary').innerHTML = S.cart.map(it=>
    `<div class="flex justify-between text-slate-600"><span>${esc(it.name)} ×${it.quantity}</span><span class="font-semibold ml-2">${fmt(it.subtotal)}</span></div>`
  ).join('') + `<div class="border-t border-slate-200 mt-1 pt-1 flex justify-between font-bold"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>`;
  g('payDiscountRow').classList.toggle('hidden', !discountAmt);
  g('payDiscountRow').classList.toggle('flex', !!discountAmt);
  if(discountAmt) g('payDiscountAmt').textContent='-'+fmt(discountAmt);
  g('payTotal').textContent = fmt(total);
  g('cashInput').value=''; g('changeDisplay').textContent='$0.00';
  g('mixedCashInput').value=''; g('mixedCardInput').value=''; g('mixedStatus').textContent='';
  S.payMethod='cash'; selectPayMethod('cash');
  /* Quick amounts buttons */
  const quicks=[total,Math.ceil(total/10)*10,Math.ceil(total/50)*50,Math.ceil(total/100)*100];
  const uniq=[...new Set(quicks)].filter(v=>v>=total).slice(0,4);
  g('quickAmounts').innerHTML=uniq.map(v=>`<button onclick="setQuick(${v})" class="flex-1 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 text-xs font-bold py-2 rounded-lg min-h-[36px]">${fmt(v)}</button>`).join('');
  closeMobileCart();
  g('payModal').classList.remove('hidden');
  setTimeout(()=>g('cashInput').focus(),200);
}
function hidePayModal(){ g('payModal').classList.add('hidden'); }
function setQuick(v){ g('cashInput').value=v; calcChange(); }

function recalcTotalConComision() {
  const {total} = cartTotals();
  let fee = 0;
  if (S.payMethod === 'card') {
    fee = total * 0.04;
  } else if (S.payMethod === 'mixed') {
    const cardAmt = parseFloat(g('mixedCardInput').value) || 0;
    fee = cardAmt * 0.04;
  }
  const grandTotal = total + fee;
  g('payFeeRow').classList.toggle('hidden', fee === 0);
  g('payFeeAmt').textContent = '+' + fmt(fee);
  g('payTotal').textContent = fmt(grandTotal);
  return { baseTotal: total, fee, grandTotal };
}

function selectPayMethod(m){
  S.payMethod=m;
  const active='border-2 border-emerald-500 bg-emerald-50 text-emerald-700 py-2.5 rounded-xl font-semibold text-xs sm:text-sm min-h-[58px]';
  const inactive='border-2 border-slate-200 bg-slate-50 text-slate-500 py-2.5 rounded-xl font-semibold text-xs sm:text-sm min-h-[58px]';
  const cardActive='border-2 border-blue-500 bg-blue-50 text-blue-700 py-2.5 rounded-xl font-semibold text-xs sm:text-sm min-h-[58px]';
  const mixedActive='border-2 border-violet-500 bg-violet-50 text-violet-700 py-2.5 rounded-xl font-semibold text-xs sm:text-sm min-h-[58px]';
  g('payBtnCash').className=m==='cash'?active:inactive;
  g('payBtnCard').className=m==='card'?cardActive:inactive;
  g('payBtnMixed').className=m==='mixed'?mixedActive:inactive;
  g('cashArea').classList.toggle('hidden',m!=='cash');
  g('mixedArea').classList.toggle('hidden',m!=='mixed');
  recalcTotalConComision();
  if(m==='cash') calcChange();
  if(m==='mixed') calcMixed();
}
function calcChange(){
  const { grandTotal } = recalcTotalConComision();
  const paid=parseFloat(g('cashInput').value)||0;
  const change=paid-grandTotal;
  g('changeDisplay').textContent=fmt(Math.max(0,change));
  g('changeDisplay').className=change>=0?'text-2xl font-black text-emerald-600':'text-2xl font-black text-red-500';
}
function calcMixed(){
  const { grandTotal } = recalcTotalConComision();
  const cash=parseFloat(g('mixedCashInput').value)||0;
  const card=parseFloat(g('mixedCardInput').value)||0;
  const sum=cash+card;
  const diff=sum-grandTotal;
  const el=g('mixedStatus');
  if(Math.abs(diff)<0.01){ el.textContent='✓ Cubre el total (incl. comisión)'; el.className='text-xs font-semibold text-center py-1.5 rounded-lg bg-emerald-50 text-emerald-600'; }
  else if(diff>0){ el.textContent=`Sobran ${fmt(diff)} — ajusta montos`; el.className='text-xs font-semibold text-center py-1.5 rounded-lg bg-amber-50 text-amber-600'; }
  else { el.textContent=`Faltan ${fmt(-diff)} para cubrir total`; el.className='text-xs font-semibold text-center py-1.5 rounded-lg bg-red-50 text-red-600'; }
}

async function processPayment(){
  if(!S.user){ showToast('Debes iniciar sesión para cobrar','error'); return; }
  /* Segunda revisión justo al confirmar: el stock pudo cambiar mientras
     el cliente pagaba (otra caja vendió lo mismo, llegó un snapshot…) */
  if(cartStockProblems().length){ hidePayModal(); await ensureCartStock(); return; }
  const {subtotal, discountAmt, total: baseTotal} = cartTotals();
  const {fee, grandTotal} = recalcTotalConComision();
  let paid = grandTotal, cashPortion=0, cardPortion=0;
  
  if(S.payMethod==='cash'){
    paid=parseFloat(g('cashInput').value)||0;
    if(paid<grandTotal){ showToast('El monto recibido es menor al total','error'); beep('error'); return; }
    cashPortion=grandTotal;
  } else if(S.payMethod==='mixed'){
    cashPortion=parseFloat(g('mixedCashInput').value)||0;
    cardPortion=parseFloat(g('mixedCardInput').value)||0;
    if(Math.abs((cashPortion+cardPortion)-grandTotal)>0.01){ showToast('Los montos mixtos no cubren el total exacto','error'); beep('error'); return; }
    paid=grandTotal;
  } else { cardPortion=grandTotal; }
  
  const total = grandTotal;

  const btn=g('processBtn');
  btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin mr-2"></i>Guardando…';
  try{
    const now=new Date();
    const localId=newLocalId();
    /* Costo de la mercancía vendida (para calcular la ganancia real) */
    const cogs = S.cart.reduce((s,i)=> s + (i.isRecharge?0:(Number(i.cost)||0)*i.quantity), 0);
    const saleData={
      localId,
      items:S.cart.map(i=>({...i})),
      subtotal, discountAmt,
      discountType: S.discount?.type||null,
      discountValue: S.discount?.value||null,
      total,
      cost: cogs,
      grossProfit: total - cogs,
      payMethod:S.payMethod,
      amountPaid:paid,
      cashPortion, cardPortion,
      change:S.payMethod==='cash'?Math.max(0,paid-total):0,
      sellerId:S.user.uid,
      sellerName:S.user.displayName||S.user.email,
      cashierName: nombreCajeroActual(),   // lo que sale en el ticket (nunca el correo)
      storeName: nombreNegocio(),
      branchId:S.userBranchId||null,
      branchName:S.userBranchName||null,
      shiftId:S.currentShift?.id||null,
      tsISO: now.toISOString(),
      date:localDateStr(now),
      year:now.getFullYear(),
      month:now.getMonth()+1,
      voided:false,
      createdOffline: !isOnline(),
    };

    /* La venta se guarda SIEMPRE en el dispositivo primero: así el cobro
       nunca se traba aunque no haya internet. Después se sube a Firebase. */
    const stockDeltas = S.cart.filter(i=>!i.isRecharge).map(i=>({barcode:i.barcode, qty:i.quantity}));
    outboxPush({
      id: localId, type:'sale', tsISO: saleData.tsISO, tries:0,
      payload: saleData,
      stockDeltas,
      shiftUpdate: S.currentShift ? {shiftId:S.currentShift.id, cash:cashPortion, card:cardPortion, total} : null,
      label: `Venta ${fmt(total)}`
    });

    /* El stock local ya se descontó: outboxPush → rebuildProducts() */
    if(S.currentShift){
      S.currentShift.cashSales=(S.currentShift.cashSales||0)+cashPortion;
      S.currentShift.cardSales=(S.currentShift.cardSales||0)+cardPortion;
      S.currentShift.totalSales=(S.currentShift.totalSales||0)+total;
      S.currentShift.salesCount=(S.currentShift.salesCount||0)+1;
      saveLocalShift();
    }

    pushSaleCompletedToDisplay(total);
    beep('success');
    hidePayModal();
    showReceiptModal({...saleData, timestamp:now});
    S.cart=[]; S.discount=null; renderCart();
    hide('stateProduct'); show('stateWelcome');
    g('searchInput').value='';
    updateStockBell();

    if(isOnline()) flushOutbox();
    else showToast('Venta guardada en el dispositivo — se subirá sola al volver el internet','warning');
  } catch(e){
    console.error('Payment error:', e);
    showToast('Error al registrar la venta: '+e.message,'error');
    beep('error');
  } finally {
    btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-check mr-2"></i>Confirmar Pago';
  }
}

/* ════════════════════════════════════
   RECEIPT (post-payment)
════════════════════════════════════ */
let _lastReceipt=null;

/* ════════════════════════════════════════════════════════
   TICKET — un solo "modelo" de renglones que se dibuja igual en:
   la vista previa, la impresión del navegador (58/80 mm), la
   impresora térmica ESC/POS y el texto para WhatsApp.
   Nunca lleva correos ni la dirección (link) del POS.
════════════════════════════════════════════════════════ */

/* Nombre de quien cobra, para el ticket. Si solo tenemos un correo, no se muestra. */
function limpiarNombre(n){
  n = String(n||'').trim();
  return (!n || n.includes('@')) ? '' : n;
}
function nombreCajeroActual(){
  return limpiarNombre(PERFIL && PERFIL.name) || limpiarNombre(S.user && S.user.displayName) || '';
}
function nombreCajero(sale){
  return limpiarNombre(sale && sale.cashierName) || limpiarNombre(sale && sale.sellerName);
}
/* Por si algún texto trae una URL o un correo (p. ej. el pie de ticket), se quita */
function sinLinks(t){
  return String(t||'')
    .replace(/https?:\/\/\S+/gi,'')
    .replace(/\bwww\.\S+/gi,'')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g,'')
    .replace(/\s{2,}/g,' ').trim();
}
function fechaTicket(iso){
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'2-digit'})
       + ' ' + d.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',hour12:false});
}

/* Renglones del ticket de venta.
   t: 'center' | 'text' | 'row' | 'hr'   ·  strong: negritas/total */
function ticketLines(sale){
  const enc = encabezadoTicket(sale);
  const L = [];
  L.push({t:'center', k:'store', text:sinLinks(enc.negocio).toUpperCase()});
  if(enc.sucursal) L.push({t:'center', k:'meta', text:sinLinks(enc.sucursal)});
  L.push({t:'center', k:'meta', text:fechaTicket(sale.tsISO)});
  const cajero = nombreCajero(sale);
  if(cajero) L.push({t:'center', k:'meta', text:'Atendió: '+cajero});
  L.push({t:'hr'});
  (sale.items||[]).forEach(it=>{
    const qty = it.isBulk ? `${round3(it.quantity)} kg` : `${it.quantity}`;
    L.push({t:'text', k:'item', text:it.name});
    L.push({t:'row', k:'itemrow', l:`${qty} x ${fmt(it.price)}`, r:fmt(it.subtotal)});
  });
  L.push({t:'hr'});
  const nArt = (sale.items||[]).reduce((n,it)=>n + (it.isBulk ? 1 : (Number(it.quantity)||0)), 0);
  L.push({t:'row', k:'sub', l:`Subtotal (${nArt} art.)`, r:fmt(sale.subtotal)});
  if(sale.discountAmt) L.push({t:'row', k:'sub', l:'Descuento', r:'-'+fmt(sale.discountAmt)});
  L.push({t:'row', k:'total', l:'TOTAL', r:fmt(sale.total)});
  if(sale.payMethod){
    L.push({t:'row', k:'pay', l:'Pago', r:METODO_TICKET[sale.payMethod]||''});
    if(sale.payMethod==='cash'){
      L.push({t:'row', k:'pay', l:'Recibido', r:fmt(sale.amountPaid||sale.total)});
      L.push({t:'row', k:'pay', l:'Cambio', r:fmt(sale.change||0)});
    }
    if(sale.payMethod==='mixed'){
      L.push({t:'row', k:'pay', l:'Efectivo', r:fmt(sale.cashPortion||0)});
      L.push({t:'row', k:'pay', l:'Tarjeta', r:fmt(sale.cardPortion||0)});
    }
  }
  const pie = sinLinks(pieDeTicket());
  if(pie){ L.push({t:'hr'}); L.push({t:'center', k:'footer', text:pie}); }
  return L;
}

/* ── Estilos del ticket ──
   Van aquí (y no en styles.css) para que el ticket SIEMPRE salga con
   formato aunque el navegador tenga guardada una versión vieja del CSS.
   Al imprimir todo es negro puro: los grises solo se usan en pantalla. */
const TICKET_CSS = `
.tk{color:#000;background:#fff;font-family:'Segoe UI',Roboto,Arial,Helvetica,sans-serif;
  font-weight:600;line-height:1.3;box-sizing:border-box;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;font-variant-numeric:tabular-nums}
.tk *{box-sizing:border-box}
.tk.p58{width:58mm;padding:4mm 5mm 5mm;font-size:11.5px}
.tk.p80{width:80mm;padding:4mm 5mm 5mm;font-size:13px}
.tk.p58.big{font-size:13px}
.tk.p80.big{font-size:15px}
.tk-c{text-align:center;overflow-wrap:anywhere}
.tk-x{overflow-wrap:anywhere}
.tk-r{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.tk-r>span:first-child{min-width:0;overflow-wrap:anywhere}
.tk-r>span:last-child{white-space:nowrap;text-align:right}
.tk-hr{border-top:1.5px dashed #000;margin:7px 0}
.tk .s{font-weight:800}
.tk .t{font-size:1.15em}

.tk .k-store{font-size:1.35em;font-weight:900;letter-spacing:.04em;line-height:1.15;margin-bottom:3px}
.tk .k-tag{font-weight:900;letter-spacing:.12em;margin:3px 0 1px}
.tk .k-meta{font-size:.88em;font-weight:500}
.tk .k-item{font-weight:700;margin-top:6px}
.tk .tk-hr + .k-item{margin-top:0}
.tk .k-itemrow{font-size:.92em;font-weight:500}
.tk .k-itemrow>span:last-child{font-weight:800;font-size:1.06em}
.tk .k-sub{font-size:.95em;font-weight:500}
.tk .k-total{border-top:2px solid #000;margin-top:5px;padding-top:5px;font-size:1.4em;font-weight:900}
.tk .k-pay{font-size:.9em;font-weight:500}
.tk .k-total + .k-pay{margin-top:5px}
.tk .k-footer{font-weight:700;font-size:.95em}

/* Vista previa en pantalla: un ticket de papel */
.tk-wrap{background:#f1f5f9;border-radius:14px;padding:14px 10px 18px;display:flex;justify-content:center;overflow:hidden}
.tk-screen{max-width:100%;box-shadow:0 1px 2px rgba(15,23,42,.08),0 6px 18px rgba(15,23,42,.10);
  border-radius:3px 3px 0 0;position:relative}
.tk-screen::after{content:'';position:absolute;left:0;right:0;bottom:-7px;height:8px;
  background:linear-gradient(-45deg,transparent 5px,#fff 0) 0 0/10px 8px repeat-x,
             linear-gradient(45deg,transparent 5px,#fff 0) 0 0/10px 8px repeat-x}
.tk-screen .k-meta,.tk-screen .k-itemrow>span:first-child,.tk-screen .k-sub,.tk-screen .k-pay{color:#475569}
.tk-screen .tk-hr{border-color:#94a3b8}
.tk-screen .k-total{color:#0f172a}

/* Contenedor de impresión: invisible en pantalla */
#ticketPrint{display:none}
#ticketPrint.measuring{display:block;position:fixed;left:-9999px;top:0;visibility:hidden}
@media print{
  /* Sin margen de página = el navegador no imprime título, fecha ni la URL */
  @page{margin:0}
  html,body{height:auto!important;min-height:0!important;overflow:visible!important;background:#fff!important;margin:0!important;padding:0!important}
  body>*:not(#ticketPrint){display:none!important}
  #ticketPrint{display:block!important;position:static!important;visibility:visible!important}
  #ticketPrint *{color:#000!important;border-color:#000!important}
}`;
(function injectTicketCSS(){
  if(document.getElementById('ticketStyles')) return;
  const st = document.createElement('style');
  st.id = 'ticketStyles';
  st.textContent = TICKET_CSS;
  document.head.appendChild(st);
})();

/* → HTML (vista previa e impresión del navegador) */
function ticketHTML(lines){
  return lines.map(x=>{
    const cls = (x.k?' k-'+x.k:'') + (x.strong?' s':'') + (x.title?' t':'');
    if(x.t==='hr')     return '<div class="tk-hr"></div>';
    if(x.t==='center') return `<div class="tk-c${cls}">${esc(x.text)}</div>`;
    if(x.t==='row')    return `<div class="tk-r${cls}"><span>${esc(x.l)}</span><span>${esc(x.r)}</span></div>`;
    return `<div class="tk-x${cls}">${esc(x.text)}</div>`;
  }).join('');
}
/* → impresora térmica (respeta columnas del papel elegido) */
/* Todo el ticket se arma y se manda en un solo envío.
   El nombre del negocio y el TOTAL van en letra doble; el resto según
   "Tamaño de letra" (normal = la mitad de papel). */
function printLinesEscPos(lines){
  return prnJob(async()=>{
    await applyPrinterSettings();
    const cfg = prnCfg();
    const body = cfg.bigFont ? 'big' : 'normal';
    const parts = [];
    try{
      for(const x of lines){
        PRN_SIZE = (x.k==='store' || x.k==='total') ? 'big' : body;
        const W = prnCols(cfg);
        let txt;
        if(x.t==='hr')          txt = prnLine();
        else if(x.t==='center') txt = prnCenter(x.text);
        else if(x.t==='row')    txt = prnRow(x.l.replace(/\$/g,''), x.r);
        else                    txt = prnWrap(x.text, W, 2).join('\n')+'\n';
        /* El estilo (tamaño) se calcula ahora, mientras PRN_SIZE es el de esta línea */
        const style = prnStyleBytes(cfg);
        txt.split('\n').forEach((ln, i, arr)=>{
          if(ln){ parts.push(...style, encPrinter(ln, cfg.codepage)); }
          if(i < arr.length-1) parts.push(new Uint8Array([0x0A]));
        });
      }
    } finally { PRN_SIZE = null; }
    parts.push(...prnStyleBytes(cfg), prnEndBytes(cfg));
    await writeToPrinter(...parts);    // solo Uint8Array: se envía tal cual
  });
}
/* → texto plano (WhatsApp / compartir) */
function ticketPlainText(lines){
  return lines.map(x=>{
    if(x.t==='hr') return '—————————';
    if(x.t==='row') return `${x.l}: ${x.r}`;
    return x.text;
  }).join('\n');
}

/* Imprime desde el navegador al ancho del rollo (58 u 80 mm).
   @page con margen 0 hace que Chrome/Edge NO impriman el encabezado y
   pie de página automáticos (título, fecha y la dirección del POS). */
function imprimirEnNavegador(lines){
  const cfg = prnCfg(), mm = paperMM(cfg);
  const box = g('ticketPrint');
  box.className = `tk p${mm}${cfg.bigFont?' big':''}`;
  box.innerHTML = ticketHTML(lines);
  /* Se mide el ticket para que la hoja tenga su largo exacto (sin papel de más) */
  box.classList.add('measuring');
  const altoMM = Math.ceil(box.getBoundingClientRect().height * 25.4 / 96) + 8;
  box.classList.remove('measuring');
  let st = g('pageSizeStyle');
  if(!st){ st = document.createElement('style'); st.id = 'pageSizeStyle'; document.head.appendChild(st); }
  st.textContent = `@page{size:${mm}mm ${Math.max(altoMM, 40)}mm;margin:0}`;
  /* Por si algún navegador ignora el margen 0: sin título en el encabezado */
  const titulo = document.title;
  document.title = ' ';
  const volver = () => { document.title = titulo; window.removeEventListener('afterprint', volver); };
  window.addEventListener('afterprint', volver);
  setTimeout(()=>{ window.print(); setTimeout(volver, 1500); }, 60);
}

function showReceiptModal(sale){
  _lastReceipt=sale;
  const cfg = prnCfg();
  g('receiptPrintArea').innerHTML =
    `<div class="tk-wrap"><div class="tk tk-screen p${paperMM(cfg)}${cfg.bigFont?' big':''}">${ticketHTML(ticketLines(sale))}</div></div>`;
  g('receiptModal').classList.remove('hidden');
  /* Se imprime solo al cobrar si la impresora está conectada */
  if(S.printer.connected && prnCfg().autoPrint){
    printEscPos(sale).catch(e=>showToast('No se pudo imprimir: '+e.message+'. Toca Imprimir para reintentar.','error'));
  }
}
function hideReceiptModal(){ g('receiptModal').classList.add('hidden'); }
function receiptText(sale){ return ticketPlainText(ticketLines(sale)); }
function shareReceipt(){
  if(!_lastReceipt) return;
  const text = receiptText(_lastReceipt);
  /* Solo texto: sin url, para que no se comparta el link del POS */
  if(navigator.share){ navigator.share({text}).catch(()=>{}); return; }
  window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank');
}
async function printReceipt(){
  if(!_lastReceipt) return;
  await imprimirDirecto(ticketLines(_lastReceipt));
}
/* Imprime en la térmica sin abrir la ventana de impresión.
   Solo si el navegador NO puede hablar con la impresora (iPhone, Firefox)
   se usa la impresión del navegador como último recurso. */
async function imprimirDirecto(lines){
  if(!printerSupported()){ imprimirEnNavegador(lines); return; }
  if(!(await ensurePrinter())) return;
  try{
    await printLinesEscPos(lines);
    showToast('Ticket enviado a la impresora 🖨️','success');
  }catch(e){
    showToast('No se pudo imprimir: '+e.message+'. Revisa que esté encendida y conectada.','error');
  }
}

/* ════════════════════════════════════
   ADMIN
════════════════════════════════════ */
function openAdmin(){
  /* Solo el dueño. El rol lo definiste tú al dar de alta el negocio;
     aquí no hay forma de ascenderse. Y si alguien llama esta función
     desde la consola, igual no pasa: las reglas no le entregan datos. */
  if(!S.isAdmin){
    showToast('Tu cuenta es de vendedor. El panel es solo del dueño.','error');
    g('adminPanel').classList.add('hidden');
    return;
  }
  g('adminPanel').classList.remove('hidden');
  g('cartFab').classList.add('hidden'); // Ocultar burbuja del carrito en Admin
  g('adminEmailLabel').textContent=S.user?.email||'';
  g('adminEmailLabelMob').textContent=S.user?.email||'';
  switchTab('metrics');
}
function closeAdmin(){ 
  g('adminPanel').classList.add('hidden'); 
  if(S.user) g('cartFab').classList.remove('hidden'); // Mostrar burbuja al volver al POS
}

function switchTab(tab){
  if(!S.isAdmin){ closeAdmin(); return; }
  /* Desktop sidebar */
  document.querySelectorAll('.atab').forEach(b=>b.classList.remove('on'));
  g('tab-'+tab)?.classList.add('on');
  /* Mobile tabs */
  document.querySelectorAll('.matab').forEach(b=>b.classList.remove('on'));
  g('mtab-'+tab)?.classList.add('on');
  /* Content */
  document.querySelectorAll('.admin-content').forEach(el=>el.classList.add('hidden'));
  g('admin-'+tab)?.classList.remove('hidden');
  if(tab==='metrics') loadMetrics('day');
  if(tab==='products') loadProducts();
  if(tab==='inventory') initInventoryTab();
  if(tab==='expenses') loadExpenses();
  if(tab==='sellers') loadSellers();
  if(tab==='history') loadHistory();
  if(tab==='shifts') loadShiftsAdmin();
  if(tab==='hardware') updatePrinterUI();
  if(tab==='branches') renderBranches();
  if(tab==='recharges') renderCarriersTable();
  if(tab==='contract') cargarMiContrato();
}

/* ════════════════════════════════════
   MI CONTRATO — solo lectura para el dueño.
   Lo escribe el proveedor desde su panel maestro en
   negocios/{TENANT}/contratos/actual. Aquí solo se lee.
════════════════════════════════════ */
const TEL_PROVEEDOR = '5548588680';
let MI_CONTRATO = null;

async function cargarMiContrato(){
  const box = g('contractBox');
  if(!box) return;
  box.innerHTML = '<div class="text-center py-10 text-slate-400 text-sm">Cargando…</div>';
  MI_CONTRATO = null;
  try{
    const doc = await db.collection('contratos').doc('actual').get();
    if(doc.exists) MI_CONTRATO = doc.data();
  }catch(e){ console.warn('Contrato del negocio:', e); }

  /* Respaldo: si el proveedor solo dejó la referencia en el negocio. */
  if(!MI_CONTRATO && NEGOCIO && NEGOCIO.contrato_id){
    try{
      const raiz = await dbRoot.collection('contratos').doc(NEGOCIO.contrato_id).get();
      if(raiz.exists) MI_CONTRATO = raiz.data();
    }catch(e){ console.warn('Contrato raíz:', e); }
  }

  if(MI_CONTRATO) pintarMiContrato(MI_CONTRATO);
  else pintarSinContrato();
}

function waProveedor(texto){
  return 'https://wa.me/52' + TEL_PROVEEDOR + '?text=' + encodeURIComponent(texto);
}

function pintarSinContrato(){
  g('contractBox').innerHTML =
    '<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center">' +
      '<i class="fa-regular fa-file-lines text-4xl text-slate-300 mb-3"></i>' +
      '<p class="font-bold text-slate-700 mb-1">Todavía no hay contrato cargado</p>' +
      '<p class="text-sm text-slate-400 mb-4">Tu proveedor lo sube desde su panel. En cuanto lo haga, aparece aquí para consultarlo y descargarlo.</p>' +
      '<a href="' + waProveedor('Hola, soy ' + nombreNegocio() + '. ¿Me pueden cargar mi contrato en el panel?') + '" target="_blank" ' +
        'class="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-lg text-sm font-semibold">' +
        '<i class="fa-brands fa-whatsapp"></i>Pedirlo por WhatsApp</a>' +
    '</div>';
}

function pintarMiContrato(c){
  const estado = c.estado === 'firmado'
    ? '<span class="text-[11px] font-bold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">Firmado</span>'
    : '<span class="text-[11px] font-bold px-2 py-1 rounded-full bg-indigo-100 text-indigo-700">Vigente</span>';
  const renta = c.renta_mensual ? fmt(c.renta_mensual) : 'Por cotizar';
  const tipo  = c.tipo_pos === 'barberia' ? '💈 Barbería' : '🏪 Tienda';

  const dato = (t,v) =>
    '<div class="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-sm">' +
      '<p class="text-[10px] sm:text-xs text-slate-400 mb-1">' + t + '</p>' +
      '<p class="font-bold text-slate-800 text-sm sm:text-base">' + v + '</p></div>';

  g('contractBox').innerHTML =
    '<div class="flex flex-wrap items-center gap-2 mb-3">' + estado +
      '<span class="text-xs text-slate-400">Folio ' + (c.folio || '—') + '</span></div>' +
    '<div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 mb-4">' +
      dato('Renta mensual', renta) +
      dato('Sucursales', (c.sucursales || 1)) +
      dato('Día de corte', 'Día ' + (c.dia_corte || 1)) +
      dato('Sistema', tipo) +
    '</div>' +
    '<div class="flex flex-wrap gap-2 mb-4">' +
      '<button onclick="descargarMiContrato()" class="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2.5 rounded-lg text-sm font-semibold min-h-[40px]">' +
        '<i class="fa-solid fa-file-word mr-1"></i>Descargar .doc</button>' +
      '<button onclick="abrirMiContrato()" class="bg-white border border-slate-300 text-slate-600 px-4 py-2.5 rounded-lg text-sm font-semibold min-h-[40px]">' +
        '<i class="fa-solid fa-up-right-from-square mr-1"></i>Abrir e imprimir</button>' +
      (c.firmado_url
        ? '<a href="' + c.firmado_url + '" target="_blank" class="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-2.5 rounded-lg text-sm font-semibold min-h-[40px] inline-flex items-center">' +
          '<i class="fa-solid fa-file-circle-check mr-1"></i>Ver contrato firmado</a>'
        : '') +
      '<a href="' + waProveedor('Hola, tengo una duda sobre el contrato ' + (c.folio || '') + ' de ' + nombreNegocio() + '.') + '" target="_blank" ' +
        'class="bg-white border border-slate-300 text-slate-600 px-4 py-2.5 rounded-lg text-sm font-semibold min-h-[40px] inline-flex items-center">' +
        '<i class="fa-brands fa-whatsapp mr-1"></i>Dudas con el proveedor</a>' +
    '</div>' +
    '<div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">' +
      '<iframe id="contractFrame" sandbox class="w-full bg-white" style="height:70vh;border:0"></iframe>' +
    '</div>';

  const frame = g('contractFrame');
  if(frame) frame.srcdoc = c.html || '<p style="font-family:sans-serif;padding:24px">Sin contenido.</p>';
}

/* El .doc se arma aquí mismo con el HTML guardado: no depende de Storage. */
function contratoEnWord(html){
  return '\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8"/><!--[if gte mso 9]><xml><w:WordDocument>' +
    '<w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' +
    '<style>@page{size:21.59cm 27.94cm;margin:2.2cm 2cm}</style></head>' +
    String(html || '').replace(/^[\s\S]*?<body>/i, '<body>');
}

function descargarMiContrato(){
  if(!MI_CONTRATO) return;
  if(MI_CONTRATO.doc_url){ window.open(MI_CONTRATO.doc_url, '_blank'); return; }
  const nombre = 'Contrato_' +
    (nombreNegocio() || 'negocio').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-zA-Z0-9]+/g,'_').slice(0,40) +
    '_' + (MI_CONTRATO.folio || '') + '.doc';
  const blob = new Blob([contratoEnWord(MI_CONTRATO.html)], {type:'application/msword'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}

function abrirMiContrato(){
  if(!MI_CONTRATO) return;
  const w = window.open('', '_blank');
  w.document.write(MI_CONTRATO.html || '<p>Sin contenido</p>');
  w.document.close();
}

/* ── METRICS ── */
async function loadMetrics(period){
  document.querySelectorAll('.pbtn').forEach(b=>{b.className=b.className.replace(' on','');if(b.dataset.period===period)b.classList.add('on');});
  const labels={day:'Hoy',week:'Esta semana',month:'Este mes',year:'Este año'};
  g('kpiPeriodLabel').textContent=labels[period];
  ['kpiTotal','kpiCash','kpiTx','kpiAvg'].forEach(id=>g(id).textContent='…');
  const now=new Date();
  const starts={day:new Date(now.getFullYear(),now.getMonth(),now.getDate()),week:new Date(now-7*864e5),month:new Date(now.getFullYear(),now.getMonth(),1),year:new Date(now.getFullYear(),0,1)};
  try{
    const snap=await db.collection('sales').where('timestamp','>=',FS.Timestamp.fromDate(starts[period])).get();
    const allSales=snap.docs.map(d=>({id:d.id,...d.data()}));
    const branchFilter = g('metricsBranchFilter')?.value || '';
    let sales=allSales.filter(x=>!x.voided);
    if(branchFilter) sales=sales.filter(x=>x.branchId===branchFilter);
    const tot=sales.reduce((s,x)=>s+(x.total||0),0);
    const cash=sales.reduce((s,x)=>s+(x.cashPortion!=null?x.cashPortion:(x.payMethod==='cash'?(x.total||0):0)),0);
    const discounts=sales.reduce((s,x)=>s+(x.discountAmt||0),0);
    const tx=sales.length;
    g('kpiTotal').textContent=fmt(tot); g('kpiCash').textContent=fmt(cash);
    g('kpiTx').textContent=tx; g('kpiAvg').textContent=fmt(tx?tot/tx:0);
    g('kpiDiscounts').textContent=fmt(discounts);
    let rechargeTotal=0, rechargeCommission=0, rechargeCount=0;
    sales.forEach(s=>(s.items||[]).forEach(it=>{
      if(it.isRecharge){ rechargeTotal+=it.subtotal||0; rechargeCommission+=(it.subtotal||0)*((it.commissionPct||0)/100); rechargeCount++; }
    }));
    g('kpiRecharges').textContent=fmt(rechargeCommission);
    g('kpiRechargesCount').textContent=`${rechargeCount} recarga${rechargeCount!==1?'s':''} · ${fmt(rechargeTotal)} vendido`;
    /* ── Gastos del mismo periodo (salidas de dinero) ── */
    const startStr = localDateStr(starts[period]);
    let expenses=[];
    try{
      const esnap=await db.collection('expenses').where('date','>=',startStr).get();
      expenses=esnap.docs.map(d=>({id:d.id,...d.data()}));
      if(branchFilter) expenses=expenses.filter(x=>!x.branchId||x.branchId===branchFilter);
    }catch(err){ console.warn('Gastos:', err.message); }
    const cogs=sales.reduce((s,x)=>s+(x.cost!=null?x.cost:sumItemsCost(x.items)),0);
    const gross=tot-cogs;
    const expTotal=expenses.reduce((s,x)=>s+(x.amount||0),0);
    g('kpiCogs').textContent=fmt(cogs);
    g('kpiGross').textContent=fmt(gross);
    g('kpiMarginPct').textContent='Margen '+(tot?((gross/tot)*100).toFixed(1):'0')+'%';
    g('kpiExpenses').textContent=fmt(expTotal);
    g('kpiExpensesCount').textContent=`${expenses.length} registro${expenses.length!==1?'s':''}`;
    const net=gross-expTotal;
    g('kpiNet').textContent=fmt(net);
    g('kpiNet').className='kpi-val '+(net>=0?'text-emerald-700':'text-red-600');

    const byDate={};sales.forEach(s=>{const d=s.timestamp?.toDate?.()?.toISOString?.()?.split('T')[0]||s.date;if(d)byDate[d]=(byDate[d]||0)+(s.total||0);});
    const profitByDate={}; sales.forEach(s=>{const d=s.timestamp?.toDate?.()?.toISOString?.()?.split('T')[0]||s.date; if(d){const c=s.cost!=null?s.cost:sumItemsCost(s.items); profitByDate[d]=(profitByDate[d]||0)+((s.total||0)-c);} });
    const expByDate={}; expenses.forEach(x=>{ if(x.date) expByDate[x.date]=(expByDate[x.date]||0)+(x.amount||0); });
    const expByCat={}; expenses.forEach(x=>{ const k=x.category||'Otros'; expByCat[k]=(expByCat[k]||0)+(x.amount||0); });
    drawProfitChart(byDate, expByDate, profitByDate);
    drawExpenseCatChart('chartExpCat', expByCat, 'expCat');
    const bySeller={};sales.forEach(s=>{const k=s.sellerName||'–';bySeller[k]=(bySeller[k]||0)+(s.total||0);});
    const byProd={};sales.forEach(s=>(s.items||[]).forEach(it=>{if(!byProd[it.barcode])byProd[it.barcode]={name:it.name,qty:0,rev:0};byProd[it.barcode].qty+=it.quantity||0;byProd[it.barcode].rev+=it.subtotal||0;}));
    drawLine(byDate); drawBar(bySeller);
    const pl=Object.values(byProd).sort((a,b)=>b.qty-a.qty);
    prodRank('topProdsEl',pl.slice(0,8),true); prodRank('botProdsEl',[...pl].reverse().slice(0,8),false);
  }catch(e){console.error(e);showToast('Error al cargar métricas: '+e.message,'error');}
}
/* ── Ajustes compartidos de las gráficas para que nunca se desborden ── */
const chartSmall = () => window.innerWidth < 480;
function baseChartOpts(){
  const s = chartSmall();
  return {
    responsive:true,
    maintainAspectRatio:false,      // respeta la altura de .chart-wrap
    resizeDelay:120,
    layout:{padding:{left:0,right:2,top:2,bottom:0}},
    interaction:{mode:'index', intersect:false},
    plugins:{
      legend:{display:false},
      tooltip:{ titleFont:{size:11}, bodyFont:{size:11}, boxPadding:4 }
    },
    scales:{
      x:{ ticks:{ font:{size:s?9:11}, maxRotation:0, minRotation:0,
                  autoSkip:true, maxTicksLimit:s?4:8 },
          grid:{display:false} },
      y:{ beginAtZero:true, ticks:{ font:{size:s?9:11}, maxTicksLimit:s?4:5,
            callback:v=>compactMoney(v) } }
    }
  };
}
/* Montos cortos en los ejes: $1.2k / $3.4M (evita etiquetas larguísimas) */
function compactMoney(v){
  const n=Math.abs(v);
  if(n>=1e6) return '$'+(v/1e6).toFixed(1).replace('.0','')+'M';
  if(n>=1e3) return '$'+(v/1e3).toFixed(1).replace('.0','')+'k';
  return '$'+Math.round(v);
}

function drawLine(byDate){
  const ctx=g('chartSales').getContext('2d');
  if(S.charts.line)S.charts.line.destroy();
  const lbs=Object.keys(byDate).sort();
  S.charts.line=new Chart(ctx,{
    type:'line',
    data:{
      labels:lbs.map(l=>{const d=new Date(l+'T00:00:00');return d.toLocaleDateString('es-MX',{day:'2-digit',month:'short'});}),
      datasets:[{label:'Ventas',data:lbs.map(l=>byDate[l]),borderColor:'#6366f1',
        backgroundColor:'rgba(99,102,241,.12)',tension:.4,fill:true,
        pointRadius:chartSmall()?2:3,borderWidth:2}]
    },
    options: baseChartOpts()
  });
}
function drawBar(bySeller){
  const ctx=g('chartSellers').getContext('2d');
  if(S.charts.bar)S.charts.bar.destroy();
  const names=Object.keys(bySeller);
  const colors=['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#3b82f6'];
  const short = n => (n||'').length>12 ? n.slice(0,11)+'…' : n;
  const opts = baseChartOpts();
  /* Con muchos vendedores, barras horizontales: no se encima el texto */
  const horizontal = names.length>4 || chartSmall();
  if(horizontal){
    opts.indexAxis='y';
    opts.scales={
      x:{beginAtZero:true, ticks:{font:{size:chartSmall()?9:11},maxTicksLimit:4,callback:v=>compactMoney(v)}},
      y:{ticks:{font:{size:chartSmall()?9:11},autoSkip:false},grid:{display:false}}
    };
  }
  opts.plugins.tooltip.callbacks={ title:items=>names[items[0].dataIndex] };
  S.charts.bar=new Chart(ctx,{
    type:'bar',
    data:{labels:names.map(short),datasets:[{data:names.map(n=>bySeller[n]),
      backgroundColor:names.map((_,i)=>colors[i%colors.length]),borderRadius:6,
      maxBarThickness:38}]},
    options:opts
  });
}
function prodRank(elId,list,isTop){
  const el=g(elId);
  if(!list.length){el.innerHTML='<p class="text-slate-400 text-xs text-center py-4">Sin datos</p>';return;}
  const max=Math.max(1, ...list.map(p=>p.qty||0));
  el.innerHTML=list.map((p,i)=>`<div class="flex items-start gap-2 py-1 w-full">
    <span class="text-xs text-slate-300 w-4 shrink-0 pt-0.5 text-right">${i+1}</span>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2 min-w-0">
        <p class="text-xs font-semibold text-slate-800 truncate flex-1 min-w-0" title="${esc(p.name)}">${esc(p.name)}</p>
        <span class="text-xs font-bold text-slate-700 shrink-0 num">${fmt(p.rev)}</span>
      </div>
      <div class="flex items-center gap-1.5 mt-1 min-w-0">
        <div class="flex-1 bg-slate-100 rounded-full h-1.5 min-w-0 overflow-hidden">
          <div class="h-1.5 rounded-full ${isTop?'bg-indigo-500':'bg-orange-400'}" style="width:${Math.min(100,Math.max(6,(p.qty/max)*100))}%"></div>
        </div>
        <span class="text-[10px] text-slate-400 shrink-0 num">${p.qty} uds</span>
      </div>
    </div>
  </div>`).join('');
}

/* ── PRODUCTS (admin) ── */
async function loadProducts(){
  const tbody=g('prodTableBody');
  tbody.innerHTML='<tr><td colspan="8" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  try{
    const snap=await db.collection('products').orderBy('name').get();
    setServerProducts(snap.docs.map(d=>({barcode:d.id,...d.data()}))); // refresh cache
    if(!S.prodView) setProdView(S.products.length ? 'mine' : 'catalog');
    filterProdTable();
    updateStockBell();
  }catch(e){
    if(!S.prodView) setProdView(S.products.length ? 'mine' : 'catalog');
    filterProdTable(); showToast('Mostrando productos guardados en el dispositivo','warning');
  }
}
function toggleLowStockFilter(){
  S.lowStockOnly=!S.lowStockOnly; S.prodPage=0;
  g('lowStockBtn').className='shrink-0 border px-3 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition min-h-[44px] '+
    (S.lowStockOnly?'border-red-300 bg-red-50 text-red-600':'border-slate-200 bg-white text-slate-500');
  filterProdTable();
}
function stockBadge(p){
  if(typeof p.stock !== 'number') return '<span class="text-slate-300 text-xs">—</span>';
  if(p.stock<=0) return `<span class="text-xs px-2 py-0.5 rounded-full font-medium badge-low">Agotado</span>`;
  if(p.stock<=LOW_STOCK_THRESHOLD) return `<span class="text-xs px-2 py-0.5 rounded-full font-medium badge-mid">${p.stock} · bajo</span>`;
  return `<span class="text-xs px-2 py-0.5 rounded-full font-medium badge-ok">${p.stock}</span>`;
}
function filterProdTable(){
  g('pvMineCount').textContent = S.products.length ? '('+S.products.length+')' : '';
  if(S.prodView==='catalog' && CAT.docs) renderCatalogRows(CAT.docs);   // refresca "En tu tienda"
  const q=g('prodFilter').value.toLowerCase();
  let list=S.products.filter(p=>(p.name||'').toLowerCase().includes(q)||(p.barcode||'').toLowerCase().includes(q));
  if(S.lowStockOnly) list=list.filter(p=>typeof p.stock==='number' && p.stock<=LOW_STOCK_THRESHOLD);
  const tbody=g('prodTableBody');
  if(!list.length){
    tbody.innerHTML = S.products.length
      ? '<tr><td colspan="8" class="py-8 text-center text-slate-400">Sin resultados</td></tr>'
      : '<tr><td colspan="8" class="py-10 text-center text-slate-500">Todavía no tienes productos.<br><button onclick="setProdView(\'catalog\')" class="mt-2 text-indigo-600 font-semibold hover:underline">Buscar en el catálogo general</button></td></tr>';
    g('prodPager').innerHTML=''; return;
  }
  const totalPag = Math.ceil(list.length/PAGE_SIZE);
  if(S.prodPage>=totalPag) S.prodPage=totalPag-1;
  if(S.prodPage<0) S.prodPage=0;
  const desde = S.prodPage*PAGE_SIZE;
  g('prodPager').innerHTML = pagerHTML({
    texto: `${desde+1}–${Math.min(desde+PAGE_SIZE,list.length)} de ${list.length}`,
    hayAnterior: S.prodPage>0, hayMas: S.prodPage<totalPag-1,
    anterior: 'S.prodPage--;filterProdTable()', siguiente: 'S.prodPage++;filterProdTable()'
  });
  tbody.innerHTML=list.slice(desde, desde+PAGE_SIZE).map(p=>`<tr class="hover:bg-slate-50 transition">
    <td class="px-3 sm:px-4 py-3"><code class="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">${esc(p.barcode)}</code></td>
    <td class="px-3 sm:px-4 py-3 font-semibold text-slate-800 text-xs sm:text-sm max-w-[180px] break-anywhere">${p.favorite?'<i class="fa-solid fa-star text-amber-400 text-[10px] mr-1"></i>':''}${esc(p.name)}${expiryChip(p)}${(p.marca||p.contenido)?`<span class="block text-[10px] font-normal text-slate-400">${esc([p.marca,p.contenido].filter(Boolean).join(' · '))}</span>`:''}</td>
    <td class="px-3 sm:px-4 py-3 text-right font-bold text-indigo-700 text-xs sm:text-sm whitespace-nowrap num">${fmt(p.price)}</td>
    <td class="px-3 sm:px-4 py-3 text-right text-xs text-slate-500 hidden lg:table-cell whitespace-nowrap num">${p.cost?fmt(p.cost):'<span class="text-slate-300">—</span>'}</td>
    <td class="px-3 sm:px-4 py-3 text-right text-xs hidden lg:table-cell">${p.cost?`<span class="font-bold ${(p.price-p.cost)>=0?'text-emerald-600':'text-red-500'}">${fmt(p.price-p.cost)}</span><span class="text-slate-400 block text-[10px]">${p.price?(((p.price-p.cost)/p.price)*100).toFixed(0):0}%</span>`:'<span class="text-slate-300">—</span>'}</td>
    <td class="px-3 sm:px-4 py-3 text-center hidden md:table-cell">${stockBadge(p)}</td>
    <td class="px-3 sm:px-4 py-3 text-center hidden sm:table-cell">
      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${p.active!==false?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-600'}">
        ${p.active!==false?'Activo':'Inactivo'}</span>
    </td>
    <td class="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
      <button onclick="openEntryModal('${p.barcode}')" title="Agregar inventario" class="text-emerald-600 hover:text-emerald-800 text-sm p-1 min-w-[32px] min-h-[32px]"><i class="fa-solid fa-dolly"></i></button>
      <button onclick="editProduct('${p.barcode}')" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px] ml-1"><i class="fa-solid fa-pen-to-square"></i></button>
      <button onclick="toggleProduct('${p.barcode}',${p.active!==false})" class="text-sm p-1 min-w-[32px] min-h-[32px] ml-1 ${p.active!==false?'text-red-400 hover:text-red-600':'text-emerald-500 hover:text-emerald-700'}">
        <i class="fa-solid fa-${p.active!==false?'ban':'check'}"></i>
      </button>
    </td>
  </tr>`).join('');
}
/* ════════════════════════════════════
   PRODUCTOS: "Mis productos" | "Catálogo general"
   El catálogo (16 mil) se pide a Firestore de 20 en 20 con cursor:
   cada página cuesta 21 lecturas, nunca se descarga completo.
════════════════════════════════════ */
const PAGE_SIZE = 20;
S.prodPage = 0;
S.prodView = null;
const CAT = { q:'', cursores:[], pagina:0, hayMas:false, docs:null, cargado:false, timer:null, seq:0 };

function pagerHTML({texto, hayAnterior, hayMas, anterior, siguiente}){
  const base='px-3 py-2 rounded-lg text-sm font-semibold border min-h-[40px] transition';
  const on = base+' border-slate-200 bg-white text-slate-700 hover:bg-slate-50';
  const off= base+' border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed';
  return `<div class="flex items-center justify-between gap-2">
    <span class="text-xs text-slate-500">${texto}</span>
    <div class="flex gap-2">
      <button ${hayAnterior?`onclick="${anterior}"`:'disabled'} class="${hayAnterior?on:off}"><i class="fa-solid fa-chevron-left mr-1"></i>Anteriores</button>
      <button ${hayMas?`onclick="${siguiente}"`:'disabled'} class="${hayMas?on:off}">Siguientes<i class="fa-solid fa-chevron-right ml-1"></i></button>
    </div>
  </div>`;
}

function setProdView(v){
  S.prodView = v;
  const on ='flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold bg-white text-indigo-700 shadow-sm min-h-[40px]';
  const off='flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:text-slate-700 min-h-[40px]';
  g('pvMine').className    = v==='mine'    ? on : off;
  g('pvCatalog').className = v==='catalog' ? on : off;
  g('myProdPanel').classList.toggle('hidden', v!=='mine');
  g('catalogPanel').classList.toggle('hidden', v!=='catalog');
  if(v==='catalog' && !CAT.cargado) cargarPaginaCatalogo(0);
}

/* Firestore distingue mayúsculas, y los nombres vienen escritos de muchas
   formas ("Skipper…", "SKIPPER…", "skipper…"). Por eso un texto se busca en
   varias formas a la vez y los resultados se combinan en orden.
   Un código (solo dígitos) se busca tal cual por el inicio del código. */
function formasDeBusqueda(q){
  if(/^\d+$/.test(q)) return [q];
  const low = q.toLowerCase();
  const cap = low.charAt(0).toUpperCase() + low.slice(1);
  const titulo = low.replace(/(^|\s)(\S)/g, (m,sp,ch)=>sp+ch.toUpperCase());
  return [...new Set([q, cap, titulo, q.toUpperCase(), low])];
}
function consultaPorForma(forma, cursor){
  const ref = dbRoot.collection('productos');
  const porCodigo = /^\d+$/.test(forma);
  let consulta = porCodigo ? ref.orderBy(FS.FieldPath.documentId()) : ref.orderBy('nombre');
  if(forma) consulta = consulta.endAt(forma+'\uf8ff');
  /* Un solo punto de inicio: donde se quedó la página anterior, o el texto buscado */
  if(cursor) return consulta.startAfter(cursor);
  return forma ? consulta.startAt(forma) : consulta;
}
const claveOrden = (d, porCodigo) => porCodigo ? d.id : String(d.data().nombre||'');

async function cargarPaginaCatalogo(pagina){
  const seq = ++CAT.seq;
  CAT.cargado = true;
  g('catTableBody').innerHTML='<tr><td colspan="3" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  try{
    const formas = CAT.q ? formasDeBusqueda(CAT.q) : [''];
    const porCodigo = !CAT.q || /^\d+$/.test(CAT.q);
    /* cursores[p] = { forma: últimoDocumentoMostrado } al terminar la página p */
    const previos = pagina>0 ? (CAT.cursores[pagina-1] || {}) : {};
    const lotes = await Promise.all(formas.map(f =>
      consultaPorForma(f, previos[f] || null).limit(PAGE_SIZE+1).get()
        .then(snap => snap.docs.map(d => ({forma:f, d})))
    ));
    if(seq!==CAT.seq) return;                       // llegó una búsqueda más nueva

    const vistos = new Set();
    const todos = lotes.flat()
      .filter(x => !vistos.has(x.d.id) && vistos.add(x.d.id))
      .sort((x,y)=>{ const a=claveOrden(x.d,porCodigo), b=claveOrden(y.d,porCodigo); return a<b?-1:a>b?1:0; });
    const pag = todos.slice(0, PAGE_SIZE);

    const siguientes = {...previos};
    pag.forEach(x => { siguientes[x.forma] = x.d; });
    CAT.cursores[pagina] = siguientes;
    CAT.pagina = pagina;
    CAT.hayMas = todos.length > PAGE_SIZE;

    const docs = pag.map(x => x.d);
    docs.forEach(d => { if(!_catalogoCache.has(d.id)) _catalogoCache.set(d.id, fichaCatalogo(d.id, d.data())); });
    CAT.docs = docs;
    renderCatalogRows(docs);
  }catch(e){
    if(seq!==CAT.seq) return;
    console.error('Catálogo:', e);
    CAT.cargado = false; CAT.docs = null;
    const motivo = e.code==='permission-denied'
      ? 'Las reglas de Firestore no permiten leer "productos". Publica el archivo firestore.rules.'
      : 'No se pudo cargar el catálogo ('+esc(e.code||e.message)+').';
    g('catTableBody').innerHTML='<tr><td colspan="3" class="text-center py-10 text-red-500 text-sm">'+motivo+'</td></tr>';
    g('catPager').innerHTML='';
  }
}

function renderCatalogRows(docs){
  const tbody = g('catTableBody');
  if(!docs.length){
    tbody.innerHTML = '<tr><td colspan="3" class="text-center py-10 text-slate-400 text-sm">'
      + (CAT.q ? 'Ningún producto empieza con «'+esc(CAT.q)+'». Prueba con el código o con la primera palabra del nombre.' : 'El catálogo está vacío.')
      + '</td></tr>';
    g('catPager').innerHTML=''; return;
  }
  tbody.innerHTML = docs.map(d=>{
    const f = fichaCatalogo(d.id, d.data());
    const nombre = f ? f.nombre : '';
    const det = detalleCatalogo(f);
    const mio = S.products.find(p=>p.barcode===d.id);
    const accion = mio
      ? `<span class="text-xs font-bold text-indigo-700 num mr-1">${fmt(mio.price)}</span>
         <button data-code="${esc(d.id)}" onclick="editProduct(this.dataset.code)" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px]" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>`
      : `<button data-code="${esc(d.id)}" onclick="addFromCatalog(this.dataset.code)" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-1.5 rounded-lg min-h-[32px]"><i class="fa-solid fa-plus mr-1"></i>Agregar</button>`;
    return `<tr class="hover:bg-slate-50 transition">
      <td class="px-3 sm:px-4 py-3"><code class="text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">${esc(d.id)}</code></td>
      <td class="px-3 sm:px-4 py-3 text-xs sm:text-sm break-anywhere">
        <span class="font-semibold text-slate-800">${esc(nombre)}</span>
        ${det?`<span class="block text-[11px] text-slate-400 mt-0.5">${esc(det)}</span>`:''}
      </td>
      <td class="px-3 sm:px-4 py-3 text-right whitespace-nowrap">${accion}</td>
    </tr>`;
  }).join('');
  const desde = CAT.pagina*PAGE_SIZE;
  g('catPager').innerHTML = pagerHTML({
    texto: `Página ${CAT.pagina+1} · ${desde+1}–${desde+docs.length}`,
    hayAnterior: CAT.pagina>0, hayMas: CAT.hayMas,
    anterior: `cargarPaginaCatalogo(${CAT.pagina-1})`, siguiente: `cargarPaginaCatalogo(${CAT.pagina+1})`
  });
}

function onCatalogFilter(){
  clearTimeout(CAT.timer);
  CAT.timer = setTimeout(()=>{
    CAT.q = g('catFilter').value.trim();
    CAT.cursores = [];
    cargarPaginaCatalogo(0);
  }, 400);
}

/* Abre el alta con el código y el nombre del catálogo ya puestos */
function addFromCatalog(code){
  window._pendingBarcode = code;
  showProductModal(true);
}

function showProductModal(fromScan=false){
  refreshCategoryList();
  g('productModalTitle').textContent='Agregar Producto';
  g('pf_barcode').value=fromScan&&window._pendingBarcode?window._pendingBarcode:'';
  g('pf_barcode').readOnly=false;
  g('pf_name').value=''; g('pf_price').value=''; g('pf_stock').value=''; g('pf_category').value='General'; g('pf_favorite').checked=false; g('pf_isBulk').checked=false;
  g('pf_cost').value=''; g('pf_costRow').classList.toggle('hidden', !S.isAdmin); updateMarginHint();
  S.editingBarcode=null;
  _pfNombreDelCatalogo=false; g('pf_nameHint').classList.add('hidden');
  g('productModal').classList.remove('hidden');
  if(g('pf_barcode').value.trim()) autollenarNombreDesdeCatalogo();
}
function editProduct(barcode){
  const p=S.products.find(x=>x.barcode===barcode); if(!p) return;
  refreshCategoryList();
  g('productModalTitle').textContent='Editar Producto';
  g('pf_barcode').value=p.barcode; g('pf_barcode').readOnly=true;
  g('pf_name').value=p.name; g('pf_price').value=p.price; g('pf_stock').value=p.stock??''; g('pf_category').value=p.category||'General';
  g('pf_favorite').checked=!!p.favorite;
  g('pf_isBulk').checked=!!p.isBulk;
  g('pf_cost').value=p.cost??''; g('pf_costRow').classList.toggle('hidden', !S.isAdmin); updateMarginHint();
  S.editingBarcode=barcode;
  _pfNombreDelCatalogo=false; g('pf_nameHint').classList.add('hidden');
  g('productModal').classList.remove('hidden');
}
async function saveProduct(){
  let barcode=g('pf_barcode').value.trim();
  const name=g('pf_name').value.trim();
  const price=parseFloat(g('pf_price').value);
  const category=g('pf_category').value.trim()||'General';
  const favorite=g('pf_favorite').checked;
  const isBulk=g('pf_isBulk').checked;
  /* Nunca stock negativo. Piezas en enteros; granel admite decimales (kg). */
  const rawStock=parseFloat(g('pf_stock').value);
  if(!isNaN(rawStock) && rawStock<0){ showToast('El stock no puede ser negativo','error'); return; }
  const stock = isNaN(rawStock) ? 0 : (isBulk ? round3(rawStock) : Math.floor(rawStock));
  
  if(!name){showToast('El nombre es requerido','error');return;}
  if(isNaN(price)||price<0){showToast('El precio no es válido','error');return;}
  
  // Si no tiene código de barras, generamos uno corto interno (Ej: GR-4521)
  if(!barcode && !S.editingBarcode) {
    barcode = 'GR-' + Math.floor(1000 + Math.random() * 9000); 
  }
  
  const data={name,price,stock,category,favorite,isBulk,active:true,updatedAt:FS.FieldValue.serverTimestamp()};
  /* Si el código viene del catálogo, se guardan sus datos de referencia */
  const fichaCat = _catalogoCache.get(barcode);
  if(fichaCat){
    data.marca = fichaCat.marca || '';
    data.contenido = fichaCat.contenido || '';
    if(fichaCat.cantidad!=null) data.cantidad = fichaCat.cantidad;
    if(fichaCat.unidad) data.unidad = fichaCat.unidad;
  }
  /* Precio de adquisición: SOLO el administrador puede fijarlo */
  if(S.isAdmin){
    const cost=parseFloat(g('pf_cost').value);
    data.cost = isNaN(cost)?0:cost;
    if(!isNaN(cost) && cost>price) showToast('Ojo: el costo es mayor que el precio de venta','warning');
  }
  try{
    if(!S.editingBarcode) data.createdAt=FS.FieldValue.serverTimestamp(); 
    await db.collection('products').doc(barcode).set(data,{merge:true});
    hideProductModal(); loadProducts();
    showToast('Producto '+(S.editingBarcode?'actualizado':'agregado')+' ✅','success');
  }catch(e){console.error(e);showToast('Error: '+e.message,'error');}
}
async function toggleProduct(barcode,active){
  if(active){
    const ok=await confirmAction({title:'¿Desactivar producto?', msg:'Dejará de aparecer en búsquedas y ventas.', okLabel:'Desactivar', icon:'🚫'});
    if(!ok) return;
  }
  try{ await db.collection('products').doc(barcode).update({active:!active}); loadProducts(); showToast('Producto '+(active?'desactivado':'activado'),'success'); }
  catch(e){ showToast('Error: '+e.message,'error'); }
}
function hideProductModal(){
  stopSc('pfScanInst'); g('pf_scanArea').classList.add('hidden');
  g('productModal').classList.add('hidden'); g('pf_barcode').readOnly=false;
}
function startProductScan(){
  g('pf_scanArea').classList.remove('hidden');
  startSc('pf_scanReader','pfScanInst', code=>{
    g('pf_barcode').value=code; stopSc('pfScanInst'); g('pf_scanArea').classList.add('hidden');
    showToast('Código: '+code,'success');
    autollenarNombreDesdeCatalogo();
  });
}

/* ── SELLERS ── */
async function loadSellers(){
  g('sellersGrid').innerHTML='<div class="col-span-3 py-10 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</div>';
  try{
    const snap=await db.collection('users').where('role','==','seller').get();
    S.allSellers=snap.docs.map(d=>({uid:d.id,...d.data()}));
    renderSellers();
    const sel=g('histSellerFilter');
    sel.innerHTML='<option value="">Todos los vendedores</option>';
    S.allSellers.forEach(s=>sel.innerHTML+=`<option value="${s.uid}">${esc(s.name)}</option>`);
  }catch(e){ g('sellersGrid').innerHTML='<div class="col-span-3 py-10 text-center text-red-400">Error: '+e.message+'</div>'; }
}
function renderSellers(){
  const grid=g('sellersGrid');
  if(!S.allSellers.length){grid.innerHTML='<div class="col-span-3 py-12 text-center"><p class="text-slate-400 text-sm">No hay vendedores</p><button onclick="showSellerModal()" class="mt-3 text-indigo-600 text-sm font-medium min-h-[44px] block mx-auto">+ Agregar primero</button></div>';return;}
  grid.innerHTML=S.allSellers.map(s=>`<div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4 sm:p-5">
    <div class="flex items-start justify-between mb-3">
      <div class="w-11 h-11 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
        <span class="font-black text-indigo-600 text-lg">${(s.name||'V')[0].toUpperCase()}</span>
      </div>
      <span class="text-xs px-2 py-0.5 rounded-full font-semibold ${s.active?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-500'}">
        ${s.active?'Activo':'Inactivo'}</span>
    </div>
    <p class="font-bold text-slate-800 text-sm">${esc(s.name)}</p>
    <p class="text-slate-400 text-xs mt-0.5 truncate">${esc(s.email)}</p>
    <p class="text-xs text-violet-600 font-semibold mt-1 mb-3"><i class="fa-solid fa-store mr-1"></i>${esc(s.branchName||'Sin sucursal asignada')}</p>
    <div class="flex gap-1.5">
      <button onclick="openReassignBranch('${s.uid}','${esc(s.name).replace(/'/g,"\\'")}')"
        class="flex-1 text-xs py-2.5 rounded-lg font-semibold bg-violet-50 text-violet-600 hover:bg-violet-100 min-h-[40px]"><i class="fa-solid fa-store mr-1"></i>Sucursal</button>
      <button onclick="toggleSeller('${s.uid}',${s.active})"
        class="flex-1 text-xs py-2.5 rounded-lg font-semibold transition min-h-[40px] ${s.active?'bg-red-50 text-red-600 hover:bg-red-100 active:bg-red-200':'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 active:bg-emerald-200'}">
        <i class="fa-solid fa-${s.active?'user-slash':'user-check'} mr-1"></i>${s.active?'Dar de baja':'Reactivar'}
      </button>
    </div>
  </div>`).join('');
}
function showSellerModal(){
  ['sf_name','sf_email','sf_password'].forEach(id=>g(id).value='');
  refreshBranchSelects();
  g('sf_branch').value='';
  g('sellerErr').classList.add('hidden'); g('sellerModal').classList.remove('hidden');
}
function hideSellerModal(){ g('sellerModal').classList.add('hidden'); }
async function saveSeller(){
  const name=g('sf_name').value.trim(), email=g('sf_email').value.trim(), pwd=g('sf_password').value;
  const branchId=g('sf_branch').value;
  const branch=S.branches.find(b=>b.id===branchId);
  const errEl=g('sellerErr'), btn=g('saveSellerBtn');
  errEl.classList.add('hidden');
  if(!name||!email||!pwd){errEl.textContent='Todos los campos son requeridos';errEl.classList.remove('hidden');return;}
  if(pwd.length<6){errEl.textContent='Contraseña mínimo 6 caracteres';errEl.classList.remove('hidden');return;}
  if(!branchId||!branch){errEl.textContent='Selecciona una sucursal';errEl.classList.remove('hidden');return;}
  btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin mr-1"></i>Creando…';
  try{
    /* Firebase Auth REST API — el admin no pierde su sesión */
    const r1=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FC.apiKey}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,password:pwd,returnSecureToken:true})
    });
    const d1=await r1.json();
    if(d1.error) throw new Error(d1.error.message);
    /* Update display name */
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FC.apiKey}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({idToken:d1.idToken,displayName:name,returnSecureToken:false})
    });
    /* Su ficha vive DENTRO del negocio, en negocios/{TENANT}/users.
       El campo uid es lo que permite encontrarla al iniciar sesión. */
    await db.collection('users').doc(d1.localId).set({
      uid: d1.localId,
      name, email, role:'seller', active:true,
      branchId, branchName:branch.name,
      createdAt:FS.FieldValue.serverTimestamp()
    });
    hideSellerModal(); loadSellers();
    showToast('Vendedor '+name+' creado ✅','success');
  }catch(e){
    const msgs={'EMAIL_EXISTS':'Este correo ya está registrado','INVALID_EMAIL':'Correo inválido','WEAK_PASSWORD : Password should be at least 6 characters':'Contraseña muy débil'};
    errEl.textContent=msgs[e.message]||e.message; errEl.classList.remove('hidden');
  } finally { btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-user-plus mr-1"></i>Crear'; }
}
async function toggleSeller(uid,active){
  if(active){
    const ok=await confirmAction({title:'¿Dar de baja al vendedor?', msg:'No podrá iniciar sesión hasta ser reactivado.', okLabel:'Dar de baja', icon:'🚫'});
    if(!ok) return;
  }
  try{
    /* Con esto basta: las reglas leen active de esta misma ficha,
       así que el bloqueo lo aplica el servidor, no la pantalla. */
    await db.collection('users').doc(uid).update({active:!active,updatedAt:FS.FieldValue.serverTimestamp()});
    showToast(active?'Vendedor dado de baja':'Vendedor reactivado','success'); loadSellers(); }
  catch(e){ showToast('Error: '+e.message,'error'); }
}

/* ── HISTORY ── */
async function loadHistory(){
  const tbody=g('histTableBody');
  tbody.innerHTML='<tr><td colspan="5" class="py-10 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  const sellerId=g('histSellerFilter').value, startD=g('histStart').value, endD=g('histEnd').value;
  try{
    let q=sellerId?db.collection('sales').where('sellerId','==',sellerId):db.collection('sales').orderBy('timestamp','desc');
    const snap=await q.limit(200).get();
    let sales=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(startD){const s=new Date(startD+'T00:00:00');sales=sales.filter(x=>x.timestamp?.toDate?.()>=s);}
    if(endD){const e=new Date(endD+'T23:59:59');sales=sales.filter(x=>x.timestamp?.toDate?.()<=e);}
    const branchFilter=g('histBranchFilter').value;
    if(branchFilter) sales=sales.filter(x=>x.branchId===branchFilter);
    if(!g('histShowVoided').checked) sales=sales.filter(x=>!x.voided);
    sales.sort((a,b)=>(b.timestamp?.toMillis?.()??0)-(a.timestamp?.toMillis?.()??0));
    S.histSales=sales;
    if(!sales.length){tbody.innerHTML='<tr><td colspan="5" class="py-10 text-center text-slate-400">Sin ventas en el período</td></tr>';return;}
    tbody.innerHTML=sales.map(s=>{
      const d=s.timestamp?.toDate?.();
      const ds=d?d.toLocaleString('es-MX',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'-';
      const methodLabel = s.payMethod==='cash'?'💵 Efectivo':s.payMethod==='card'?'💳 Tarjeta':'🔀 Mixto';
      const methodCls = s.payMethod==='cash'?'bg-emerald-100 text-emerald-700':s.payMethod==='card'?'bg-blue-100 text-blue-700':'bg-violet-100 text-violet-700';
      return`<tr class="hover:bg-slate-50 transition ${s.voided?'opacity-50':''}">
        <td class="px-3 sm:px-4 py-3 text-xs text-slate-600 whitespace-nowrap">${ds}${s.voided?' <span class="badge-low text-[10px] px-1.5 py-0.5 rounded-full ml-1">Anulada</span>':''}</td>
        <td class="px-3 sm:px-4 py-3 text-xs sm:text-sm text-slate-800 hidden sm:table-cell">${esc(s.sellerName||'–')}</td>
        <td class="px-3 sm:px-4 py-3 text-right font-bold text-indigo-700 text-xs sm:text-sm ${s.voided?'line-through':''}">${fmt(s.total)}</td>
        <td class="px-3 sm:px-4 py-3 text-center hidden md:table-cell">
          <span class="text-xs px-2 py-0.5 rounded-full ${methodCls}">${methodLabel}</span>
        </td>
        <td class="px-3 sm:px-4 py-3 text-right">
          <button onclick="showSaleDetail('${s.id}')" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px]"><i class="fa-solid fa-eye"></i></button>
        </td>
      </tr>`;}).join('');
  }catch(e){console.error(e);tbody.innerHTML='<tr><td colspan="5" class="py-10 text-center text-red-400">Error: '+e.message+'</td></tr>';}
}
let _curSaleDetail=null;
async function showSaleDetail(id){
  try{
    const doc=await db.collection('sales').doc(id).get();
    const s={id:doc.id,...doc.data()};
    _curSaleDetail=s;
    const ds=s.timestamp?.toDate?.()?.toLocaleString('es-MX')||'–';
    const methodLabel = s.payMethod==='cash'?'💵 Efectivo':s.payMethod==='card'?'💳 Tarjeta':'🔀 Mixto';
    g('saleDetailContent').innerHTML=`
      ${s.voided?`<div class="bg-red-50 border border-red-200 text-red-600 text-xs rounded-lg px-3 py-2 mb-3"><i class="fa-solid fa-ban mr-1"></i>Venta anulada${s.voidReason?': '+esc(s.voidReason):''}</div>`:''}
      ${(s.stockShortages||[]).length?`<div class="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2 mb-3"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Se vendió más de lo que había en inventario: ${s.stockShortages.map(x=>esc(x.name)+' (faltaron '+round3(x.requested-x.available)+')').join(', ')}. El stock se dejó en 0.</div>`:''}
      <div class="grid grid-cols-2 gap-3 text-sm mb-4">
        <div><p class="text-slate-400 text-xs">Fecha</p><p class="font-semibold text-sm">${ds}</p></div>
        <div><p class="text-slate-400 text-xs">Vendedor</p><p class="font-semibold text-sm">${esc(s.sellerName||'–')}</p></div>
        <div><p class="text-slate-400 text-xs">Método de pago</p><p class="font-semibold text-sm">${methodLabel}</p></div>
        ${s.payMethod==='cash'?`<div><p class="text-slate-400 text-xs">Cambio</p><p class="font-semibold text-sm">${fmt(s.change||0)}</p></div>`:''}
      </div>
      <div class="bg-slate-50 rounded-xl overflow-hidden mb-4">
        <table class="w-full text-xs sm:text-sm">
          <thead class="bg-slate-100"><tr>
            <th class="text-left px-3 py-2 text-slate-500 font-semibold">Producto</th>
            <th class="text-center px-3 py-2 text-slate-500 font-semibold">Qty</th>
            <th class="text-right px-3 py-2 text-slate-500 font-semibold">P.U.</th>
            <th class="text-right px-3 py-2 text-slate-500 font-semibold">Sub</th>
          </tr></thead>
          <tbody class="divide-y divide-slate-100">
            ${(s.items||[]).map(it=>`<tr>
              <td class="px-3 py-2">${esc(it.name)}</td>
              <td class="px-3 py-2 text-center">${it.quantity}</td>
              <td class="px-3 py-2 text-right">${fmt(it.price)}</td>
              <td class="px-3 py-2 text-right font-semibold">${fmt(it.subtotal)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${s.discountAmt?`<div class="flex justify-between items-center text-sm text-emerald-600 px-1 mb-1"><span>Descuento</span><span>-${fmt(s.discountAmt)}</span></div>`:''}
      <div class="flex justify-between items-center font-black text-lg px-1">
        <span>Total</span><span class="text-indigo-700">${fmt(s.total)}</span>
      </div>`;
    g('voidArea').classList.toggle('hidden', !S.isAdmin || !!s.voided);
    g('voidReasonInput').value='';
    g('saleDetailModal').classList.remove('hidden');
  }catch(e){ showToast('Error: '+e.message,'error'); }
}
function hideSaleDetail(){ g('saleDetailModal').classList.add('hidden'); }
async function voidSale(){
  if(!_curSaleDetail) return;
  const reason=g('voidReasonInput').value.trim();
  if(!reason){ showToast('Escribe un motivo de anulación','warning'); return; }
  const ok=await confirmAction({title:'¿Anular esta venta?', msg:'Se repondrá el stock de los productos y la venta se excluirá de las métricas.', okLabel:'Anular venta', icon:'🛑'});
  if(!ok) return;
  try{
    await db.collection('sales').doc(_curSaleDetail.id).update({
      voided:true, voidReason:reason, voidedAt:FS.FieldValue.serverTimestamp(), voidedBy:S.user?.email||S.user?.uid||''
    });
    /* Se repone solo lo que de verdad se descontó (stockApplied).
       Ventas viejas no lo traen: se usa lo vendido, sin recargas. */
    const items = (_curSaleDetail.items||[]).filter(it=>!it.isRecharge);
    const repo = Array.isArray(_curSaleDetail.stockApplied)
      ? _curSaleDetail.stockApplied
      : items.map(it=>({barcode:it.barcode, qty:it.quantity}));
    repo.forEach(r=>{
      if(!r.qty) return;
      db.collection('products').doc(r.barcode).update({stock:FS.FieldValue.increment(r.qty)}).catch(()=>{});
    });
    items.forEach(it=>{
      db.collection('products').doc(it.barcode).update({salesCount:FS.FieldValue.increment(-it.quantity)}).catch(()=>{});
    });
    showToast('Venta anulada, stock repuesto ✅','success');
    hideSaleDetail(); loadHistory(); loadMetrics(document.querySelector('.pbtn.on')?.dataset.period||'day');
  }catch(e){ showToast('Error al anular: '+e.message,'error'); }
}

function exportCSV(){
  if(!S.histSales.length){showToast('Carga el historial primero','warning');return;}
  const h=['ID','Fecha','Vendedor','Subtotal','Descuento','Total','Método','Estado','Items'];
  const methodName = m => m==='cash'?'Efectivo':m==='card'?'Tarjeta':'Mixto';
  const rows=S.histSales.map(s=>[s.id,s.timestamp?.toDate?.()?.toLocaleString('es-MX')||'',s.sellerName||'',s.subtotal??s.total??0,s.discountAmt||0,s.total||0,methodName(s.payMethod),s.voided?'Anulada':'Válida',(s.items||[]).map(i=>`${i.name}(x${i.quantity})`).join('; ')]);
  const csv=[h,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  a.download='ventas_'+new Date().toISOString().split('T')[0]+'.csv'; a.click();
}

/* ════════════════════════════════════
   SHIFTS / CORTE DE CAJA
   NOTE: requires a "shifts" collection with read/write rules for
   authenticated sellers (own docs) and the admin. If your Firestore
   rules don't cover it yet, these calls fail gracefully with a toast.
════════════════════════════════════ */

/* ── Persistencia local del turno (para seguir cobrando sin internet) ── */
const SHIFT_KEY='posCurrentShift_v1';
function saveLocalShift(){
  if(S.currentShift) localStorage.setItem(SHIFT_KEY, JSON.stringify(S.currentShift));
  else localStorage.removeItem(SHIFT_KEY);
  updateShiftIndicator();
}
function restoreLocalShift(){
  try{
    const raw=localStorage.getItem(SHIFT_KEY);
    if(raw) S.currentShift=JSON.parse(raw);
  }catch(e){}
  updateShiftIndicator();
}

async function checkCurrentShift(){
  if(!S.user) return;
  try{
    const snap = await db.collection('shifts')
      .where('sellerId','==',S.user.uid).where('status','==','open').limit(1).get();
    if(!snap.empty){
      const remote={id:snap.docs[0].id, ...snap.docs[0].data()};
      /* Si hay ventas locales aún sin subir, conservamos los totales locales */
      const local=S.currentShift;
      S.currentShift = (local && local.id===remote.id && pendingCount()>0) ? {...remote, ...local} : remote;
    } else if(!(S.currentShift && S.currentShift.pendingCreate)){
      S.currentShift = null;
    }
  }catch(e){ console.warn('Turno (sin conexión, se usa el local):', e.message); }
  saveLocalShift();
}
function updateShiftIndicator(){
  const dot=g('shiftDot'), label=g('shiftBtnLabel');
  if(!dot) return;
  if(S.currentShift){ dot.className='shift-dot bg-emerald-400 animate-pulse'; if(label) label.textContent='Turno abierto'; }
  else { dot.className='shift-dot bg-gray-300'; if(label) label.textContent='Turno'; }
}
function shiftExpectedCash(s){
  if(!s) return 0;
  return (s.openingCash||0)+(s.cashSales||0)-(s.cashOut||0);
}
function openShiftModal(){
  if(S.currentShift){
    g('shiftOpenArea').classList.add('hidden'); g('shiftCloseArea').classList.remove('hidden');
    g('shiftOpenAmtEl').textContent=fmt(S.currentShift.openingCash||0);
    g('shiftCashSalesEl').textContent=fmt(S.currentShift.cashSales||0);
    g('shiftCardSalesEl').textContent=fmt(S.currentShift.cardSales||0);
    g('shiftCashOutEl').textContent='-'+fmt(S.currentShift.cashOut||0);
    g('shiftExpectedEl').textContent=fmt(shiftExpectedCash(S.currentShift));
    g('shiftCountedInput').value=''; calcShiftDiff();
  } else {
    g('shiftOpenArea').classList.remove('hidden'); g('shiftCloseArea').classList.add('hidden');
    g('shiftOpenInput').value='';
  }
  g('shiftModal').classList.remove('hidden');
}
function hideShiftModal(){ g('shiftModal').classList.add('hidden'); }
function calcShiftDiff(){
  const expected=shiftExpectedCash(S.currentShift);
  const counted=parseFloat(g('shiftCountedInput').value)||0;
  const diff=counted-expected;
  const el=g('shiftDiffEl');
  el.textContent=(diff>=0?'+':'')+fmt(diff);
  el.className='text-xl font-black '+(Math.abs(diff)<0.01?'text-emerald-600':diff>0?'text-blue-600':'text-red-500');
}
async function openShift(){
  const amt=parseFloat(g('shiftOpenInput').value)||0;
  const id=newLocalId();
  const now=new Date();
  const data={
    sellerId:S.user.uid, sellerName:S.user.displayName||S.user.email,
    storeName: nombreNegocio(),
    branchId:S.userBranchId||null, branchName:S.userBranchName||null,
    openingCash:amt, cashSales:0, cardSales:0, totalSales:0, salesCount:0, cashOut:0,
    status:'open', openISO:now.toISOString(), date:localDateStr(now)
  };
  S.currentShift={id, ...data, pendingCreate:true};
  outboxPush({id:'shiftopen_'+id, type:'shiftOpen', tsISO:now.toISOString(), tries:0,
    payload:{shiftId:id, ...data}, label:`Apertura de turno ${fmt(amt)}`});
  saveLocalShift(); hideShiftModal();
  showToast('Turno abierto con '+fmt(amt),'success');
  if(isOnline()) flushOutbox();
}
async function closeShift(){
  if(!S.currentShift) return;
  const counted=parseFloat(g('shiftCountedInput').value)||0;
  const expected=shiftExpectedCash(S.currentShift);
  const ok=await confirmAction({title:'¿Cerrar turno?', msg:'Se registrará el corte de caja con la diferencia calculada.', okLabel:'Cerrar turno', icon:'🗄️'});
  if(!ok) return;
  const now=new Date();
  const snapshot={
    openingCash:S.currentShift.openingCash||0,
    cashSales:S.currentShift.cashSales||0,
    cardSales:S.currentShift.cardSales||0,
    totalSales:S.currentShift.totalSales||0,
    salesCount:S.currentShift.salesCount||0,
    cashOut:S.currentShift.cashOut||0,
  };
  outboxPush({id:'shiftclose_'+S.currentShift.id, type:'shiftClose', tsISO:now.toISOString(), tries:0,
    payload:{shiftId:S.currentShift.id, countedCash:counted, expectedCash:expected,
             difference:counted-expected, closeISO:now.toISOString(), snapshot},
    label:`Corte de caja ${fmt(counted)}`});
  const diff=counted-expected;
  S.currentShift=null; saveLocalShift(); hideShiftModal();
  showToast('Turno cerrado. Diferencia: '+fmt(diff), Math.abs(diff)<0.01?'success':'warning');
  if(isOnline()) flushOutbox();
}

/* ── Historial de cortes (admin) ── */
async function loadShiftsAdmin(){
  const tbody=g('shiftsTableBody');
  tbody.innerHTML='<tr><td colspan="8" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  try{
    const snap=await db.collection('shifts').orderBy('openAt','desc').limit(200).get();
    S.shiftsCache=snap.docs.map(d=>({id:d.id,...d.data()}));
    const sel=g('shiftSellerFilter');
    if(sel){
      const names=[...new Set(S.shiftsCache.map(s=>s.sellerName).filter(Boolean))];
      sel.innerHTML='<option value="">Todos los vendedores</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    }
    renderShiftsTable();
  }catch(e){
    tbody.innerHTML='<tr><td colspan="8" class="text-center py-10 text-red-400">Error: '+esc(e.message)+'<br><span class="text-xs text-slate-400">Verifica los permisos de la colección "shifts" en tus reglas de Firestore.</span></td></tr>';
  }
}
function renderShiftsTable(){
  const tbody=g('shiftsTableBody');
  const who=g('shiftSellerFilter')?.value||'';
  const st=g('shiftStatusFilter')?.value||'';
  let list=S.shiftsCache;
  if(who) list=list.filter(s=>s.sellerName===who);
  if(st) list=list.filter(s=>(s.status||'closed')===st);
  if(!list.length){tbody.innerHTML='<tr><td colspan="8" class="text-center py-10 text-slate-400">Sin cortes registrados</td></tr>';return;}
  tbody.innerHTML=list.map(s=>{
    const open=tsLabel(s.openAt, s.openISO);
    const close=s.closeAt||s.closeISO?tsLabel(s.closeAt, s.closeISO):'—';
    const diff=s.difference;
    return `<tr class="hover:bg-slate-50 transition">
      <td class="px-3 sm:px-4 py-3 text-xs sm:text-sm font-semibold text-slate-800 max-w-[160px] break-anywhere">${esc(s.sellerName||'–')}</td>
      <td class="px-3 sm:px-4 py-3 text-xs text-slate-600 whitespace-nowrap">${open}</td>
      <td class="px-3 sm:px-4 py-3 text-xs text-slate-600 whitespace-nowrap hidden sm:table-cell">${close}</td>
      <td class="px-3 sm:px-4 py-3 text-right text-xs sm:text-sm">${fmt(s.openingCash||0)}</td>
      <td class="px-3 sm:px-4 py-3 text-right text-xs sm:text-sm hidden md:table-cell">${s.expectedCash!=null?fmt(s.expectedCash):'—'}</td>
      <td class="px-3 sm:px-4 py-3 text-right text-xs sm:text-sm font-bold ${diff==null?'text-slate-300':Math.abs(diff)<0.01?'text-emerald-600':diff<0?'text-red-500':'text-blue-600'}">${diff!=null?(diff>=0?'+':'')+fmt(diff):'—'}</td>
      <td class="px-3 sm:px-4 py-3 text-center">
        <span class="text-xs px-2 py-0.5 rounded-full font-medium ${s.status==='open'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}">${s.status==='open'?'Abierto':'Cerrado'}</span>
      </td>
      <td class="px-3 sm:px-4 py-3 text-right">
        <button onclick="showShiftDetail('${s.id}')" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px]"><i class="fa-solid fa-eye"></i></button>
      </td>
    </tr>`;
  }).join('');
}
async function showShiftDetail(id){
  const s=S.shiftsCache.find(x=>x.id===id); if(!s) return;
  const box=g('shiftDetailContent');
  box.innerHTML='<p class="text-center text-slate-400 py-8"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando movimientos…</p>';
  g('shiftDetailModal').classList.remove('hidden');
  let sales=[], exps=[];
  try{
    /* El vendedor solo puede leer sus propias ventas: filtramos por él.
       El dueño no filtra, porque puede cerrar el turno de cualquiera. */
    let qs = db.collection('sales').where('shiftId','==',id);
    if(!S.isAdmin && S.user) qs = qs.where('sellerId','==',S.user.uid);
    const snap=await qs.get();
    sales=snap.docs.map(d=>d.data()).filter(x=>!x.voided);
  }catch(e){ console.warn(e.message); }
  try{
    /* Igual que con las ventas: el vendedor solo alcanza sus propios gastos. */
    let qe = db.collection('expenses').where('shiftId','==',id);
    if(!S.isAdmin && S.user) qe = qe.where('userId','==',S.user.uid);
    const snap=await qe.get();
    exps=snap.docs.map(d=>d.data());
  }catch(e){ console.warn(e.message); }
  const cogs=sales.reduce((a,x)=>a+(x.cost!=null?x.cost:sumItemsCost(x.items)),0);
  const gross=(s.totalSales||0)-cogs;
  const expTotal=exps.reduce((a,x)=>a+(x.amount||0),0);
  _lastCorte = {s, sales, exps, cogs, gross, expTotal};
  const row=(l,v,cls='')=>`<div class="flex justify-between gap-3 py-1 min-w-0"><span class="text-slate-500 min-w-0 break-anywhere">${l}</span><span class="font-semibold shrink-0 num ${cls}">${v}</span></div>`;
  box.innerHTML=`
    <div class="bg-slate-50 rounded-xl p-3 text-sm mb-3">
      ${row('Vendedor', esc(s.sellerName||'–'))}
      ${row('Sucursal', esc(s.branchName||'—'))}
      ${row('Apertura', tsLabel(s.openAt, s.openISO))}
      ${row('Cierre', s.closeAt||s.closeISO?tsLabel(s.closeAt,s.closeISO):'Turno abierto')}
    </div>
    <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Caja</p>
    <div class="bg-white border border-slate-200 rounded-xl p-3 text-sm mb-3">
      ${row('Fondo inicial', fmt(s.openingCash||0))}
      ${row('+ Ventas en efectivo', fmt(s.cashSales||0),'text-emerald-600')}
      ${row('− Salidas de efectivo', '-'+fmt(s.cashOut||0),'text-red-500')}
      <div class="border-t border-dashed border-slate-200 my-1"></div>
      ${row('Efectivo esperado', fmt(s.expectedCash!=null?s.expectedCash:shiftExpectedCash(s)),'text-slate-800')}
      ${row('Efectivo contado', s.countedCash!=null?fmt(s.countedCash):'—')}
      ${row('Diferencia', s.difference!=null?((s.difference>=0?'+':'')+fmt(s.difference)):'—', s.difference==null?'':Math.abs(s.difference)<0.01?'text-emerald-600':s.difference<0?'text-red-500':'text-blue-600')}
    </div>
    <p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Ventas del turno</p>
    <div class="bg-white border border-slate-200 rounded-xl p-3 text-sm mb-3">
      ${row('Tickets', s.salesCount||sales.length||0)}
      ${row('Total vendido', fmt(s.totalSales||0))}
      ${row('Con tarjeta', fmt(s.cardSales||0))}
      ${row('Costo de mercancía', '-'+fmt(cogs),'text-slate-500')}
      ${row('Utilidad bruta', fmt(gross),'text-teal-600')}
      ${row('Gastos del turno', '-'+fmt(expTotal),'text-red-500')}
      <div class="border-t border-dashed border-slate-200 my-1"></div>
      ${row('Ganancia neta', fmt(gross-expTotal), (gross-expTotal)>=0?'text-emerald-700':'text-red-600')}
    </div>
    ${exps.length?`<p class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-1">Salidas registradas</p>
    <div class="space-y-1 mb-3">${exps.map(e=>`<div class="flex justify-between text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2">
      <span class="text-slate-600 truncate pr-2">${esc(e.concept||e.category||'Gasto')}</span><span class="font-bold text-red-500 shrink-0">-${fmt(e.amount||0)}</span></div>`).join('')}</div>`:''}
    <button onclick="printCorte()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-2.5 rounded-xl font-semibold text-sm min-h-[44px]"><i class="fa-solid fa-print mr-1.5"></i>Imprimir corte</button>`;
}
/* ── Corte de caja impreso (mismo formato de ticket 58/80 mm) ── */
let _lastCorte = null;
function corteLines(c){
  const s = c.s, L = [];
  const dif = s.difference;
  L.push({t:'center', k:'store', text:sinLinks(s.storeName||nombreNegocio()).toUpperCase()});
  if(s.branchName) L.push({t:'center', k:'meta', text:sinLinks(s.branchName)});
  L.push({t:'center', k:'tag', text:'CORTE DE CAJA'});
  const cajero = limpiarNombre(s.sellerName);
  if(cajero) L.push({t:'center', k:'meta', text:'Cajero: '+cajero});
  L.push({t:'hr'});
  L.push({t:'row', l:'Apertura', r:tsLabel(s.openAt, s.openISO)});
  L.push({t:'row', l:'Cierre', r:(s.closeAt||s.closeISO) ? tsLabel(s.closeAt, s.closeISO) : 'Abierto'});
  L.push({t:'hr'});
  L.push({t:'row', l:'Fondo inicial', r:fmt(s.openingCash||0)});
  L.push({t:'row', l:'+ Efectivo', r:fmt(s.cashSales||0)});
  L.push({t:'row', l:'- Salidas', r:'-'+fmt(s.cashOut||0)});
  L.push({t:'row', k:'total', l:'Esperado', r:fmt(s.expectedCash!=null ? s.expectedCash : shiftExpectedCash(s))});
  if(s.countedCash!=null) L.push({t:'row', l:'Contado', r:fmt(s.countedCash)});
  if(dif!=null) L.push({t:'row', l:'Diferencia', r:(dif>=0?'+':'')+fmt(dif), strong:true});
  L.push({t:'hr'});
  L.push({t:'row', l:'Tickets', r:String(s.salesCount||c.sales.length||0)});
  L.push({t:'row', l:'Total vendido', r:fmt(s.totalSales||0)});
  L.push({t:'row', l:'Con tarjeta', r:fmt(s.cardSales||0)});
  if(c.exps.length){
    L.push({t:'hr'});
    L.push({t:'text', text:'Salidas registradas', strong:true});
    c.exps.forEach(e=>L.push({t:'row', l:e.concept||e.category||'Gasto', r:'-'+fmt(e.amount||0)}));
  }
  L.push({t:'hr'});
  L.push({t:'center', k:'meta', text:'Impreso '+fechaTicket()});
  return L;
}
function printCorte(){
  if(!_lastCorte) return;
  const lines = corteLines(_lastCorte);
  imprimirDirecto(lines);
}
function hideShiftDetail(){ g('shiftDetailModal')?.classList.add('hidden'); }
function exportShiftsCSV(){
  if(!S.shiftsCache.length){ showToast('No hay cortes para exportar','warning'); return; }
  const h=['Vendedor','Sucursal','Apertura','Cierre','Fondo inicial','Ventas efectivo','Ventas tarjeta','Total vendido','Salidas','Esperado','Contado','Diferencia','Estado'];
  const rows=S.shiftsCache.map(s=>[s.sellerName||'',s.branchName||'',tsLabel(s.openAt,s.openISO),s.closeAt||s.closeISO?tsLabel(s.closeAt,s.closeISO):'',s.openingCash||0,s.cashSales||0,s.cardSales||0,s.totalSales||0,s.cashOut||0,s.expectedCash??'',s.countedCash??'',s.difference??'',s.status==='open'?'Abierto':'Cerrado']);
  downloadCSV(h,rows,'cortes_de_caja');
}

/* ════════════════════════════════════════════════════════════════
   MODO SIN CONEXIÓN — cola local + sincronización con Firebase
   Todo lo que se registra (ventas, entradas, gastos, turnos) pasa
   primero por esta cola guardada en el dispositivo. Cuando hay
   internet, se sube a Firestore y se borra de la cola.
════════════════════════════════════════════════════════════════ */
const OUTBOX_KEY   = 'posOutbox_v1';
const PRODCACHE_KEY= 'posProductsCache_v2';  // v2: guarda el stock de Firebase, sin ventas pendientes
const NET = { syncing:false, timer:null, lastSync:0 };

const isOnline = () => navigator.onLine !== false;
function newLocalId(){ return 'loc'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function localDateStr(d){ const x=d||new Date(); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; }
function tsLabel(ts, iso){
  const d = ts?.toDate?.() || (iso?new Date(iso):null);
  return d ? d.toLocaleString('es-MX',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
}
function sumItemsCost(items){ return (items||[]).reduce((a,i)=>a+((Number(i.cost)||0)*(i.quantity||0)),0); }

function loadOutbox(){ try{ return JSON.parse(localStorage.getItem(OUTBOX_KEY)||'[]'); }catch(e){ return []; } }
function saveOutbox(l){ try{ localStorage.setItem(OUTBOX_KEY, JSON.stringify(l)); }catch(e){} rebuildProducts(); updateNetUI(); }
function outboxPush(item){ const l=loadOutbox(); l.push(item); saveOutbox(l); }
function outboxPatch(id,patch){ const l=loadOutbox(); const i=l.findIndex(x=>x.id===id); if(i>=0){ l[i]={...l[i],...patch}; saveOutbox(l); } }
function outboxRemove(id){ saveOutbox(loadOutbox().filter(x=>x.id!==id)); }
function pendingCount(){ return loadOutbox().length; }

/* Catálogo local, para poder buscar y cobrar aunque se abra la app sin internet */
/* Se guarda lo que dijo Firebase (sin las ventas pendientes): al abrir la
   app sin internet, rebuildProducts() vuelve a descontar la cola local. */
function cacheProductsLocally(){
  try{ localStorage.setItem(PRODCACHE_KEY, JSON.stringify((S.productsRaw||[]).slice(0,4000))); }catch(e){}
}
function restoreLocalProducts(){
  if((S.productsRaw||[]).length) return;
  try{
    const raw=localStorage.getItem(PRODCACHE_KEY);
    if(raw) setServerProducts(JSON.parse(raw)||[]);
  }catch(e){}
}

function initNetwork(){
  window.addEventListener('online',  ()=>{ updateNetUI(); showToast('Conexión restablecida — subiendo lo pendiente ☁️','success'); flushOutbox(); });
  window.addEventListener('offline', ()=>{ updateNetUI(); showToast('Se fue el internet. Puedes seguir cobrando con normalidad.','warning'); });
  clearInterval(NET.timer);
  NET.timer=setInterval(()=>{ if(isOnline() && pendingCount()) flushOutbox(); }, 20000);
  updateNetUI();
}

function updateNetUI(){
  const dot=g('netDot'), label=g('netLabel'), badge=g('netPending'), banner=g('offlineBanner');
  const n=pendingCount(), on=isOnline();
  if(dot){
    dot.className='w-2 h-2 rounded-full inline-block '+(NET.syncing?'bg-blue-300 animate-pulse':on?(n?'bg-amber-400':'bg-emerald-400'):'bg-red-400');
  }
  if(label) label.textContent = NET.syncing?'Sincronizando…':on?(n?'Pendientes':'En línea'):'Sin conexión';
  if(badge){ badge.textContent=n>99?'99+':n; badge.classList.toggle('hidden', n===0); }
  if(banner){
    const show = !on || (n>0 && !NET.syncing);
    banner.classList.toggle('hidden', !show);
    banner.classList.toggle('flex', show);
    const msg=g('offlineBannerMsg');
    if(msg) msg.textContent = !on
      ? `Puedes seguir cobrando normalmente. ${n?n+' registro(s) esperando':'Todo se guardará'} en este dispositivo y se subirá solo al volver el internet.`
      : `${n} registro(s) pendientes de subir a la nube.`;
  }
  const box=g('syncStatusBox');
  if(box && !g('syncModal').classList.contains('hidden')) renderSyncModal();
}

async function flushOutbox(manual=false){
  if(NET.syncing) return;
  const list=loadOutbox();
  if(!list.length){ if(manual) showToast('Todo está sincronizado ✅','success'); updateNetUI(); return; }
  if(!isOnline()){ if(manual) showToast('Sigues sin conexión — se subirá automáticamente','warning'); return; }
  if(!S.user){ if(manual) showToast('Inicia sesión para poder sincronizar','warning'); return; }
  NET.syncing=true; updateNetUI();
  let ok=0, failed=0;
  for(const item of list){
    try{
      await pushOutboxItem(item);
      outboxRemove(item.id); ok++;
    }catch(e){
      console.warn('Sync fallo:', item.type, e.message);
      outboxPatch(item.id,{tries:(item.tries||0)+1, lastError:e.message});
      failed++;
      if(!isOnline()) break;
    }
  }
  NET.syncing=false; NET.lastSync=Date.now(); updateNetUI();
  if(ok) showToast(`${ok} registro${ok!==1?'s':''} subido${ok!==1?'s':''} a la nube ☁️`,'success');
  else if(manual && failed) showToast('No se pudo subir todavía. Se reintentará solo.','warning');
  if(ok){ checkCurrentShift(); }
}

/* Evita que una escritura sin respuesta deje la sincronización colgada */
function withTimeout(promise, ms=12000){
  return Promise.race([promise, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), ms))]);
}

/* Sube una venta y descuenta su stock en la misma transacción.
   - Lee el stock REAL en Firebase en ese momento (no el de este dispositivo).
   - Nunca deja el stock en negativo: como mínimo queda en 0.
   - Si otra caja vendió lo mismo mientras esta estaba sin internet, la venta
     se guarda igual (el dinero ya se cobró) pero queda marcada en
     stockShortages para que el dueño lo vea en el historial.
   - Es idempotente: si la venta ya tiene stockApplied, no vuelve a descontar. */
async function commitSaleWithStock(item){
  const p = item.payload || {};
  const {tsISO, ...rest} = p;
  const saleRef = db.collection('sales').doc(p.localId);

  const need = {};
  (item.stockDeltas||[]).forEach(d=>{
    if(d.barcode && !String(d.barcode).includes('/')) need[d.barcode] = round3((need[d.barcode]||0) + (d.qty||0));
  });
  const codes = Object.keys(need);
  const nameOf = code => (p.items||[]).find(i=>i.barcode===code)?.name || code;

  return dbRoot.runTransaction(async tx=>{
    const saleSnap = await tx.get(saleRef);
    if(saleSnap.exists && saleSnap.data().stockApplied){
      return {already:true, shortages:[]};
    }
    const refs  = codes.map(c=>db.collection('products').doc(c));
    const snaps = await Promise.all(refs.map(r=>tx.get(r)));   // todas las lecturas antes de escribir

    const applied = [], shortages = [];
    snaps.forEach((snap, i)=>{
      if(!snap.exists) return;
      const code = codes[i], qty = need[code], d = snap.data();
      const upd = { salesCount: FS.FieldValue.increment(qty) };
      if(typeof d.stock==='number'){
        const antes = Math.max(0, d.stock);
        upd.stock = round3(Math.max(0, antes - qty));
        applied.push({barcode:code, qty: round3(Math.min(qty, antes))});
        if(qty > antes + 1e-9) shortages.push({barcode:code, name:nameOf(code), requested:qty, available:antes});
      }
      tx.update(refs[i], upd);
    });

    tx.set(saleRef, {
      ...rest, tsISO,
      timestamp: FS.Timestamp.fromDate(new Date(tsISO)),
      syncedAt: FS.FieldValue.serverTimestamp(),
      stockApplied: applied,
      stockShortages: shortages
    }, {merge:true});

    return {already:false, shortages};
  });
}

function avisarFaltantes(shortages){
  const txt = shortages.map(s=>`${s.name} (vendidas ${round3(s.requested)}, había ${round3(s.available)})`).join(', ');
  showToast('Ojo: se vendió más de lo que había en Firebase — '+txt+'. El stock quedó en 0; revisa el inventario.','warning');
}

async function pushOutboxItem(item){
  const p=item.payload||{};

  if(item.type==='sale'){
    let shiftPending = !!item.shiftPending;
    if(!item.sideDone){
      /* Venta + descuento de stock en UNA transacción: el stock nunca baja
         de 0 y, si se reintenta, no se descuenta dos veces. */
      const res = await withTimeout(commitSaleWithStock(item), 20000);
      shiftPending = !!item.shiftUpdate?.shiftId && !res.already;
      outboxPatch(item.id,{saleSaved:true, sideDone:true, shiftPending});
      if(res.shortages.length) avisarFaltantes(res.shortages);
    }
    /* El turno se actualiza UNA sola vez: Firestore conserva el incremento
       en su propia cola durable, así que no hay que reintentarlo. */
    if(shiftPending && item.shiftUpdate?.shiftId){
      db.collection('shifts').doc(item.shiftUpdate.shiftId).update({
        cashSales: FS.FieldValue.increment(item.shiftUpdate.cash||0),
        cardSales: FS.FieldValue.increment(item.shiftUpdate.card||0),
        totalSales:FS.FieldValue.increment(item.shiftUpdate.total||0),
        salesCount:FS.FieldValue.increment(1)
      }).catch(()=>{});
      outboxPatch(item.id,{shiftPending:false});
    }
    return;
  }

  if(item.type==='shiftOpen'){
    const {shiftId, openISO, ...rest}=p;
    await withTimeout(db.collection('shifts').doc(shiftId).set({
      ...rest, openISO,
      openAt: FS.Timestamp.fromDate(new Date(openISO)),
      createdAt: FS.FieldValue.serverTimestamp()
    },{merge:true}));
    if(S.currentShift?.id===shiftId){ delete S.currentShift.pendingCreate; saveLocalShift(); }
    return;
  }

  if(item.type==='shiftClose'){
    await withTimeout(db.collection('shifts').doc(p.shiftId).set({
      status:'closed', countedCash:p.countedCash, expectedCash:p.expectedCash,
      difference:p.difference, closeISO:p.closeISO,
      closeAt: FS.Timestamp.fromDate(new Date(p.closeISO)),
      ...(p.snapshot||{})
    },{merge:true}));
    return;
  }

  if(item.type==='entry'){
    if(!item.entrySaved){
      const {tsISO, ...rest}=p;
      await withTimeout(db.collection('inventoryEntries').doc(p.localId).set({
        ...rest, tsISO,
        timestamp: FS.Timestamp.fromDate(new Date(tsISO)),
        syncedAt: FS.FieldValue.serverTimestamp()
      }));
      outboxPatch(item.id,{entrySaved:true});
    }
    if(!item.sideDone){
      const upd={ stock: FS.FieldValue.increment(p.quantity), lastEntryAt: FS.FieldValue.serverTimestamp() };
      if(p.updateCost && p.unitCost>0) upd.cost=p.unitCost;
      if(p.expiry) upd.lots = FS.FieldValue.arrayUnion({expiry:p.expiry, qty:p.quantity, entryId:p.localId});
      db.collection('products').doc(p.productBarcode).set(upd,{merge:true}).catch(()=>{});
      outboxPatch(item.id,{sideDone:true});
    }
    return;
  }

  if(item.type==='expense'){
    if(!item.expSaved){
      const {tsISO, ...rest}=p;
      await withTimeout(db.collection('expenses').doc(p.localId).set({
        ...rest, tsISO,
        timestamp: FS.Timestamp.fromDate(new Date(tsISO)),
        syncedAt: FS.FieldValue.serverTimestamp()
      }));
      outboxPatch(item.id,{expSaved:true});
    }
    if(!item.sideDone){
      if(p.shiftId && p.method==='cash'){
        db.collection('shifts').doc(p.shiftId)
          .update({cashOut: FS.FieldValue.increment(p.amount||0)}).catch(()=>{});
      }
      outboxPatch(item.id,{sideDone:true});
    }
    return;
  }

  throw new Error('Tipo desconocido: '+item.type);
}

function openSyncModal(){ g('syncModal').classList.remove('hidden'); renderSyncModal(); }
function hideSyncModal(){ g('syncModal')?.classList.add('hidden'); }
function renderSyncModal(){
  const box=g('syncStatusBox'); if(!box) return;
  const on=isOnline(), list=loadOutbox();
  box.className='rounded-xl p-4 mb-3 border '+(on?(list.length?'bg-amber-50 border-amber-200':'bg-emerald-50 border-emerald-200'):'bg-red-50 border-red-200');
  box.innerHTML=`
    <p class="font-black text-sm ${on?(list.length?'text-amber-800':'text-emerald-800'):'text-red-700'}">
      <i class="fa-solid ${on?(list.length?'fa-cloud-arrow-up':'fa-circle-check'):'fa-plug-circle-xmark'} mr-1.5"></i>
      ${on?(list.length?'Hay registros esperando subir':'Todo sincronizado con Firebase'):'Sin conexión a internet'}
    </p>
    <p class="text-xs mt-1 ${on?(list.length?'text-amber-700':'text-emerald-700'):'text-red-600'}">
      ${on? (list.length?`${list.length} registro(s) en la cola local.`:'No hay nada pendiente.')
          : 'Sigue cobrando con normalidad: las ventas se guardan aquí y se subirán solas.'}
    </p>`;
  const el=g('syncPendingList');
  el.innerHTML = list.length ? list.slice(0,50).map(i=>`
    <div class="flex items-center justify-between gap-2 border border-slate-200 rounded-xl px-3 py-2">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-slate-700 truncate">${esc(i.label||i.type)}</p>
        <p class="text-[10px] text-slate-400">${new Date(i.tsISO).toLocaleString('es-MX')}${i.tries?` · ${i.tries} intento(s)`:''}</p>
      </div>
      <span class="text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full shrink-0">Pendiente</span>
    </div>`).join('') : '<p class="text-center text-slate-400 text-xs py-4">Sin registros pendientes</p>';
}

/* ════════════════════════════════════════════════════════════════
   ENTRADAS DE INVENTARIO (solo ADMIN)
   Escanea un producto existente, indica cuántas piezas entran,
   su costo de adquisición y, con el switch, su fecha de caducidad.
════════════════════════════════════════════════════════════════ */
function openEntryModal(barcode){
  if(!S.isAdmin){ showToast('Solo el administrador puede registrar entradas','error'); return; }
  S.entryProduct=null;
  g('ie_barcode').value=barcode||'';
  g('ie_found').classList.add('hidden');
  g('ie_notFound').classList.add('hidden');
  g('ie_qty').value=1; g('ie_cost').value='';
  g('ie_expSwitch').checked=false; g('ie_expArea').classList.add('hidden');
  g('ie_expDate').value=''; g('ie_supplier').value='';
  g('ie_expenseSwitch').checked=true; g('ie_expenseArea').classList.remove('hidden');
  g('ie_updateCost').checked=true;
  g('entryModal').classList.remove('hidden');
  if(barcode) lookupEntryProduct();
  else setTimeout(()=>g('ie_barcode').focus(),200);
}
function hideEntryModal(){
  stopSc('ieScanInst'); g('ie_scanArea')?.classList.add('hidden');
  g('entryModal')?.classList.add('hidden');
}
function startEntryScan(){
  g('ie_scanArea').classList.remove('hidden');
  startSc('ie_scanReader','ieScanInst', code=>{
    g('ie_barcode').value=code;
    stopSc('ieScanInst'); g('ie_scanArea').classList.add('hidden');
    beep('scan');
    lookupEntryProduct();
  });
}
function lookupEntryProduct(){
  const code=g('ie_barcode').value.trim();
  if(!code) return;
  const p=S.products.find(x=>x.barcode===code)
       || S.products.find(x=>(x.name||'').toLowerCase()===code.toLowerCase());
  if(!p){
    S.entryProduct=null;
    g('ie_found').classList.add('hidden');
    g('ie_notFound').classList.remove('hidden');
    window._pendingBarcode=code;
    beep('error');
    g('ie_catalogName').classList.add('hidden');
    buscarEnCatalogo(code).then(ficha=>{
      if(!ficha || g('ie_barcode').value.trim()!==code) return;
      const det = detalleCatalogo(ficha);
      g('ie_catalogName').innerHTML='En el catálogo: <b>'+esc(ficha.nombre)+'</b>'+(det?' · '+esc(det):'');
      g('ie_catalogName').classList.remove('hidden');
    });
    return;
  }
  S.entryProduct=p;
  g('ie_notFound').classList.add('hidden');
  g('ie_found').classList.remove('hidden');
  g('ie_found').classList.add('pop-in');
  g('ie_prodName').textContent=p.name;
  g('ie_curStock').textContent=(typeof p.stock==='number'?p.stock:0);
  g('ie_curPrice').textContent=fmt(p.price);
  g('ie_curCost').textContent=p.cost?fmt(p.cost):'sin costo';
  g('ie_cost').value=p.cost||'';
  g('ie_qty').value=1;
  const lot=(p.lots||[]).slice().sort((a,b)=>String(a.expiry).localeCompare(String(b.expiry)))[0];
  if(lot){ g('ie_expSwitch').checked=true; g('ie_expArea').classList.remove('hidden'); }
  updateEntryPreview();
  setTimeout(()=>g('ie_qty').select(),120);
}
function createFromEntry(){
  hideEntryModal();
  showProductModal(true);
}
function changeEntryQty(d){ const el=g('ie_qty'); el.value=Math.max(1,(parseInt(el.value)||1)+d); updateEntryPreview(); }
function setEntryQty(v){ g('ie_qty').value=v; updateEntryPreview(); }
function toggleExpirySwitch(){ g('ie_expArea').classList.toggle('hidden', !g('ie_expSwitch').checked); }
function toggleEntryExpense(){ g('ie_expenseArea').classList.toggle('hidden', !g('ie_expenseSwitch').checked); }
function setExpiryIn(days){
  const d=new Date(Date.now()+days*864e5);
  g('ie_expDate').value=localDateStr(d);
}
function updateEntryPreview(){
  const qty=Math.max(1,parseInt(g('ie_qty').value)||1);
  const cost=parseFloat(g('ie_cost').value)||0;
  const p=S.entryProduct;
  const total=qty*cost;
  const util=p?((p.price||0)-cost)*qty:0;
  g('ie_costPreview').innerHTML = cost
    ? `Inversión: <b class="text-slate-700">${fmt(total)}</b> · ganancia esperada del lote: <b class="${util>=0?'text-emerald-600':'text-red-500'}">${fmt(util)}</b>`
    : 'Sin costo capturado no se calculará la ganancia real de estas piezas.';
  const newStock=(typeof p?.stock==='number'?p.stock:0)+qty;
  g('ie_saveLabel').textContent=`Agregar ${qty} pza${qty!==1?'s':''} (queda ${newStock})`;
}
async function saveEntry(){
  if(!S.isAdmin){ showToast('Solo el administrador puede registrar entradas','error'); return; }
  const p=S.entryProduct;
  if(!p){ showToast('Primero escanea o busca el producto','error'); return; }
  const qty=parseInt(g('ie_qty').value)||0;
  if(qty<=0){ showToast('Indica cuántas piezas entran','error'); return; }
  const unitCost=parseFloat(g('ie_cost').value)||0;
  const wantsExpiry=g('ie_expSwitch').checked;
  const expiry=wantsExpiry?g('ie_expDate').value:null;
  if(wantsExpiry && !expiry){ showToast('Selecciona la fecha de caducidad o apaga el switch','error'); return; }
  const asExpense=g('ie_expenseSwitch').checked;
  const supplier=g('ie_supplier').value.trim();
  const method=g('ie_payMethod').value;

  const btn=g('ie_saveBtn'); btn.disabled=true;
  const now=new Date();
  const localId=newLocalId();
  const entry={
    localId,
    productBarcode:p.barcode, productName:p.name,
    quantity:qty, unitCost, totalCost:+(qty*unitCost).toFixed(2),
    updateCost:g('ie_updateCost').checked,
    expiry: expiry||null,
    supplier: supplier||null,
    userId:S.user?.uid||null, userName:S.user?.displayName||S.user?.email||'',
    branchId:S.userBranchId||null, branchName:S.userBranchName||null,
    tsISO:now.toISOString(), date:localDateStr(now),
    year:now.getFullYear(), month:now.getMonth()+1,
    createdOffline:!isOnline(),
    expenseId:null
  };

  if(asExpense && entry.totalCost>0){
    const expId=newLocalId();
    entry.expenseId=expId;
    const expense={
      localId:expId,
      concept:`Mercancía: ${p.name} ×${qty}`,
      category:'Proveedores / Mercancía',
      amount:entry.totalCost,
      method,
      supplier:supplier||null,
      note:`Entrada de inventario · código ${p.barcode}`,
      source:'inventory', entryId:localId,
      shiftId:(method==='cash' && S.currentShift)?S.currentShift.id:null,
      userId:S.user?.uid||null, userName:S.user?.displayName||S.user?.email||'',
      branchId:S.userBranchId||null, branchName:S.userBranchName||null,
      date:entry.date, year:entry.year, month:entry.month,
      tsISO:entry.tsISO, createdOffline:!isOnline()
    };
    outboxPush({id:expId, type:'expense', tsISO:entry.tsISO, tries:0, payload:expense, label:`Gasto proveedor ${fmt(expense.amount)}`});
    if(expense.shiftId && S.currentShift){
      S.currentShift.cashOut=(S.currentShift.cashOut||0)+expense.amount;
      saveLocalShift();
    }
  }

  outboxPush({id:localId, type:'entry', tsISO:entry.tsISO, tries:0, payload:entry, label:`Entrada ${p.name} ×${qty}`});

  /* El catálogo local ya suma estas piezas: outboxPush → rebuildProducts() */

  btn.disabled=false;
  hideEntryModal();
  beep('success');
  showToast(`+${qty} pza(s) de ${p.name}${isOnline()?'':' (se subirá al volver el internet)'}`, isOnline()?'success':'warning');
  updateStockBell();
  if(isOnline()) await flushOutbox();
  if(g('admin-inventory') && !g('admin-inventory').classList.contains('hidden')) loadEntries();
  if(g('admin-products') && !g('admin-products').classList.contains('hidden')) filterProdTable();
}

/* ── Pestaña de entradas ── */
function initInventoryTab(){ loadEntries(); renderExpiryPanel(); }
async function loadEntries(){
  const tbody=g('entriesTableBody');
  tbody.innerHTML='<tr><td colspan="7" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  const start=g('entStart').value||'2000-01-01';
  const end=g('entEnd').value||'2999-12-31';
  try{
    const snap=await db.collection('inventoryEntries').where('date','>=',start).where('date','<=',end).get();
    S.entries=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.tsISO||'').localeCompare(String(a.tsISO||'')));
    renderEntries();
  }catch(e){
    tbody.innerHTML='<tr><td colspan="7" class="text-center py-10 text-red-400">Error: '+esc(e.message)+'<br><span class="text-xs text-slate-400">Revisa los permisos de la colección "inventoryEntries".</span></td></tr>';
  }
  renderExpiryPanel();
}
function renderEntries(){
  const tbody=g('entriesTableBody');
  const list=S.entries;
  g('kpiEntries').textContent=list.length;
  g('kpiEntryUnits').textContent=list.reduce((a,x)=>a+(x.quantity||0),0);
  g('kpiEntryCost').textContent=fmt(list.reduce((a,x)=>a+(x.totalCost||0),0));
  if(!list.length){ tbody.innerHTML='<tr><td colspan="7" class="text-center py-10 text-slate-400">Sin entradas en este periodo</td></tr>'; return; }
  tbody.innerHTML=list.map(e=>{
    const exp=e.expiry?expiryTag(e.expiry):'<span class="text-slate-300 text-xs">—</span>';
    return `<tr class="hover:bg-slate-50 transition">
      <td class="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">${tsLabel(e.timestamp, e.tsISO)}</td>
      <td class="px-3 py-3 text-xs sm:text-sm font-semibold text-slate-800 max-w-[200px] break-anywhere">${esc(e.productName||'')}<span class="block text-[10px] text-slate-400 font-normal">${esc(e.productBarcode||'')}</span></td>
      <td class="px-3 py-3 text-center text-sm font-black text-emerald-600">+${e.quantity||0}</td>
      <td class="px-3 py-3 text-right text-xs text-slate-600 whitespace-nowrap num">${e.unitCost?fmt(e.unitCost):'—'}</td>
      <td class="px-3 py-3 text-right text-xs font-bold text-slate-700 whitespace-nowrap num">${e.totalCost?fmt(e.totalCost):'—'}</td>
      <td class="px-3 py-3">${exp}</td>
      <td class="px-3 py-3 text-xs text-slate-500 hidden md:table-cell">${esc(e.userName||'')}</td>
    </tr>`;
  }).join('');
}
function daysUntil(dateStr){
  const d=new Date(dateStr+'T00:00:00');
  return Math.ceil((d-new Date(new Date().toDateString()))/864e5);
}
function expiryTag(dateStr){
  const d=daysUntil(dateStr);
  const label=new Date(dateStr+'T00:00:00').toLocaleDateString('es-MX',{day:'2-digit',month:'short',year:'2-digit'});
  const cls = d<0?'badge-low' : d<=EXPIRY_WARN_DAYS?'badge-mid':'badge-ok';
  const extra = d<0?'vencido':`${d} d`;
  return `<span class="text-xs px-2 py-0.5 rounded-full font-medium ${cls} whitespace-nowrap">${label} · ${extra}</span>`;
}
function expiryChip(p){
  const lots=(p.lots||[]).filter(l=>l&&l.expiry);
  if(!lots.length) return '';
  const soon=lots.map(l=>daysUntil(l.expiry)).sort((a,b)=>a-b)[0];
  if(soon>EXPIRY_WARN_DAYS) return '';
  return ` <span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold ${soon<0?'badge-low':'badge-mid'}">${soon<0?'vencido':'caduca en '+soon+'d'}</span>`;
}
function getExpiringLots(){
  const out=[];
  S.products.forEach(p=>(p.lots||[]).forEach(l=>{
    if(l&&l.expiry) out.push({name:p.name, barcode:p.barcode, expiry:l.expiry, qty:l.qty||0, days:daysUntil(l.expiry)});
  }));
  return out.sort((a,b)=>a.days-b.days);
}
function renderExpiryPanel(){
  const el=g('expiryList'); if(!el) return;
  const lots=getExpiringLots();
  const soon=lots.filter(l=>l.days<=EXPIRY_WARN_DAYS);
  if(g('kpiExpiring')) g('kpiExpiring').textContent=soon.length;
  el.innerHTML = lots.length ? lots.slice(0,40).map(l=>`
    <div class="flex items-center justify-between gap-2 border border-slate-200 rounded-xl px-3 py-2">
      <div class="min-w-0">
        <p class="text-xs font-semibold text-slate-800 break-anywhere">${esc(l.name)}</p>
        <p class="text-[10px] text-slate-400 break-anywhere">${l.qty} pza(s) · ${esc(l.barcode)}</p>
      </div>
      ${expiryTag(l.expiry)}
    </div>`).join('')
    : '<p class="text-slate-400 text-xs text-center py-8">Ningún producto tiene fecha de caducidad registrada todavía.</p>';
}
function exportEntriesCSV(){
  if(!S.entries.length){ showToast('No hay entradas para exportar','warning'); return; }
  const h=['Fecha','Código','Producto','Piezas','Costo unitario','Costo total','Caducidad','Proveedor','Registró'];
  const rows=S.entries.map(e=>[tsLabel(e.timestamp,e.tsISO),e.productBarcode||'',e.productName||'',e.quantity||0,e.unitCost||0,e.totalCost||0,e.expiry||'',e.supplier||'',e.userName||'']);
  downloadCSV(h,rows,'entradas_inventario');
}

/* ════════════════════════════════════════════════════════════════
   GASTOS / SALIDAS DE DINERO
════════════════════════════════════════════════════════════════ */
function openExpenseModal(opts={}){
  S.editingExpenseId=null;
  S.expenseCtx={fromShift:!!opts.fromShift};
  g('expenseModalTitle').innerHTML='<i class="fa-solid fa-money-bill-transfer text-red-500 mr-1.5"></i>'+(opts.fromShift?'Salida de efectivo':'Registrar gasto');
  g('ex_amount').value=''; g('ex_concept').value=''; g('ex_supplier').value=''; g('ex_note').value='';
  g('ex_category').value=opts.category||'';
  g('ex_date').value=localDateStr(new Date());
  g('ex_method').value=opts.fromShift?'cash':'cash';
  const row=g('ex_shiftRow');
  const canShift=!!S.currentShift;
  row.classList.toggle('hidden', !canShift);
  row.classList.toggle('flex', canShift);
  g('ex_fromShift').checked=!!opts.fromShift;
  renderExpenseCatChips();
  const dl=g('expCatList');
  if(dl) dl.innerHTML=EXPENSE_CATEGORIES.map(c=>`<option value="${esc(c)}">`).join('');
  hideShiftModal();
  g('expenseModal').classList.remove('hidden');
  setTimeout(()=>g('ex_amount').focus(),150);
}
function hideExpenseModal(){ g('expenseModal')?.classList.add('hidden'); }
function renderExpenseCatChips(){
  const el=g('ex_catChips'); if(!el) return;
  const cur=g('ex_category').value;
  el.innerHTML=EXPENSE_CATEGORIES.map(c=>`
    <button onclick="pickExpenseCat('${esc(c).replace(/'/g,"\\'")}')" class="quick-chip text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${cur===c?'bg-indigo-600 text-white border-indigo-600':'bg-slate-50 text-slate-600 border-slate-200'}">${esc(c)}</button>`).join('');
}
function pickExpenseCat(c){ g('ex_category').value=c; renderExpenseCatChips(); if(!g('ex_concept').value) g('ex_concept').value=c; }
function editExpense(id){
  const e=S.expenses.find(x=>x.id===id); if(!e) return;
  S.editingExpenseId=id; S.expenseCtx={fromShift:false};
  g('expenseModalTitle').innerHTML='<i class="fa-solid fa-pen-to-square text-indigo-500 mr-1.5"></i>Editar gasto';
  g('ex_amount').value=e.amount||''; g('ex_category').value=e.category||''; g('ex_concept').value=e.concept||'';
  g('ex_date').value=e.date||localDateStr(new Date()); g('ex_method').value=e.method||'cash';
  g('ex_supplier').value=e.supplier||''; g('ex_note').value=e.note||'';
  g('ex_shiftRow').classList.add('hidden');
  renderExpenseCatChips();
  g('expenseModal').classList.remove('hidden');
}
async function saveExpense(){
  const amount=parseFloat(g('ex_amount').value);
  const category=g('ex_category').value.trim();
  const concept=g('ex_concept').value.trim();
  const date=g('ex_date').value||localDateStr(new Date());
  if(isNaN(amount)||amount<=0){ showToast('Captura un monto válido','error'); return; }
  if(!category){ showToast('Elige una categoría','error'); return; }
  if(!concept){ showToast('Describe el concepto del gasto','error'); return; }

  const btn=g('ex_saveBtn'); btn.disabled=true;
  const method=g('ex_method').value;
  const d=new Date(date+'T12:00:00');
  const base={
    concept, category, amount, method,
    supplier:g('ex_supplier').value.trim()||null,
    note:g('ex_note').value.trim()||null,
    date, year:d.getFullYear(), month:d.getMonth()+1,
    userId:S.user?.uid||null, userName:S.user?.displayName||S.user?.email||'',
    branchId:S.userBranchId||null, branchName:S.userBranchName||null,
  };

  try{
    if(S.editingExpenseId){
      await db.collection('expenses').doc(S.editingExpenseId).update({...base, updatedAt:FS.FieldValue.serverTimestamp()});
      showToast('Gasto actualizado ✅','success');
    } else {
      const localId=newLocalId();
      const now=new Date();
      const useShift = g('ex_fromShift').checked && S.currentShift && method==='cash';
      const payload={...base, localId, source:'manual', entryId:null,
        shiftId: useShift?S.currentShift.id:null,
        tsISO: now.toISOString(), createdOffline:!isOnline()};
      outboxPush({id:localId, type:'expense', tsISO:payload.tsISO, tries:0, payload, label:`Gasto ${category} ${fmt(amount)}`});
      if(useShift){
        S.currentShift.cashOut=(S.currentShift.cashOut||0)+amount;
        saveLocalShift();
      }
      showToast(isOnline()?'Gasto registrado ✅':'Gasto guardado — se subirá al volver el internet', isOnline()?'success':'warning');
      if(isOnline()) await flushOutbox();
    }
    hideExpenseModal();
    if(g('admin-expenses') && !g('admin-expenses').classList.contains('hidden')) loadExpenses();
  }catch(e){
    showToast('Error: '+e.message,'error');
  }finally{ btn.disabled=false; S.editingExpenseId=null; }
}
async function deleteExpense(id){
  const ok=await confirmAction({title:'¿Eliminar gasto?', msg:'Se quitará del historial y de la gráfica de ganancias.', okLabel:'Eliminar', icon:'🗑️'});
  if(!ok) return;
  try{
    await db.collection('expenses').doc(id).delete();
    showToast('Gasto eliminado','success');
    loadExpenses();
  }catch(e){ showToast('Error: '+e.message,'error'); }
}
async function loadExpenses(){
  const tbody=g('expTableBody');
  tbody.innerHTML='<tr><td colspan="6" class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Cargando…</td></tr>';
  const start=g('expStart').value||'2000-01-01';
  const end=g('expEnd').value||'2999-12-31';
  try{
    const snap=await db.collection('expenses').where('date','>=',start).where('date','<=',end).get();
    S.expenses=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.date+(b.tsISO||'')).localeCompare(String(a.date+(a.tsISO||''))));
    const sel=g('expCatFilter');
    const cats=[...new Set([...EXPENSE_CATEGORIES, ...S.expenses.map(e=>e.category).filter(Boolean)])];
    const cur=sel.value;
    sel.innerHTML='<option value="">Todas las categorías</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value=cur;
    renderExpenses();
  }catch(e){
    tbody.innerHTML='<tr><td colspan="6" class="text-center py-10 text-red-400">Error: '+esc(e.message)+'<br><span class="text-xs text-slate-400">Revisa los permisos de la colección "expenses".</span></td></tr>';
  }
}
const METHOD_LABEL={cash:'Efectivo',transfer:'Transferencia',card:'Tarjeta',credit:'Crédito'};
function renderExpenses(){
  const tbody=g('expTableBody');
  const cat=g('expCatFilter')?.value||'';
  let list=S.expenses;
  if(cat) list=list.filter(e=>e.category===cat);
  const total=list.reduce((a,x)=>a+(x.amount||0),0);
  const cash=list.filter(x=>x.method==='cash').reduce((a,x)=>a+(x.amount||0),0);
  const sup=list.filter(x=>x.source==='inventory'||/proveedor|mercanc/i.test(x.category||'')).reduce((a,x)=>a+(x.amount||0),0);
  g('expTotalEl').textContent=fmt(total);
  g('expCashEl').textContent=fmt(cash);
  g('expSupplierEl').textContent=fmt(sup);
  g('expCountEl').textContent=list.length;
  if(!list.length){ tbody.innerHTML='<tr><td colspan="6" class="text-center py-10 text-slate-400">Sin gastos en este periodo</td></tr>'; }
  else tbody.innerHTML=list.map(e=>`<tr class="hover:bg-slate-50 transition">
      <td class="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">${e.date||''}</td>
      <td class="px-3 py-3 text-xs sm:text-sm font-semibold text-slate-800 max-w-[220px] break-anywhere">${esc(e.concept||'')}
        ${e.supplier?`<span class="block text-[10px] text-slate-400 font-normal">${esc(e.supplier)}</span>`:''}
        ${e.source==='inventory'?'<span class="text-[10px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full font-bold">automático</span>':''}</td>
      <td class="px-3 py-3 text-xs"><span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium whitespace-nowrap">${esc(e.category||'Otros')}</span></td>
      <td class="px-3 py-3 text-center text-xs text-slate-500 hidden md:table-cell">${METHOD_LABEL[e.method]||'—'}</td>
      <td class="px-3 py-3 text-right text-sm font-black text-red-500 whitespace-nowrap num">-${fmt(e.amount||0)}</td>
      <td class="px-3 py-3 text-right whitespace-nowrap">
        <button onclick="editExpense('${e.id}')" class="text-indigo-500 hover:text-indigo-700 text-sm p-1 min-w-[32px] min-h-[32px]"><i class="fa-solid fa-pen-to-square"></i></button>
        <button onclick="deleteExpense('${e.id}')" class="text-red-400 hover:text-red-600 text-sm p-1 min-w-[32px] min-h-[32px] ml-1"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('');
  const byCat={}; list.forEach(e=>{const k=e.category||'Otros'; byCat[k]=(byCat[k]||0)+(e.amount||0);});
  drawExpenseCatChart('chartExpBreakdown', byCat, 'expBreak');
  const legend=g('expCatLegend');
  const entries=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  legend.innerHTML=entries.map(([k,v],i)=>`
    <div class="flex items-center gap-2 text-xs min-w-0">
      <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${EXPENSE_COLORS[i%EXPENSE_COLORS.length]}"></span>
      <span class="flex-1 truncate text-slate-600 min-w-0" title="${esc(k)}">${esc(k)}</span>
      <span class="font-bold text-slate-700 shrink-0 num">${fmt(v)}</span>
      <span class="text-slate-400 w-9 text-right shrink-0 num">${total?((v/total)*100).toFixed(0):0}%</span>
    </div>`).join('') || '<p class="text-xs text-slate-400 text-center">Sin datos</p>';
}
function exportExpensesCSV(){
  if(!S.expenses.length){ showToast('No hay gastos para exportar','warning'); return; }
  const h=['Día','Concepto','Categoría','Monto','Forma de pago','Proveedor','Origen','Registró','Nota'];
  const rows=S.expenses.map(e=>[e.date||'',e.concept||'',e.category||'',e.amount||0,METHOD_LABEL[e.method]||'',e.supplier||'',e.source==='inventory'?'Entrada de inventario':'Manual',e.userName||'',e.note||'']);
  downloadCSV(h,rows,'gastos');
}

/* ── Gráficas de ganancias/gastos ── */
function drawProfitChart(byDate, expByDate, profitByDate){
  const el=g('chartProfit'); if(!el) return;
  const labels=[...new Set([...Object.keys(byDate),...Object.keys(expByDate)])].sort();
  if(S.charts.profit) S.charts.profit.destroy();
  S.charts.profit=new Chart(el.getContext('2d'),{
    type:'bar',
    data:{
      labels:labels.map(l=>{const d=new Date(l+'T00:00:00');return d.toLocaleDateString('es-MX',{day:'2-digit',month:'short'});}),
      datasets:[
        {label:'Ingresos', data:labels.map(l=>byDate[l]||0), backgroundColor:'rgba(99,102,241,.75)', borderRadius:5},
        {label:'Gastos',   data:labels.map(l=>expByDate[l]||0), backgroundColor:'rgba(239,68,68,.75)', borderRadius:5},
        {label:'Ganancia neta', type:'line', data:labels.map(l=>(profitByDate[l]||0)-(expByDate[l]||0)),
         borderColor:'#059669', backgroundColor:'rgba(5,150,105,.15)', tension:.35, fill:true, pointRadius:3}
      ]
    },
    options: (()=>{ const o=baseChartOpts();
      o.plugins.legend={display:true, position:'bottom',
        labels:{boxWidth:10, padding:8, font:{size:chartSmall()?9:11}, usePointStyle:true}};
      return o; })()
  });
}
function drawExpenseCatChart(canvasId, byCat, key){
  const el=g(canvasId); if(!el) return;
  const labels=Object.keys(byCat);
  if(S.charts[key]) S.charts[key].destroy();
  if(!labels.length){
    const ctx=el.getContext('2d'); ctx.clearRect(0,0,el.width,el.height); return;
  }
  S.charts[key]=new Chart(el.getContext('2d'),{
    type:'doughnut',
    data:{labels, datasets:[{data:labels.map(l=>byCat[l]), backgroundColor:labels.map((_,i)=>EXPENSE_COLORS[i%EXPENSE_COLORS.length]), borderWidth:0}]},
    options:{
      responsive:true, maintainAspectRatio:false, resizeDelay:120, cutout:'62%',
      layout:{padding:4},
      plugins:{
        legend:{ position:'bottom',
          labels:{boxWidth:10, padding:6, font:{size:chartSmall()?9:10}, usePointStyle:true,
            generateLabels:(ch)=>{
              const d=ch.data;
              return d.labels.map((l,i)=>({
                text: l.length>16?l.slice(0,15)+'…':l,
                fillStyle:d.datasets[0].backgroundColor[i],
                strokeStyle:d.datasets[0].backgroundColor[i],
                pointStyle:'circle', hidden:false, index:i
              }));
            }}},
        tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)}`}}
      }
    }
  });
}

/* ── CSV helper ── */
function downloadCSV(headers, rows, name){
  const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=name+'_'+localDateStr(new Date())+'.csv'; a.click();
}

/* ── Ayuda visual del margen en el alta de productos ── */
function updateMarginHint(){
  const el=g('pf_marginHint'); if(!el) return;
  const price=parseFloat(g('pf_price').value)||0;
  const cost=parseFloat(g('pf_cost').value)||0;
  if(!cost){ el.textContent='—'; el.className='text-sm font-black text-slate-300'; return; }
  const m=price-cost;
  el.textContent=fmt(m)+(price?` · ${((m/price)*100).toFixed(0)}%`:'');
  el.className='text-sm font-black '+(m>=0?'text-emerald-600':'text-red-500');
}

/* ════════════════════════════════════
   UTILITIES
════════════════════════════════════ */
const g   = id => document.getElementById(id);
const fmt = n  => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(n||0);
const esc = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const delay= ms=> new Promise(r=>setTimeout(r,ms));
function show(id){ g(id)?.classList.remove('hidden'); }
function hide(id){ g(id)?.classList.add('hidden'); }

let _tt;
function showToast(msg,type='info'){
  const toast=g('toast'),inner=g('toastInner'),icon=g('toastIcon');
  g('toastMsg').textContent=msg;
  const C={success:{cls:'fa-solid fa-circle-check text-emerald-500',bg:'bg-emerald-50 border-emerald-200'},error:{cls:'fa-solid fa-circle-xmark text-red-500',bg:'bg-red-50 border-red-200'},info:{cls:'fa-solid fa-circle-info text-blue-500',bg:'bg-blue-50 border-blue-200'},warning:{cls:'fa-solid fa-triangle-exclamation text-yellow-500',bg:'bg-yellow-50 border-yellow-200'}};
  const c=C[type]||C.info;
  icon.className=c.cls+' text-lg w-5 text-center shrink-0';
  inner.className=`flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl border min-w-[240px] max-w-[calc(100vw-2rem)] ${c.bg}`;
  toast.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>toast.classList.remove('show'),3500);
}

/* ════════════════════════════════════
   KEYBOARD SHORTCUTS
════════════════════════════════════ */
document.addEventListener('keydown',e=>{
  if(window._displayMode) return; // customer screen: no shortcuts
  if(e.ctrlKey&&e.shiftKey&&e.key==='A'){e.preventDefault(); S.isAdmin?openAdmin():showLoginModal();}
  if(e.key==='Escape'){
    hideLoginModal(); closeScanModal(); hidePayModal(); hideProductModal(); hideSellerModal(); hideSaleDetail();
    hideDiscountModal(); hideParkedModal(); hideReceiptModal(); hideShiftModal(); hideHardwareModal(); hideStockAlerts();
    hideBranchModal(); hideReassignBranchModal(); hideCarrierModal(); hideRechargeModal();
    hideEntryModal(); hideExpenseModal(); hideShiftDetail(); hideSyncModal();
    if(!g('confirmModal').classList.contains('hidden')) _confirmResolve(false);
    closeMobileCart();
  }
  /* Cashier speed shortcuts (only meaningful while logged in, not while typing in an input) */
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if((S.isSeller||S.isAdmin) && !typing){
    if(e.key==='F2'){ e.preventDefault(); g('searchInput')?.focus(); }
    if(e.key==='F4'){ e.preventDefault(); if(S.cart.length) showPaymentModal(); }
    if(e.key==='F8'){ e.preventDefault(); clearCart(); }
  }
});

/* ════════════════════════════════════
   INIT
════════════════════════════════════ */
document.addEventListener('DOMContentLoaded',()=>{
  const today=new Date().toISOString().split('T')[0];
  const week =new Date(Date.now()-7*864e5).toISOString().split('T')[0];
  g('histEnd').value=today; g('histStart').value=week;

  const monthStart=new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
  ['entStart','expStart'].forEach(id=>{ if(g(id)) g(id).value=monthStart; });
  ['entEnd','expEnd'].forEach(id=>{ if(g(id)) g(id).value=today; });

  initNetwork();          // estado de conexión + cola de sincronización
  restoreLocalProducts(); // catálogo guardado en el dispositivo (arranque sin internet)
  restoreLocalShift();    // turno abierto guardado localmente
  /* subscribeProducts / subscribeBranches / subscribeCarriers / initTerminal
     escuchan colecciones que viven DENTRO de un negocio. Arrancan desde
     resolverNegocio(), cuando ya sabemos cuál es. */
  checkPhoneMode();
  checkCustomerDisplayMode();
  initClock();
  initHardwareScanner();
  initResponsive();
});

/* ── Ajustes al girar el teléfono o cambiar de tamaño ── */
let _rsTimer=null;
function initResponsive(){
  const onResize=()=>{
    clearTimeout(_rsTimer);
    _rsTimer=setTimeout(()=>{
      Object.values(S.charts||{}).forEach(c=>{ try{ c.resize(); }catch(e){} });
      /* Si el carrito lateral quedó abierto y pasamos a móvil (o al revés) */
      const backdropOpen = !g('cartBackdrop')?.classList.contains('hidden');
      if(backdropOpen){ closeMobileCart(); }
    }, 180);
  };
  window.addEventListener('resize', onResize, {passive:true});
  window.addEventListener('orientationchange', onResize, {passive:true});
  if(window.visualViewport) window.visualViewport.addEventListener('resize', onResize, {passive:true});
}