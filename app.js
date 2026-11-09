/* ===========================================================
   app.js — Lógica principal de la app de Control de Hormigón
   Modelo: un Remito (encabezado: proveedor, hormigón, camión,
   horarios, probetas) puede tener una o varias Líneas (elementos
   a los que se aplicó ese hormigón).
   =========================================================== */

const APP_VERSION = "2.20.0";

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
  // Ícono para el acceso directo del celular (iPhone/iPad necesitan PNG o JPG).
  const apple = $("#appleIcon");
  if (apple) {
    const logo = (obra && obra.logoUrl) || "";
    apple.href = /\.(png|jpe?g)(\?|$)/i.test(logo) ? logo : (esSummit ? "apple-touch-icon-summit.png" : "apple-touch-icon.png");
  }
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
  if (typeof plantaImportarDesdeURL === "function") plantaImportarDesdeURL();
}

// ---------- Recordatorio semanal de copia de seguridad ----------
// Solo al administrador le aparece este aviso si pasó una semana (o más,
// o nunca) desde la última descarga del JSON de respaldo. No se puede
// cerrar de otra forma: solo descargando el backup se oculta.
const MS_UNA_SEMANA = 7 * 24 * 60 * 60 * 1000;
async function verificarRecordatorioBackup() {
  const ov = $("#backupReminderOverlay");
  if (!esAdmin()) { if (ov) ov.style.display = "none"; return; }
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

  const bImp = $("#btnImpConfirmar");
  if (bImp) bImp.addEventListener("click", plantaConfirmarImport);

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
  $("#btnExportarRecibidos").addEventListener("click", exportarRecibidosExcel);
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
  if (state.planRemitosDisponible) stores.push("planRemitos");
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
  { value: "BASAMENTO_I", label: "Basamento I" },
  { value: "BASAMENTO_II", label: "Basamento II" },
  { value: "BASAMENTO", label: "Basamento (general / histórico)" },
  { value: "VIGA_PERIMETRAL", label: "Viga perimetral" },
];

