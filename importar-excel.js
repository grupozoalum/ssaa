/* ════════════════════════════════════════════════════════════════
   IMPORTAR PRODUCTOS DESDE EXCEL (eleventa u otro sistema)
   Admin → Productos → «Importar Excel». Solo el dueño.

   - El archivo se lee AQUÍ, en el navegador (librería SheetJS):
     no se sube a ningún servidor ni se manda a nadie.
   - Las columnas se detectan solas por su encabezado (Código,
     Descripción, Precio Venta…). Si alguna no se reconoce, el dueño
     la elige de una lista antes de importar.
   - Los productos se guardan en negocios/{TENANT}/products/{código},
     en lotes de 400, igual que si se dieran de alta a mano.

   Cárgalo DESPUÉS de app.js:
     <script src="importar-excel.js?v=..."></script>
   Usa de app.js: S, TENANT, db, dbRoot, FS, g, esc, fmt, showToast,
   beep, confirmAction, sinAcentos, round3, redondear2, isOnline,
   withTimeout, loadProducts.
════════════════════════════════════════════════════════════════ */

const IMP_LIB  = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const IMP_LOTE = 400;
const IMP_MAX_MB = 25;

/* Campos de tu POS y cómo suelen llamarse en eleventa y otros sistemas.
   Los encabezados se comparan sin acentos, sin espacios y en minúsculas
   ("Precio Venta" → "precioventa"). Gana el primer patrón que coincida. */
const IMP_CAMPOS = [
  { k:'barcode',  t:'Código de barras',      req:true,
    pats:[/^codigo$/, /^codigodebarras$/, /codigobarras/, /^clave$/, /^sku$/, /^codigo/, /^code/] },
  { k:'name',     t:'Nombre / descripción',  req:true,
    pats:[/^descripcion$/, /^nombre$/, /^producto$/, /descripcion/, /nombre/, /articulo/] },
  { k:'price',    t:'Precio de venta',       req:true,
    pats:[/^precioventa$/, /^preciodeventa$/, /^pventa$/, /^precio1$/, /preciopublico/, /precio.*venta/, /^precio$/] },
  { k:'cost',     t:'Costo',
    pats:[/^preciocosto$/, /^preciodecosto$/, /^pcosto$/, /^costo$/, /costo/] },
  { k:'stock',    t:'Existencia',
    pats:[/^existencias?$/, /^existenciaactual$/, /^inventario$/, /^inventarioactual$/, /^stock$/, /^cantidad$/] },
  { k:'category', t:'Departamento / categoría',
    pats:[/^departamento$/, /^depto$/, /^categoria$/, /departamento/, /categoria/, /^familia$/, /^linea$/] },
  { k:'bulk',     t:'Se vende por (granel)',
    pats:[/^sevendepor$/, /^tipodeventa$/, /^tipoventa$/, /^unidaddeventa$/, /granel/, /^unidad$/, /unidadmedida/] },
];
/* El costo se busca ANTES que el precio, para que "Precio Costo" no se confunda con el de venta */
const IMP_ORDEN = ['barcode','name','cost','price','stock','category','bulk'];

const IMP = { filas:null, encabezado:0, columnas:[], mapa:{}, registros:[], resumen:null,
              archivo:'', hoja:'', ocupado:false };

const impNorm  = t => sinAcentos(t).replace(/[^a-z0-9]/g, '');
const impLetra = i => { let s = ''; i++; while(i > 0){ const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const impMiles = n => Number(n).toLocaleString('es-MX');

/* La librería se descarga solo la primera vez que se usa el importador */
function cargarLectorExcel(){
  if(window.XLSX) return Promise.resolve();
  if(IMP._cargando) return IMP._cargando;
  IMP._cargando = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = IMP_LIB; s.async = true;
    s.onload = () => res();
    s.onerror = () => { IMP._cargando = null; rej(new Error('No se pudo cargar el lector de Excel. Revisa tu internet.')); };
    document.head.appendChild(s);
  });
  return IMP._cargando;
}

