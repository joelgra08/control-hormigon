/* ===========================================================
   app.js — Lógica principal de la app de Control de Hormigón
   Modelo: un Remito (encabezado: proveedor, hormigón, camión,
   horarios, probetas) puede tener una o varias Líneas (elementos
   a los que se aplicó ese hormigón).
   =========================================================== */

const APP_VERSION = "2.7.2";

const state = {
  miPerfil: null, // { nombre, puesto, rol } de la persona logueada
  obraId: null,
  planDia: [],
  planFecha: null,
  obras: [],
  catalogo: { elementos: [], hormigones: [], proveedores: [], cuadrillas: [], colocacion: [], equipos: [] },
  personal: [],     // nómina (nombre, apellido, cargo, equipo)
  remitos: [],      // encabezados
  lineas: [],       // todas las líneas de la obra
  diasExtra: [],
  personalMensual: [],
  pedidosHierro: [],      // encabezados de pedidos de hierro (con factura adjunta)
  pedidoHierroLineas: [], // todos los ítems (barra/perfil) de todos los pedidos de la obra
  editingRemitoId: null,
  editingHierroId: null,
  lineasForm: [],   // líneas que se están armando/editando en el formulario actual
  editingLineaIdx: null, // índice dentro de lineasForm que se está editando (o null = nueva)
  lineasHierroForm: [],       // ítems que se están armando/editando para el pedido de hierro actual
  facturasHierroForm: [],     // facturas ya subidas que va a quedar con el pedido actual (sin contar las que se agreguen recién al guardar)
  editingLineaHierroIdx: null, // índice dentro de lineasHierroForm que se está editando (o null = nuevo)
  tarjetaFecha: todayISO(),
  resumenMes: new Date().toISOString().slice(0, 7),
  probetasFiltro: { desde: "", hasta: "" },
  filtro: { desde: "", hasta: "", elementoId: "", proveedorId: "" },
  hierroFiltro: { desde: "", hasta: "" },
  programacion: [],             // llenados programados (ver programacion.js)
  programacionDisponible: true, // false si la tabla todavía no existe en el servidor
  prog: { zona: "TORRE", desde: progHoy(), hasta: progSumarDias(progHoy(), 13), editingId: null },
};

// Filas actualmente en modo edición en las tablas de Referencias / Personal.
// Se guarda afuera del ciclo de render para que sobreviva a un re-render del panel.
const editingRows = {};
function isEditingRow(store, id) { return !!(editingRows[store] && editingRows[store].has(id)); }
function setEditingRow(store, id, on) {
  if (!editingRows[store]) editingRows[store] = new Set();
  if (on) editingRows[store].add(id); else editingRows[store].delete(id);
}

// ---------- Indicador de guardado ----------
function markSaved() {
  const elSave = document.getElementById("saveStatus");
  if (!elSave) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  elSave.textContent = `✓ Guardado ${hh}:${mm}:${ss}`;
  elSave.classList.add("flash");
  clearTimeout(elSave._flashTimer);
  elSave._flashTimer = setTimeout(() => elSave.classList.remove("flash"), 900);
}

// ---------- Utilidades ----------
function fmtM3(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return Number(n).toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  return (n * 100).toLocaleString("es-UY", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}
function fmtFechaCorta(iso) {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function byId(arr, id) {
  return arr.find((x) => x.id === id) || null;
}
function findByField(arr, field, value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  return arr.find((x) => String(x[field] || "").trim().toLowerCase() === v) || null;
}
function $(sel, root = document) {
  return root.querySelector(sel);
}
function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    const isPrimitive = typeof c === "string" || typeof c === "number";
    e.appendChild(isPrimitive ? document.createTextNode(String(c)) : c);
  }
  return e;
}

let toastTimer = null;
function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTimer);
  // Los avisos de error quedan un poco más de tiempo en pantalla: si pasa
  // justo antes de un aviso de "listo", no queremos que se tape enseguida.
  toastTimer = setTimeout(() => (t.className = "toast"), type === "error" ? 5500 : 2600);
}

// ---------- Carga de datos por obra ----------
async function loadObras() {
  state.obras = (await DB.getAll("obras")).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function migrarRemitosLegacy(obraId) {
  // Estas 4 funciones de compatibilidad ("migrar.../asegurar...") solo las
  // tiene que correr el Administrador: son parches de datos (escrituras) y
  // el resto de los roles no tiene permiso para escribir en estas tablas —
  // además, un rol con la lectura restringida (ej. Probetas) puede ver "0
  // filas" simplemente porque no tiene permiso para verlas, no porque estén
  // vacías de verdad, y no hay que confundir una cosa con la otra.
  if (!esAdmin()) return;
  // Compatibilidad: si quedó algún remito del formato viejo (todo en un solo
  // registro, sin líneas separadas), lo partimos en encabezado + 1 línea.
  const remitosCrudos = await DB.getAll("remitos");
  const legacy = remitosCrudos.filter((r) => r.obraId === obraId && (r.elementoId !== undefined || r.volumen !== undefined));
  for (const r of legacy) {
    const linea = {
      id: uid("lin"),
      remitoId: r.id,
      obraId,
      elementoId: r.elementoId || "",
      nomenclatura: r.nomenclatura || "",
      sector: r.sector || "",
      asentamiento: r.asentamiento ?? null,
      nivelFondo: r.nivelFondo ?? null,
      largoCm: r.largoCm ?? null,
      anchoCm: r.anchoCm ?? null,
      alturaCm: r.alturaCm ?? null,
      areaM2: r.areaM2 ?? null,
      volumen: r.volumen ?? null,
      cuadrillaId: r.cuadrillaId || "",
      bombeado: !!r.bombeado,
      colocacionId: r.colocacionId || "",
      observaciones: r.observaciones || "",
    };
    await DB.put("remitoLineas", linea);
    const header = {
      id: r.id,
      obraId,
      fecha: r.fecha,
      proveedorId: r.proveedorId || "",
      hormigonId: r.hormigonId || "",
      remitoNro: r.remitoNro || "",
      m3Remito: r.m3Remito ?? null,
      unidadMovil: r.unidadMovil || "",
      horaAObra: r.horaAObra || "",
      horaEnObra: r.horaEnObra || "",
      horaDescarga: r.horaDescarga || "",
      horaFinDescarga: r.horaFinDescarga || "",
      probeta1: r.probeta1 || null,
      probeta2: r.probeta2 || null,
      probeta3: r.probeta3 || null,
    };
    await DB.put("remitos", header);
  }
}

// Compatibilidad: obras creadas antes de que existiera el catálogo de
// Equipos (v1.3.2) no tienen ninguna fila en "catalogoEquipos" todavía. Acá
// se las sembramos con los 4 equipos de siempre (Torre/Basamento/Herreros/
// Indirectos) la primera vez, y de paso migramos el personal que tenía
// cargado el código viejo ("TORRE", etc. literal) para que apunte al id
// real del nuevo catálogo — así no se pierde ni se desordena nada.
async function asegurarCatalogoEquipos(obraId) {
  if (!esAdmin()) return;
  const existentes = (await DB.getAll("catalogoEquipos")).filter((e) => e.obraId === obraId);
  if (existentes.length > 0) return;
  const nuevos = catalogoEquiposBase().map((e) => ({ ...e, obraId }));
  await DB.bulkPut("catalogoEquipos", nuevos);
  const porRol = {};
  nuevos.forEach((e) => { porRol[e.rol] = e.id; });
  const personalObra = (await DB.getAll("personal")).filter((p) => p.obraId === obraId);
  for (const p of personalObra) {
    if (porRol[p.equipo]) {
      p.equipo = porRol[p.equipo];
      await DB.put("personal", p);
    }
  }
}

// Compatibilidad: elementos del catálogo cargados antes de v1.3.2 no tienen
// todavía "permiteModificado" ni "pagaPorM2". Les aplicamos el valor por
// defecto (según el nombre: Cabezal/Riostra => permiteModificado, Contrapiso
// => pagaPorM2) una sola vez; si el usuario ya los editó a mano (el campo
// ya existe, aunque sea en false) no se vuelve a tocar.
async function migrarFlagsElementos(obraId) {
  if (!esAdmin()) return;
  const elementos = (await DB.getAll("catalogoElementos")).filter((e) => e.obraId === obraId);
  for (const e of elementos) {
    if (e.permiteModificado !== undefined && e.pagaPorM2 !== undefined) continue;
    const nombre = (e.nombre || "").toLowerCase();
    const permiteModificado = e.permiteModificado !== undefined ? e.permiteModificado : (nombre.includes("cabezal") || nombre.includes("riostra"));
    const pagaPorM2 = e.pagaPorM2 !== undefined ? e.pagaPorM2 : nombre.includes("contrapiso");
    await DB.put("catalogoElementos", { ...e, permiteModificado, pagaPorM2 });
  }
}

// Compatibilidad: una obra que existe en el servidor pero todavía no tiene
// ningún elemento cargado en su catálogo (ej. una obra recién creada desde
// el panel de Supabase, sin pasar por el formulario de "Nueva obra") se
// siembra una sola vez con el catálogo base de Summit, para que no aparezca
// vacía la primera vez que alguien entra.
async function asegurarCatalogoBase(obraId) {
  if (!esAdmin()) return;
  const elementos = (await DB.getAll("catalogoElementos")).filter((e) => e.obraId === obraId);
  if (elementos.length > 0) return;
  await seedObraCatalogoSummit(obraId);
}

async function loadObraData(obraId) {
  await migrarRemitosLegacy(obraId);
  await asegurarCatalogoBase(obraId);
  await asegurarCatalogoEquipos(obraId);
  await migrarFlagsElementos(obraId);
  const [elementos, hormigones, proveedores, cuadrillas, colocacion, equipos, remitos, lineas, diasExtra, personalMensual, personal, pedidosHierro, pedidoHierroLineas] = await Promise.all([
    DB.getAll("catalogoElementos"),
    DB.getAll("catalogoHormigones"),
    DB.getAll("catalogoProveedores"),
    DB.getAll("catalogoCuadrillas"),
    DB.getAll("catalogoColocacion"),
    DB.getAll("catalogoEquipos"),
    DB.getAll("remitos"),
    DB.getAll("remitoLineas"),
    DB.getAll("diasExtra"),
    DB.getAll("personalMensual"),
    DB.getAll("personal"),
    DB.getAll("pedidosHierro"),
    DB.getAll("pedidoHierroLineas"),
  ]);
  const f = (arr) => arr.filter((x) => x.obraId === obraId);
  state.catalogo.elementos = f(elementos);
  state.catalogo.hormigones = f(hormigones);
  state.catalogo.proveedores = f(proveedores);
  state.catalogo.cuadrillas = f(cuadrillas);
  state.catalogo.colocacion = f(colocacion);
  state.catalogo.equipos = f(equipos);
  state.remitos = f(remitos).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  state.lineas = lineas.filter((l) => byId(state.remitos, l.remitoId) || l.obraId === obraId);
  state.diasExtra = f(diasExtra);
  state.personalMensual = f(personalMensual);
  state.personal = f(personal);
  state.pedidosHierro = f(pedidosHierro);
  state.pedidoHierroLineas = pedidoHierroLineas.filter((l) => byId(state.pedidosHierro, l.pedidoId) || l.obraId === obraId);
  await cargarProgramacion(obraId);
  await cargarPlanDia(obraId);
}

async function setObraActiva(obraId) {
  state.obraId = obraId;
  await DB.put("config", { key: "obraActiva", value: obraId });
  await loadObraData(obraId);
  renderAll();
  suscribirRealtime(obraId);
  aplicarLogoObra(obraId);
}

// Muestra el logo propio de la obra elegida arriba a la izquierda; si la
// obra no tiene uno cargado, se usa el ícono genérico de la app.
function aplicarPaletaObra(obra) {
  const p = obra && obra.paleta && obra.paleta !== "verde" ? obra.paleta : "";
  if (p) document.documentElement.setAttribute("data-paleta", p);
  else document.documentElement.removeAttribute("data-paleta");
  try { localStorage.setItem("paletaObra", p || "verde"); } catch (e) { /* sin storage */ }
}

function aplicarLogoObra(obraId) {
  const img = $("#headerLogo");
  if (!img) return;
  const obra = byId(state.obras, obraId);
  aplicarPaletaObra(obra);
  // Sin logo cargado: Summit conserva el suyo y cualquier otra obra muestra el de DECC.
  const esSummit = obra && /summit/i.test(obra.nombre || "");
  img.src = (obra && obra.logoUrl) || (esSummit ? "favicon.svg" : "favicon-decc.png");
  // El ícono solo es un link si la obra tiene página web cargada (Summit conserva la suya).
  const link = img.closest("a");
  if (link) {
    let web = ((obra && obra.webUrl) || (esSummit ? "https://www.summit.com.uy/" : "")).trim();
    if (web && !/^https?:\/\//i.test(web)) web = "https://" + web;
    if (web) {
      link.href = web;
      link.title = obra && obra.nombre ? obra.nombre : "";
      link.style.pointerEvents = "";
      link.style.cursor = "";
    } else {
      link.removeAttribute("href");
      link.removeAttribute("title");
      link.style.pointerEvents = "none";
      link.style.cursor = "default";
    }
  }
}

// ---------- Tiempo real: avisar cuando otra persona cambia algo ----------
let realtimeChannel = null;
let realtimeTimer = null;
const TABLAS_REALTIME = [
  "remitos", "remito_lineas", "dias_extra", "personal_mensual", "personal",
  "pedidos_hierro", "pedido_hierro_lineas", "catalogo_elementos",
  "catalogo_hormigones", "catalogo_proveedores", "catalogo_cuadrillas",
  "catalogo_colocacion", "catalogo_equipos",
];

function suscribirRealtime(obraId) {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  let canal = supabaseClient.channel(`obra-${obraId}`);
  // "programacion" solo se escucha si la tabla ya existe en el servidor.
  const tablas = state.programacionDisponible ? [...TABLAS_REALTIME, "programacion"] : TABLAS_REALTIME;
  tablas.forEach((tabla) => {
    canal = canal.on(
      "postgres_changes",
      { event: "*", schema: "public", table: tabla, filter: `obra_id=eq.${obraId}` },
      onCambioRealtime
    );
  });
  canal.subscribe();
  realtimeChannel = canal;
}

function onCambioRealtime() {
  // Varios cambios pueden llegar juntos (ej. un remito con 3 líneas):
  // esperamos un toque antes de refrescar para no recargar de más.
  clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(async () => {
    await loadObraData(state.obraId);
    renderAll();
    toast("Se actualizaron los datos (cambio de otro usuario)", "ok");
  }, 700);
}

// ---------- Init ----------
async function init() {
  const footerVersion = document.getElementById("footerVersion");
  if (footerVersion) {
    footerVersion.innerHTML = `Desarrollado por <a href="https://www.linkedin.com/in/joelgra/" target="_blank" rel="noopener noreferrer">Graña Zeballos Reiner Joel</a>. RUT 100811800012. DECC ©. Versión ${APP_VERSION}`;
  }

  bindLoginForm();
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") mostrarLogin();
  });

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    const perfil = await cargarMiPerfil(session.user.id);
    if (perfil && perfil.rol) {
      state.miPerfil = perfil;
      ocultarLogin();
      await continuarInicioLuegoDeLogin();
      return;
    }
    await supabaseClient.auth.signOut();
  }
  mostrarLogin();
}

async function continuarInicioLuegoDeLogin() {
  await loadObras();

  if (state.obras.length === 0) {
    if (esAdmin()) {
      // Primera vez que se usa la app: precargar automáticamente la obra
      // Summit con los datos reales, sin que el usuario tenga que tocar nada.
      await crearYCargarSummit();
      await loadObras();
    } else {
      toast("Todavía no tenés ninguna obra asignada. Pedile al administrador que te dé acceso.", "error");
      bindTabs();
      bindGlobalHandlers();
      aplicarPermisosUI();
      verificarRecordatorioBackup();
      return;
    }
  }

  const cfg = await DB.get("config", "obraActiva");
  const activa = (cfg && byId(state.obras, cfg.value)) ? cfg.value : state.obras[0].id;
  await setObraActiva(activa);

  bindTabs();
  bindGlobalHandlers();
  resetLineaForm();
  aplicarPermisosUI();
  verificarRecordatorioBackup();
}

// ---------- Recordatorio semanal de copia de seguridad ----------
// A TODOS los usuarios (sin importar el rol) les tiene que aparecer este
// aviso si pasó una semana (o más, o nunca) desde la última vez que
// descargaron el JSON de respaldo. No se puede cerrar de ninguna otra
// forma: solo descargando el backup se oculta.
const MS_UNA_SEMANA = 7 * 24 * 60 * 60 * 1000;
async function verificarRecordatorioBackup() {
  const cfg = await DB.get("config", "ultimoBackupDescargado");
  const ultimo = cfg && cfg.value ? new Date(cfg.value).getTime() : 0;
  const vencido = !ultimo || (Date.now() - ultimo) > MS_UNA_SEMANA;
  const overlay = $("#backupReminderOverlay");
  if (overlay) overlay.style.display = vencido ? "flex" : "none";
}