const ROLES_EQUIPO = [
  { value: "OTRO", label: "Otro (no suma a HH/m3)" },
  { value: "TORRE", label: "Torre" },
  { value: "BASAMENTO_I", label: "Basamento I" },
  { value: "BASAMENTO_II", label: "Basamento II" },
  { value: "BASAMENTO", label: "Basamento (general / histórico)" },
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
    const items = state.pedidoHierroLineas.filter((l) => l.pedidoId === p.id);
    const tdItems = el("td", { style: "white-space:normal" });
    if (items.length === 0) {
      tdItems.appendChild(document.createTextNode("-"));
    } else {
      const cab = el("div", { class: "hierro-cab" });
      const flecha = el("span", { class: "hierro-flecha" }, "▸");
      cab.appendChild(flecha);
      cab.appendChild(document.createTextNode(` ${items.length} ${items.length === 1 ? "ítem" : "ítems"} — tocá para ver el detalle`));
      const lista = el("ul", { class: "hierro-lista", style: "display:none" },
        items.map((it) => el("li", {}, [
          el("span", { class: "hierro-it" }, detalleLineaHierro(it)),
          el("strong", {}, ` ${it.cantidad} ${it.unidad}`),
          ...(it.observaciones ? [el("span", { class: "hierro-obs" }, it.observaciones)] : []),
        ])));
      if (p.observaciones) lista.appendChild(el("li", { class: "hierro-obs-pedido" }, [el("strong", {}, "Observaciones: "), document.createTextNode(p.observaciones)]));
      tdItems.appendChild(cab);
      tdItems.appendChild(lista);
      tr.classList.add("hierro-fila");
      tr.addEventListener("click", (ev) => {
        if (ev.target.closest("button, a")) return;
        const abierto = lista.style.display !== "none";
        lista.style.display = abierto ? "none" : "";
        flecha.textContent = abierto ? "▸" : "▾";
      });
    }
    tr.appendChild(tdItems);
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
  if (!state.editingRemitoId) {
    if (!get("horaAObra")) return toast("Falta la hora de salida de planta (Hora - A obra)", "error");
    if (!get("horaDescarga")) return toast("Falta la hora de descarga", "error");
  }

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

// Hormigón de limpieza (elemento HL / HORM-LIMP, o remito de hormigón "HL"): se muestra aparte
// y NO suma al Total m3 ni al resto de los KPIs.
function esLimpieza(linea) {
  const elem = byId(state.catalogo.elementos, linea.elementoId);
  if (elem && ((elem.tipoElemento || "").toUpperCase() === "HORM-LIMP" || (elem.codigo || "").toUpperCase() === "HL")) return true;
  const r = byId(state.remitos, linea.remitoId);
  const h = r ? byId(state.catalogo.hormigones, r.hormigonId) : null;
  return !!h && ((h.codigo || "").toUpperCase() === "HL" || /limpieza/i.test(h.nombre || h.resistencia || ""));
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
  let totalM3 = 0, m3Bombeado = 0, m3Desperdicio = 0, m3PagaPorM2 = 0, m2PagaPorM2 = 0, m3Limpieza = 0;
  rows.forEach((l) => {
    const v = l.volumen || 0;
    if (esPagaPorM2(l)) {
      // Se paga/mide por m2 (ej. Contrapiso): se muestra aparte, no entra
      // al Total m3 ni al resto de los KPIs.
      m3PagaPorM2 += v;
      m2PagaPorM2 += l.areaM2 || 0;
      return;
    }
    if (esLimpieza(l)) {
      m3Limpieza += v;
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
    m3Limpieza,
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
  $("#kpiTarjetaLimpiezaCard").style.display = k.m3Limpieza > 0 ? "" : "none";
  if (k.m3Limpieza > 0) $("#kpiTarjetaLimpieza").textContent = `${fmtM3(k.m3Limpieza)} m³`;
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
// El mortero (albañilería) se pide por el mismo circuito pero NO es hormigón:
// queda en los remitos y en sus Excel, y no suma a los reportes mensuales.
function esMortero(remito) {
  const h = remito ? byId(state.catalogo.hormigones, remito.hormigonId) : null;
  return !!h && /mortero/i.test(`${h.codigo || ""} ${h.resistencia || ""}`);
}

function lineasDelMes(yyyyMm) {
  return state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    return r && r.fecha && r.fecha.slice(0, 7) === yyyyMm && !esMortero(r);
  });
}

// Ordena los tipos de hormigón por resistencia (C15, C20, C25...); los que no
// tienen número (ej. "Sin tipo") van al final.
function ordenarTiposHormigon(obj) {
  const num = (k) => { const m = /(\d+)/.exec(k); return m ? parseInt(m[1], 10) : Infinity; };
  return Object.entries(obj).sort((a, b) => num(a[0]) - num(b[0]) || a[0].localeCompare(b[0]));
}

// Acumulado de obra: todo lo hormigonado desde el principio hasta el fin del mes
// elegido (inclusive), por zona. Misma base que el HH/m3: sin desperdicio, sin
// elementos por m2 y sin mortero.
// Hormigón teórico total de la obra (Basamento + Torre), en m3: base del % de avance.
// Torre 8.405 + Basamento 2.963 (Basamento = Basamento I + II + Viga perimetral).
const M3_TEORICO_TORRE = 8405;
const M3_TEORICO_BASAMENTO = 2963;
const M3_TEORICO_OBRA = M3_TEORICO_TORRE + M3_TEORICO_BASAMENTO; // 11.368
function pctAvanceObra(m3) { return M3_TEORICO_OBRA ? m3 / M3_TEORICO_OBRA : 0; }
function fmtPctAv(m3, base) { return `${(base ? (m3 / base) * 100 : 0).toFixed(1).replace(".", ",")} %`; }
function fmtAvance(m3) { return fmtPctAv(m3, M3_TEORICO_OBRA); }
// Avance acumulado hasta el mes y aporte del mes, por zona. Quedan fuera contrapisos (por m2),
// desperdicio y hormigón de limpieza (ya lo excluye volumenPorGrupo); el mortero tampoco cuenta.
function calcularAvance(yyyyMm) {
  const ac = calcularAcumulado(yyyyMm);
  const rowsMes = state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    return r && r.fecha && r.fecha.slice(0, 7) === yyyyMm && !esMortero(r);
  });
  const t = volumenPorGrupo(rowsMes, "TORRE");
  const b = volumenPorGrupo(rowsMes, "BASAMENTO_I") + volumenPorGrupo(rowsMes, "BASAMENTO_II") + volumenPorGrupo(rowsMes, "BASAMENTO") + volumenPorGrupo(rowsMes, "VIGA_PERIMETRAL");
  const basAc = ac.basamento + ac.viga;
  return {
    torre: { acum: ac.torre, mes: t, base: M3_TEORICO_TORRE },
    basamento: { acum: basAc, mes: b, base: M3_TEORICO_BASAMENTO },
    total: { acum: ac.torre + basAc, mes: t + b, base: M3_TEORICO_OBRA },
  };
}

function calcularAcumulado(yyyyMm) {
  const rows = state.lineas.filter((l) => {
    const r = byId(state.remitos, l.remitoId);
    return r && r.fecha && r.fecha.slice(0, 7) <= yyyyMm && !esMortero(r);
  });
  const torre = volumenPorGrupo(rows, "TORRE");
  const basI = volumenPorGrupo(rows, "BASAMENTO_I");
  const basII = volumenPorGrupo(rows, "BASAMENTO_II");
  const basGeneral = volumenPorGrupo(rows, "BASAMENTO");
  const basamento = basI + basII + basGeneral;
  const viga = volumenPorGrupo(rows, "VIGA_PERIMETRAL");
  return { torre, basI, basII, basamento, viga, total: torre + basamento + viga };
}

function calcularResumenMensual(rows) {
  const k = calcularKPIs(rows);
  const porElemento = {};
  const porProveedor = {};
  const porHormigon = {};
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

    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const hkey = horm ? horm.codigo : "Sin tipo";
    porHormigon[hkey] = (porHormigon[hkey] || 0) + (l.volumen || 0);

    if (r.fecha) diasConHormigon.add(r.fecha);
    remitosDelMes.add(r.id);
  });

  return {
    ...k,
    porElemento,
    porProveedor,
    porHormigon,
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
    if (esDesperdicio(l) || esPagaPorM2(l) || esLimpieza(l)) return;
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
  const personalBasI = personalPorEquipo("BASAMENTO_I");
  const personalBasII = personalPorEquipo("BASAMENTO_II");
  // Basamento unificado = Basamento I + Basamento II + el personal "general/histórico"
  const personalBasamento = personalBasI + personalBasII + personalPorEquipo("BASAMENTO");
  const personalHerreros = personalPorEquipo("HERREROS");
  const personalIndirectos = personalPorEquipo("INDIRECTOS");

  const diasLaborables = diasLaborablesDelMes(mes, p.diasNoLaborables);
  const hhTorre = personalTorre * p.horasPromedioDia * diasLaborables;
  const hhBasamento = personalBasamento * p.horasPromedioDia * diasLaborables;
  const hhBasI = personalBasI * p.horasPromedioDia * diasLaborables;
  const hhBasII = personalBasII * p.horasPromedioDia * diasLaborables;
  const hhHerreros = personalHerreros * p.horasPromedioDia * diasLaborables;
  const hhIndirectos = personalIndirectos * p.horasPromedioDia * diasLaborables;

  const m3Torre = volumenPorGrupo(rows, "TORRE");
  const m3BasI = volumenPorGrupo(rows, "BASAMENTO_I");
  const m3BasII = volumenPorGrupo(rows, "BASAMENTO_II");
  const m3Basamento = m3BasI + m3BasII + volumenPorGrupo(rows, "BASAMENTO"); // unificado
  const m3Viga = volumenPorGrupo(rows, "VIGA_PERIMETRAL"); // solo m3 por ahora (sin HH)
  const m3Directo = m3Torre + m3Basamento; // la viga no entra al HH/m3 hasta definir su personal

  return {
    p, personalTorre, personalBasamento, personalHerreros, personalIndirectos,
    personalBasI, personalBasII, m3BasI, m3BasII, m3Viga,
    diasLaborables, m3Torre, m3Basamento, m3Directo,
    // Indirectos: la mitad a Torre y la mitad a Basamento; dentro de Basamento, un cuarto a cada cuadrilla (I y II)
    hhm3BasIDirectos: m3BasI ? hhBasI / m3BasI : null,
    hhm3BasIConIndirectos: m3BasI ? (hhBasI + hhIndirectos / 4) / m3BasI : null,
    hhm3BasIIDirectos: m3BasII ? hhBasII / m3BasII : null,
    hhm3BasIIConIndirectos: m3BasII ? (hhBasII + hhIndirectos / 4) / m3BasII : null,
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
  $("#pm_cant_basI").textContent = prod.personalBasI;
  $("#pm_cant_basII").textContent = prod.personalBasII;
  $("#pm_cant_herreros").textContent = prod.personalHerreros;
  $("#pm_cant_indirectos").textContent = prod.personalIndirectos;

  $("#pm_diasLaborables").textContent = prod.diasLaborables;
  $("#pm_m3Torre").textContent = fmtM3(prod.m3Torre);
  $("#pm_m3Basamento").textContent = fmtM3(prod.m3Basamento);
  $("#pm_m3BasI").textContent = fmtM3(prod.m3BasI);
  $("#pm_m3BasII").textContent = fmtM3(prod.m3BasII);
  $("#pm_m3Viga").textContent = fmtM3(prod.m3Viga);

  $("#hh_general_directos").textContent = fmtHH(prod.hhm3GeneralDirectos);
  $("#hh_general_indirectos").textContent = fmtHH(prod.hhm3GeneralConIndirectos);
  $("#hh_torre_directos").textContent = fmtHH(prod.hhm3TorreDirectos);
  $("#hh_torre_indirectos").textContent = fmtHH(prod.hhm3TorreConIndirectos);
  $("#hh_basamento_directos").textContent = fmtHH(prod.hhm3BasamentoDirectos);
  $("#hh_basamento_indirectos").textContent = fmtHH(prod.hhm3BasamentoConIndirectos);
  $("#hh_basI_directos").textContent = fmtHH(prod.hhm3BasIDirectos);
  $("#hh_basI_indirectos").textContent = fmtHH(prod.hhm3BasIConIndirectos);
  $("#hh_basII_directos").textContent = fmtHH(prod.hhm3BasIIDirectos);
  $("#hh_basII_indirectos").textContent = fmtHH(prod.hhm3BasIIConIndirectos);
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


// ---------- m3 recibidos en obra (repartidos + remitos precargados del Plan) ----------
function recibidosPorDia(yyyyMm) {
  const dias = {};
  const get = (f) => (dias[f] = dias[f] || { remitos: 0, m3: 0, pend: 0 });
  const rem = new Set();
  lineasDelMes(yyyyMm).forEach((l) => {
    const r = byId(state.remitos, l.remitoId);
    const d = get(r.fecha);
    d.m3 += l.volumen || 0;
    if (!rem.has(r.id)) { rem.add(r.id); d.remitos++; }
  });
  (state.planRemitos || []).filter((p) => p.fecha && p.fecha.slice(0, 7) === yyyyMm).forEach((p) => {
    const d = get(p.fecha);
    d.remitos++; d.m3 += p.m3 || 0; d.pend += p.m3 || 0;
  });
  return dias;
}

function renderRecibidosObra() {
  const dias = recibidosPorDia(state.resumenMes);
  const fechas = Object.keys(dias).sort();
  const tot = fechas.reduce((a, f) => ({ remitos: a.remitos + dias[f].remitos, m3: a.m3 + dias[f].m3, pend: a.pend + dias[f].pend }), { remitos: 0, m3: 0, pend: 0 });
  $("#kpiRecibidosTotal").textContent = fmtM3(tot.m3);
  $("#kpiRecibidosRemitos").textContent = tot.remitos;
  $("#kpiRecibidosPend").textContent = fmtM3(tot.pend) + " m³";
  const tb = $("#tablaRecibidos tbody");
  tb.innerHTML = "";
  fechas.forEach((f) => {
    const d = dias[f];
    tb.appendChild(el("tr", {}, [el("td", {}, fmtFechaCorta(f)), el("td", {}, String(d.remitos)), el("td", {}, fmtM3(d.m3)), el("td", {}, d.pend ? fmtM3(d.pend) : "")]));
  });
  if (fechas.length) tb.appendChild(el("tr", {}, [el("td", {}, el("strong", {}, "Total")), el("td", {}, el("strong", {}, String(tot.remitos))), el("td", {}, el("strong", {}, fmtM3(tot.m3))), el("td", {}, tot.pend ? fmtM3(tot.pend) : "")]));
}

function exportarRecibidosExcel() {
  const dias = recibidosPorDia(state.resumenMes);
  const fechas = Object.keys(dias).sort();
  const data = [["Fecha", "Remitos", "m3 recibidos", "m3 sin reparto"]];
  fechas.forEach((f) => data.push([f, dias[f].remitos, Number(dias[f].m3.toFixed(2)), Number(dias[f].pend.toFixed(2))]));
  data.push(["Total", fechas.reduce((a, f) => a + dias[f].remitos, 0), Number(fechas.reduce((a, f) => a + dias[f].m3, 0).toFixed(2)), Number(fechas.reduce((a, f) => a + dias[f].pend, 0).toFixed(2))]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "m3 recibidos");
  XLSX.writeFile(wb, `m3_recibidos_${state.resumenMes}.xlsx`);
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

  $("#kpiResumenLimpiezaCard").style.display = r.m3Limpieza > 0 ? "" : "none";
  if (r.m3Limpieza > 0) $("#kpiResumenLimpieza").textContent = `${fmtM3(r.m3Limpieza)} m³`;

  renderRecibidosObra();
  const ac = calcularAcumulado(state.resumenMes);
  $("#acumuladoTitulo").textContent = `Acumulado de la obra hasta ${state.resumenMes}`;
  $("#ac_torre").textContent = fmtM3(ac.torre);
  $("#ac_basI").textContent = fmtM3(ac.basI);
  $("#ac_basII").textContent = fmtM3(ac.basII);
  $("#ac_bas").textContent = fmtM3(ac.basamento);
  $("#ac_viga").textContent = fmtM3(ac.viga);
  $("#ac_total").textContent = fmtM3(ac.total);
  const av = calcularAvance(state.resumenMes);
  [["Torre", av.torre], ["Bas", av.basamento], ["Total", av.total]].forEach(([k, a]) => {
    $("#av" + k).textContent = fmtPctAv(a.acum, a.base);
    $("#av" + k + "Det").textContent = `${fmtM3(a.acum)} de ${fmtM3(a.base)} m³ · este mes +${fmtPctAv(a.mes, a.base)}`;
  });

  const rend = (contId, obj, mantenerOrden) => {
    const cont = $(contId);
    cont.innerHTML = "";
    const entries = mantenerOrden ? Object.entries(obj) : Object.entries(obj).sort((a, b) => b[1] - a[1]);
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
  rend("#resumenPorHormigon", Object.fromEntries(ordenarTiposHormigon(r.porHormigon)), true);

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
  const aMin = (h) => { const m = /^(\d{1,2}):(\d{2})/.exec(h || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const data = rows.map((r) => {
    const horm = byId(state.catalogo.hormigones, r.hormigonId);
    const lins = state.lineas.filter((l) => l.remitoId === r.id);
    const unicos = (arr) => [...new Set(arr.filter((x) => x !== "" && x !== null && x !== undefined))];
    const asent = unicos(lins.map((l) => l.asentamiento)).join(" / ");
    const elementos = unicos(lins.map((l) => {
      if (l.nomenclatura) return l.nomenclatura;
      const e = byId(state.catalogo.elementos, l.elementoId);
      return e ? e.nombre : "";
    })).join(", ");
    const bomba = lins.length ? (lins.some((l) => l.bombeado) ? "SI" : "NO") : "";
    let tiempo = "";
    const t0 = aMin(r.horaAObra), t1 = aMin(r.horaDescarga);
    if (t0 !== null && t1 !== null) {
      const d = (t1 - t0 + 1440) % 1440;
      tiempo = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}`;
    }
    return {
      "Fecha": r.fecha,
      "N° Remito": r.remitoNro || "",
      "Tipo de hormigón": horm ? `${horm.codigo} (${horm.resistencia})` : "",
      "Asentamiento (cm)": asent,
      "N° de probeta": [r.probeta1, r.probeta2, r.probeta3].filter((x) => x !== null && x !== undefined && x !== "").join(" / "),
      "Bomba": bomba,
      "Elemento(s)": elementos,
      "Tiempo planta-descarga (hs)": tiempo,
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

  const hayPre = (state.planRemitos || []).some((p) => (!desde || p.fecha >= desde) && (!hasta || p.fecha <= hasta));
  if (rows.length === 0 && !hayPre) return toast("No hay remitos en ese rango", "error");

  // Un solo renglón por remito: si por algún motivo hay dos cabezales con el
  // mismo N° (mismo proveedor y fecha), se muestra una sola vez.
  const vistos = new Set();
  const unicos = rows.filter((r) => {
    const nro = (r.remitoNro || "").trim().toLowerCase();
    if (!nro) return true;
    const k = `${r.proveedorId || ""}|${r.fecha}|${nro}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  const filas = unicos.map((r) => ({ f: r.fecha || "", row: remitoARowControl(r) }));
  // Remitos precargados en el Plan (todavía sin reparto): también cuentan como recibidos.
  const nrosCargados = new Set(unicos.map((r) => (r.remitoNro || "").trim().toLowerCase()).filter(Boolean));
  (state.planRemitos || [])
    .filter((p) => (!desde || p.fecha >= desde) && (!hasta || p.fecha <= hasta) && !nrosCargados.has((p.nro || "").trim().toLowerCase()))
    .forEach((p) => {
      const horm = state.catalogo.hormigones.find((h) => h.codigo === p.hormigon);
      filas.push({
        f: p.fecha,
        row: {
          "Fecha": p.fecha || "",
          "N° Remito": p.nro || "",
          "M3 remito": p.m3 ?? "",
          "Tipo de hormigón": horm ? `${horm.codigo} (${horm.resistencia})` : (p.hormigon || ""),
          "Bombeado/Volcado": p.bombeo ? "Bombeado" : "Volcado",
        },
      });
    });
  filas.sort((x, y) => (x.f < y.f ? -1 : x.f > y.f ? 1 : 0));
  const data = filas.map((x) => x.row);
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

async function exportarTarjetaDiariaPDF() {
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
      ...(k.m3Limpieza > 0 ? [["H. limpieza", `${fmtM3(k.m3Limpieza)} m3`, "(no suma al total)", "", "", ""]] : []),
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

  // Plantas de la torre con lo hormigonado ese día pintado (una hoja por nivel).
  // Si el plano no está disponible, la tarjeta sale igual, sin plantas.
  try {
    if (typeof plantaDisponible === "function" && plantaDisponible()) {
      for (const { niv, items } of plantaElementosDelDia(rows)) {
        const img = await plantaImagenPintada(niv, items);
        doc.addPage();
        const w = pageWidth - margin * 2;
        const h = w * img.h / img.w;
        doc.setTextColor(20, 30, 20);
        doc.setFont(undefined, "bold");
        doc.setFontSize(13);
        doc.text(`Planta para llenados - N${niv.nivel} (piso ${niv.piso})`, margin, 16);
        doc.setFontSize(10);
        doc.setFont(undefined, "normal");
        doc.text(`Fecha: ${fmtFechaCorta(state.tarjetaFecha)}`, pageWidth - margin, 16, { align: "right" });
        doc.addImage(img.url, "JPEG", margin, 22, w, h);
        const total = items.reduce((a, x) => a + x.m3, 0);
        const lista = items.map((x) => `${plantaRotulo(x.e)} ${fmtM3(x.m3)} m3`).join("  |  ");
        doc.setFontSize(9);
        doc.setFont(undefined, "bold");
        doc.text(`Llenado ese día (${fmtM3(total)} m3):`, margin, 22 + h + 8);
        doc.setFont(undefined, "normal");
        doc.text(doc.splitTextToSize(lista, w), margin, 22 + h + 13);
      }
    }
  } catch (err) {
    console.warn("Plantas pintadas no incluidas en la tarjeta:", err);
  }

  doc.save(`${fmtFechaArchivo(state.tarjetaFecha)} tarjeta diaria.pdf`);
}

// ---------- Portada del reporte mensual (páginas 1 a 3 del PDF) ----------
function mesAnterior(yyyyMm, n) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const MESES_ABR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGO = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function dibujarPortadaReporte(doc, r, rows, prod, obra) {
  const PW = 210, M = 12, CW = PW - M * 2;
  const C = { gd: [20, 45, 32], g: [47, 107, 73], gl: [168, 213, 186], or: [224, 160, 48], rd: [201, 80, 63], bl: [59, 110, 165], gr: [138, 148, 143], bg: [246, 248, 246], tx: [68, 80, 74] };
  const fill = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const ink = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const [ay, am] = state.resumenMes.split("-").map(Number);
  const mesTxt = `${MESES_LARGO[am - 1]} ${ay}`;
  const num0 = (n) => fmtM3(Math.round(n)).split(",")[0];
  const txt = (t, x, y, size, c, style, align) => { doc.setFontSize(size); doc.setFont(undefined, style || "normal"); ink(c); doc.text(String(t), x, y, align ? { align } : undefined); };
  const header = (titulo) => {
    fill(C.gd); doc.rect(0, 0, PW, 16, "F");
    txt(titulo, M, 10.5, 15, [255, 255, 255], "bold");
    txt(`${obra?.nombre || ""} · ${mesTxt}`, PW - M, 10.5, 9, C.gl, "normal", "right");
  };
  const card = (x, y, w, h, val, label, c) => {
    fill(C.bg); doc.setDrawColor(223, 230, 225); doc.roundedRect(x, y, w, h, 2, 2, "FD");
    txt(val, x + w / 2, y + h * 0.5, 17, c, "bold", "center");
    txt(label, x + w / 2, y + h * 0.78, 7.5, C.tx, "normal", "center");
  };

  // Cifras base
  const comprados = r.totalM3 + r.m3PagaPorM2 + r.m3Limpieza;
  const enElem = r.totalM3 - r.m3Desperdicio;
  const dif = comprados - enElem;

  // ============ Página 1 ============
  header("Reporte mensual de hormigón");
  txt("Hormigón en remitos", M, 28, 14, C.gd, "bold");
  const cw = (CW - 8) / 3;
  card(M, 33, cw, 24, `${num0(comprados)} m3`, "comprados en el mes (remitos)", C.gd);
  card(M + cw + 4, 33, cw, 24, `${num0(enElem)} m3`, "teóricos (en elementos)", C.g);
  card(M + (cw + 4) * 2, 33, cw, 24, `+${num0(dif)} m3`, `diferencia (${fmtPct(enElem ? dif / enElem : 0)} sobre el teórico)`, C.or);

  txt("De lo comprado a lo teórico (m3)", M, 68, 10, C.gd, "bold");
  const bars = [["Comprado", comprados, C.gd, "t"], ["Contrapisos", -r.m3PagaPorM2, C.or], ["Hormigón de limpieza", -r.m3Limpieza, C.bl], ["Desperdicio", -r.m3Desperdicio, C.rd], ["Teórico", enElem, C.g, "t"]];
  const cx0 = M + 4, cy0 = 72, ch = 78, cwid = CW - 8, bw = cwid / bars.length;
  const vmax = comprados || 1, vmin = Math.max(0, Math.floor((enElem * 0.85) / 100) * 100); // eje cortado para que se vean las diferencias
  const sy = (v) => cy0 + ch - ((v - vmin) / ((vmax * 1.03 - vmin) || 1)) * ch;
  doc.setDrawColor(150, 150, 150); doc.line(cx0, cy0 + ch, cx0 + cwid, cy0 + ch);
  let run = comprados;
  bars.forEach(([n, v, c, t], i) => {
    const bx = cx0 + i * bw + bw * 0.18, w = bw * 0.64;
    fill(c);
    if (t) { doc.rect(bx, sy(v), w, cy0 + ch - sy(v), "F"); txt(num0(v), bx + w / 2, sy(v) - 2, 9, C.gd, "bold", "center"); }
    else { const top = sy(run), bot = sy(run + v); doc.rect(bx, top, w, Math.max(bot - top, 0.4), "F"); txt(`-${num0(-v)}`, bx + w / 2, top - 2, 9, c, "bold", "center"); run += v; }
    doc.setFontSize(8); doc.setFont(undefined, "normal"); ink(C.gd);
    doc.text(doc.splitTextToSize(n, bw - 2), bx + w / 2, cy0 + ch + 5, { align: "center" });
  });
  if (vmin > 0) txt(`el eje arranca en ${num0(vmin)} m3`, cx0 + cwid, cy0 - 1, 7, C.gr, "normal", "right");

  txt("Detalle de la diferencia", M, 172, 11, C.gd, "bold");
  const det = [["Contrapisos (se pagan por m2)", r.m3PagaPorM2, C.or, r.m2PagaPorM2 > 0 ? `${fmtM3(r.m2PagaPorM2)} m2` : ""], ["Hormigón de limpieza", r.m3Limpieza, C.bl, ""], ["Desperdicio", r.m3Desperdicio, C.rd, `${fmtPct(r.pctDesperdicio)} de lo colado`]];
  det.forEach(([n, v, c, nota], i) => {
    const yy = 182 + i * 14;
    fill(c); doc.rect(M, yy - 4, 1.8, 9, "F");
    txt(n, M + 5, yy, 10, [20, 30, 20]);
    if (nota) txt(nota, M + 5, yy + 4.5, 7.5, C.gr);
    txt(`${fmtM3(v)} m3`, M + 112, yy, 10, [20, 30, 20], "bold", "right");
    txt(`${fmtPct(dif ? v / dif : 0)} de la diferencia`, M + 116, yy, 8, C.gr);
  });
  txt("Teórico = volumen calculado con las dimensiones de cada elemento (losas, pilares, vigas, etc.).", M, 232, 7.5, C.gr);

  // ============ Página 2 ============
  doc.addPage();
  header("Avance de obra");
  const av = calcularAvance(state.resumenMes);
  txt(`Avance sobre los ${num0(M3_TEORICO_OBRA)} m3 teóricos de la obra`, M, 28, 14, C.gd, "bold");
  [["Torre", av.torre], ["Basamento (I + II + Viga perimetral)", av.basamento], ["Total obra", av.total]].forEach(([n, a], i) => {
    const yy = 38 + i * 16;
    txt(n, M, yy, 10, [20, 30, 20], "bold");
    txt(`${fmtPctAv(a.acum, a.base)}   (${num0(a.acum)} de ${num0(a.base)} m3)   este mes +${fmtPctAv(a.mes, a.base)}`, PW - M, yy, 8.5, C.tx, "normal", "right");
    fill([230, 236, 232]); doc.rect(M, yy + 2, CW, 5, "F");
    const prev = Math.max(0, (a.acum - a.mes) / a.base), mes = Math.max(0, a.mes / a.base);
    fill(C.g); doc.rect(M, yy + 2, CW * Math.min(prev, 1), 5, "F");
    fill(C.or); doc.rect(M + CW * Math.min(prev, 1), yy + 2, CW * Math.min(mes, 1 - Math.min(prev, 1)), 5, "F");
  });
  fill(C.g); doc.rect(M, 84, 3, 3, "F"); txt("acumulado anterior", M + 5, 86.5, 7.5, C.gr);
  fill(C.or); doc.rect(M + 40, 84, 3, 3, "F"); txt("aporte del mes", M + 45, 86.5, 7.5, C.gr);

  // Evolución mensual
  txt("Hormigón colado por mes (barras) y % de avance acumulado (línea)", M, 98, 10, C.gd, "bold");
  const meses = [];
  for (let i = 5; i >= 0; i--) { const mm = mesAnterior(state.resumenMes, i); const a = calcularAvance(mm); if (a.total.acum > 0 || a.total.mes > 0) meses.push({ mm, mes: a.total.mes, pct: a.total.acum / M3_TEORICO_OBRA }); }
  const ex0 = M + 4, ey0 = 104, eh = 52, ew = CW - 8;
  doc.setDrawColor(150, 150, 150); doc.line(ex0, ey0 + eh, ex0 + ew, ey0 + eh);
  if (meses.length) {
    const mx = Math.max(...meses.map((m) => m.mes), 1), pmx = Math.max(...meses.map((m) => m.pct), 0.01);
    const bw2 = ew / meses.length;
    const pts = [];
    meses.forEach((m, i) => {
      const bx = ex0 + i * bw2 + bw2 * 0.2, w = bw2 * 0.6, h = (m.mes / mx) * eh * 0.8;
      fill(m.mm === state.resumenMes ? C.g : C.gl); doc.rect(bx, ey0 + eh - h, w, h, "F");
      txt(`${num0(m.mes)} m3`, bx + w / 2, ey0 + eh - 2, 8, m.mm === state.resumenMes ? [255, 255, 255] : C.gd, "bold", "center");
      txt(MESES_ABR[parseInt(m.mm.slice(5), 10) - 1], bx + w / 2, ey0 + eh + 5, 8.5, C.gd, "normal", "center");
      pts.push([bx + w / 2, ey0 + eh * 0.95 - (m.pct / (pmx * 1.15)) * eh * 0.85, m.pct]);
    });
    doc.setDrawColor(C.or[0], C.or[1], C.or[2]); doc.setLineWidth(0.7);
    for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    doc.setLineWidth(0.2);
    pts.forEach((p) => { fill(C.or); doc.circle(p[0], p[1], 1.2, "F"); txt(`${(p[2] * 100).toFixed(1).replace(".", ",")} %`, p[0], p[1] - 3, 8, C.or, "bold", "center"); });
  }

  // Tipo de hormigón (barra apilada) y m3 por día
  txt("Por tipo de hormigón", M, 172, 10, C.gd, "bold");
  const tipos = ordenarTiposHormigon(r.porHormigon).filter(([, v]) => v > 0);
  const totH = tipos.reduce((a, [, v]) => a + v, 0) || 1;
  const pal = [C.g, C.gd, C.bl, C.or, C.gr, C.rd, C.gl];
  let hx = M;
  tipos.forEach(([k, v], i) => { const w = (v / totH) * 88; fill(pal[i % pal.length]); doc.rect(hx, 176, w, 7, "F"); hx += w; });
  tipos.slice(0, 7).forEach(([k, v], i) => { fill(pal[i % pal.length]); doc.rect(M, 188 + i * 5, 3, 3, "F"); txt(`${k}   ${fmtM3(v)} m3   (${fmtPct(v / totH)})`, M + 5, 190.6 + i * 5, 8, C.tx); });

  txt("m3 por día", 112, 172, 10, C.gd, "bold");
  const porDia = {};
  rows.forEach((l) => { const rr = byId(state.remitos, l.remitoId); if (rr?.fecha) porDia[rr.fecha] = (porDia[rr.fecha] || 0) + (l.volumen || 0); });
  const dmax = Math.max(...Object.values(porDia), 1);
  const dias = new Date(ay, am, 0).getDate(), dx0 = 112, dy0 = 178, dh = 38, dw = PW - M - dx0;
  doc.setDrawColor(150, 150, 150); doc.line(dx0, dy0 + dh, dx0 + dw, dy0 + dh);
  let pico = null;
  for (let d = 1; d <= dias; d++) {
    const f = `${state.resumenMes}-${String(d).padStart(2, "0")}`, v = porDia[f] || 0;
    if (!pico || v > pico.v) pico = { d, v };
    if (v > 0) { const h = (v / dmax) * dh * 0.85, bx = dx0 + ((d - 1) / dias) * dw; fill(v === dmax ? C.or : C.gl); doc.rect(bx, dy0 + dh - h, dw / dias * 0.75, h, "F"); }
  }
  [1, 10, 20, dias].forEach((d) => txt(String(d), dx0 + ((d - 1) / dias) * dw + 1, dy0 + dh + 4, 7, C.gr, "normal", "center"));
  if (pico && pico.v > 0) txt(`pico: ${pico.d}/${String(am).padStart(2, "0")} · ${fmtM3(pico.v)} m3`, dx0 + dw, dy0 - 2, 7.5, C.tx, "normal", "right");

  // Basamento por equipo
  txt("Basamento por equipo (mes)", M, 232, 10, C.gd, "bold");
  const nomCuad = (g, def) => { const c = (state.catalogo.cuadrillas || []).find((q) => q.grupo === g); return c && c.nombre ? `${def} · ${c.nombre}` : def; };
  const eq = [[nomCuad("BASAMENTO_I", "Basamento I"), prod.m3BasI], [nomCuad("BASAMENTO_II", "Basamento II"), prod.m3BasII], ["Viga perimetral", prod.m3Viga]];
  const gen = volumenPorGrupo(rows, "BASAMENTO");
  if (gen > 0) eq.push(["Basamento (general)", gen]);
  eq.forEach(([n, v], i) => { const x = M + i * (CW / eq.length); txt(`${num0(v)} m3`, x, 244, 15, C.g, "bold"); txt(n, x, 250, 8, C.tx); });

  // ============ Página 3 ============
  doc.addPage();
  header("Personal y productividad");
  const hayPersonal = (prod.personalTorre + prod.personalBasamento + prod.personalHerreros + prod.personalIndirectos) > 0;
  if (!hayPersonal) {
    fill(C.bg); doc.setDrawColor(223, 230, 225); doc.roundedRect(M + 10, 50, CW - 20, 50, 3, 3, "FD");
    txt("Todavía no hay personal cargado este mes", PW / 2, 70, 13, C.gd, "bold", "center");
    txt("Cuando se cargue aparecen acá: jornales por equipo y HH por m3.", PW / 2, 82, 9.5, C.gr, "normal", "center");
  } else {
    const f2 = (n) => (n == null ? "-" : fmtM3(n));
    doc.autoTable({
      startY: 26, theme: "striped", styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: C.g, textColor: 255 }, margin: { left: M, right: M },
      head: [["Equipo", "Personal", "m3 del mes", "HH/m3 directas", "HH/m3 con indirectos"]],
      body: [
        ["Torre", prod.personalTorre, f2(prod.m3Torre), f2(prod.hhm3TorreDirectos), f2(prod.hhm3TorreConIndirectos)],
        ["Basamento I", prod.personalBasI, f2(prod.m3BasI), f2(prod.hhm3BasIDirectos), f2(prod.hhm3BasIConIndirectos)],
        ["Basamento II", prod.personalBasII, f2(prod.m3BasII), f2(prod.hhm3BasIIDirectos), f2(prod.hhm3BasIIConIndirectos)],
        ["Basamento unificado", prod.personalBasamento, f2(prod.m3Basamento), f2(prod.hhm3BasamentoDirectos), f2(prod.hhm3BasamentoConIndirectos)],
        ["General", "", f2(prod.m3Directo), f2(prod.hhm3GeneralDirectos), f2(prod.hhm3GeneralConIndirectos)],
      ],
    });
  }
  doc.addPage();
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

  dibujarPortadaReporte(doc, r, rows, prod, obra);

  doc.setFillColor(20, 45, 32);
  doc.rect(margin, y, pageWidth - margin * 2, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont(undefined, "bold");
  doc.text("Reporte mensual de hormigón - detalle de remitos", pageWidth / 2, y + 8, { align: "center" });
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
  if (r.m3Limpieza > 0) kpiBody.push(["Hormigón de limpieza (no suma al total)", `${fmtM3(r.m3Limpieza)} m3`, "", "", "", ""]);
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
  const acPdf = calcularAcumulado(state.resumenMes);
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  doc.text(`Acumulado de la obra hasta ${state.resumenMes}`, margin, y);
  doc.autoTable({ startY: y + 3, head: [["Zona", "M3 acumulados"]], theme: "striped", styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin },
    body: [["Torre", fmtM3(acPdf.torre) + " m3"], ["Basamento I", fmtM3(acPdf.basI) + " m3"], ["Basamento II", fmtM3(acPdf.basII) + " m3"], ["Basamento unificado", fmtM3(acPdf.basamento) + " m3"], ["Viga perimetral", fmtM3(acPdf.viga) + " m3"], ["Total (Torre + Basamento + Viga)", fmtM3(acPdf.total) + " m3"]] });
  {
    const av = calcularAvance(state.resumenMes);
    y = doc.lastAutoTable.finalY + 6;
    doc.autoTable({ startY: y, head: [["Avance de obra", "Acumulado", "% acumulado", "Del mes"]], theme: "striped", styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin },
      body: [["Torre", av.torre], ["Basamento (I + II + Viga perimetral)", av.basamento], ["Total obra", av.total]].map(([n, a]) => [n, `${fmtM3(a.acum)} de ${fmtM3(a.base)} m3`, fmtPctAv(a.acum, a.base), `+${fmtPctAv(a.mes, a.base)}`]) });
  }
  y = doc.lastAutoTable.finalY + 8;
  if (y > 230) { doc.addPage(); y = margin; }
  doc.setFont(undefined, "bold");
  doc.setFontSize(11);
  const bodyHorm = ordenarTiposHormigon(r.porHormigon).map(([kk, v]) => [kk, fmtM3(v) + " m3"]);
  doc.text("M3 por tipo de hormigón", margin, y);
  doc.autoTable({ startY: y + 3, head: [["Tipo de hormigón", "M3"]], body: bodyHorm, theme: "striped", styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [47, 107, 73], textColor: 255 }, margin: { left: margin, right: margin } });
  y = doc.lastAutoTable.finalY + 8;
  if (y > 230) { doc.addPage(); y = margin; }
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
      ["Personal Torre / Basamento I / Basamento II / Basamento unificado / Herreros / Indirectos", `${prod.personalTorre} / ${prod.personalBasI} / ${prod.personalBasII} / ${prod.personalBasamento} / ${prod.personalHerreros} / ${prod.personalIndirectos}`],
      ["M3 Torre / Basamento I / Basamento II / Basamento unificado", `${fmtM3(prod.m3Torre)} / ${fmtM3(prod.m3BasI)} / ${fmtM3(prod.m3BasII)} / ${fmtM3(prod.m3Basamento)}`],
      ["M3 Viga perimetral", fmtM3(prod.m3Viga)],
      ["Días laborables del mes", String(prod.diasLaborables)],
      ["HH/m3 general — directos / con indirectos", `${fmtHH(prod.hhm3GeneralDirectos)} / ${fmtHH(prod.hhm3GeneralConIndirectos)}`],
      ["HH/m3 Torre — directos / con indirectos", `${fmtHH(prod.hhm3TorreDirectos)} / ${fmtHH(prod.hhm3TorreConIndirectos)}`],
      ["HH/m3 Basamento I — directos / con indirectos", `${fmtHH(prod.hhm3BasIDirectos)} / ${fmtHH(prod.hhm3BasIConIndirectos)}`],
      ["HH/m3 Basamento II — directos / con indirectos", `${fmtHH(prod.hhm3BasIIDirectos)} / ${fmtHH(prod.hhm3BasIIConIndirectos)}`],
      ["HH/m3 Basamento unificado — directos / con indirectos", `${fmtHH(prod.hhm3BasamentoDirectos)} / ${fmtHH(prod.hhm3BasamentoConIndirectos)}`],
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
    ...(r.m3Limpieza > 0 ? [["Hormigón de limpieza (no suma al total)", r.m3Limpieza]] : []),
    [],
    ["M3 por tipo de elemento"],
    ...Object.entries(r.porElemento).sort((a, b) => b[1] - a[1]),
    [],
    [`Acumulado de la obra hasta ${state.resumenMes} (m3)`],
    ["Torre", calcularAcumulado(state.resumenMes).torre],
    ["Basamento I", calcularAcumulado(state.resumenMes).basI],
    ["Basamento II", calcularAcumulado(state.resumenMes).basII],
    ["Basamento unificado", calcularAcumulado(state.resumenMes).basamento],
    ["Viga perimetral", calcularAcumulado(state.resumenMes).viga],
    ["Total (Torre + Basamento + Viga)", calcularAcumulado(state.resumenMes).total],
    [],
    ["Avance de obra", "m3 acumulados", "m3 teóricos", "% acumulado", "m3 del mes", "% del mes"],
    ...(() => { const av = calcularAvance(state.resumenMes); return [["Torre", av.torre], ["Basamento (I + II + Viga perimetral)", av.basamento], ["Total obra", av.total]].map(([n, a]) => [n, a.acum, a.base, a.base ? a.acum / a.base : 0, a.mes, a.base ? a.mes / a.base : 0]); })(),
    [],
    ["M3 por tipo de hormigón"],
    ...ordenarTiposHormigon(r.porHormigon),
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