/* ════════════════════════════════════
   ABRIR / CERRAR / PASOS
════════════════════════════════════ */
function abrirImportador(){
  if(!S.isAdmin){ showToast('Solo el dueño puede importar productos','error'); return; }
  impPaso(1);
  g('imp_file').value = '';
  g('importModal').classList.remove('hidden');
  cargarLectorExcel().catch(() => {});   // se precarga mientras eligen el archivo
}
function cerrarImportador(){
  if(IMP.ocupado){ showToast('Espera a que termine la importación','warning'); return; }
  g('importModal').classList.add('hidden');
  IMP.filas = null; IMP.registros = [];   // no se queda el inventario en memoria
}
function impPaso(n){ [1,2,3].forEach(i => g('imp_paso' + i).classList.toggle('hidden', i !== n)); }

/* ════════════════════════════════════
   1) LEER EL ARCHIVO (en el navegador)
════════════════════════════════════ */
async function impLeerArchivo(input){
  const f = input.files && input.files[0]; if(!f) return;
  if(f.size > IMP_MAX_MB * 1024 * 1024){ showToast('El archivo es muy grande (máx. ' + IMP_MAX_MB + ' MB)','error'); input.value=''; return; }
  g('imp_leyendo').classList.remove('hidden');
  try{
    await cargarLectorExcel();
    const wb = XLSX.read(await f.arrayBuffer(), { type:'array' });
    /* Se usa la hoja con más renglones (eleventa exporta una sola) */
    let mejor = null;
    wb.SheetNames.forEach(nom => {
      const filas = XLSX.utils.sheet_to_json(wb.Sheets[nom], { header:1, raw:true, defval:'', blankrows:false });
      if(!mejor || filas.length > mejor.filas.length) mejor = { nom, filas };
    });
    if(!mejor || mejor.filas.length < 2) throw new Error('el archivo no tiene renglones de productos');
    IMP.archivo = f.name; IMP.hoja = mejor.nom; IMP.filas = mejor.filas;
    impDetectar();
    impPaso(2);
    impPintar();
  }catch(e){
    console.error('Importar Excel:', e);
    showToast('No se pudo leer el archivo: ' + e.message,'error'); beep('error');
  }finally{
    g('imp_leyendo').classList.add('hidden');
    input.value = '';
  }
}

/* Encuentra el renglón de encabezados y adivina qué columna es cada dato */
function impDetectar(){
  const filas = IMP.filas;
  let enc = 0, mejor = -1;
  for(let i = 0; i < Math.min(15, filas.length); i++){
    const hs = (filas[i] || []).map(impNorm);
    const puntos = IMP_CAMPOS.reduce((s, c) => s + (hs.some(h => h && c.pats.some(p => p.test(h))) ? 1 : 0), 0);
    if(puntos > mejor){ mejor = puntos; enc = i; }
  }
  IMP.encabezado = enc;
  const ancho = Math.max(1, ...filas.slice(enc, enc + 300).map(r => (r || []).length));
  IMP.columnas = Array.from({ length: ancho }, (_, i) => ({
    i, nombre: String((filas[enc] || [])[i] ?? '').trim() || ('Columna ' + impLetra(i))
  }));

  IMP.mapa = {};
  const usadas = new Set();
  IMP_ORDEN.forEach(k => {
    const campo = IMP_CAMPOS.find(c => c.k === k);
    IMP.mapa[k] = -1;
    for(const p of campo.pats){
      const col = IMP.columnas.find(c => !usadas.has(c.i) && p.test(impNorm(c.nombre)));
      if(col){ IMP.mapa[k] = col.i; usadas.add(col.i); break; }
    }
  });
}