function renderAll() {
  renderObraSelector();
  renderRemitoForm();
  resetRemitoForm();
  renderRemitosTable();
  renderTarjetaDiaria();
  renderResumenMensual();
  renderCatalogo();
  renderPersonalPanel();
  renderProbetas();
  resetHierroForm();
  renderHierro();
  renderProgramacion();
  renderPlanDia();
}

// ---------- Tabs ----------
function bindTabs() {
  $all("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });
  showTab("remitos");
}
function showTab(tab) {
  const botones = $all("nav.tabs button");
  const previa = botones.findIndex((b) => b.classList.contains("active"));
  const nueva = botones.findIndex((b) => b.dataset.tab === tab);
  botones.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $all(".view").forEach((v) => {
    v.classList.remove("slide-der", "slide-izq");
    v.classList.toggle("active", v.id === "view-" + tab);
  });
  // Animación de deslizamiento (solo escritorio; el CSS la ignora en celular)
  if (previa >= 0 && nueva >= 0 && previa !== nueva) {
    const vista = $("#view-" + tab);
    if (vista) {
      void vista.offsetWidth; // reinicia la animación
      vista.classList.add(nueva > previa ? "slide-der" : "slide-izq");
    }
  }
}

// =========================================================
//  OBRAS
// =========================================================
function renderObraSelector() {
  const sel = $("#selObra");
  sel.innerHTML = "";
  state.obras.forEach((o) => sel.appendChild(el("option", { value: o.id }, o.nombre)));
  sel.value = state.obraId;
}

function bindGlobalHandlers() {
  $("#selObra").addEventListener("change", (e) => setObraActiva(e.target.value));
  $("#btnNuevaObra").addEventListener("click", () => openObraModal(null));
  $("#btnEditarObra").addEventListener("click", () => openObraModal(byId(state.obras, state.obraId)));

  $("#obraLogoFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) mostrarPreviewLogoObra(URL.createObjectURL(file));
  });
  $("#btnQuitarLogoObra").addEventListener("click", () => {
    $("#formObraModal").logoUrl.value = "";
    $("#obraLogoFile").value = "";
    mostrarPreviewLogoObra("");
  });

  $("#formObraModal").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const editId = fd.get("id");
    const proximaProbeta = fd.get("proximaProbeta") ? parseInt(fd.get("proximaProbeta"), 10) : null;
    if (editId) {
      const obra = byId(state.obras, editId);
      const logoUrl = await subirLogoObraSiCorresponde(obra.id, fd.get("logoUrl"));
      Object.assign(obra, {
        nombre: fd.get("nombre").trim(),
        ubicacion: fd.get("ubicacion").trim(),
        proyectista: fd.get("proyectista").trim(),
        director: fd.get("director").trim(),
        supervisorTerreno: fd.get("supervisorTerreno").trim(),
        proximaProbeta,
        logoUrl,
      });
      const web = (fd.get("webUrl") || "").trim();
      if (web || obra.webUrl) obra.webUrl = web || null;
      const pal = fd.get("paleta") || "verde";
      if (pal !== "verde" || obra.paleta) obra.paleta = pal;
      await DB.put("obras", obra);
      await loadObras();
      await setObraActiva(obra.id);
    } else {
      const obra = {
        id: uid("obra"),
        nombre: fd.get("nombre").trim() || "Obra sin nombre",
        ubicacion: fd.get("ubicacion").trim(),
        proyectista: fd.get("proyectista").trim(),
        director: fd.get("director").trim(),
        supervisorTerreno: fd.get("supervisorTerreno").trim(),
        proximaProbeta,
        creada: todayISO(),
      };
      obra.logoUrl = await subirLogoObraSiCorresponde(obra.id, fd.get("logoUrl"));
      const webNueva = (fd.get("webUrl") || "").trim();
      if (webNueva) obra.webUrl = webNueva;
      if ((fd.get("paleta") || "verde") !== "verde") obra.paleta = fd.get("paleta");
      await DB.put("obras", obra);
      await seedObraCatalogo(obra.id);
      await loadObras();
      await setObraActiva(obra.id);
    }
    closeModal("#modalObra");
    toast("Obra guardada", "ok");
  });

  $("#btnBorrarObra").addEventListener("click", async () => {
    if (state.obras.length <= 1) return toast("Debe quedar al menos una obra", "error");
    if (!confirm("¿Borrar esta obra y TODOS sus remitos y catálogo? Esta acción no se puede deshacer.")) return;
    await borrarObra(state.obraId);
    await loadObras();
    await setObraActiva(state.obras[0].id);
    closeModal("#modalObra");
    toast("Obra eliminada", "ok");
  });

  $all("[data-close-modal]").forEach((b) =>
    b.addEventListener("click", () => closeModal(b.closest(".modal-backdrop")))
  );

  // Remitos
  $("#formRemito").addEventListener("submit", onSubmitRemito);
  $("#btnCancelarEdicion").addEventListener("click", resetRemitoForm);
  // Fecha, N° de Remito y M3 del remito destraban "Agregar elemento al
  // remito" apenas están los 3 completos, y el M3 además actualiza en vivo
  // cuánto queda disponible.
  const onCambioCabezal = () => {
    actualizarBloqueoLinea();
    renderLineasFormTable();
  };
  $("#fecha").addEventListener("input", onCambioCabezal);
  $("#remitoNro").addEventListener("input", onCambioCabezal);
  $("#m3Remito").addEventListener("input", onCambioCabezal);
  $("#btnAgregarLinea").addEventListener("click", onAgregarLinea);
  $("#btnCancelarLinea").addEventListener("click", resetLineaForm);
  $("#lin_elementoId").addEventListener("change", updateElementoPreview);
  $("#lin_elementoId").addEventListener("change", onCambioNomenclatura);
  $("#lin_nomenclatura").addEventListener("input", onCambioNomenclatura);
  $("#lin_largoCm").addEventListener("input", onCambioLargoAncho);
  $("#lin_anchoCm").addEventListener("input", onCambioLargoAncho);
  $("#lin_areaM2").addEventListener("input", onCambioAreaOAltura);
  $("#lin_alturaCm").addEventListener("input", onCambioAreaOAltura);
  $("#lin_volumen").addEventListener("input", onInputVolumenManual);
  $("#hormigonId").addEventListener("change", updateHormigonPreview);
  $("#chkAutoProbetas").addEventListener("change", aplicarAutoProbetas);

  $("#btnBuscarRemitos").addEventListener("click", () => {
    state.filtro = {
      desde: $("#filtroDesde").value,
      hasta: $("#filtroHasta").value,
      elementoId: $("#filtroElemento").value,
      proveedorId: $("#filtroProveedor").value,
    };
    renderRemitosTable();
  });
  $("#btnLimpiarFiltro").addEventListener("click", () => {
    state.filtro = { desde: "", hasta: "", elementoId: "", proveedorId: "" };
    $("#filtroDesde").value = ""; $("#filtroHasta").value = "";
    $("#filtroElemento").value = ""; $("#filtroProveedor").value = "";
    renderRemitosTable();
  });

  // Tarjeta diaria
  $("#btnVerTarjeta").addEventListener("click", () => {
    state.tarjetaFecha = $("#tarjetaFecha").value || todayISO();
    renderTarjetaDiaria();
  });
  $("#tarjetaTemperatura").addEventListener("change", saveDiaExtra);
  $("#btnExportarTarjeta").addEventListener("click", exportarTarjetaDiariaExcel);
  $("#btnImprimirTarjeta").addEventListener("click", exportarTarjetaDiariaPDF);

  // Resumen mensual
  $("#resumenMes").addEventListener("change", (e) => { state.resumenMes = e.target.value; renderResumenMensual(); });
  $("#btnExportarResumen").addEventListener("click", exportarResumenMensualExcel);
  $("#btnExportarResumenPDF").addEventListener("click", exportarResumenMensualPDF);
  $all("#formPersonalMensual input").forEach((inp) => inp.addEventListener("change", guardarPersonalMensual));

  // Probetas
  $("#btnBuscarProbetas").addEventListener("click", () => {
    state.probetasFiltro = { desde: $("#probetasDesde").value, hasta: $("#probetasHasta").value };
    renderProbetas();
  });
  $("#btnExportarProbetas").addEventListener("click", exportarProbetasExcel);

  // Exportar general
  $("#btnExportarTodo").addEventListener("click", exportarTodoExcel);
  $("#btnExportarControl").addEventListener("click", exportarControlRemitosExcel);
  $("#btnBackupDescargar").addEventListener("click", exportarBackupJSON);
  $("#inputRestaurarBackup").addEventListener("change", (e) => {
    const file = e.target.files[0];
    restaurarBackupJSON(file);
    e.target.value = "";
  });

  // Recordatorio semanal de backup: el único botón del pop-up. Descarga el
  // JSON, guarda la fecha y recién ahí se puede ocultar el aviso.
  const btnBackupReminder = $("#btnBackupReminderDescargar");
  if (btnBackupReminder) {
    btnBackupReminder.addEventListener("click", async () => {
      await exportarBackupJSON();
      await DB.put("config", { key: "ultimoBackupDescargado", value: new Date().toISOString() });
      const overlay = $("#backupReminderOverlay");
      if (overlay) overlay.style.display = "none";
    });
  }

  // Pedidos de hierro
  $("#formHierro").addEventListener("submit", onSubmitHierro);
  $("#btnCancelarHierro").addEventListener("click", resetHierroForm);
  $("#btnAgregarItemHierro").addEventListener("click", onAgregarItemHierro);
  $("#btnWaHierroAbrir").addEventListener("click", enviarWhatsappHierro);
  $("#btnWaHierroCopiar").addEventListener("click", copiarWhatsappHierro);
  $("#btnCancelarItemHierro").addEventListener("click", resetLineaHierroForm);
  $("#itemHierro_tipo").addEventListener("change", onHierroTipoChange);
  $("#btnBuscarHierro").addEventListener("click", () => {
    state.hierroFiltro = { desde: $("#hierroDesde").value, hasta: $("#hierroHasta").value };
    renderHierro();
  });
  $("#btnLimpiarHierro").addEventListener("click", () => {
    state.hierroFiltro = { desde: "", hasta: "" };
    $("#hierroDesde").value = ""; $("#hierroHasta").value = "";
    renderHierro();
  });

  // Catálogo / Personal
  bindCatalogoHandlers();

  // Programación de hormigón
  bindProgramacionHandlers();
  bindPlanDiaHandlers();
}

function openObraModal(obra) {
  const form = $("#formObraModal");
  form.reset();
  $("#modalObraTitulo").textContent = obra ? "Editar obra" : "Nueva obra";
  $("#btnBorrarObra").style.display = obra ? "inline-block" : "none";
  if (obra) {
    form.id.value = obra.id;
    form.nombre.value = obra.nombre;
    form.ubicacion.value = obra.ubicacion || "";
    form.proyectista.value = obra.proyectista || "";
    form.director.value = obra.director || "";
    form.supervisorTerreno.value = obra.supervisorTerreno || "";
    form.proximaProbeta.value = obra.proximaProbeta ?? "";
    form.logoUrl.value = obra.logoUrl || "";
    form.webUrl.value = obra.webUrl || "";
    form.paleta.value = obra.paleta || "verde";
  } else {
    form.id.value = "";
    form.logoUrl.value = "";
  }
  mostrarPreviewLogoObra(form.logoUrl.value);
  openModal("#modalObra");
}

function mostrarPreviewLogoObra(url) {
  const img = $("#obraLogoPreview");
  const btnQuitar = $("#btnQuitarLogoObra");
  if (url) {
    img.src = url;
    img.style.display = "block";
    btnQuitar.style.display = "inline-block";
  } else {
    img.style.display = "none";
    btnQuitar.style.display = "none";
  }
}

// Sube (si se eligió un archivo nuevo) el logo de la obra a Supabase
// Storage y devuelve su link público, o null si no hay logo.
async function subirLogoObraSiCorresponde(obraId, logoUrlActual) {
  const fileInput = $("#obraLogoFile");
  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const path = `${obraId}/${Date.now()}_${file.name}`;
    const { error } = await supabaseClient.storage.from("logos").upload(path, file, { upsert: true });
    if (error) {
      toast("No se pudo subir el logo: " + error.message, "error");
      return logoUrlActual || null;
    }
    return supabaseClient.storage.from("logos").getPublicUrl(path).data.publicUrl;
  }
  return logoUrlActual || null;
}

async function borrarObra(obraId) {
  const remitosObra = (await DB.getAll("remitos")).filter((r) => r.obraId === obraId);
  const remitoIds = new Set(remitosObra.map((r) => r.id));
  const lineas = await DB.getAll("remitoLineas");
  for (const l of lineas.filter((x) => remitoIds.has(x.remitoId))) await DB.delete("remitoLineas", l.id);

  const pedidosHierroObra = (await DB.getAll("pedidosHierro")).filter((p) => p.obraId === obraId);
  const pedidoHierroIds = new Set(pedidosHierroObra.map((p) => p.id));
  const itemsHierro = await DB.getAll("pedidoHierroLineas");
  for (const it of itemsHierro.filter((x) => pedidoHierroIds.has(x.pedidoId))) await DB.delete("pedidoHierroLineas", it.id);

  const stores = ["remitos", "catalogoElementos", "catalogoHormigones", "catalogoProveedores", "catalogoCuadrillas", "catalogoColocacion", "catalogoEquipos", "diasExtra", "personalMensual", "personal", "pedidosHierro"];
  if (state.programacionDisponible) stores.push("programacion");
  if (state.planDiaDisponible) stores.push("planDia");
  for (const s of stores) {
    const all = await DB.getAll(s);
    for (const item of all.filter((x) => x.obraId === obraId)) await DB.delete(s, item.id);
  }
  await DB.delete("obras", obraId);
}

function openModal(sel) { $(sel).classList.add("show"); }
function closeModal(selOrEl) {
  const node = typeof selOrEl === "string" ? $(selOrEl) : selOrEl;
  if (node) node.classList.remove("show");
}

// =========================================================
//  PRECARGA AUTOMÁTICA DE DATOS REALES DE SUMMIT (solo la 1ª vez)
// =========================================================
async function crearYCargarSummit() {
  if (typeof SEED_SUMMIT_DATA === "undefined") return;

  const obra = {
    id: uid("obra"),
    nombre: "Summit",
    ubicacion: "Bvar Artigas y Chiverta, Punta del Este",
    proyectista: "RDA Ingeniería",
    director: "Zulamián",
    supervisorTerreno: "MELKUY SA",
    proximaProbeta: SEED_SUMMIT_DATA.proximaProbeta || null,
    creada: todayISO(),
  };
  await DB.put("obras", obra);
  await seedObraCatalogoSummit(obra.id);
  await loadObras();
  await loadObraData(obra.id);

  const provCieloAzul = findByField(state.catalogo.proveedores, "nombre", "CIELO AZUL");
  const hormigonByCodigo = {};
  state.catalogo.hormigones.forEach((h) => (hormigonByCodigo[h.codigo] = h));
  const elementoByCodigo = {};
  state.catalogo.elementos.forEach((e) => (elementoByCodigo[e.codigo] = e));
  const cuadrillaByNombre = {
    Jhon: findByField(state.catalogo.cuadrillas, "nombre", "Jhon (Torre)"),
    Pablo: findByField(state.catalogo.cuadrillas, "nombre", "Pablo (Basamento)"),
  };
  const colocacionByNombre = {};
  state.catalogo.colocacion.forEach((c) => (colocacionByNombre[c.nombre] = c));

  const remitosNuevos = SEED_SUMMIT_DATA.remitos.map((r) => ({
    id: r.id,
    obraId: obra.id,
    fecha: r.fecha,
    proveedorId: provCieloAzul ? provCieloAzul.id : "",
    hormigonId: hormigonByCodigo[r.hormigonCodigo] ? hormigonByCodigo[r.hormigonCodigo].id : "",
    remitoNro: r.remitoNro || "",
    m3Remito: r.m3Remito,
    unidadMovil: r.unidadMovil ?? "",
    horaAObra: r.horaAObra || "",
    horaEnObra: r.horaEnObra || "",
    horaDescarga: r.horaDescarga || "",
    horaFinDescarga: r.horaFinDescarga || "",
    probeta1: r.probeta1 || null,
    probeta2: r.probeta2 || null,
    probeta3: r.probeta3 || null,
  }));
  await DB.bulkPut("remitos", remitosNuevos);

  const lineasNuevas = SEED_SUMMIT_DATA.lineas.map((l) => ({
    id: l.id,
    remitoId: l.remitoId,
    obraId: obra.id,
    elementoId: elementoByCodigo[l.elementoCodigo] ? elementoByCodigo[l.elementoCodigo].id : "",
    nomenclatura: l.nomenclatura || "",
    sector: l.sector || "",
    asentamiento: l.asentamiento ?? null,
    nivelFondo: l.nivelFondo ?? null,
    largoCm: l.largoCm ?? null,
    anchoCm: l.anchoCm ?? null,
    alturaCm: l.alturaCm ?? null,
    areaM2: l.areaM2 ?? null,
    volumen: l.volumen ?? null,
    cuadrillaId: cuadrillaByNombre[l.cuadrillaNombre] ? cuadrillaByNombre[l.cuadrillaNombre].id : "",
    bombeado: !!l.bombeado,
    colocacionId: colocacionByNombre[l.colocacionNombre] ? colocacionByNombre[l.colocacionNombre].id : "",
    observaciones: l.observaciones || "",
  }));
  await DB.bulkPut("remitoLineas", lineasNuevas);

  await DB.put("config", { key: "obraActiva", value: obra.id });
}