/* ════════════════════════════════════
   2) CONVERTIR RENGLONES EN PRODUCTOS
════════════════════════════════════ */
function impNum(v){
  if(typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[$\s,]/g, '');
  if(!s) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
/* Excel guarda muchos códigos como número: 7501055300075 → "7501055300075" */
function impCodigo(v){
  if(typeof v === 'number') return isFinite(v) ? (Number.isInteger(v) ? String(v) : String(v)) : '';
  return String(v ?? '').trim();
}
/* eleventa: "Granel" / "G" = por peso; "Unidad" / "U" / "Paquete" / "P" = por pieza */
function impGranel(v){
  const s = impNorm(v);
  return !!s && (s === 'g' || s.startsWith('granel') || s === 'kg' || s.includes('kilo') || s === 'peso');
}
/* Firestore no admite "/" en el nombre de un documento */
const impCodigoValido = c => !!c && c.length <= 200 && !c.includes('/') && c !== '.' && c !== '..' && !/^__.*__$/.test(c);

function impConstruir(){
  const m = IMP.mapa;
  const cel = (r, k) => m[k] >= 0 ? r[m[k]] : '';
  const existentes = new Set((S.productsRaw || []).map(p => p.barcode));
  const porCodigo = new Map();
  const R = { total:0, sinDatos:0, codigoInvalido:0, duplicados:0, sinPrecio:0, negativos:0, nuevos:0, existentes:0 };

  if(m.barcode >= 0 && m.name >= 0){
    IMP.filas.slice(IMP.encabezado + 1).forEach(r => {
      if(!r || r.every(v => String(v ?? '').trim() === '')) return;
      R.total++;
      const code = impCodigo(cel(r, 'barcode'));
      const name = String(cel(r, 'name') ?? '').trim();
      if(!code || !name){ R.sinDatos++; return; }
      if(!impCodigoValido(code)){ R.codigoInvalido++; return; }
      if(porCodigo.has(code)) R.duplicados++;
      porCodigo.set(code, {
        code,
        name: name.slice(0, 200),
        price: impNum(cel(r, 'price')),
        cost: impNum(cel(r, 'cost')),
        stock: impNum(cel(r, 'stock')),
        category: String(cel(r, 'category') ?? '').trim().slice(0, 60),
        isBulk: impGranel(cel(r, 'bulk')),
      });
    });
  } else {
    R.total = Math.max(0, IMP.filas.length - IMP.encabezado - 1);
  }

  IMP.registros = [...porCodigo.values()];
  IMP.registros.forEach(x => {
    x.existe = existentes.has(x.code);
    if(x.existe) R.existentes++; else R.nuevos++;
    if(!(x.price > 0)) R.sinPrecio++;
    if(x.stock !== null && x.stock < 0) R.negativos++;
  });
  IMP.resumen = R;
}

/* Cómo queda cada producto en Firestore (mismos campos que el alta manual) */
function impDatos(x, conStock){
  const d = {
    name: x.name,
    price: x.price > 0 ? redondear2(x.price) : 0,
    category: x.category || 'General',
    isBulk: !!x.isBulk,
    active: x.price > 0,              // sin precio se importa desactivado: no se puede vender en $0
    updatedAt: FS.FieldValue.serverTimestamp(),
    importadoDe: 'excel',
  };
  if(x.cost !== null && x.cost >= 0) d.cost = redondear2(x.cost);
  /* Sin existencia en el archivo NO se pone 0 (quedaría "Agotado"):
     el producto queda sin control de inventario y se puede vender. */
  if(conStock && x.stock !== null) d.stock = x.isBulk ? round3(Math.max(0, x.stock)) : Math.max(0, Math.round(x.stock));
  if(!x.existe){ d.createdAt = FS.FieldValue.serverTimestamp(); d.favorite = false; }
  return d;
}

/* ════════════════════════════════════
   PANTALLA DE REVISIÓN
════════════════════════════════════ */
function impCambiarMapa(sel){ IMP.mapa[sel.dataset.k] = Number(sel.value); impPintar(); }

function impPintar(){
  impConstruir();
  const R = IMP.resumen, m = IMP.mapa;
  const actualizar = g('imp_actualizar').checked;
  const hayStock = m.stock >= 0;
  g('imp_stock').disabled = !hayStock;
  g('imp_stockRow').classList.toggle('opacity-50', !hayStock);
  const conStock = hayStock && g('imp_stock').checked;

  g('imp_archivo').textContent = `${IMP.archivo} · hoja «${IMP.hoja}» · ${impMiles(R.total)} renglones`;

  g('imp_mapa').innerHTML = IMP_CAMPOS.map(c => `
    <label class="block">
      <span class="text-[11px] font-semibold ${c.req && m[c.k] < 0 ? 'text-red-600' : 'text-slate-500'}">${c.t}${c.req ? ' *' : ''}</span>
      <select data-k="${c.k}" onchange="impCambiarMapa(this)"
        class="w-full border ${c.req && m[c.k] < 0 ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'} rounded-lg px-2 py-2 text-xs min-h-[40px]">
        <option value="-1">— No usar —</option>
        ${IMP.columnas.map(col => `<option value="${col.i}" ${m[c.k] === col.i ? 'selected' : ''}>${impLetra(col.i)} · ${esc(col.nombre).slice(0, 40)}</option>`).join('')}
      </select>
    </label>`).join('');

  const aImportar = IMP.registros.filter(x => actualizar || !x.existe);
  const chip = (txt, cls) => `<span class="text-[11px] font-semibold px-2.5 py-1 rounded-full ${cls}">${txt}</span>`;
  g('imp_resumen').innerHTML = [
    chip(impMiles(R.nuevos) + ' nuevos', 'bg-emerald-100 text-emerald-700'),
    R.existentes ? chip(impMiles(R.existentes) + (actualizar ? ' se actualizan' : ' ya existen (se saltan)'), 'bg-indigo-100 text-indigo-700') : '',
    R.sinPrecio ? chip(impMiles(R.sinPrecio) + ' sin precio → desactivados', 'bg-amber-100 text-amber-700') : '',
    R.negativos && conStock ? chip(impMiles(R.negativos) + ' con existencia negativa → 0', 'bg-amber-100 text-amber-700') : '',
    R.duplicados ? chip(impMiles(R.duplicados) + ' códigos repetidos (queda el último)', 'bg-slate-100 text-slate-600') : '',
    R.sinDatos ? chip(impMiles(R.sinDatos) + ' sin código o nombre (se omiten)', 'bg-slate-100 text-slate-600') : '',
    R.codigoInvalido ? chip(impMiles(R.codigoInvalido) + ' con «/» en el código (se omiten)', 'bg-red-100 text-red-600') : '',
  ].join('');

  g('imp_preview').innerHTML = IMP.registros.slice(0, 8).map(x => `
    <tr class="border-t border-slate-100">
      <td class="px-2 py-1.5 font-mono">${esc(x.code)}</td>
      <td class="px-2 py-1.5 break-anywhere">${esc(x.name)}</td>
      <td class="px-2 py-1.5 text-right num">${x.price > 0 ? fmt(x.price) : '<span class="text-amber-600">—</span>'}</td>
      <td class="px-2 py-1.5 text-right num">${x.cost !== null ? fmt(x.cost) : '—'}</td>
      <td class="px-2 py-1.5 text-right num">${conStock && x.stock !== null ? (x.isBulk ? round3(Math.max(0, x.stock)) + ' kg' : Math.max(0, Math.round(x.stock))) : '—'}</td>
      <td class="px-2 py-1.5">${esc(x.category || 'General')}</td>
      <td class="px-2 py-1.5">${x.isBulk ? 'Granel' : 'Pieza'}</td>
      <td class="px-2 py-1.5">${x.existe ? '<span class="text-indigo-600">Ya existe</span>' : '<span class="text-emerald-600">Nuevo</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="px-2 py-6 text-center text-slate-400">Elige las columnas de código y nombre para ver la vista previa.</td></tr>';

  const faltan = IMP_CAMPOS.filter(c => c.req && m[c.k] < 0).map(c => c.t);
  const aviso = g('imp_aviso');
  aviso.textContent = faltan.length ? 'Falta elegir: ' + faltan.join(', ') + '.' : '';
  aviso.classList.toggle('hidden', !faltan.length);

  const btn = g('imp_btn');
  btn.disabled = !!faltan.length || !aImportar.length;
  btn.innerHTML = `<i class="fa-solid fa-file-import mr-1.5"></i>Importar ${impMiles(aImportar.length)} producto${aImportar.length === 1 ? '' : 's'}`;
}

/* ════════════════════════════════════
   3) GUARDAR EN EL INVENTARIO DEL NEGOCIO
════════════════════════════════════ */
async function impImportar(){
  if(IMP.ocupado) return;
  if(!S.isAdmin){ showToast('Solo el dueño puede importar productos','error'); return; }
  const actualizar = g('imp_actualizar').checked;
  const conStock = IMP.mapa.stock >= 0 && g('imp_stock').checked;
  const lista = IMP.registros.filter(x => actualizar || !x.existe);
  if(!lista.length){ showToast('No hay productos para importar','warning'); return; }
  if(!isOnline()){ showToast('Necesitas internet para importar productos','error'); return; }

  const nuevos = lista.filter(x => !x.existe).length, act = lista.length - nuevos;
  const ok = await confirmAction({
    title: `¿Importar ${impMiles(lista.length)} productos?`,
    msg: `${impMiles(nuevos)} nuevos` + (act ? ` y ${impMiles(act)} que ya tenías se actualizan con los datos del Excel` : '') + '.'
       + (conStock ? '\n\nLas existencias del archivo reemplazan a las actuales.' : ''),
    okLabel: 'Importar', icon: '📥'
  });
  if(!ok) return;

  IMP.ocupado = true;
  impPaso(3);
  g('imp_fin').classList.add('hidden');
  g('imp_progNota').classList.remove('hidden');
  let hechos = 0, fallidos = 0, error = '';
  const pintarAvance = () => {
    const pct = Math.round((hechos + fallidos) / lista.length * 100);
    g('imp_barra').style.width = pct + '%';
    g('imp_prog').textContent = `Guardando ${impMiles(hechos + fallidos)} de ${impMiles(lista.length)}…`;
  };
  pintarAvance();

  for(let i = 0; i < lista.length; i += IMP_LOTE){
    const parte = lista.slice(i, i + IMP_LOTE);
    const lote = dbRoot.batch();
    parte.forEach(x => lote.set(db.collection('products').doc(x.code), impDatos(x, conStock), { merge:true }));
    try{
      await withTimeout(lote.commit(), 90000);
      hechos += parte.length;
    }catch(e){
      console.error('Importar lote:', e);
      fallidos += parte.length;
      error = e.code === 'permission-denied'
        ? 'Firebase no dio permiso para guardar productos (revisa que el negocio esté activo).'
        : (e.message === 'timeout' ? 'La conexión está lenta; algunos lotes pueden terminar de guardarse solos en unos minutos.' : e.message);
      if(e.code === 'permission-denied') { fallidos = lista.length - hechos; break; }
    }
    pintarAvance();
  }

  IMP.ocupado = false;
  g('imp_progNota').classList.add('hidden');
  g('imp_barra').style.width = '100%';
  g('imp_prog').textContent = fallidos ? 'Importación terminada con problemas' : 'Importación terminada';
  g('imp_fin').innerHTML = `
    <div class="rounded-xl p-4 border ${fallidos ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}">
      <p class="font-bold ${fallidos ? 'text-amber-800' : 'text-emerald-800'}">
        <i class="fa-solid ${fallidos ? 'fa-triangle-exclamation' : 'fa-circle-check'} mr-1"></i>${impMiles(hechos)} productos guardados${fallidos ? ` · ${impMiles(fallidos)} sin guardar` : ''}
      </p>
      ${error ? `<p class="text-xs text-amber-700 mt-1">${esc(error)}</p>` : ''}
      ${IMP.resumen.sinPrecio ? `<p class="text-xs text-slate-600 mt-1">${impMiles(IMP.resumen.sinPrecio)} productos no traían precio: quedaron desactivados. Ponles precio en Productos para poder venderlos.</p>` : ''}
    </div>
    <button onclick="cerrarImportador()" class="w-full mt-3 bg-slate-900 hover:bg-slate-800 text-white py-3 rounded-xl font-bold text-sm min-h-[48px]">Listo</button>`;
  g('imp_fin').classList.remove('hidden');
  beep(fallidos ? 'error' : 'success');
  showToast(`${impMiles(hechos)} productos importados`, fallidos ? 'warning' : 'success');
  if(g('admin-products') && !g('admin-products').classList.contains('hidden')){ try{ loadProducts(); }catch(e){} }
}