// =========================================================
//  TABLA GENÉRICA CON EDICIÓN POR LÁPIZ (Referencias / Personal)
// =========================================================
function renderEditableTable(container, { store, items, cols, deleteLabelKey, onChanged }) {
  container.innerHTML = "";
  const table = el("table");
  const thead = el("thead", {}, el("tr", {}, [...cols.map((c) => el("th", {}, c.label)), el("th", {}, "")]));
  table.appendChild(thead);
  const tbody = el("tbody");

  items.forEach((item) => {
    const editing = isEditingRow(store, item.id);
    const tr = el("tr");

    cols.forEach((c) => {
      const td = el("td");
      if (editing) {
        let input;
        if (c.type === "select") {
          input = el("select", { "data-field": c.key }, c.options.map((o) => el("option", { value: o.value }, o.label)));
          input.value = item[c.key] || c.options[0].value;
        } else if (c.type === "checkbox") {
          input = el("input", { type: "checkbox", "data-field": c.key });
          input.checked = !!item[c.key];
        } else {
          input = el("input", { "data-field": c.key, value: item[c.key] || "", style: "min-width:120px" });
        }
        td.appendChild(input);
      } else if (c.type === "select") {
        const opt = c.options.find((o) => o.value === item[c.key]);
        td.appendChild(document.createTextNode(opt ? opt.label : (c.options[0] ? c.options[0].label : "-")));
      } else if (c.type === "checkbox") {
        td.appendChild(document.createTextNode(item[c.key] ? "Sí" : "No"));
      } else {
        td.appendChild(document.createTextNode(item[c.key] || "-"));
      }
      tr.appendChild(td);
    });

    const tdAcc = el("td");
    if (!esAdmin()) {
      tdAcc.appendChild(document.createTextNode("-"));
    } else if (editing) {
      const btnOk = el("button", { class: "ghost", title: "Guardar cambios" }, "✓");
      btnOk.addEventListener("click", async () => {
        cols.forEach((c) => {
          const input = tr.querySelector(`[data-field="${c.key}"]`);
          if (!input) return;
          if (c.type === "checkbox") {
            item[c.key] = input.checked;
            return;
          }
          const v = input.value;
          item[c.key] = typeof v === "string" ? v.trim() : v;
        });
        await DB.put(store, item);
        setEditingRow(store, item.id, false);
        toast("Guardado", "ok");
        await onChanged();
      });
      const btnCancel = el("button", { class: "ghost", title: "Cancelar edición" }, "✕");
      btnCancel.addEventListener("click", async () => {
        setEditingRow(store, item.id, false);
        await onChanged();
      });
      tdAcc.appendChild(btnOk);
      tdAcc.appendChild(btnCancel);
    } else {
      const btnEd = el("button", { class: "ghost", title: "Editar" }, "✎");
      btnEd.addEventListener("click", async () => {
        setEditingRow(store, item.id, true);
        await onChanged();
      });
      const btnDel = el("button", { class: "ghost danger", title: "Borrar" }, "✕");
      btnDel.addEventListener("click", async () => {
        const label = deleteLabelKey ? (item[deleteLabelKey] || "") : "";
        if (!confirm(`¿Borrar "${label}"?`)) return;
        await DB.delete(store, item.id);
        setEditingRow(store, item.id, false);
        await onChanged();
      });
      tdAcc.appendChild(btnEd);
      tdAcc.appendChild(btnDel);
    }
    tr.appendChild(tdAcc);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(el("div", { class: "table-scroll" }, table));
}

// =========================================================
//  REFERENCIAS (antes "Catálogo")
// =========================================================
const GRUPOS_CUADRILLA = [
  { value: "OTRO", label: "Otro / sin asignar" },
  { value: "TORRE", label: "Torre" },
  { value: "BASAMENTO", label: "Basamento" },
];

const ROLES_EQUIPO = [
  { value: "OTRO", label: "Otro (no suma a HH/m3)" },
  { value: "TORRE", label: "Torre" },
  { value: "BASAMENTO", label: "Basamento" },
  { value: "HERREROS", label: "Herreros" },
  { value: "INDIRECTOS", label: "Indirectos" },
];

const CATALOGO_DEFS = [
  { key: "elementos", store: "catalogoElementos", titulo: "Elementos", cols: [
      { key: "codigo", label: "Código", placeholder: "Ej: L" },
      { key: "tipoElemento", label: "Tipo elemento", placeholder: "Ej: ELEM-HORIZ" },
      { key: "nombre", label: "Nombre", placeholder: "Ej: Losa" },
      { key: "permiteModificado", label: "¿Puede quedar modificado?", type: "checkbox" },
      { key: "pagaPorM2", label: "Se paga por m2 (no sumar al total)", type: "checkbox" },
  ]},
  { key: "hormigones", store: "catalogoHormigones", titulo: "Tipos de hormigón", cols: [
      { key: "codigo", label: "Código", placeholder: "Ej: C35" },
      { key: "resistencia", label: "Resistencia", placeholder: "Ej: 35 N/mm²" },
  ]},
  { key: "proveedores", store: "catalogoProveedores", titulo: "Proveedores", cols: [
      { key: "nombre", label: "Nombre", placeholder: "Ej: Cielo Azul" },
  ]},
  { key: "cuadrillas", store: "catalogoCuadrillas", titulo: "Cuadrillas / Capataces", cols: [
      { key: "nombre", label: "Nombre", placeholder: "Ej: Equipo 1 - Pablo" },
      { key: "grupo", label: "Grupo (para HH/m3)", type: "select", options: GRUPOS_CUADRILLA },
  ]},
  { key: "colocacion", store: "catalogoColocacion", titulo: "Tipos de colocación", cols: [
      { key: "nombre", label: "Nombre", placeholder: "Ej: Bomba lanza" },
  ]},
  { key: "equipos", store: "catalogoEquipos", titulo: "Equipos (personal)", cols: [
      { key: "nombre", label: "Nombre", placeholder: "Ej: Sanitarios" },
      { key: "rol", label: "Rol (para HH/m3)", type: "select", options: ROLES_EQUIPO },
  ]},
];

function renderCatalogo() {
  const root = $("#catalogoRoot");
  root.innerHTML = "";
  CATALOGO_DEFS.forEach((def) => root.appendChild(renderCatalogoPanel(def)));
}

function renderCatalogoPanel(def) {
  const items = state.catalogo[def.key];
  const panel = el("div", { class: "panel" });
  panel.appendChild(el("h3", {}, def.titulo));

  const wrap = el("div");
  renderEditableTable(wrap, {
    store: def.store,
    items,
    cols: def.cols,
    deleteLabelKey: def.cols[0].key,
    onChanged: async () => {
      await loadObraData(state.obraId);
      renderCatalogo();
      renderRemitoForm();
      renderPersonalPanel();
      renderResumenMensual();
    },
  });
  panel.appendChild(wrap);

  if (esAdmin()) {
    const btnAdd = el("button", { class: "ghost", style: "margin-top:8px" }, "+ Agregar");
    btnAdd.addEventListener("click", async () => {
      const nuevo = { id: uid(def.key.slice(0, 4)), obraId: state.obraId };
      def.cols.forEach((c) => (nuevo[c.key] = c.type === "select" ? c.options[0].value : (c.type === "checkbox" ? false : "")));
      await DB.put(def.store, nuevo);
      await loadObraData(state.obraId);
      setEditingRow(def.store, nuevo.id, true);
      renderCatalogo();
      renderRemitoForm();
      renderPersonalPanel();
      renderResumenMensual();
    });
    panel.appendChild(btnAdd);
  }
  return panel;
}

function bindCatalogoHandlers() {
  // Los handlers de cada fila/botón se agregan dinámicamente en renderCatalogoPanel / renderPersonalPanel
}

// =========================================================
//  PERSONAL (nómina)
// =========================================================
// El equipo de cada persona ahora es un id de "catalogoEquipos" (editable en
// Referencias → Equipos), no un código fijo. "rol" es lo que decide si cuenta
// para TORRE/BASAMENTO/HERREROS/INDIRECTOS en el HH/m3 (ROL="OTRO" => no suma).
function equipoOpciones() {
  return state.catalogo.equipos.map((e) => ({ value: e.id, label: e.nombre }));
}

function personalPorEquipo(rol) {
  return state.personal.filter((p) => {
    const eq = byId(state.catalogo.equipos, p.equipo);
    return eq ? eq.rol === rol : p.equipo === rol; // respaldo por si el catálogo no cargó aún
  }).length;
}

function nombreEquipoPersona(p) {
  const eq = byId(state.catalogo.equipos, p.equipo);
  return eq ? eq.nombre : (p.equipo || "-");
}

function renderPersonalPanel() {
  const root = $("#personalRoot");
  if (!root) return;
  root.innerHTML = "";
  const panel = el("div", { class: "panel" });
  const headerRow = el("div", { class: "row between" }, [
    el("h3", { style: "margin:0" }, "Nómina de personal"),
    el("button", { class: "ghost", id: "btnExportarPersonal" }, "⬇ Exportar a Excel"),
  ]);
  panel.appendChild(headerRow);
  panel.appendChild(el("p", { class: "hint" }, 'Cargá acá, uno por uno, a cada integrante del equipo. El Resumen mensual usa esta lista para calcular sola la cantidad de personal por equipo. Los equipos (Torre, Basamento, Herreros, Indirectos, y los que quieras agregar como Sanitarios o Electricistas) se editan en Referencias → Equipos.'));

  const equiposOpts = equipoOpciones();
  const wrap = el("div");
  renderEditableTable(wrap, {
    store: "personal",
    items: state.personal,
    cols: [
      { key: "nombre", label: "Nombre", placeholder: "Ej: Juan" },
      { key: "apellido", label: "Apellido", placeholder: "Ej: Pérez" },
      { key: "cargo", label: "Cargo", placeholder: "Ej: Oficial" },
      { key: "equipo", label: "Equipo", type: "select", options: equiposOpts.length ? equiposOpts : [{ value: "", label: "(sin equipos cargados)" }] },
    ],
    deleteLabelKey: "nombre",
    onChanged: async () => {
      await loadObraData(state.obraId);
      renderPersonalPanel();
      renderResumenMensual();
    },
  });
  panel.appendChild(wrap);

  if (esAdmin()) {
    const btnAdd = el("button", { class: "ghost", style: "margin-top:8px" }, "+ Agregar persona");
    btnAdd.addEventListener("click", async () => {
      const nuevo = { id: uid("per"), obraId: state.obraId, nombre: "", apellido: "", cargo: "", equipo: equiposOpts[0] ? equiposOpts[0].value : "" };
      await DB.put("personal", nuevo);
      await loadObraData(state.obraId);
      setEditingRow("personal", nuevo.id, true);
      renderPersonalPanel();
      renderResumenMensual();
    });
    panel.appendChild(btnAdd);
  }
  root.appendChild(panel);

  $("#btnExportarPersonal").addEventListener("click", exportarPersonalExcel);
}

function exportarPersonalExcel() {
  const obra = byId(state.obras, state.obraId);
  if (state.personal.length === 0) return toast("No hay personal cargado para exportar", "error");
  const filas = state.personal.map((p) => ({
    "Nombre": p.nombre || "",
    "Apellido": p.apellido || "",
    "Cargo": p.cargo || "",
    "Equipo": nombreEquipoPersona(p),
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  ws["!cols"] = autoWidth(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Personal");
  descargarWorkbook(wb, `Personal - ${obra?.nombre || ""}.xlsx`);
}

// =========================================================
//  PEDIDOS DE HIERRO (encabezado + ítems: barras / perfiles) + factura
// =========================================================
const DIAMETROS_HIERRO = [6, 8, 10, 12, 16, 20, 25, 32];

function renderHierroDiametroSelect() {
  const sel = $("#itemHierro_diametro");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = "";
  DIAMETROS_HIERRO.forEach((d) => sel.appendChild(el("option", { value: d }, `Ø${d} mm`)));
  if (DIAMETROS_HIERRO.some((d) => String(d) === current)) sel.value = current;
}

// Barras: se piden por tonelada. Perfiles: se piden por unidad.
// "LISA" (barra lisa) es solo una opción del formulario: se guarda como un
// ítem de tipo PERFIL con su descripción ("Barra lisa Ø6 mm x 6 m") y se
// pide por tonelada (como la conformada), así no hace falta tocar la base de datos.
function unidadHierro(tipo) {
  return tipo === "PERFIL" ? "un" : "Tn";
}

function onHierroTipoChange() {
  const tipo = $("#itemHierro_tipo").value;
  const conDiametro = tipo === "BARRA" || tipo === "LISA";
  const enUnidades = tipo === "PERFIL";
  $("#hierroCamposBarra").style.display = conDiametro ? "" : "none";
  $("#hierroCamposBarraLongitud").style.display = conDiametro ? "" : "none";
  $("#hierroCamposPerfil").style.display = tipo === "PERFIL" ? "" : "none";
  $("#itemHierro_cantidadLabel").textContent = enUnidades ? "Cantidad (unidades) *" : "Cantidad (toneladas) *";
  $("#itemHierro_cantidad").step = enUnidades ? "1" : "0.01";
  // Al cambiar de tipo, la longitud pasa a la habitual: 6 m la lisa, 12 m la conformada.
  if (conDiametro && onHierroTipoChange.anterior !== undefined && onHierroTipoChange.anterior !== tipo) {
    $("#itemHierro_longitud").value = tipo === "LISA" ? 6 : 12;
  }
  onHierroTipoChange.anterior = tipo;
}

// ---------- Ítem del pedido (sub-formulario) ----------
function resetLineaHierroForm() {
  state.editingLineaHierroIdx = null;
  const form = $("#formItemHierro");
  if (!form) return;
  form.reset();
  renderHierroDiametroSelect();
  form.itemHierro_tipo.value = "BARRA";
  form.itemHierro_longitud.value = 12;
  onHierroTipoChange();
  $("#btnAgregarItemHierro").textContent = "+ Agregar ítem";
  $("#btnCancelarItemHierro").style.display = "none";
}

function leerFormLineaHierro() {
  const form = $("#formItemHierro");
  const fd = new FormData(form);
  const get = (k) => (fd.get(k) || "").toString().trim();
  const getNum = (k) => {
    const v = get(k);
    return v === "" ? null : parseFloat(v.replace(",", "."));
  };

  const tipo = get("itemHierro_tipo");
  if ((tipo === "BARRA" || tipo === "LISA") && !get("itemHierro_diametro")) { toast("Falta el diámetro", "error"); return null; }
  if (tipo === "PERFIL" && !get("itemHierro_perfilNombre")) { toast("Falta el nombre del perfil", "error"); return null; }
  const cantidad = getNum("itemHierro_cantidad");
  if (cantidad === null) { toast("Falta la cantidad", "error"); return null; }

  const idItem = state.editingLineaHierroIdx !== null ? state.lineasHierroForm[state.editingLineaHierroIdx].id : uid("hie_it");
  if (tipo === "LISA") {
    const lon = getNum("itemHierro_longitud") || 6;
    return {
      id: idItem,
      tipo: "PERFIL",
      diametroMm: null,
      longitudM: null,
      perfilNombre: `Barra lisa Ø${get("itemHierro_diametro")} mm x ${String(lon).replace(".", ",")} m`,
      cantidad,
      unidad: "Tn",
      observaciones: get("itemHierro_observaciones"),
    };
  }
  return {
    id: idItem,
    tipo,
    diametroMm: tipo === "BARRA" ? parseInt(get("itemHierro_diametro"), 10) : null,
    longitudM: tipo === "BARRA" ? (getNum("itemHierro_longitud") || 12) : null,
    perfilNombre: tipo === "PERFIL" ? get("itemHierro_perfilNombre") : "",
    cantidad,
    unidad: unidadHierro(tipo),
    observaciones: get("itemHierro_observaciones"),
  };
}

function onAgregarItemHierro() {
  const item = leerFormLineaHierro();
  if (!item) return;
  if (state.editingLineaHierroIdx !== null) {
    state.lineasHierroForm[state.editingLineaHierroIdx] = item;
  } else {
    state.lineasHierroForm.push(item);
  }
  resetLineaHierroForm();
  renderLineasHierroFormTable();
}

function editarItemHierroForm(idx) {
  const item = state.lineasHierroForm[idx];
  const form = $("#formItemHierro");
  renderHierroDiametroSelect();
  // Una barra lisa guardada vuelve a cargarse como "Barra lisa" con su Ø y largo.
  const lisa = item.tipo === "PERFIL" ? /^Barra lisa Ø(\d+) mm x ([\d,.]+) m$/i.exec(item.perfilNombre || "") : null;
  form.itemHierro_tipo.value = lisa ? "LISA" : item.tipo;
  onHierroTipoChange();
  form.itemHierro_diametro.value = lisa ? lisa[1] : (item.diametroMm || "");
  form.itemHierro_longitud.value = lisa ? lisa[2].replace(",", ".") : (item.longitudM || 12);
  form.itemHierro_perfilNombre.value = item.perfilNombre || "";
  form.itemHierro_cantidad.value = item.cantidad ?? "";
  form.itemHierro_observaciones.value = item.observaciones || "";
  state.editingLineaHierroIdx = idx;
  $("#btnAgregarItemHierro").textContent = "Actualizar ítem";
  $("#btnCancelarItemHierro").style.display = "inline-block";
}

function quitarItemHierroForm(idx) {
  state.lineasHierroForm.splice(idx, 1);
  if (state.editingLineaHierroIdx === idx) resetLineaHierroForm();
  renderLineasHierroFormTable();
}

function detalleLineaHierro(item) {
  if (item.tipo === "BARRA") return `Ø${item.diametroMm} x ${item.longitudM}m`;
  return item.perfilNombre || "-";
}

function renderLineasHierroFormTable() {
  const tbody = $("#tablaItemsHierroForm tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (state.lineasHierroForm.length === 0) {
    $("#itemsHierroFormEmpty").style.display = "block";
    $("#tablaItemsHierroFormWrap").style.display = "none";
  } else {
    $("#itemsHierroFormEmpty").style.display = "none";
    $("#tablaItemsHierroFormWrap").style.display = "block";
  }
  state.lineasHierroForm.forEach((item, idx) => {
    const tr = el("tr");
    tr.appendChild(el("td", {}, item.tipo === "BARRA" ? "Barra" : /^Barra lisa/i.test(item.perfilNombre || "") ? "Barra lisa" : "Perfil"));
    tr.appendChild(el("td", {}, detalleLineaHierro(item)));
    tr.appendChild(el("td", {}, `${item.cantidad} ${item.unidad}`));
    tr.appendChild(el("td", {}, item.observaciones || "-"));
    const tdAcc = el("td");
    const btnEd = el("button", { class: "ghost", title: "Editar" }, "✎");
    btnEd.addEventListener("click", () => editarItemHierroForm(idx));
    const btnDel = el("button", { class: "ghost danger", title: "Quitar" }, "✕");
    btnDel.addEventListener("click", () => quitarItemHierroForm(idx));
    tdAcc.appendChild(btnEd);
    tdAcc.appendChild(btnDel);
    tr.appendChild(tdAcc);
    tbody.appendChild(tr);
  });
}

// ---------- Pedido de hierro (encabezado) ----------
function resetHierroForm() {
  const form = $("#formHierro");
  if (!form) return;
  state.editingHierroId = null;
  state.lineasHierroForm = [];
  form.reset();
  $("#hierro_fecha").value = todayISO();
  resetLineaHierroForm();
  renderLineasHierroFormTable();
  $("#btnGuardarHierro").textContent = "Guardar pedido";
  $("#btnCancelarHierro").style.display = "none";
  state.facturasHierroForm = [];
  renderFacturasHierroForm();
  $("#formHierroTitulo").textContent = "Nuevo pedido de hierro";
}

// Un pedido viejo (de antes de poder tener varias facturas) guardaba una
// sola en facturaPath/facturaNombre/facturaTipo. Esto lo junta con la
// lista nueva para que se vea y se use igual no importa cuándo se cargó.
function facturasDePedido(p) {
  if (!p) return [];
  if (Array.isArray(p.facturas) && p.facturas.length > 0) return p.facturas;
  if (p.facturaPath) return [{ path: p.facturaPath, nombre: p.facturaNombre || "Factura", tipo: p.facturaTipo || "" }];
  return [];
}

// Dibuja, dentro del formulario, la lista de facturas que va a quedar
// guardada con el pedido (las que ya estaban + las nuevas se agregan al
// guardar), cada una con su botón para sacarla antes de guardar.
function renderFacturasHierroForm() {
  const cont = $("#hierroFacturaActual");
  cont.innerHTML = "";
  if (state.facturasHierroForm.length === 0) {
    cont.appendChild(document.createTextNode("Sin facturas adjuntas todavía."));
    return;
  }
  state.facturasHierroForm.forEach((f, idx) => {
    const fila = el("div", { class: "row", style: "align-items:center;gap:6px;margin-top:4px" });
    fila.appendChild(document.createTextNode(f.nombre));
    const btnVer = el("button", { type: "button", class: "ghost" }, "Ver");
    btnVer.addEventListener("click", () => abrirFactura(f.path));
    const btnQuitar = el("button", { type: "button", class: "ghost danger" }, "✕");
    btnQuitar.addEventListener("click", () => {
      state.facturasHierroForm.splice(idx, 1);
      renderFacturasHierroForm();
    });
    fila.appendChild(btnVer);
    fila.appendChild(btnQuitar);
    cont.appendChild(fila);
  });
}

async function onSubmitHierro(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const get = (k) => (fd.get(k) || "").toString().trim();

  if (!get("hierro_fecha")) return toast("Falta la fecha", "error");
  if (state.lineasHierroForm.length === 0) return toast("Agregá al menos un ítem a este pedido", "error");

  const eraNuevo = !state.editingHierroId;
  const pedidoId = state.editingHierroId || uid("hie");
  const existente = state.editingHierroId ? byId(state.pedidosHierro, state.editingHierroId) : null;

  const pedido = {
    id: pedidoId,
    obraId: state.obraId,
    fecha: get("hierro_fecha"),
    proveedor: get("hierro_proveedor"),
    observaciones: get("hierro_observaciones"),
  };

  // Facturas que ya estaban (menos las que se hayan sacado con "✕") +
  // las que se eligieron recién en el input de archivos.
  const facturasFinal = [...state.facturasHierroForm];
  const erroresFactura = [];
  const fileInput = $("#hierro_factura");
  if (fileInput.files && fileInput.files.length > 0) {
    for (const file of fileInput.files) {
      const path = `${state.obraId}/${pedidoId}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${file.name}`;
      const { error: upErr } = await supabaseClient.storage.from("facturas").upload(path, file, { upsert: true });
      if (upErr) {
        console.error(`No se pudo subir "${file.name}":`, upErr);
        erroresFactura.push(`${file.name} (${upErr.message})`);
      } else {
        facturasFinal.push({ path, nombre: file.name, tipo: file.type || "" });
      }
    }
  }
  pedido.facturas = facturasFinal;

  await DB.put("pedidosHierro", pedido);

  // Reemplazar los ítems: borrar los viejos que ya no están, guardar los actuales
  const idsNuevos = new Set(state.lineasHierroForm.map((l) => l.id));
  const viejosDeEstePedido = state.pedidoHierroLineas.filter((l) => l.pedidoId === pedidoId);
  for (const viejo of viejosDeEstePedido) {
    if (!idsNuevos.has(viejo.id)) await DB.delete("pedidoHierroLineas", viejo.id);
  }
  for (const item of state.lineasHierroForm) {
    await DB.put("pedidoHierroLineas", { ...item, pedidoId, obraId: state.obraId });
  }

  await loadObraData(state.obraId);
  resetHierroForm();
  renderHierro();
  if (erroresFactura.length > 0) {
    toast(`Pedido guardado, pero no se pudo subir: ${erroresFactura.join(" · ")}`, "error");
  } else {
    toast(eraNuevo ? "Pedido registrado" : "Pedido actualizado", "ok");
    if (eraNuevo && puedeAgregar()) abrirWhatsappHierro(pedidoId);
  }
}

// ---------- Mensaje de WhatsApp para el grupo de pedidos de hierro ----------
function mensajeWhatsappHierro(pedidoId) {
  const p = byId(state.pedidosHierro, pedidoId);
  if (!p) return "";
  const obra = byId(state.obras, state.obraId);
  const n = (v) => Number(v).toLocaleString("es-UY", { maximumFractionDigits: 2 });
  const lineas = [`*PEDIDO DE HIERRO - Obra ${obra?.nombre || ""}*`, `Fecha: ${fmtFechaCorta(p.fecha)}`];
  if (p.proveedor) lineas.push(`Proveedor: ${p.proveedor}`);
  lineas.push("", "*Detalle:*");
  state.pedidoHierroLineas.filter((l) => l.pedidoId === pedidoId).forEach((it) => {
    lineas.push(`• ${detalleLineaHierro(it)} - *${n(it.cantidad)} ${it.unidad}*${it.observaciones ? ` (${it.observaciones})` : ""}`);
  });
  if (p.observaciones) lineas.push("", `Observaciones: ${p.observaciones}`);
  return lineas.join("\n");
}

function abrirWhatsappHierro(pedidoId) {
  const txt = mensajeWhatsappHierro(pedidoId);
  if (!txt) return;
  $("#waHierroTexto").value = txt;
  openModal("#modalWhatsappHierro");
}

function enviarWhatsappHierro() {
  const txt = $("#waHierroTexto").value.trim();
  if (!txt) return toast("El mensaje está vacío", "error");
  window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, "_blank", "noopener");
}

async function copiarWhatsappHierro() {
  const area = $("#waHierroTexto");
  try { await navigator.clipboard.writeText(area.value); }
  catch (e) { area.select(); document.execCommand("copy"); }
  toast("Mensaje copiado", "ok");
}

function editarHierro(pedidoId) {
  const p = byId(state.pedidosHierro, pedidoId);
  if (!p) return;
  state.editingHierroId = pedidoId;
  state.lineasHierroForm = state.pedidoHierroLineas.filter((l) => l.pedidoId === pedidoId).map((l) => ({ ...l }));
  state.editingLineaHierroIdx = null;

  const form = $("#formHierro");
  form.hierro_fecha.value = p.fecha;
  form.hierro_proveedor.value = p.proveedor || "";
  form.hierro_observaciones.value = p.observaciones || "";
  state.facturasHierroForm = facturasDePedido(p).map((f) => ({ ...f }));
  renderFacturasHierroForm();
  $("#formHierroTitulo").textContent = "Editar pedido de hierro";
  $("#btnGuardarHierro").textContent = "Actualizar pedido";
  $("#btnCancelarHierro").style.display = "inline-block";
  resetLineaHierroForm();
  renderLineasHierroFormTable();
  showTab("hierro");
  form.scrollIntoView({ behavior: "smooth" });
}

async function borrarHierro(pedidoId) {
  if (!confirm("¿Borrar este pedido de hierro (todos sus ítems y la factura adjunta, si tiene)?")) return;
  const itemsDelPedido = state.pedidoHierroLineas.filter((l) => l.pedidoId === pedidoId);
  for (const it of itemsDelPedido) await DB.delete("pedidoHierroLineas", it.id);
  await DB.delete("pedidosHierro", pedidoId);
  await loadObraData(state.obraId);
  resetHierroForm();
  renderHierro();
  toast("Pedido borrado", "ok");
}

async function abrirFactura(path) {
  if (!path) return;
  const { data, error } = await supabaseClient.storage.from("facturas").createSignedUrl(path, 120);
  if (error || !data) { toast("No se pudo abrir la factura", "error"); return; }
  window.open(data.signedUrl, "_blank");
}

function pedidosHierroFiltrados() {
  return state.pedidosHierro.filter((p) => {
    if (state.hierroFiltro.desde && p.fecha < state.hierroFiltro.desde) return false;
    if (state.hierroFiltro.hasta && p.fecha > state.hierroFiltro.hasta) return false;
    return true;
  }).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

function resumenItemsHierro(pedidoId) {
  const items = state.pedidoHierroLineas.filter((l) => l.pedidoId === pedidoId);
  if (items.length === 0) return "-";
  return items.map((it) => `${detalleLineaHierro(it)}: ${it.cantidad} ${it.unidad}`).join(" · ");
}

function renderHierro() {
  const rows = pedidosHierroFiltrados();
  const tbody = $("#tablaHierro tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (rows.length === 0) {
    $("#hierroEmpty").style.display = "block";
    $("#tablaHierroWrap").style.display = "none";
    return;
  }
  $("#hierroEmpty").style.display = "none";
  $("#tablaHierroWrap").style.display = "block";

  rows.forEach((p) => {
    const tr = el("tr");
    tr.appendChild(el("td", {}, fmtFechaCorta(p.fecha)));
    tr.appendChild(el("td", {}, p.proveedor || "-"));
    tr.appendChild(el("td", { style: "white-space:normal" }, resumenItemsHierro(p.id)));
    const tdFactura = el("td");
    const facturas = facturasDePedido(p);
    if (facturas.length > 0) {
      facturas.forEach((f, idx) => {
        const btnVer = el("button", { class: "ghost", title: f.nombre, style: "margin:2px" }, facturas.length > 1 ? `Factura ${idx + 1}` : "Ver factura");
        btnVer.addEventListener("click", () => abrirFactura(f.path));
        tdFactura.appendChild(btnVer);
      });
    } else {
      tdFactura.appendChild(document.createTextNode("-"));
    }
    tr.appendChild(tdFactura);
    const tdAcc = el("td");
    if (puedeAgregar()) {
      const btnWa = el("button", { class: "ghost", title: "Armar mensaje de WhatsApp" }, "WhatsApp");
      btnWa.addEventListener("click", () => abrirWhatsappHierro(p.id));
      tdAcc.appendChild(btnWa);
    }
    if (esAdmin()) {
      const btnEd = el("button", { class: "ghost", title: "Editar" }, "✎");
      btnEd.addEventListener("click", () => editarHierro(p.id));
      const btnDel = el("button", { class: "ghost danger", title: "Borrar" }, "✕");
      btnDel.addEventListener("click", () => borrarHierro(p.id));
      tdAcc.appendChild(btnEd);
      tdAcc.appendChild(btnDel);
    } else if (!puedeAgregar()) {
      tdAcc.appendChild(document.createTextNode("-"));
    }
    tr.appendChild(tdAcc);
    tbody.appendChild(tr);
  });
}

// =========================================================
//  REMITOS — formulario (encabezado + líneas) y tabla
// =========================================================
function selectOptions(sel, items, labelFn, opts = {}) {
  const current = sel.value;
  sel.innerHTML = "";
  if (opts.placeholder) sel.appendChild(el("option", { value: "" }, opts.placeholder));
  items.forEach((it) => sel.appendChild(el("option", { value: it.id }, labelFn(it))));
  if (items.some((i) => i.id === current)) sel.value = current;
}

function renderRemitoForm() {
  selectOptions($("#lin_elementoId"), state.catalogo.elementos, (e) => `${e.codigo} — ${e.nombre}`, { placeholder: "Seleccionar..." });
  selectOptions($("#hormigonId"), state.catalogo.hormigones, (h) => `${h.codigo} (${h.resistencia})`, { placeholder: "Seleccionar..." });
  selectOptions($("#proveedorId"), state.catalogo.proveedores, (p) => p.nombre, { placeholder: "Seleccionar..." });
  selectOptions($("#lin_cuadrillaId"), state.catalogo.cuadrillas, (c) => c.nombre, { placeholder: "Seleccionar..." });
  selectOptions($("#lin_colocacionId"), state.catalogo.colocacion, (c) => c.nombre, { placeholder: "Seleccionar..." });

  selectOptions($("#filtroElemento"), state.catalogo.elementos, (e) => `${e.codigo} — ${e.nombre}`, { placeholder: "Todos los elementos" });
  selectOptions($("#filtroProveedor"), state.catalogo.proveedores, (p) => p.nombre, { placeholder: "Todos los proveedores" });

  updateHormigonPreview();
  updateElementoPreview();
  renderLineasFormTable();
}

function updateElementoPreview() {
  const item = byId(state.catalogo.elementos, $("#lin_elementoId").value);
  $("#lin_elementoPreview").textContent = item ? `${item.tipoElemento}` : "";
  const permite = !!(item && item.permiteModificado);
  $("#lin_modificadoField").style.display = permite ? "" : "none";
  if (!permite) $("#lin_modificado").checked = false;
}
function updateHormigonPreview() {
  const item = byId(state.catalogo.hormigones, $("#hormigonId").value);
  $("#hormigonPreview").textContent = item ? item.resistencia : "";
}
// El volumen (m3) se autocompleta desde área×altura. Si el usuario lo carga
// a mano (por ejemplo un valor sacado de BIM), queda "trabado" y no se
// vuelve a pisar hasta que borre el campo o se resetee el formulario.
let volumenAutoLock = false;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Recalcula el área (m2) a partir de Largo×Ancho (cm), cuando ambos están
// cargados. Si el usuario prefiere cargar el área directamente (ej: una
// superficie irregular sacada de AutoCAD), puede dejar Largo/Ancho vacíos
// y escribir el m2 a mano: esta función no lo pisa en ese caso.
function recalcularAreaDesdeLargoAncho() {
  const l = parseFloat($("#lin_largoCm").value);
  const a = parseFloat($("#lin_anchoCm").value);
  if (!isNaN(l) && !isNaN(a) && l > 0 && a > 0) {
    $("#lin_areaM2").value = round2((l / 100) * (a / 100));
  }
}

// Recalcula el volumen (m3) a partir de Área (m2) × Altura (cm), salvo que
// el usuario ya haya escrito el volumen a mano (volumenAutoLock).
function recalcularVolumenDesdeAreaAltura() {
  if (volumenAutoLock) return;
  const area = parseFloat($("#lin_areaM2").value);
  const alturaCm = parseFloat($("#lin_alturaCm").value);
  if (!isNaN(area) && area > 0 && !isNaN(alturaCm) && alturaCm > 0) {
    $("#lin_volumen").value = round2(area * (alturaCm / 100));
  }
}

function onCambioLargoAncho() {
  recalcularAreaDesdeLargoAncho();
  recalcularVolumenDesdeAreaAltura();
}

function onCambioAreaOAltura() {
  recalcularVolumenDesdeAreaAltura();
}

function onInputVolumenManual() {
  volumenAutoLock = $("#lin_volumen").value.trim() !== "";
}

// ---------- Dimensiones de Pilares/Pantallas desde registros previos ----------
// Pilares y pantallas se repiten con el mismo número (Nomenclatura, ej:
// "F09") y la misma sección en toda la obra. En vez de pedirle a Joel una
// lista aparte, buscamos entre las líneas YA CARGADAS de esta obra si ese
// mismo elemento+nomenclatura tiene Largo/Ancho/Altura, y si los tiene, se
// los copiamos (si hay varias, usamos la del remito más reciente). Nunca
// pisa datos que el usuario ya haya escrito a mano en este formulario.
function esPilarOPantalla(elementoId) {
  const elem = byId(state.catalogo.elementos, elementoId);
  if (!elem) return false;
  const nombre = (elem.nombre || "").trim().toUpperCase();
  return nombre === "PILAR" || nombre === "PANTALLA";
}

function buscarDimensionesHistoricas(elementoId, nomenclatura) {
  const nom = (nomenclatura || "").trim().toUpperCase();
  if (!nom || !esPilarOPantalla(elementoId)) return null;

  const candidatas = state.lineas.filter(
    (l) => l.elementoId === elementoId && (l.nomenclatura || "").trim().toUpperCase() === nom
      && l.largoCm != null && l.anchoCm != null && l.alturaCm != null
  );
  if (candidatas.length === 0) return null;

  candidatas.sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    const fa = (ra && ra.fecha) || "", fb = (rb && rb.fecha) || "";
    return fa < fb ? 1 : fa > fb ? -1 : 0;
  });
  const { largoCm, anchoCm, alturaCm } = candidatas[0];
  return { largoCm, anchoCm, alturaCm };
}

function onCambioNomenclatura() {
  const largoVacio = $("#lin_largoCm").value.trim() === "";
  const anchoVacio = $("#lin_anchoCm").value.trim() === "";
  const alturaVacio = $("#lin_alturaCm").value.trim() === "";
  if (!largoVacio || !anchoVacio || !alturaVacio) return; // ya hay algo cargado a mano: no lo tocamos

  const dim = buscarDimensionesHistoricas($("#lin_elementoId").value, $("#lin_nomenclatura").value);
  if (!dim) return;

  $("#lin_largoCm").value = dim.largoCm;
  $("#lin_anchoCm").value = dim.anchoCm;
  $("#lin_alturaCm").value = dim.alturaCm;
  onCambioLargoAncho();
  onCambioAreaOAltura();
}

// ---------- Probetas automáticas ----------
function aplicarAutoProbetas() {
  if (!$("#chkAutoProbetas").checked) return;
  const obra = byId(state.obras, state.obraId);
  if (!obra || !obra.proximaProbeta) return;
  const base = obra.proximaProbeta;
  $("#probeta1").value = base;
  $("#probeta2").value = base + 1;
  $("#probeta3").value = base + 2;
}

async function avanzarContadorProbetas() {
  const obra = byId(state.obras, state.obraId);
  if (!obra) return;
  const nums = [$("#probeta1").value, $("#probeta2").value, $("#probeta3").value]
    .map((v) => parseInt(v, 10))
    .filter((n) => !isNaN(n));
  if (nums.length === 0) return;
  const maxUsado = Math.max(...nums);
  if (!obra.proximaProbeta || maxUsado + 1 > obra.proximaProbeta) {
    obra.proximaProbeta = maxUsado + 1;
    await DB.put("obras", obra);
  }
}

// ---------- Líneas (elementos dentro de un remito) ----------
function resetLineaForm() {
  state.editingLineaIdx = null;
  volumenAutoLock = false;
  const form = $("#formLinea");
  form.reset();
  $("#btnAgregarLinea").textContent = "+ Agregar elemento";
  $("#btnCancelarLinea").style.display = "none";
  updateElementoPreview();
}

function leerFormLinea() {
  const form = $("#formLinea");
  const fd = new FormData(form);
  const get = (k) => (fd.get(k) || "").toString().trim();
  const getNum = (k) => {
    const v = get(k);
    return v === "" ? null : parseFloat(v.replace(",", "."));
  };
  if (!get("lin_elementoId")) { toast("Falta seleccionar el elemento", "error"); return null; }
  if (getNum("lin_volumen") === null) { toast("Falta el volumen (m3) del elemento", "error"); return null; }

  const largo = getNum("lin_largoCm");
  const ancho = getNum("lin_anchoCm");
  const area = getNum("lin_areaM2");

  return {
    id: state.editingLineaIdx !== null ? state.lineasForm[state.editingLineaIdx].id : uid("lin"),
    elementoId: get("lin_elementoId"),
    nomenclatura: get("lin_nomenclatura"),
    sector: get("lin_sector"),
    asentamiento: getNum("lin_asentamiento"),
    nivelFondo: getNum("lin_nivelFondo"),
    largoCm: largo,
    anchoCm: ancho,
    alturaCm: getNum("lin_alturaCm"),
    areaM2: area,
    volumen: getNum("lin_volumen"),
    cuadrillaId: get("lin_cuadrillaId"),
    bombeado: get("lin_bombeado") === "SI",
    colocacionId: get("lin_colocacionId"),
    observaciones: get("lin_observaciones"),
    modificado: $("#lin_modificado").checked,
  };
}

function onAgregarLinea() {
  const linea = leerFormLinea();
  if (!linea) return;

  const m3Remito = getM3RemitoCabezal();
  if (m3Remito !== null) {
    const otras = state.lineasForm.reduce(
      (a, l, idx) => a + (idx === state.editingLineaIdx ? 0 : (l.volumen || 0)),
      0
    );
    const nuevoTotal = round2(otras + (linea.volumen || 0));
    if (nuevoTotal > round2(m3Remito) + 0.001) {
      const disponible = round2(m3Remito - otras);
      toast(`Ese volumen supera lo disponible del remito: quedan ${fmtM3(disponible)} m³ de ${fmtM3(m3Remito)} m³`, "error");
      return;
    }
  }

  if (state.editingLineaIdx !== null) {
    state.lineasForm[state.editingLineaIdx] = linea;
  } else {
    state.lineasForm.push(linea);
  }
  resetLineaForm();
  renderLineasFormTable();
}

function editarLineaForm(idx) {
  const linea = state.lineasForm[idx];
  const form = $("#formLinea");
  form.lin_elementoId.value = linea.elementoId;
  form.lin_nomenclatura.value = linea.nomenclatura || "";
  form.lin_sector.value = linea.sector || "";
  form.lin_asentamiento.value = linea.asentamiento ?? "";
  form.lin_nivelFondo.value = linea.nivelFondo ?? "";
  form.lin_largoCm.value = linea.largoCm ?? "";
  form.lin_anchoCm.value = linea.anchoCm ?? "";
  form.lin_areaM2.value = linea.areaM2 ?? "";
  form.lin_alturaCm.value = linea.alturaCm ?? "";
  form.lin_volumen.value = linea.volumen ?? "";
  form.lin_cuadrillaId.value = linea.cuadrillaId || "";
  form.lin_bombeado.value = linea.bombeado ? "SI" : "NO";
  form.lin_colocacionId.value = linea.colocacionId || "";
  form.lin_observaciones.value = linea.observaciones || "";
  state.editingLineaIdx = idx;
  // Al editar una línea existente, el volumen ya cargado se respeta tal
  // cual (no se recalcula solo) hasta que el usuario borre o vuelva a tocar
  // los campos de largo/ancho/área/altura.
  volumenAutoLock = linea.volumen !== null && linea.volumen !== undefined;
  $("#btnAgregarLinea").textContent = "Actualizar elemento";
  $("#btnCancelarLinea").style.display = "inline-block";
  updateElementoPreview();
  $("#lin_modificado").checked = !!linea.modificado;
}

function quitarLineaForm(idx) {
  state.lineasForm.splice(idx, 1);
  if (state.editingLineaIdx === idx) resetLineaForm();
  renderLineasFormTable();
}

// Lee el M3 del remito (camión) tal cual está escrito en el cabezal en
// este momento, aunque todavía no se haya guardado el remito.
function getM3RemitoCabezal() {
  const form = $("#formRemito");
  const raw = (form.m3Remito.value || "").trim();
  if (!raw) return null;
  const v = parseFloat(raw.replace(",", "."));
  return isNaN(v) || v <= 0 ? null : v;
}

// El cabezal se considera completo (y recién ahí se puede empezar a
// agregar elementos) cuando están Fecha, N° de Remito y M3 del remito.
function cabezalCompleto() {
  const form = $("#formRemito");
  return !!form.fecha.value.trim() && !!form.remitoNro.value.trim() && getM3RemitoCabezal() !== null;
}

// Bloquea/desbloquea el subformulario "Agregar elemento al remito" según
// si el cabezal ya está completo. Para reducir el margen de error: así no
// se puede empezar a cargar elementos sin antes tener Fecha, N° de Remito
// y M3 del remito.
function actualizarBloqueoLinea() {
  const completo = cabezalCompleto();
  const fieldset = $("#lineaFieldset");
  if (fieldset) fieldset.disabled = !completo;
  const hint = $("#lineaBloqueadaHint");
  if (hint) hint.style.display = completo ? "none" : "block";
}

// ¿Ya existe otro remito con el mismo N° para el mismo proveedor en esta
// obra? (excluilId es el remito que se está editando, para no compararse
// contra sí mismo).
function remitoNroDuplicado(remitoNro, proveedorId, excluirId) {
  const nro = (remitoNro || "").trim();
  if (!nro) return false;
  return state.remitos.some((r) =>
    r.id !== excluirId &&
    (r.proveedorId || "") === (proveedorId || "") &&
    (r.remitoNro || "").trim().toLowerCase() === nro.toLowerCase()
  );
}

function renderLineasFormTable() {
  const tbody = $("#tablaLineasForm tbody");
  tbody.innerHTML = "";
  if (state.lineasForm.length === 0) {
    $("#lineasFormEmpty").style.display = "block";
    $("#tablaLineasFormWrap").style.display = "none";
  } else {
    $("#lineasFormEmpty").style.display = "none";
    $("#tablaLineasFormWrap").style.display = "block";
  }
  let total = 0;
  state.lineasForm.forEach((linea, idx) => {
    total += linea.volumen || 0;
    const elem = byId(state.catalogo.elementos, linea.elementoId);
    const cuad = byId(state.catalogo.cuadrillas, linea.cuadrillaId);
    const tr = el("tr");
    tr.appendChild(el("td", {}, elem ? `${elem.codigo} - ${elem.nombre}` : "-"));
    tr.appendChild(el("td", {}, [linea.nomenclatura, linea.sector].filter(Boolean).join(" - ") || "-"));
    tr.appendChild(el("td", {}, fmtM3(linea.volumen)));
    tr.appendChild(el("td", {}, cuad ? cuad.nombre : "-"));
    tr.appendChild(el("td", {}, linea.bombeado ? el("span", { class: "badge si" }, "SI") : el("span", { class: "badge no" }, "NO")));
    const tdAcc = el("td");
    const btnEd = el("button", { class: "ghost", title: "Editar" }, "✎");
    btnEd.addEventListener("click", () => editarLineaForm(idx));
    const btnDel = el("button", { class: "ghost danger", title: "Quitar" }, "✕");
    btnDel.addEventListener("click", () => quitarLineaForm(idx));
    tdAcc.appendChild(btnEd);
    tdAcc.appendChild(btnDel);
    tr.appendChild(tdAcc);
    tbody.appendChild(tr);
  });
  const totalDiv = $("#lineasFormTotal");
  const totalTxt = state.lineasForm.length ? `${state.lineasForm.length} elemento(s) — Total ${fmtM3(total)} m³` : "";
  const m3Remito = getM3RemitoCabezal();
  totalDiv.innerHTML = "";
  if (totalTxt) totalDiv.appendChild(document.createTextNode(totalTxt));
  if (m3Remito !== null) {
    const restante = round2(m3Remito - total);
    let color = "";
    if (restante < -0.001) color = "color:var(--danger);font-weight:600";
    else if (Math.abs(restante) < 0.001) color = "color:var(--primary);font-weight:600";
    if (totalTxt) totalDiv.appendChild(document.createTextNode(" — "));
    totalDiv.appendChild(el("span", color ? { style: color } : {}, `Disponible: ${fmtM3(restante)} m³ de ${fmtM3(m3Remito)} m³`));
  }
}

// ---------- Remito (encabezado) ----------
function resetRemitoForm() {
  state.editingRemitoId = null;
  state.lineasForm = [];
  state.editingLineaIdx = null;
  $("#formRemito").reset();
  $("#formRemitoTitulo").textContent = "Nuevo remito";
  $("#btnCancelarEdicion").style.display = "none";
  $("#fecha").value = todayISO();
  $("#chkAutoProbetas").checked = true;
  aplicarAutoProbetas();
  resetLineaForm();
  renderLineasFormTable();
  updateHormigonPreview();
  actualizarBloqueoLinea();
}

async function onSubmitRemito(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const get = (k) => (fd.get(k) || "").toString().trim();
  const getNum = (k) => {
    const v = get(k);
    return v === "" ? null : parseFloat(v.replace(",", "."));
  };
  const getInt = (k) => {
    const v = get(k);
    return v === "" ? null : parseInt(v, 10);
  };

  if (!get("fecha")) return toast("Falta la fecha", "error");
  if (!get("remitoNro")) return toast("Falta el N° de remito", "error");
  const m3RemitoVal = getNum("m3Remito");
  if (m3RemitoVal === null || m3RemitoVal <= 0) return toast("Falta el M3 del remito (camión)", "error");
  if (state.lineasForm.length === 0) return toast("Agregá al menos un elemento a este remito", "error");

  const remitoId = state.editingRemitoId || uid("rem");

  if (remitoNroDuplicado(get("remitoNro"), get("proveedorId"), remitoId)) {
    return toast(`Ya existe un remito N° ${get("remitoNro")} para este proveedor en esta obra`, "error");
  }

  const totalLineas = round2(state.lineasForm.reduce((a, l) => a + (l.volumen || 0), 0));
  if (Math.abs(totalLineas - round2(m3RemitoVal)) > 0.001) {
    return toast(
      `La suma de los elementos (${fmtM3(totalLineas)} m³) no coincide con el M3 del remito (${fmtM3(m3RemitoVal)} m³). Si sobró hormigón, cargalo como un elemento "Desperdicio".`,
      "error"
    );
  }

  const remito = {
    id: remitoId,
    obraId: state.obraId,
    fecha: get("fecha"),
    proveedorId: get("proveedorId"),
    hormigonId: get("hormigonId"),
    remitoNro: get("remitoNro"),
    m3Remito: getNum("m3Remito"),
    unidadMovil: get("unidadMovil"),
    horaAObra: get("horaAObra"),
    horaEnObra: get("horaEnObra"),
    horaDescarga: get("horaDescarga"),
    horaFinDescarga: get("horaFinDescarga"),
    probeta1: getInt("probeta1"),
    probeta2: getInt("probeta2"),
    probeta3: getInt("probeta3"),
  };
  await DB.put("remitos", remito);

  // Reemplazar las líneas: borrar las viejas que ya no están, guardar las actuales
  const idsNuevos = new Set(state.lineasForm.map((l) => l.id));
  const viejasDeEsteRemito = state.lineas.filter((l) => l.remitoId === remitoId);
  for (const vieja of viejasDeEsteRemito) {
    if (!idsNuevos.has(vieja.id)) await DB.delete("remitoLineas", vieja.id);
  }
  for (const linea of state.lineasForm) {
    await DB.put("remitoLineas", { ...linea, remitoId, obraId: state.obraId });
  }

  if ($("#chkAutoProbetas").checked) await avanzarContadorProbetas();
  await loadObras();

  await loadObraData(state.obraId);
  resetRemitoForm();
  renderRemitosTable();
  renderTarjetaDiaria();
  renderResumenMensual();
  renderProbetas();
  toast(state.editingRemitoId ? "Remito actualizado" : "Remito cargado", "ok");
}

function editarRemito(remitoId) {
  const r = byId(state.remitos, remitoId);
  if (!r) return;
  state.editingRemitoId = remitoId;
  state.lineasForm = state.lineas.filter((l) => l.remitoId === remitoId).map((l) => ({ ...l }));
  state.editingLineaIdx = null;

  const form = $("#formRemito");
  form.fecha.value = r.fecha;
  form.proveedorId.value = r.proveedorId || "";
  form.hormigonId.value = r.hormigonId || "";
  form.remitoNro.value = r.remitoNro || "";
  form.m3Remito.value = r.m3Remito ?? "";
  form.unidadMovil.value = r.unidadMovil || "";
  form.horaAObra.value = r.horaAObra || "";
  form.horaEnObra.value = r.horaEnObra || "";
  form.horaDescarga.value = r.horaDescarga || "";
  form.horaFinDescarga.value = r.horaFinDescarga || "";
  form.probeta1.value = r.probeta1 ?? "";
  form.probeta2.value = r.probeta2 ?? "";
  form.probeta3.value = r.probeta3 ?? "";
  $("#chkAutoProbetas").checked = false;

  $("#formRemitoTitulo").textContent = `Editar remito${r.remitoNro ? " N° " + r.remitoNro : ""}`;
  $("#btnCancelarEdicion").style.display = "inline-block";
  resetLineaForm();
  renderLineasFormTable();
  updateHormigonPreview();
  actualizarBloqueoLinea();
  showTab("remitos");
  form.scrollIntoView({ behavior: "smooth" });
}

async function borrarRemito(remitoId) {
  if (!confirm("¿Borrar este remito y todos sus elementos cargados?")) return;
  const lineasDelRemito = state.lineas.filter((l) => l.remitoId === remitoId);
  for (const l of lineasDelRemito) await DB.delete("remitoLineas", l.id);
  await DB.delete("remitos", remitoId);
  await loadObraData(state.obraId);
  renderRemitosTable();
  renderTarjetaDiaria();
  renderResumenMensual();
  renderProbetas();
  toast("Remito borrado", "ok");
}

function esDesperdicio(linea) {
  const elem = byId(state.catalogo.elementos, linea.elementoId);
  return !!elem && elem.tipoElemento.toUpperCase() === "DESPERDICIO";
}

// Elementos marcados en Referencias como "se paga por m2" (ej. Contrapiso):
// se muestran aparte y NO suman al Total m3 del día/mes, ni a la
// productividad HH/m3 (ver volumenPorGrupo), porque esa mano de obra se
// paga/mide por m2 y mezclarla distorsiona ambos números.
function esPagaPorM2(linea) {
  const elem = byId(state.catalogo.elementos, linea.elementoId);
  return !!elem && !!elem.pagaPorM2;
}

function lineaConRemito(linea) {
  return { linea, remito: byId(state.remitos, linea.remitoId) };
}

function lineasFiltradas() {
  return state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    if (!r) return false;
    if (state.filtro.desde && r.fecha < state.filtro.desde) return false;
    if (state.filtro.hasta && r.fecha > state.filtro.hasta) return false;
    if (state.filtro.elementoId && l.elementoId !== state.filtro.elementoId) return false;
    if (state.filtro.proveedorId && r.proveedorId !== state.filtro.proveedorId) return false;
    return true;
  });
}

function renderRemitosTable() {
  const rows = lineasFiltradas().sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    return ra.fecha < rb.fecha ? 1 : ra.fecha > rb.fecha ? -1 : 0;
  });
  const tbody = $("#tablaRemitos tbody");
  tbody.innerHTML = "";

  if (rows.length === 0) {
    $("#remitosEmpty").style.display = "block";
    $("#tablaRemitosWrap").style.display = "none";
    return;
  }
  $("#remitosEmpty").style.display = "none";
  $("#tablaRemitosWrap").style.display = "block";

  let totalM3 = 0;
  rows.forEach((l) => {
    const r = byId(state.remitos, l.remitoId);
    totalM3 += l.volumen || 0;
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const prov = byId(state.catalogo.proveedores, r.proveedorId);
    const cuad = byId(state.catalogo.cuadrillas, l.cuadrillaId);
    const desperdicio = esDesperdicio(l);
    const otrasLineas = state.lineas.filter((x) => x.remitoId === r.id).length;

    const tr = el("tr");
    tr.appendChild(el("td", {}, fmtFechaCorta(r.fecha)));
    tr.appendChild(el("td", {}, desperdicio
      ? el("span", { class: "badge desperdicio" }, "Desperdicio")
      : (elem ? `${elem.codigo} - ${elem.nombre}` : "-")));
    tr.appendChild(el("td", {}, [l.nomenclatura, l.sector].filter(Boolean).join(" - ") || "-"));
    tr.appendChild(el("td", {}, horm ? `${horm.codigo} (${horm.resistencia})` : "-"));
    tr.appendChild(el("td", {}, fmtM3(l.volumen)));
    tr.appendChild(el("td", {}, prov ? prov.nombre : "-"));
    tr.appendChild(el("td", {}, [r.remitoNro || "-", otrasLineas > 1 ? el("span", { class: "badge no", title: "Este remito tiene varios elementos" }, `+${otrasLineas - 1}`) : null]));
    tr.appendChild(el("td", {}, r.m3Remito != null ? fmtM3(r.m3Remito) : "-"));
    tr.appendChild(el("td", {}, cuad ? cuad.nombre : "-"));
    tr.appendChild(el("td", {}, l.bombeado ? el("span", { class: "badge si" }, "SI") : el("span", { class: "badge no" }, "NO")));
    tr.appendChild(el("td", {}, (elem && elem.permiteModificado)
      ? (l.modificado ? el("span", { class: "badge desperdicio" }, "Modificado") : el("span", { class: "badge no" }, "No"))
      : "-"));
    const tdAcc = el("td");
    if (esAdmin()) {
      const btnEd = el("button", { class: "ghost", title: "Editar remito completo" }, "✎");
      btnEd.addEventListener("click", () => editarRemito(r.id));
      const btnDel = el("button", { class: "ghost danger", title: "Borrar remito completo" }, "✕");
      btnDel.addEventListener("click", () => borrarRemito(r.id));
      tdAcc.appendChild(btnEd);
      tdAcc.appendChild(btnDel);
    } else {
      tdAcc.appendChild(document.createTextNode("-"));
    }
    tr.appendChild(tdAcc);
    tbody.appendChild(tr);
  });

  $("#remitosResumenFiltro").textContent = `${rows.length} elemento(s) cargado(s) — Total ${fmtM3(totalM3)} m³`;
}

// =========================================================
//  TARJETA DIARIA
// =========================================================
async function saveDiaExtra() {
  const fecha = state.tarjetaFecha;
  let dia = state.diasExtra.find((d) => d.fecha === fecha);
  if (!dia) {
    dia = { id: uid("dia"), obraId: state.obraId, fecha };
    state.diasExtra.push(dia);
  }
  dia.temperatura = $("#tarjetaTemperatura").value ? parseFloat($("#tarjetaTemperatura").value) : null;
  await DB.put("diasExtra", dia);
}

function lineasDelDia(fecha) {
  return state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    return r && r.fecha === fecha;
  });
}

function calcularKPIs(rows) {
  let totalM3 = 0, m3Bombeado = 0, m3Desperdicio = 0, m3PagaPorM2 = 0, m2PagaPorM2 = 0;
  rows.forEach((l) => {
    const v = l.volumen || 0;
    if (esPagaPorM2(l)) {
      // Se paga/mide por m2 (ej. Contrapiso): se muestra aparte, no entra
      // al Total m3 ni al resto de los KPIs.
      m3PagaPorM2 += v;
      m2PagaPorM2 += l.areaM2 || 0;
      return;
    }
    totalM3 += v;
    if (l.bombeado) m3Bombeado += v;
    if (esDesperdicio(l)) m3Desperdicio += v;
  });
  return {
    totalM3,
    m3Bombeado,
    m3Desperdicio,
    pctDesperdicio: totalM3 ? m3Desperdicio / totalM3 : 0,
    cantLineas: rows.length,
    m3PagaPorM2,
    m2PagaPorM2,
  };
}

function renderTarjetaDiaria() {
  $("#tarjetaFecha").value = state.tarjetaFecha;
  const dia = state.diasExtra.find((d) => d.fecha === state.tarjetaFecha);
  $("#tarjetaTemperatura").value = dia?.temperatura ?? "";

  const obra = byId(state.obras, state.obraId);
  $("#tarjetaObraNombre").textContent = obra ? obra.nombre : "";
  $("#tarjetaObraUbicacion").textContent = obra ? (obra.ubicacion || "") : "";

  const rows = lineasDelDia(state.tarjetaFecha);
  const k = calcularKPIs(rows);

  $("#kpiTarjetaTotalM3").textContent = fmtM3(k.totalM3);
  $("#kpiTarjetaBombeado").textContent = fmtM3(k.m3Bombeado);
  $("#kpiTarjetaDesperdicio").textContent = fmtM3(k.m3Desperdicio);
  $("#kpiTarjetaPctDesperdicio").textContent = fmtPct(k.pctDesperdicio);
  $("#kpiTarjetaCantRemitos").textContent = new Set(rows.map((l) => l.remitoId)).size;

  const tbody = $("#tablaTarjeta tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    $("#tarjetaEmpty").style.display = "block";
    $("#tablaTarjetaWrap").style.display = "none";
    return;
  }
  $("#tarjetaEmpty").style.display = "none";
  $("#tablaTarjetaWrap").style.display = "block";

  rows.forEach((l) => {
    const r = byId(state.remitos, l.remitoId);
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const prov = byId(state.catalogo.proveedores, r.proveedorId);
    const tr = el("tr");
    tr.appendChild(el("td", {}, horm ? `${horm.codigo} (${horm.resistencia})${l.bombeado ? " · BOM" : ""}` : "-"));
    tr.appendChild(el("td", {}, fmtM3(l.volumen)));
    tr.appendChild(el("td", {}, elem ? `${elem.tipoElemento} - ${elem.nombre}` : "-"));
    tr.appendChild(el("td", {}, prov ? prov.nombre : "-"));
    tr.appendChild(el("td", {}, [l.nomenclatura, l.sector].filter(Boolean).join(" - ") || "-"));
    tr.appendChild(el("td", {}, r.remitoNro || "-"));
    tbody.appendChild(tr);
  });
}

// =========================================================
//  RESUMEN MENSUAL
// =========================================================
function lineasDelMes(yyyyMm) {
  return state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    return r && r.fecha && r.fecha.slice(0, 7) === yyyyMm;
  });
}

function calcularResumenMensual(rows) {
  const k = calcularKPIs(rows);
  const porElemento = {};
  const porProveedor = {};
  const diasConHormigon = new Set();
  const remitosDelMes = new Set();

  rows.forEach((l) => {
    const r = byId(state.remitos, l.remitoId);
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const key = elem ? `${elem.tipoElemento} - ${elem.nombre}` : "Sin elemento";
    porElemento[key] = (porElemento[key] || 0) + (l.volumen || 0);

    const prov = byId(state.catalogo.proveedores, r.proveedorId);
    const pkey = prov ? prov.nombre : "Sin proveedor";
    porProveedor[pkey] = (porProveedor[pkey] || 0) + (l.volumen || 0);

    if (r.fecha) diasConHormigon.add(r.fecha);
    remitosDelMes.add(r.id);
  });

  return {
    ...k,
    porElemento,
    porProveedor,
    diasConHormigon: diasConHormigon.size,
    cantRemitos: remitosDelMes.size,
    promedioPorDia: diasConHormigon.size ? k.totalM3 / diasConHormigon.size : 0,
  };
}

// ---------- Productividad / HH por m3 ----------
function diasLaborablesDelMes(yyyyMm, feriados = 0) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const ultimo = new Date(y, m, 0).getDate();
  let cnt = 0;
  for (let d = 1; d <= ultimo; d++) {
    const dow = new Date(y, m - 1, d).getDay(); // 0=domingo, 6=sabado
    if (dow !== 0 && dow !== 6) cnt++;
  }
  return Math.max(0, cnt - (feriados || 0));
}

function getPersonalMensual(mes) {
  let p = state.personalMensual.find((x) => x.mes === mes);
  if (!p) {
    p = { id: uid("per"), obraId: state.obraId, mes, horasPromedioDia: 8.8, diasNoLaborables: 0 };
  }
  return p;
}

async function guardarPersonalMensual() {
  const mes = state.resumenMes;
  const p = getPersonalMensual(mes);
  p.obraId = state.obraId;
  p.mes = mes;
  p.horasPromedioDia = parseFloat($("#pm_horas").value) || 8.8;
  p.diasNoLaborables = parseInt($("#pm_feriados").value, 10) || 0;
  await DB.put("personalMensual", p);
  const idx = state.personalMensual.findIndex((x) => x.id === p.id);
  if (idx >= 0) state.personalMensual[idx] = p; else state.personalMensual.push(p);
  renderProductividadMensual(lineasDelMes(mes));
}

function volumenPorGrupo(rows, grupo) {
  let total = 0;
  rows.forEach((l) => {
    if (esDesperdicio(l) || esPagaPorM2(l)) return;
    const cuad = byId(state.catalogo.cuadrillas, l.cuadrillaId);
    if (cuad && cuad.grupo === grupo) total += l.volumen || 0;
  });
  return total;
}

const fmtHH = (v) => (v === null || v === undefined ? "-" : v.toLocaleString("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Cálculo puro de productividad (sin tocar el DOM), para poder reutilizarlo
// tanto en la pantalla como en la comparación con el mes anterior y el PDF.
function calcularProductividad(mes, rows) {
  const p = getPersonalMensual(mes);
  const personalTorre = personalPorEquipo("TORRE");
  const personalBasamento = personalPorEquipo("BASAMENTO");
  const personalHerreros = personalPorEquipo("HERREROS");
  const personalIndirectos = personalPorEquipo("INDIRECTOS");

  const diasLaborables = diasLaborablesDelMes(mes, p.diasNoLaborables);
  const hhTorre = personalTorre * p.horasPromedioDia * diasLaborables;
  const hhBasamento = personalBasamento * p.horasPromedioDia * diasLaborables;
  const hhHerreros = personalHerreros * p.horasPromedioDia * diasLaborables;
  const hhIndirectos = personalIndirectos * p.horasPromedioDia * diasLaborables;

  const m3Torre = volumenPorGrupo(rows, "TORRE");
  const m3Basamento = volumenPorGrupo(rows, "BASAMENTO");
  const m3Directo = m3Torre + m3Basamento;

  return {
    p, personalTorre, personalBasamento, personalHerreros, personalIndirectos,
    diasLaborables, m3Torre, m3Basamento, m3Directo,
    hhm3GeneralDirectos: m3Directo ? (hhTorre + hhBasamento + hhHerreros) / m3Directo : null,
    hhm3GeneralConIndirectos: m3Directo ? (hhTorre + hhBasamento + hhHerreros + hhIndirectos) / m3Directo : null,
    hhm3TorreDirectos: m3Torre ? hhTorre / m3Torre : null,
    hhm3TorreConIndirectos: m3Torre ? (hhTorre + hhIndirectos / 2) / m3Torre : null,
    hhm3BasamentoDirectos: m3Basamento ? hhBasamento / m3Basamento : null,
    hhm3BasamentoConIndirectos: m3Basamento ? (hhBasamento + hhIndirectos / 2) / m3Basamento : null,
  };
}

function renderProductividadMensual(rows) {
  const p = getPersonalMensual(state.resumenMes);
  $("#pm_horas").value = p.horasPromedioDia || 8.8;
  $("#pm_feriados").value = p.diasNoLaborables || 0;

  const prod = calcularProductividad(state.resumenMes, rows);
  $("#pm_cant_torre").textContent = prod.personalTorre;
  $("#pm_cant_basamento").textContent = prod.personalBasamento;
  $("#pm_cant_herreros").textContent = prod.personalHerreros;
  $("#pm_cant_indirectos").textContent = prod.personalIndirectos;

  $("#pm_diasLaborables").textContent = prod.diasLaborables;
  $("#pm_m3Torre").textContent = fmtM3(prod.m3Torre);
  $("#pm_m3Basamento").textContent = fmtM3(prod.m3Basamento);

  $("#hh_general_directos").textContent = fmtHH(prod.hhm3GeneralDirectos);
  $("#hh_general_indirectos").textContent = fmtHH(prod.hhm3GeneralConIndirectos);
  $("#hh_torre_directos").textContent = fmtHH(prod.hhm3TorreDirectos);
  $("#hh_torre_indirectos").textContent = fmtHH(prod.hhm3TorreConIndirectos);
  $("#hh_basamento_directos").textContent = fmtHH(prod.hhm3BasamentoDirectos);
  $("#hh_basamento_indirectos").textContent = fmtHH(prod.hhm3BasamentoConIndirectos);
}

// ---------- Comparación con el mes anterior ----------
function mesAnteriorStr(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function renderComparacionMensual() {
  const cont = $("#resumenComparacion");
  if (!cont) return;
  cont.innerHTML = "";
  const mesAct = state.resumenMes;
  const mesAnt = mesAnteriorStr(mesAct);
  const rowsAct = lineasDelMes(mesAct);
  const rowsAnt = lineasDelMes(mesAnt);

  if (rowsAnt.length === 0) {
    cont.appendChild(el("div", { class: "hint" }, `Todavía no hay remitos cargados en ${mesAnt} para comparar. En cuanto tengas datos de un mes anterior, la comparación aparece sola acá.`));
    return;
  }

  const rAct = calcularResumenMensual(rowsAct);
  const rAnt = calcularResumenMensual(rowsAnt);
  const prodAct = calcularProductividad(mesAct, rowsAct);
  const prodAnt = calcularProductividad(mesAnt, rowsAnt);

  const pctVar = (act, ant) => (act === null || ant === null || !ant) ? null : ((act - ant) / ant) * 100;
  // "masEsMejor" indica si un aumento es una mejora (más m3 producidos) o
  // un empeoramiento (más horas-hombre por m3 = menos productividad), para
  // pintar la variación en verde/rojo con el sentido correcto en cada fila.
  const filas = [
    ["Total m³ del mes", rAct.totalM3, rAnt.totalM3, true],
    ["Promedio m³/día", rAct.promedioPorDia, rAnt.promedioPorDia, true],
    ["HH/m³ general (con indirectos)", prodAct.hhm3GeneralConIndirectos, prodAnt.hhm3GeneralConIndirectos, false],
  ];

  const table = el("table");
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, ""), el("th", {}, mesAct), el("th", {}, mesAnt), el("th", {}, "Variación"),
  ])));
  const tbody = el("tbody");
  filas.forEach(([label, act, ant, masEsMejor]) => {
    const variacion = pctVar(act, ant);
    const tr = el("tr");
    tr.appendChild(el("td", {}, label));
    tr.appendChild(el("td", {}, act == null ? "-" : fmtHH(act)));
    tr.appendChild(el("td", {}, ant == null ? "-" : fmtHH(ant)));
    const varLabel = variacion === null ? "-" : `${variacion >= 0 ? "+" : ""}${variacion.toFixed(1)}%`;
    const esMejora = variacion === null ? null : (masEsMejor ? variacion >= 0 : variacion <= 0);
    tr.appendChild(el("td", {}, variacion === null ? el("span", {}, "-") : el("span", { class: esMejora ? "badge si" : "badge desperdicio" }, varLabel)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  cont.appendChild(table);
}

function renderResumenMensual() {
  $("#resumenMes").value = state.resumenMes;
  const rows = lineasDelMes(state.resumenMes);
  const r = calcularResumenMensual(rows);

  $("#kpiResumenTotalM3").textContent = fmtM3(r.totalM3);
  $("#kpiResumenBombeado").textContent = fmtM3(r.m3Bombeado);
  $("#kpiResumenDesperdicio").textContent = fmtM3(r.m3Desperdicio);
  $("#kpiResumenPctDesperdicio").textContent = fmtPct(r.pctDesperdicio);
  $("#kpiResumenDias").textContent = r.diasConHormigon;
  $("#kpiResumenPromedio").textContent = fmtM3(r.promedioPorDia);
  $("#kpiResumenCantRemitos").textContent = r.cantRemitos;
  const tienePagaM2 = r.m3PagaPorM2 > 0 || r.m2PagaPorM2 > 0;
  $("#kpiResumenPagaM2Card").style.display = tienePagaM2 ? "" : "none";
  if (tienePagaM2) {
    $("#kpiResumenPagaM2").textContent = `${fmtM3(r.m3PagaPorM2)} m³ (${fmtM3(r.m2PagaPorM2)} m²)`;
  }

  const rend = (contId, obj) => {
    const cont = $(contId);
    cont.innerHTML = "";
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      cont.appendChild(el("div", { class: "hint" }, "Sin datos en el mes seleccionado."));
      return;
    }
    const maxVal = Math.max(...entries.map((e) => e[1]));
    entries.forEach(([label, val]) => {
      const pct = maxVal ? (val / maxVal) * 100 : 0;
      const row = el("div", { style: "margin-bottom:8px" });
      row.appendChild(el("div", { class: "row between" }, [
        el("span", {}, label),
        el("strong", {}, fmtM3(val) + " m³"),
      ]));
      row.appendChild(el("div", { style: "background:#eef0f2;border-radius:4px;height:8px;overflow:hidden" },
        el("div", { style: `background:var(--primary);height:8px;width:${pct}%` })
      ));
      cont.appendChild(row);
    });
  };
  rend("#resumenPorElemento", r.porElemento);
  rend("#resumenPorProveedor", r.porProveedor);

  renderProductividadMensual(rows);
  renderComparacionMensual();

  const tbody = $("#tablaResumenDetalle tbody");
  tbody.innerHTML = "";
  const rowsOrdenadas = [...rows].sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    return ra.fecha < rb.fecha ? -1 : 1;
  });
  if (rowsOrdenadas.length === 0) {
    $("#resumenDetalleEmpty").style.display = "block";
    $("#tablaResumenDetalleWrap").style.display = "none";
    return;
  }
  $("#resumenDetalleEmpty").style.display = "none";
  $("#tablaResumenDetalleWrap").style.display = "block";
  rowsOrdenadas.forEach((l) => {
    const rr = byId(state.remitos, l.remitoId);
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const horm = byId(state.catalogo.hormigones, rr.hormigonId);
    const prov = byId(state.catalogo.proveedores, rr.proveedorId);
    const tr = el("tr");
    tr.appendChild(el("td", {}, fmtFechaCorta(rr.fecha)));
    tr.appendChild(el("td", {}, elem ? `${elem.codigo} - ${elem.nombre}` : "-"));
    tr.appendChild(el("td", {}, [l.nomenclatura, l.sector].filter(Boolean).join(" - ") || "-"));
    tr.appendChild(el("td", {}, horm ? `${horm.codigo} (${horm.resistencia})` : "-"));
    tr.appendChild(el("td", {}, fmtM3(l.volumen)));
    tr.appendChild(el("td", {}, prov ? prov.nombre : "-"));
    tr.appendChild(el("td", {}, rr.remitoNro || "-"));
    tbody.appendChild(tr);
  });
}

// =========================================================
//  PROBETAS
// =========================================================
function remitosConProbetas() {
  return state.remitos.filter((r) => (r.probeta1 || r.probeta2 || r.probeta3) &&
    (!state.probetasFiltro.desde || r.fecha >= state.probetasFiltro.desde) &&
    (!state.probetasFiltro.hasta || r.fecha <= state.probetasFiltro.hasta)
  ).sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

function renderProbetas() {
  const rows = remitosConProbetas();
  const tbody = $("#tablaProbetas tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    $("#probetasEmpty").style.display = "block";
    $("#tablaProbetasWrap").style.display = "none";
    return;
  }
  $("#probetasEmpty").style.display = "none";
  $("#tablaProbetasWrap").style.display = "block";

  rows.forEach((r) => {
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const elementos = state.lineas.filter((l) => l.remitoId === r.id)
      .map((l) => byId(state.catalogo.elementos, l.elementoId))
      .filter(Boolean).map((e) => e.nombre);
    const tr = el("tr");
    tr.appendChild(el("td", {}, fmtFechaCorta(r.fecha)));
    tr.appendChild(el("td", {}, r.remitoNro || "-"));
    tr.appendChild(el("td", {}, horm ? `${horm.codigo} (${horm.resistencia})` : "-"));
    tr.appendChild(el("td", {}, [...new Set(elementos)].join(", ") || "-"));
    tr.appendChild(el("td", {}, r.probeta1 ?? "-"));
    tr.appendChild(el("td", {}, r.probeta2 ?? "-"));
    tr.appendChild(el("td", {}, r.probeta3 ?? "-"));
    tbody.appendChild(tr);
  });
}

function exportarProbetasExcel() {
  const obra = byId(state.obras, state.obraId);
  const rows = remitosConProbetas();
  if (rows.length === 0) return toast("No hay remitos con probetas en ese rango", "error");
  const data = rows.map((r) => {
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const elementos = state.lineas.filter((l) => l.remitoId === r.id)
      .map((l) => byId(state.catalogo.elementos, l.elementoId)).filter(Boolean)
      .map((e) => e.nombre);
    return {
      "Fecha": r.fecha,
      "N° Remito": r.remitoNro || "",
      "Tipo de hormigón": horm ? `${horm.codigo} (${horm.resistencia})` : "",
      "Elemento(s)": [...new Set(elementos)].join(", "),
      "Probeta 1": r.probeta1 ?? "",
      "Probeta 2": r.probeta2 ?? "",
      "Probeta 3": r.probeta3 ?? "",
    };
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = autoWidth(data);
  XLSX.utils.book_append_sheet(wb, ws, "Probetas");
  descargarWorkbook(wb, `Reporte de probetas - ${obra?.nombre || ""}.xlsx`);
}

// =========================================================
//  EXPORTAR A EXCEL (SheetJS)
// =========================================================
function lineaARow(linea) {
  const r = byId(state.remitos, linea.remitoId) || {};
  const elem = byId(state.catalogo.elementos, linea.elementoId);
  const horm = byId(state.catalogo.hormigones, r.hormigonId);
  const prov = byId(state.catalogo.proveedores, r.proveedorId);
  const cuad = byId(state.catalogo.cuadrillas, linea.cuadrillaId);
  const coloc = byId(state.catalogo.colocacion, linea.colocacionId);
  return {
    "Fecha": r.fecha || "",
    "N° Remito": r.remitoNro || "",
    "Elemento": elem ? elem.codigo : "",
    "Nombre": elem ? elem.nombre : "",
    "Nomenclatura": linea.nomenclatura || "",
    "Sector": linea.sector || "",
    "Volumen (m3)": linea.volumen ?? "",
    "Tipo H°": horm ? horm.codigo : "",
    "Resistencia": horm ? horm.resistencia : "",
    "Proveedor": prov ? prov.nombre : "",
    "M3 remito": r.m3Remito ?? "",
    "Cuadrilla": cuad ? cuad.nombre : "",
    "Bombeado": linea.bombeado ? "SI" : "NO",
    "Modificado": (elem && elem.permiteModificado) ? (linea.modificado ? "SI" : "NO") : "",
    "Tipo colocación": coloc ? coloc.nombre : "",
    "Tipo elemento": elem ? elem.tipoElemento : "",
    "Observaciones": linea.observaciones || "",
    "Asentamiento (cm)": linea.asentamiento ?? "",
    "Nivel de fondo": linea.nivelFondo ?? "",
    "Largo (cm)": linea.largoCm ?? "",
    "Ancho (cm)": linea.anchoCm ?? "",
    "Altura (cm)": linea.alturaCm ?? "",
    "Área (m2)": linea.areaM2 ?? "",
    "Unidad móvil": r.unidadMovil || "",
    "A obra": r.horaAObra || "",
    "En obra": r.horaEnObra || "",
    "Descarga": r.horaDescarga || "",
    "Fin descarga": r.horaFinDescarga || "",
    "Probeta 1": r.probeta1 ?? "",
    "Probeta 2": r.probeta2 ?? "",
    "Probeta 3": r.probeta3 ?? "",
  };
}

// ---------- Export simplificado "Control de remitos" (para control vs. facturas) ----------
function remitoARowControl(r) {
  const horm = byId(state.catalogo.hormigones, r.hormigonId);
  const lineasDeEste = state.lineas.filter((l) => l.remitoId === r.id);
  const bombeado = lineasDeEste.some((l) => l.bombeado);
  return {
    "Fecha": r.fecha || "",
    "N° Remito": r.remitoNro || "",
    "M3 remito": r.m3Remito ?? "",
    "Tipo de hormigón": horm ? `${horm.codigo} (${horm.resistencia})` : "",
    "Bombeado/Volcado": bombeado ? "Bombeado" : "Volcado",
  };
}

function exportarControlRemitosExcel() {
  const obra = byId(state.obras, state.obraId);
  const desde = $("#expDesde").value;
  const hasta = $("#expHasta").value;
  let rows = [...state.remitos];
  if (desde) rows = rows.filter((r) => r.fecha >= desde);
  if (hasta) rows = rows.filter((r) => r.fecha <= hasta);
  rows = rows.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));

  if (rows.length === 0) return toast("No hay remitos en ese rango", "error");

  const data = rows.map(remitoARowControl);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = autoWidth(data);
  XLSX.utils.book_append_sheet(wb, ws, "Control remitos");
  const rango = desde || hasta ? ` (${desde || "inicio"} a ${hasta || "hoy"})` : "";
  descargarWorkbook(wb, `Control de remitos - ${obra?.nombre || ""}${rango}.xlsx`);
}

function autoWidth(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  return keys.map((k) => ({
    wch: Math.min(40, Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2),
  }));
}

function descargarWorkbook(wb, nombreArchivo) {
  XLSX.writeFile(wb, nombreArchivo);
}

function exportarTarjetaDiariaExcel() {
  const obra = byId(state.obras, state.obraId);
  const rows = lineasDelDia(state.tarjetaFecha);
  if (rows.length === 0) return toast("No hay remitos ese día", "error");
  const dia = state.diasExtra.find((d) => d.fecha === state.tarjetaFecha);
  const k = calcularKPIs(rows);

  const wb = XLSX.utils.book_new();
  const encabezado = [
    ["Tarjeta diaria de hormigonado"],
    ["Obra", obra?.nombre || "", "Ubicación", obra?.ubicacion || "", "Fecha", fmtFechaCorta(state.tarjetaFecha)],
    ["Temperatura", dia?.temperatura ?? ""],
    ["Total M3", k.totalM3, "M3 Bombeado", k.m3Bombeado, "M3 Desperdicio", k.m3Desperdicio, "% Desperdicio", k.pctDesperdicio],
    [],
  ];
  const detalle = rows.map(lineaARow);
  const wsData = XLSX.utils.aoa_to_sheet(encabezado);
  XLSX.utils.sheet_add_json(wsData, detalle, { origin: -1 });
  wsData["!cols"] = autoWidth(detalle);
  XLSX.utils.book_append_sheet(wb, wsData, "Tarjeta diaria");
  descargarWorkbook(wb, `Tarjeta diaria ${state.tarjetaFecha} - ${obra?.nombre || ""}.xlsx`);
}

function fmtFechaArchivo(iso) {
  return (iso || todayISO()).replace(/-/g, ".");
}

function exportarTarjetaDiariaPDF() {
  const obra = byId(state.obras, state.obraId);
  const rows = lineasDelDia(state.tarjetaFecha);
  if (rows.length === 0) return toast("No hay remitos ese día", "error");
  const dia = state.diasExtra.find((d) => d.fecha === state.tarjetaFecha);
  const k = calcularKPIs(rows);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  let y = 10;

  doc.setFillColor(20, 45, 32);
  doc.rect(margin, y, pageWidth - margin * 2, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont(undefined, "bold");
  doc.text("Tarjeta diaria de hormigonado", pageWidth / 2, y + 8, { align: "center" });
  y += 16;

  doc.setTextColor(20, 30, 20);
  doc.setFont(undefined, "normal");

  doc.autoTable({
    startY: y,
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2 },
    margin: { left: margin, right: margin },
    body: [["Obra", obra?.nombre || "", "Ubicación", obra?.ubicacion || "", "Fecha", fmtFechaCorta(state.tarjetaFecha)]],
    columnStyles: { 0: { fontStyle: "bold" }, 2: { fontStyle: "bold" }, 4: { fontStyle: "bold" } },
  });
  y = doc.lastAutoTable.finalY;

  doc.autoTable({
    startY: y,
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2 },
    margin: { left: margin, right: margin },
    body: [
      ["Temperatura", dia?.temperatura != null ? `${dia.temperatura} °C` : "-", "Total M3", `${fmtM3(k.totalM3)} m3`, "M3 Desperdicio", `${fmtM3(k.m3Desperdicio)} m3`],
      ["M3 Bombeados", `${fmtM3(k.m3Bombeado)} m3`, "% Desperdicio", fmtPct(k.pctDesperdicio), "Remitos del día", String(new Set(rows.map((l) => l.remitoId)).size)],
    ],
    columnStyles: { 0: { fontStyle: "bold" }, 2: { fontStyle: "bold" }, 4: { fontStyle: "bold" } },
  });
  y = doc.lastAutoTable.finalY + 4;

  const body = rows.map((l) => {
    const r = byId(state.remitos, l.remitoId);
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const prov = byId(state.catalogo.proveedores, r.proveedorId);
    return [
      horm ? `${horm.codigo} (${horm.resistencia})${l.bombeado ? " · BOM" : ""}` : "-",
      fmtM3(l.volumen) + " m3",
      elem ? `${elem.tipoElemento} - ${elem.nombre}` : "-",
      prov ? prov.nombre : "-",
      [l.nomenclatura, l.sector].filter(Boolean).join(" - ") || "-",
      r.remitoNro || "-",
    ];
  });
  doc.autoTable({
    startY: y,
    head: [["Tipo hormigón", "M3", "Elemento", "Proveedor", "Nombre / Sector", "Remito"]],
    body,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [47, 107, 73], textColor: 255 },
    margin: { left: margin, right: margin },
  });
  y = doc.lastAutoTable.finalY + 6;

  const obsHeight = 40;
  if (y + obsHeight + 35 > pageHeight - margin) {
    doc.addPage();
    y = margin;
  }
  doc.setFontSize(9);
  doc.setFont(undefined, "bold");
  doc.text("Observaciones / Croquis", margin + 2, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.rect(margin, y, pageWidth - margin * 2, obsHeight);
  y += obsHeight + 10;

  // Recuadro para firmar: dos bloques de firma lado a lado (espacio en
  // blanco para firmar a mano + línea), uno para el Supervisor de Terreno
  // (con su nombre debajo, cargado en Obras) y otro en blanco sin nombre,
  // para imprimir y archivar en el legajo físico.
  const supervisor = obra?.supervisorTerreno || "";
  const sigGap = 18; // alto del espacio en blanco para firmar a mano
  const sigColWidth = (pageWidth - margin * 2 - 20) / 2;
  const sigCol2X = margin + sigColWidth + 20;
  const sigLineY = y + sigGap;

  doc.setDrawColor(60, 60, 60);
  doc.line(margin, sigLineY, margin + sigColWidth, sigLineY);
  doc.line(sigCol2X, sigLineY, sigCol2X + sigColWidth, sigLineY);

  doc.setFont(undefined, "bold");
  doc.setFontSize(9);
  doc.text(`Supervisor de Terreno${supervisor ? " " + supervisor : ""}`, margin, sigLineY + 5);

  doc.save(`${fmtFechaArchivo(state.tarjetaFecha)} tarjeta diaria.pdf`);
}

function exportarResumenMensualPDF() {
  const obra = byId(state.obras, state.obraId);
  const rows = lineasDelMes(state.resumenMes);
  if (rows.length === 0) return toast("No hay remitos ese mes", "error");
  const r = calcularResumenMensual(rows);
  const prod = calcularProductividad(state.resumenMes, rows);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  let y = 10;

  doc.setFillColor(20, 45, 32);
  doc.rect(margin, y, pageWidth - margin * 2, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont(undefined, "bold");
  doc.text("Reporte mensual de hormigón", pageWidth / 2, y + 8, { align: "center" });
  y += 18;

  doc.setTextColor(20, 30, 20);
  doc.setFontSize(10);
  doc.setFont(undefined, "normal");
  doc.text(`Obra: ${obra?.nombre || ""}      Mes: ${state.resumenMes}`, margin, y);
  y += 4;

  const kpiBody = [
    ["Total m3", fmtM3(r.totalM3), "M3 bombeado", fmtM3(r.m3Bombeado), "M3 desperdicio", fmtM3(r.m3Desperdicio)],
    ["% desperdicio", fmtPct(r.pctDesperdicio), "Días con hormigonado", String(r.diasConHormigon), "Cant. remitos", String(r.cantRemitos)],
  ];
  if (r.m3PagaPorM2 > 0 || r.m2PagaPorM2 > 0) {
    kpiBody.push(["Elementos por m2 (no suman al total)", `${fmtM3(r.m3PagaPorM2)} m3`, "", `${fmtM3(r.m2PagaPorM2)} m2`, "", ""]);
  }
  doc.autoTable({
    startY: y,
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2 },
    margin: { left: margin, right: margin },
    body: kpiBody,
    columnStyles: { 0: { fontStyle: "bold" }, 2: { fontStyle: "bold" }, 4: { fontStyle: "bold" } },
  });
  y = doc.lastAutoTable.finalY + 8;

  const totalElem = Object.values(r.porElemento).reduce((a, b) => a + b, 0) || 1;
  const bodyElem = Object.entries(r.porElemento).sort((a, b) => b[1] - a[1]).map(([kk, v]) => [kk, fmtM3(v) + " m3", fmtPct(v / totalElem)]);
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text("M3 por tipo de elemento", margin, y);
  doc.autoTable({ startY: y + 3, head: [["Elemento", "M3", "%"]], body: bodyElem, theme: "striped", styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin } });
  y = doc.lastAutoTable.finalY + 8;

  const totalProv = Object.values(r.porProveedor).reduce((a, b) => a + b, 0) || 1;
  const bodyProv = Object.entries(r.porProveedor).sort((a, b) => b[1] - a[1]).map(([kk, v]) => [kk, fmtM3(v) + " m3", fmtPct(v / totalProv)]);
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text("M3 por proveedor", margin, y);
  doc.autoTable({ startY: y + 3, head: [["Proveedor", "M3", "%"]], body: bodyProv, theme: "striped", styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin } });
  y = doc.lastAutoTable.finalY + 8;

  if (y > 230) { doc.addPage(); y = margin; }
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text("Productividad (HH/m3)", margin, y);
  doc.autoTable({
    startY: y + 3,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 2 },
    margin: { left: margin, right: margin },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 95 } },
    body: [
      ["Personal Torre / Basamento / Herreros / Indirectos", `${prod.personalTorre} / ${prod.personalBasamento} / ${prod.personalHerreros} / ${prod.personalIndirectos}`],
      ["Días laborables del mes", String(prod.diasLaborables)],
      ["HH/m3 general — directos / con indirectos", `${fmtHH(prod.hhm3GeneralDirectos)} / ${fmtHH(prod.hhm3GeneralConIndirectos)}`],
      ["HH/m3 Torre — directos / con indirectos", `${fmtHH(prod.hhm3TorreDirectos)} / ${fmtHH(prod.hhm3TorreConIndirectos)}`],
      ["HH/m3 Basamento — directos / con indirectos", `${fmtHH(prod.hhm3BasamentoDirectos)} / ${fmtHH(prod.hhm3BasamentoConIndirectos)}`],
    ],
  });
  y = doc.lastAutoTable.finalY + 8;

  const mesAnt = mesAnteriorStr(state.resumenMes);
  const rowsAnt = lineasDelMes(mesAnt);
  if (rowsAnt.length > 0) {
    const rAnt = calcularResumenMensual(rowsAnt);
    const prodAnt = calcularProductividad(mesAnt, rowsAnt);
    const pctVarTxt = (act, ant) => (ant ? `${(((act - ant) / ant) * 100).toFixed(1)}%` : "-");
    if (y > 230) { doc.addPage(); y = margin; }
    doc.setFont(undefined, "bold");
    doc.setFontSize(11);
    doc.text(`Comparación con ${mesAnt}`, margin, y);
    doc.autoTable({
      startY: y + 3,
      head: [["", state.resumenMes, mesAnt, "Variación"]],
      body: [
        ["Total m3", fmtM3(r.totalM3), fmtM3(rAnt.totalM3), pctVarTxt(r.totalM3, rAnt.totalM3)],
        ["Promedio m3/día", fmtM3(r.promedioPorDia), fmtM3(rAnt.promedioPorDia), pctVarTxt(r.promedioPorDia, rAnt.promedioPorDia)],
        ["HH/m3 general (con indirectos)", fmtHH(prod.hhm3GeneralConIndirectos), fmtHH(prodAnt.hhm3GeneralConIndirectos), (prod.hhm3GeneralConIndirectos != null && prodAnt.hhm3GeneralConIndirectos) ? pctVarTxt(prod.hhm3GeneralConIndirectos, prodAnt.hhm3GeneralConIndirectos) : "-"],
      ],
      theme: "grid", styles: { fontSize: 8, cellPadding: 2 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  doc.addPage();
  y = margin;
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text("Detalle de remitos del mes", margin, y);
  const detalle = [...rows].sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    return ra.fecha < rb.fecha ? -1 : 1;
  }).map((l) => {
    const rr = byId(state.remitos, l.remitoId);
    const elem = byId(state.catalogo.elementos, l.elementoId);
    const horm = byId(state.catalogo.hormigones, rr.hormigonId);
    const prov = byId(state.catalogo.proveedores, rr.proveedorId);
    return [fmtFechaCorta(rr.fecha), elem ? `${elem.codigo} - ${elem.nombre}` : "-", [l.nomenclatura, l.sector].filter(Boolean).join(" - ") || "-", horm ? `${horm.codigo} (${horm.resistencia})` : "-", fmtM3(l.volumen), prov ? prov.nombre : "-", rr.remitoNro || "-"];
  });
  doc.autoTable({
    startY: y + 3,
    head: [["Fecha", "Elemento", "Nomenclatura/Sector", "Hormigón", "Volumen (m3)", "Proveedor", "N° Remito"]],
    body: detalle,
    theme: "grid",
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [47, 107, 73], textColor: 255 },
    margin: { left: margin, right: margin },
  });

  doc.save(`Reporte mensual ${state.resumenMes} - ${obra?.nombre || ""}.pdf`);
}

function exportarResumenMensualExcel() {
  const obra = byId(state.obras, state.obraId);
  const rows = lineasDelMes(state.resumenMes);
  if (rows.length === 0) return toast("No hay remitos ese mes", "error");
  const r = calcularResumenMensual(rows);

  const wb = XLSX.utils.book_new();

  const encabezado = [
    ["Reporte mensual de hormigón"],
    ["Obra", obra?.nombre || "", "Mes", state.resumenMes],
    [],
    ["Total M3", r.totalM3],
    ["M3 Bombeado", r.m3Bombeado],
    ["M3 Desperdicio", r.m3Desperdicio],
    ["% Desperdicio", r.pctDesperdicio],
    ["Días con hormigonado", r.diasConHormigon],
    ["Promedio m3/día", r.promedioPorDia],
    ["Cantidad de remitos", r.cantRemitos],
    ...(r.m3PagaPorM2 > 0 || r.m2PagaPorM2 > 0 ? [["Elementos por m2 (no suman al total)", r.m3PagaPorM2, "m2", r.m2PagaPorM2]] : []),
    [],
    ["M3 por tipo de elemento"],
    ...Object.entries(r.porElemento).sort((a, b) => b[1] - a[1]),
    [],
    ["M3 por proveedor"],
    ...Object.entries(r.porProveedor).sort((a, b) => b[1] - a[1]),
  ];
  const wsResumen = XLSX.utils.aoa_to_sheet(encabezado);
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

  const detalle = [...rows].sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    return ra.fecha < rb.fecha ? -1 : 1;
  }).map(lineaARow);
  const wsDetalle = XLSX.utils.json_to_sheet(detalle);
  wsDetalle["!cols"] = autoWidth(detalle);
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle remitos");

  descargarWorkbook(wb, `Reporte mensual ${state.resumenMes} - ${obra?.nombre || ""}.xlsx`);
}

function exportarTodoExcel() {
  const obra = byId(state.obras, state.obraId);
  const desde = $("#expDesde").value;
  const hasta = $("#expHasta").value;
  let rows = state.lineas.filter((l) => byId(state.remitos, l.remitoId));
  if (desde) rows = rows.filter((l) => byId(state.remitos, l.remitoId).fecha >= desde);
  if (hasta) rows = rows.filter((l) => byId(state.remitos, l.remitoId).fecha <= hasta);
  rows = rows.sort((a, b) => {
    const ra = byId(state.remitos, a.remitoId), rb = byId(state.remitos, b.remitoId);
    return ra.fecha < rb.fecha ? -1 : 1;
  });

  if (rows.length === 0) return toast("No hay remitos en ese rango", "error");

  const wb = XLSX.utils.book_new();
  const detalle = rows.map(lineaARow);
  const wsDetalle = XLSX.utils.json_to_sheet(detalle);
  wsDetalle["!cols"] = autoWidth(detalle);
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle remitos");

  const porMes = {};
  rows.forEach((l) => {
    const r = byId(state.remitos, l.remitoId);
    const mes = r.fecha.slice(0, 7);
    if (!porMes[mes]) porMes[mes] = { total: 0, bombeado: 0, desperdicio: 0, remitos: new Set() };
    porMes[mes].total += l.volumen || 0;
    if (l.bombeado) porMes[mes].bombeado += l.volumen || 0;
    if (esDesperdicio(l)) porMes[mes].desperdicio += l.volumen || 0;
    porMes[mes].remitos.add(r.id);
  });
  const resumenMeses = Object.entries(porMes).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([mes, v]) => ({
    "Mes": mes,
    "Total m3": v.total,
    "M3 bombeado": v.bombeado,
    "M3 desperdicio": v.desperdicio,
    "% desperdicio": v.total ? v.desperdicio / v.total : 0,
    "Cantidad de remitos": v.remitos.size,
  }));
  const wsMeses = XLSX.utils.json_to_sheet(resumenMeses);
  wsMeses["!cols"] = autoWidth(resumenMeses);
  XLSX.utils.book_append_sheet(wb, wsMeses, "Resumen por mes");

  const rango = desde || hasta ? ` (${desde || "inicio"} a ${hasta || "hoy"})` : "";
  descargarWorkbook(wb, `Remitos hormigón - ${obra?.nombre || ""}${rango}.xlsx`);
}

// =========================================================
//  COPIA DE SEGURIDAD (JSON) — para migrar entre PCs/carpetas
// =========================================================
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// La tabla de programación se agregó en la versión 2.1: si todavía no fue
// creada en el servidor, se saltea para no romper la copia de seguridad.
function storesParaBackup() {
  return Object.keys(STORES).filter((s) => s !== "programacion" || state.programacionDisponible);
}

async function exportarBackupJSON() {
  const stores = storesParaBackup();
  const data = {};
  for (const s of stores) {
    // Las facturas adjuntas (pedidosHierro.facturaPath) viven en Supabase
    // Storage, no en esta tabla: viajan como referencia (texto), no hace
    // falta convertir ningún Blob acá como en la versión local anterior.
    data[s] = await DB.getAll(s);
  }
  data.__meta = { app: "ControlHormigon", version: APP_VERSION, exportado: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ControlHormigon-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Copia de seguridad descargada", "ok");
}

async function restaurarBackupJSON(file) {
  if (!file) return;
  if (!confirm("Esto reemplaza TODOS los datos actuales de la app por los del archivo elegido. ¿Continuar?")) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const stores = storesParaBackup();
    for (const s of stores) {
      if (!Array.isArray(data[s])) continue;
      await DB.clear(s);
      let filas = data[s];
      if (s === "pedidosHierro") {
        // Compatibilidad con copias de seguridad viejas (de la versión local,
        // antes de Supabase) que todavía traen la factura como base64 en vez
        // de una ruta de Storage: la subimos ahora y guardamos su ruta.
        filas = await Promise.all(filas.map(async (row) => {
          if (row.facturaBlobBase64) {
            const { facturaBlobBase64, ...resto } = row;
            try {
              const blob = base64ToBlob(facturaBlobBase64);
              const path = `${row.obraId}/${row.id}/${Date.now()}_${resto.facturaNombre || "factura"}`;
              const { error } = await supabaseClient.storage.from("facturas").upload(path, blob, {
                upsert: true,
                contentType: resto.facturaTipo || blob.type,
              });
              if (!error) return { ...resto, facturaPath: path };
            } catch (e) { console.error(e); }
            return resto;
          }
          return row;
        }));
      }
      await DB.bulkPut(s, filas);
    }
    await loadObras();
    if (state.obras.length === 0) {
      toast("El archivo no tenía obras cargadas", "error");
      return;
    }
    const cfg = await DB.get("config", "obraActiva");
    const activa = (cfg && byId(state.obras, cfg.value)) ? cfg.value : state.obras[0].id;
    await setObraActiva(activa);
    toast("Copia de seguridad restaurada", "ok");
  } catch (err) {
    console.error(err);
    if (err instanceof SyntaxError) {
      toast("No se pudo leer el archivo: no es un JSON válido", "error");
    } else {
      toast("No se pudo restaurar: " + (err.message || err), "error");
    }
  }
}

// ---------- Tablas en el celular ----------
// En pantallas angostas las tablas largas se muestran como tarjetas (ver styles.css,
// bloque "CELULAR"). Para eso cada celda necesita saber el título de su columna:
// se lo copiamos del encabezado en un atributo data-label. Es solo visual.
function etiquetarTablasParaCelular() {
  document.querySelectorAll("table").forEach((t) => {
    const titulos = Array.from(t.querySelectorAll("thead th")).map((th) => th.textContent.trim());
    if (titulos.length === 0) return;
    t.querySelectorAll("tbody tr").forEach((tr) => {
      let col = 0;
      Array.from(tr.children).forEach((td) => {
        if (td.tagName !== "TD") return;
        const ancho = parseInt(td.getAttribute("colspan") || "1", 10);
        if (ancho === 1 && !td.hasAttribute("data-label")) td.setAttribute("data-label", titulos[col] || "");
        // Las celdas sin dato ("-" o vacías) se esconden en las tarjetas del celular
        const txt = td.textContent.trim();
        td.classList.toggle("celda-vacia", ancho === 1 && !td.querySelector("button") && (txt === "" || txt === "-"));
        col += ancho;
      });
    });
  });
}

function iniciarEtiquetadoDeTablas() {
  const main = document.querySelector("main");
  if (!main || typeof MutationObserver === "undefined") return;
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(etiquetarTablasParaCelular, 60);
  }).observe(main, { childList: true, subtree: true });
  etiquetarTablasParaCelular();
}

// ---------- Arranque ----------
document.addEventListener("DOMContentLoaded", () => {
  iniciarEtiquetadoDeTablas();
  init();
});

// ---------- Modo oscuro / claro ----------
(function iniciarTema() {
  const aplicar = (oscuro) => {
    if (oscuro) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    const b = document.getElementById("btnTema");
    if (b) {
      b.setAttribute("aria-checked", oscuro ? "true" : "false");
      b.title = oscuro ? "Pasar a modo claro" : "Pasar a modo oscuro";
      const t = b.querySelector(".tema-txt");
      if (t) t.textContent = oscuro ? "Modo claro" : "Modo oscuro";
    }
  };
  const iniciar = () => {
    aplicar(document.documentElement.getAttribute("data-theme") === "dark");
    const b = document.getElementById("btnTema");
    if (!b) return;
    b.addEventListener("click", () => {
      const oscuro = document.documentElement.getAttribute("data-theme") !== "dark";
      aplicar(oscuro);
      try { localStorage.setItem("tema", oscuro ? "oscuro" : "claro"); } catch (e) { /* sin storage */ }
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
