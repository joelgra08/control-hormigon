/* ===========================================================
   programacion.js — Programación de hormigón (pedidos a futuro)
   Cada fila es un llenado programado: fecha, hora de llegada,
   forma de colocación (volcado / bomba), tipo de hormigón,
   elemento, m3 y notas, cargado por separado para Torre y para
   Basamento. Al exportar a PDF se unifican las dos zonas por día,
   ordenadas por hora, con el total de m3 de cada día — es la
   planilla que se le manda a la hormigonera.

   Permisos: Administrador y Asistente pueden agregar, editar y
   borrar; el resto solo ve y exporta. Como siempre, la seguridad
   real la aplica el servidor (RLS de la tabla "programacion").
   =========================================================== */

const PROG_ZONAS = { TORRE: "Torre", BASAMENTO: "Basamento" };
const PROG_BOMBEADO = ["Volcado", "Bomba Lanza", "Bomba de arrastre"];
// Tipos de hormigón del desplegable, en el orden en que se muestran.
const PROG_HORMIGONES = [
  "C20 pp14-20 A15",
  "C25 pp14-20 A15",
  "C25 pp14-20 A18",
  "C30 pp14-20 A15",
  "C45 pp5-14 A15",
  "C35 pp14-20 A18",
  "C35 pp5-14 A15",
  "C45 pp5-14 A18",
  "A definir",
];
const PROG_DIAS = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
const PROG_MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];
const PROG_MOTIVO_DEFAULT = "Sin llenados por lluvia";

// ---------- Fechas (siempre en hora local, sin pasar por UTC) ----------
function progISO(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function progParse(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function progHoy() { return progISO(new Date()); }
function progSumarDias(iso, n) {
  const d = progParse(iso);
  d.setDate(d.getDate() + n);
  return progISO(d);
}
function progSiguienteHabil(iso) {
  let f = progSumarDias(iso, 1);
  while ([0, 6].includes(progParse(f).getDay())) f = progSumarDias(f, 1);
  return f;
}
function progDiaNombre(iso) { return PROG_DIAS[progParse(iso).getDay()]; }
function progFechaCorta(iso) {
  const d = progParse(iso);
  return `${d.getDate()}-${PROG_MESES[d.getMonth()]}`;
}
function progFechaLarga(iso) { return `${progFechaCorta(iso)}-${progParse(iso).getFullYear()}`; }

function progEsBomba(texto) { return /bomba/i.test(texto || ""); }
function progPuedeEditar() { return puedeAgregar(); }

// ---------- Carga ----------
// No usa DB.getAll a propósito: si la tabla todavía no fue creada en el
// servidor, acá se detecta y se avisa en la pestaña, sin tirar un error en
// pantalla cada vez que se recargan los datos. Además trae de a 1000 filas,
// que es el tope por pedido del servidor.
async function cargarProgramacion(obraId) {
  const filas = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabaseClient
      .from("programacion").select("*").eq("obra_id", obraId)
      .order("fecha", { ascending: true }).order("id", { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) {
      console.warn("[Programación] No se pudo leer la tabla:", error);
      state.programacionDisponible = false;
      state.programacion = [];
      return;
    }
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  state.programacionDisponible = true;
  state.programacion = filas.map(rowFromDb).map((r) => ({ ...r, m3: r.m3 === null || r.m3 === undefined ? null : Number(r.m3) }));
}

// ---------- Consultas ----------
function progOrdenar(a, b) {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  if (!!a.sinLlenados !== !!b.sinLlenados) return a.sinLlenados ? 1 : -1;
  const ha = a.hora || "99:99", hb = b.hora || "99:99";
  if (ha !== hb) return ha < hb ? -1 : 1;
  if (a.zona !== b.zona) return a.zona === "TORRE" ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function progFilas(zona, desde, hasta) {
  return state.programacion.filter((r) => {
    if (zona !== "TODAS" && r.zona !== zona) return false;
    if (desde && r.fecha < desde) return false;
    if (hasta && r.fecha > hasta) return false;
    return true;
  }).sort(progOrdenar);
}

function progAgruparPorDia(filas) {
  const dias = [];
  filas.forEach((r) => {
    let dia = dias[dias.length - 1];
    if (!dia || dia.fecha !== r.fecha) {
      dia = { fecha: r.fecha, filas: [], total: 0 };
      dias.push(dia);
    }
    dia.filas.push(r);
    if (!r.sinLlenados) dia.total += r.m3 || 0;
  });
  // Un día que tiene llenados programados no muestra el aviso de "sin
  // llenados" de la otra zona: ese aviso solo vale si el día quedó vacío.
  dias.forEach((d) => {
    const conLlenados = d.filas.filter((r) => !r.sinLlenados);
    if (conLlenados.length > 0) d.filasVisibles = conLlenados;
    else {
      const motivos = new Set();
      d.filasVisibles = d.filas.filter((r) => {
        const m = (r.notas || PROG_MOTIVO_DEFAULT).trim().toLowerCase();
        if (motivos.has(m)) return false;
        motivos.add(m);
        return true;
      });
    }
  });
  return dias;
}

// ---------- Formulario ----------
function progForm() { return $("#formProgramacion"); }

// Arma el desplegable de tipo de hormigón. Si el valor que hay que mostrar
// no está en la lista (un llenado cargado antes con otro texto), se agrega
// al final para no perderlo al editar esa fila.
function progRenderHormigones(valor) {
  const sel = progForm().prog_hormigon;
  const actual = valor !== undefined ? (valor || "") : sel.value;
  const opciones = [...PROG_HORMIGONES];
  if (actual && !opciones.includes(actual)) opciones.push(actual);
  sel.innerHTML = "";
  sel.appendChild(el("option", { value: "" }, "Seleccionar..."));
  opciones.forEach((o) => sel.appendChild(el("option", { value: o }, o)));
  sel.value = actual;
}

function progOnSinLlenadosChange() {
  const f = progForm();
  const sin = f.prog_sinLlenados.checked;
  ["prog_hora", "prog_bombeado", "prog_hormigon", "prog_elemento", "prog_m3"].forEach((n) => { f[n].disabled = sin; });
  f.prog_notas.placeholder = sin ? PROG_MOTIVO_DEFAULT : "Ej: Llaneado";
  $("#prog_notasLabel").textContent = sin ? "Motivo" : "Notas";
}

function progResetForm(mantener) {
  const f = progForm();
  if (!f) return;
  const previo = mantener ? { fecha: f.prog_fecha.value, hora: f.prog_hora.value, bombeado: f.prog_bombeado.value, hormigon: f.prog_hormigon.value } : null;
  f.reset();
  state.prog.editingId = null;
  f.prog_fecha.value = previo ? previo.fecha : (f.prog_fecha.value || progHoy());
  if (previo) {
    f.prog_hora.value = previo.hora;
    f.prog_bombeado.value = previo.bombeado;
    f.prog_hormigon.value = previo.hormigon;
  }
  progOnSinLlenadosChange();
  progActualizarTituloForm();
}

function progActualizarTituloForm() {
  const zonaNombre = PROG_ZONAS[state.prog.zona] || "";
  const editando = !!state.prog.editingId;
  $("#progFormTitulo").textContent = `${editando ? "Editar llenado" : "Nuevo llenado"} — ${zonaNombre}`;
  $("#btnProgGuardar").textContent = editando ? "Guardar cambios" : "+ Agregar";
  $("#btnProgCancelar").style.display = editando ? "" : "none";
}

function progCargarEnForm(fila, comoNuevo) {
  if (state.prog.zona !== fila.zona) progSetZona(fila.zona);
  const f = progForm();
  f.reset();
  state.prog.editingId = comoNuevo ? null : fila.id;
  f.prog_fecha.value = fila.fecha;
  f.prog_hora.value = fila.hora || "";
  f.prog_bombeado.value = PROG_BOMBEADO.includes(fila.bombeado) ? fila.bombeado : PROG_BOMBEADO[0];
  progRenderHormigones(fila.tipoHormigon || "");
  f.prog_elemento.value = fila.elemento || "";
  f.prog_m3.value = fila.m3 ?? "";
  f.prog_notas.value = fila.notas || "";
  f.prog_sinLlenados.checked = !!fila.sinLlenados;
  progOnSinLlenadosChange();
  progActualizarTituloForm();
  $("#progFormPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  (fila.sinLlenados ? f.prog_notas : f.prog_elemento).focus();
}

async function progOnSubmit(e) {
  e.preventDefault();
  if (!progPuedeEditar()) return;
  const f = progForm();
  const sin = f.prog_sinLlenados.checked;
  const fecha = f.prog_fecha.value;
  if (!fecha) return toast("Falta la fecha", "error");
  const m3 = f.prog_m3.value === "" ? null : Number(f.prog_m3.value);
  if (!sin) {
    if (!f.prog_hormigon.value) { f.prog_hormigon.focus(); return toast("Falta el tipo de hormigón", "error"); }
    if (!f.prog_elemento.value.trim()) { f.prog_elemento.focus(); return toast("Falta el elemento", "error"); }
    if (m3 === null || isNaN(m3) || m3 <= 0) { f.prog_m3.focus(); return toast("Faltan los m3", "error"); }
  }
  const fila = {
    id: state.prog.editingId || uid("prog"),
    obraId: state.obraId,
    zona: state.prog.zona,
    fecha,
    hora: sin ? null : (f.prog_hora.value || null),
    bombeado: sin ? null : f.prog_bombeado.value,
    tipoHormigon: sin ? null : (f.prog_hormigon.value || null),
    elemento: sin ? null : f.prog_elemento.value.trim(),
    m3: sin ? null : m3,
    notas: f.prog_notas.value.trim() || (sin ? PROG_MOTIVO_DEFAULT : null),
    sinLlenados: sin,
  };
  const editando = !!state.prog.editingId;
  const anterior = editando ? state.programacion.find((r) => r.id === fila.id) : null;
  try {
    await DB.put("programacion", fila);
  } catch (err) { return; } // el aviso de error ya lo mostró la capa de datos
  const idx = state.programacion.findIndex((r) => r.id === fila.id);
  if (idx >= 0) state.programacion[idx] = fila; else state.programacion.push(fila);
  progResetForm(true);
  renderProgramacion();
  toast(editando ? "Llenado actualizado" : "Llenado agregado", "ok");
  progAvisarCambio(editando ? "modificado" : "agregado", fila, anterior);
  if (!sin) progForm().prog_elemento.focus();
}

async function progBorrar(fila) {
  const desc = fila.sinLlenados ? (fila.notas || PROG_MOTIVO_DEFAULT) : `${fila.elemento} (${fmtM3(fila.m3)} m3)`;
  if (!confirm(`¿Borrar de la programación del ${progFechaCorta(fila.fecha)}: ${desc}?`)) return;
  try { await DB.delete("programacion", fila.id); } catch (err) { return; }
  state.programacion = state.programacion.filter((r) => r.id !== fila.id);
  if (state.prog.editingId === fila.id) progResetForm(true);
  renderProgramacion();
  toast("Llenado borrado", "ok");
  progAvisarCambio("eliminado", fila, null);
}

function progPasarAlSiguiente(fila) { return progMoverA(fila, progSiguienteHabil(fila.fecha)); }

// Cambia de día un llenado (botón ⏭ o arrastrando la fila a otro día).
async function progMoverA(fila, fecha) {
  if (!progPuedeEditar() || !fecha || fecha === fila.fecha) return;
  const nueva = { ...fila, fecha };
  const anterior = fila;
  try { await DB.put("programacion", nueva); } catch (err) { return; }
  const idx = state.programacion.findIndex((r) => r.id === fila.id);
  if (idx >= 0) state.programacion[idx] = nueva;
  renderProgramacion();
  toast(`Pasado al ${progDiaNombre(nueva.fecha).toLowerCase()} ${progFechaCorta(nueva.fecha)}`, "ok");
  progAvisarCambio("reprogramado", nueva, anterior);
}

// ---------- Vista ----------
let progArrastrandoId = null; // id del llenado que se está arrastrando a otro día

function progSetZona(zona) {
  state.prog.zona = zona;
  if (state.prog.editingId) progResetForm(true);
  renderProgramacion();
}

function progSetRango(desde, hasta) {
  state.prog.desde = desde;
  state.prog.hasta = hasta;
  $("#progDesde").value = desde;
  $("#progHasta").value = hasta;
  renderProgramacion();
}

function renderProgramacion() {
  const root = $("#progLista");
  if (!root) return;
  const zona = state.prog.zona;
  const unificado = zona === "TODAS";
  const editor = progPuedeEditar();

  $all("#progZonaTabs button").forEach((b) => b.classList.toggle("active", b.dataset.zona === zona));
  $("#progNoDisponible").style.display = state.programacionDisponible ? "none" : "block";
  $("#progFormPanel").style.display = (!state.programacionDisponible || unificado) ? "none" : "";
  $("#progAvisoUnificado").style.display = (unificado && editor && state.programacionDisponible) ? "block" : "none";
  if ($("#progDesde").value !== state.prog.desde) $("#progDesde").value = state.prog.desde;
  if ($("#progHasta").value !== state.prog.hasta) $("#progHasta").value = state.prog.hasta;
  if (!unificado) progActualizarTituloForm();
  if (!progForm().prog_fecha.value) progForm().prog_fecha.value = progHoy();
  progRenderHormigones();

  const filas = progFilas(zona, state.prog.desde, state.prog.hasta);
  const dias = progAgruparPorDia(filas);
  root.innerHTML = "";

  const todas = progFilas("TODAS", state.prog.desde, state.prog.hasta).filter((r) => !r.sinLlenados);
  const suma = (z) => todas.filter((r) => r.zona === z).reduce((a, r) => a + (r.m3 || 0), 0);
  $("#progResumen").textContent = todas.length === 0 ? "" :
    `Total del período: ${fmtM3(suma("TORRE") + suma("BASAMENTO"))} m³ — Torre ${fmtM3(suma("TORRE"))} m³ · Basamento ${fmtM3(suma("BASAMENTO"))} m³`;

  // Quien puede editar ve también los días hábiles del rango que todavía
  // están vacíos: son el lugar donde soltar un llenado al arrastrarlo.
  if (editor && state.prog.desde && state.prog.hasta && state.prog.desde <= state.prog.hasta) {
    const porFecha = new Map(dias.map((d) => [d.fecha, d]));
    const completos = [];
    let f = state.prog.desde;
    for (let i = 0; i < 92 && f <= state.prog.hasta; i++, f = progSumarDias(f, 1)) {
      if (porFecha.has(f)) completos.push(porFecha.get(f));
      else if (![0, 6].includes(progParse(f).getDay())) completos.push({ fecha: f, filas: [], filasVisibles: [], total: 0 });
    }
    dias.filter((d) => d.fecha >= f).forEach((d) => completos.push(d));
    dias.length = 0;
    dias.push(...completos);
  }
  $("#progAyudaArrastre").style.display = editor && dias.some((d) => d.filas.length > 0) ? "block" : "none";

  if (dias.length === 0) {
    root.appendChild(el("div", { class: "empty-state" },
      unificado ? "No hay llenados programados en ese rango de fechas."
                : `No hay llenados programados de ${PROG_ZONAS[zona]} en ese rango de fechas.`));
    return;
  }

  dias.forEach((dia) => {
    const vacio = dia.filas.length === 0;
    const bloque = el("div", { class: "prog-dia" + (vacio ? " prog-dia-vacio" : "") });
    bloque.appendChild(el("div", { class: "prog-dia-head" }, [
      el("span", {}, `${progDiaNombre(dia.fecha)} ${progFechaCorta(dia.fecha)}`),
      el("span", {}, vacio ? "Sin llenados programados" : `Total ${fmtM3(dia.total)} m³`),
    ]));
    if (editor) {
      // Cada día es un destino donde soltar una fila arrastrada.
      bloque.addEventListener("dragover", (e) => {
        if (!progArrastrandoId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        bloque.classList.add("prog-destino");
      });
      bloque.addEventListener("dragleave", (e) => {
        if (!bloque.contains(e.relatedTarget)) bloque.classList.remove("prog-destino");
      });
      bloque.addEventListener("drop", (e) => {
        e.preventDefault();
        bloque.classList.remove("prog-destino");
        const fila = byId(state.programacion, progArrastrandoId);
        progArrastrandoId = null;
        if (fila) progMoverA(fila, dia.fecha);
      });
    }
    if (vacio) {
      bloque.appendChild(el("div", { class: "prog-soltar" }, "Soltá acá para pasar el llenado a este día"));
      root.appendChild(bloque);
      return;
    }
    const tabla = el("table");
    const cols = ["Hora llegada", "Bombeado", "Tipo hormigón", "Elemento", "m³", "Notas"];
    if (unificado) cols.push("Zona");
    if (editor) cols.push("");
    const clases = { "Hora llegada": "c-hora", "Bombeado": "c-bomb", "Tipo hormigón": "c-tipo", "m³": "c-m3", "Notas": "c-notas", "Zona": "c-zona", "": "c-acc" };
    tabla.appendChild(el("thead", {}, el("tr", {}, cols.map((c) => el("th", clases[c] !== undefined ? { class: clases[c] } : {}, c)))));
    const tbody = el("tbody");
    // En las pestañas Torre / Basamento se muestran todas las filas de esa
    // zona (incluido su aviso de "sin llenados"), para poder editarlas o
    // borrarlas; la vista unificada muestra lo mismo que va a salir en el PDF.
    (unificado ? dia.filasVisibles : dia.filas).forEach((r) => {
      const tr = el("tr", r.sinLlenados ? { class: "prog-sin" } : {});
      if (r.sinLlenados) {
        tr.appendChild(el("td", { colspan: String(cols.length - (editor ? 1 : 0)) }, r.notas || PROG_MOTIVO_DEFAULT));
      } else {
        tr.appendChild(el("td", {}, r.hora || "-"));
        tr.appendChild(el("td", {}, el("span", { class: progEsBomba(r.bombeado) ? "prog-bomba" : "" }, r.bombeado || "-")));
        tr.appendChild(el("td", {}, r.tipoHormigon || "-"));
        tr.appendChild(el("td", { style: "white-space:normal" }, r.elemento || "-"));
        tr.appendChild(el("td", { style: "text-align:right" }, fmtM3(r.m3)));
        tr.appendChild(el("td", { style: "white-space:normal" }, r.notas || ""));
        if (unificado) tr.appendChild(el("td", {}, PROG_ZONAS[r.zona] || r.zona));
      }
      if (editor) {
        tr.draggable = true;
        tr.classList.add("prog-arrastrable");
        tr.title = "Arrastrá la fila a otro día para reprogramarla";
        tr.addEventListener("dragstart", (e) => {
          progArrastrandoId = r.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", r.id);
          tr.classList.add("prog-arrastrando");
          root.classList.add("prog-en-arrastre");
        });
        tr.addEventListener("dragend", () => {
          progArrastrandoId = null;
          tr.classList.remove("prog-arrastrando");
          root.classList.remove("prog-en-arrastre");
          $all(".prog-destino", root).forEach((b) => b.classList.remove("prog-destino"));
        });
        const td = el("td", { class: "prog-acciones" });
        const boton = (txt, titulo, fn, extra = "") => {
          const b = el("button", { class: "ghost" + extra, title: titulo, type: "button" }, txt);
          b.addEventListener("click", fn);
          td.appendChild(b);
        };
        boton("✎", "Editar", () => progCargarEnForm(r, false));
        if (!r.sinLlenados) boton("⧉", "Duplicar (carga los mismos datos como un llenado nuevo)", () => progCargarEnForm(r, true));
        boton("⏭", "Pasar al día hábil siguiente", () => progPasarAlSiguiente(r));
        boton("✕", "Borrar", () => progBorrar(r), " danger");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    tabla.appendChild(tbody);
    bloque.appendChild(tabla);
    root.appendChild(bloque);
  });
}

// ---------- Exportar a PDF (Torre + Basamento unificados por día) ----------
function exportarProgramacionPDF() {
  const obra = byId(state.obras, state.obraId);
  const desde = state.prog.desde, hasta = state.prog.hasta;
  if (!desde || !hasta) return toast("Elegí las fechas Desde y Hasta", "error");
  if (desde > hasta) return toast("La fecha Desde es posterior a la fecha Hasta", "error");
  const dias = progAgruparPorDia(progFilas("TODAS", desde, hasta));
  if (dias.length === 0) return toast("No hay llenados programados en ese rango", "error");

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const ancho = pageWidth - margin * 2;
  const VERDE_OSCURO = [20, 45, 32], VERDE = [47, 107, 73], VERDE_CLARO = [214, 235, 221];
  let y = margin;

  doc.setFillColor(...VERDE_OSCURO);
  doc.rect(margin, y, ancho, 11, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont(undefined, "bold");
  doc.setFontSize(12);
  doc.text(`PROGRAMACIÓN DE HORMIGÓN - ${(obra?.nombre || "").toUpperCase()}`, margin + 3, y + 7.3);
  doc.setFontSize(10);
  doc.text(`${progFechaLarga(desde)}  al  ${progFechaLarga(hasta)}`, pageWidth - margin - 3, y + 7.3, { align: "right" });
  y += 15;

  const ALTO_FILA = 6.2, ALTO_BARRA = 6.5;
  let totalPeriodo = 0;
  dias.forEach((dia) => {
    totalPeriodo += dia.total;
    // Que un día no quede partido entre dos hojas si entra entero en la siguiente.
    const altoEstimado = ALTO_BARRA + ALTO_FILA * (dia.filasVisibles.length + 2);
    if (y + altoEstimado > pageHeight - margin && y > margin + 20) {
      doc.addPage();
      y = margin;
    }

    doc.setFillColor(...VERDE);
    doc.rect(margin, y, ancho, ALTO_BARRA, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont(undefined, "bold");
    doc.setFontSize(9.5);
    doc.text(`${progDiaNombre(dia.fecha)}   ${progFechaCorta(dia.fecha)}`, margin + 2, y + 4.6);
    y += ALTO_BARRA;

    const body = dia.filasVisibles.map((r) => {
      if (r.sinLlenados) {
        return [{ content: r.notas || PROG_MOTIVO_DEFAULT, colSpan: 7, styles: { halign: "center", fontStyle: "bold", textColor: [179, 65, 58], fillColor: [253, 236, 234] } }];
      }
      const bombeado = { content: r.bombeado || "-", styles: { fontStyle: "bold" } };
      if (progEsBomba(r.bombeado)) bombeado.styles.fillColor = [255, 242, 0];
      return [
        r.hora || "-",
        bombeado,
        { content: r.tipoHormigon || "-", styles: { fontStyle: "bold" } },
        r.elemento || "-",
        `${fmtM3(r.m3)} m3`,
        r.notas || "",
        PROG_ZONAS[r.zona] || r.zona || "",
      ];
    });

    doc.autoTable({
      startY: y,
      head: [["Hora llegada", "Bombeado", "Tipo hormigón", "Elemento", "m3", "Notas", "Zona"]],
      body,
      foot: [[{ content: "Total", colSpan: 4, styles: { halign: "right" } }, `${fmtM3(dia.total)} m3`, "", ""]],
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 1.4, textColor: [28, 38, 32], lineColor: [190, 205, 196], lineWidth: 0.1, overflow: "linebreak" },
      headStyles: { fillColor: VERDE_CLARO, textColor: [20, 45, 32], fontStyle: "bold" },
      footStyles: { fillColor: VERDE_CLARO, textColor: [20, 45, 32], fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 22, halign: "right" },
        1: { cellWidth: 28 },
        2: { cellWidth: 27 },
        3: { cellWidth: ancho - 144 },
        4: { cellWidth: 19, halign: "right" },
        5: { cellWidth: 30 },
        6: { cellWidth: 18 },
      },
      didParseCell: (data) => {
        if (data.column.index === 4 && data.section !== "body") data.cell.styles.halign = "right";
      },
      margin: { left: margin, right: margin },
      showFoot: "lastPage",
      rowPageBreak: "avoid",
    });
    y = doc.lastAutoTable.finalY + 4;
  });

  if (y + 8 > pageHeight - margin) { doc.addPage(); y = margin; }
  doc.setTextColor(20, 45, 32);
  doc.setFont(undefined, "bold");
  doc.setFontSize(9.5);
  doc.text(`Total del período: ${fmtM3(totalPeriodo)} m3`, pageWidth - margin, y + 4, { align: "right" });

  const paginas = doc.internal.getNumberOfPages();
  doc.setFont(undefined, "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(110, 125, 116);
  const emitido = new Date();
  const emitidoTxt = `Emitido el ${progFechaLarga(progISO(emitido))} ${String(emitido.getHours()).padStart(2, "0")}:${String(emitido.getMinutes()).padStart(2, "0")}`;
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p);
    doc.text(emitidoTxt, margin, pageHeight - 5);
    doc.text(`Hoja ${p} de ${paginas}`, pageWidth - margin, pageHeight - 5, { align: "right" });
  }

  // Nombre del archivo sin tildes: algunos navegadores descartan el nombre
  // entero si trae caracteres acentuados.
  const nombreObra = (obra?.nombre || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w .-]/g, "").trim();
  doc.save(`${fmtFechaArchivo(desde)} programacion hormigon ${nombreObra}`.trim() + ".pdf");
}

// ---------- Aviso por mail a la hormigonera cuando se modifica la programación ----------
// Abre un borrador en el programa de correo del usuario (mailto:, por
// ejemplo Outlook). No se envía nada solo: el administrador decide si lo manda.
const PROG_MAIL_CC = ["jamonte@zulamian.com", "mcoitino@zulamian.com"];
const PROG_MAIL_PARA = ["hormigonmaldonado@cieloazul.com", "dramirez@cieloazul.com", "hceretta@cieloazul.com"];

function progAvisoActivo() {
  const c = $("#progAvisarMail");
  return !!(esAdmin() && c && c.checked);
}

function progDescLlenado(r) {
  const cuando = progDiaTransito(r.fecha);
  const zona = PROG_ZONAS[r.zona] || r.zona || "";
  if (r.sinLlenados) return `${cuando} - ${zona} - ${r.notas || PROG_MOTIVO_DEFAULT}`;
  return [cuando, progHoraHHMM(r.hora) ? `${progHoraHHMM(r.hora)}hs` : "sin hora", zona, r.elemento,
    r.m3 !== null && r.m3 !== undefined ? `${fmtM3(r.m3)} m3` : "", r.bombeado, r.tipoHormigon].filter(Boolean).join(" - ");
}

// Recuadro de un día (como la tarjeta del PDF) dibujado como imagen PNG:
// se ve igual en cualquier Outlook y con letra grande. La fila que cambió va
// resaltada; una fila borrada aparece tachada. Devuelve el PNG en base64.
function progImagenDia(fecha, idResaltar, borrada) {
  const filas = state.programacion.filter((r) => r.fecha === fecha).sort(progOrdenar);
  const conLlenados = filas.filter((r) => !r.sinLlenados);
  const visibles = conLlenados.length ? conLlenados : filas.slice(0, 1);
  const total = conLlenados.reduce((a, r) => a + (r.m3 || 0), 0);
  const nombre = PROG_DIAS[progParse(fecha).getDay()];

  const W = 1100, ESC = 2, PAD = 10, LH = 22;
  const FUENTE = "Calibri, 'Segoe UI', Arial, sans-serif";
  const cols = [
    { t: "Hora llegada", w: 120, der: true }, { t: "Bombeado", w: 180 }, { t: "Tipo hormigón", w: 210 },
    { t: "Elemento", w: 240 }, { t: "m³", w: 90, der: true }, { t: "Notas", w: 150 }, { t: "Zona", w: 110 },
  ];
  const medir = document.createElement("canvas").getContext("2d");
  medir.font = `18px ${FUENTE}`;
  const partir = (txt, ancho) => {
    const lineas = []; let actual = "";
    String(txt || "").split(/\s+/).filter(Boolean).forEach((pal) => {
      const prueba = actual ? `${actual} ${pal}` : pal;
      if (medir.measureText(prueba).width <= ancho || !actual) actual = prueba;
      else { lineas.push(actual); actual = pal; }
    });
    if (actual) lineas.push(actual);
    return lineas.length ? lineas : [""];
  };

  const datos = visibles.map((r) => ({ r, bg: r.id === idResaltar ? "#fff4cc" : "#ffffff", tachado: false }));
  if (borrada && borrada.fecha === fecha) datos.push({ r: borrada, bg: "#fdecea", tachado: true });
  const celdas = datos.map((d) => {
    const r = d.r;
    if (r.sinLlenados) return { ...d, sin: true, lineas: partir(r.notas || PROG_MOTIVO_DEFAULT, W - 2 * PAD) };
    return { ...d, cel: [
      [progHoraHHMM(r.hora) || "-"], [r.bombeado || "-"], [r.tipoHormigon || "-"], [r.elemento || "-"],
      [r.m3 === null || r.m3 === undefined ? "" : fmtM3(r.m3)], [r.notas || ""], [PROG_ZONAS[r.zona] || r.zona || ""],
    ].map((c, i) => (i === 3 || i === 5 || i === 2 ? partir(c[0], cols[i].w - 2 * PAD) : c)) };
  });
  const altoFila = (c) => (c.sin ? c.lineas.length : Math.max(...c.cel.map((x) => x.length))) * LH + 16;
  const ALTO_TIT = 50, ALTO_CAB = 40, ALTO_TOT = 40;
  const vacio = celdas.length === 0;
  const alto = ALTO_TIT + ALTO_CAB + (vacio ? 44 : celdas.reduce((a, c) => a + altoFila(c), 0)) + ALTO_TOT;

  const cv = document.createElement("canvas");
  cv.width = W * ESC; cv.height = alto * ESC;
  const g = cv.getContext("2d");
  g.scale(ESC, ESC);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, alto);
  g.textBaseline = "middle";
  const borde = (x, y, w, h, fondo) => {
    if (fondo) { g.fillStyle = fondo; g.fillRect(x, y, w, h); }
    g.strokeStyle = "#becdc4"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };

  g.fillStyle = "#2f6b49"; g.fillRect(0, 0, W, ALTO_TIT);
  g.fillStyle = "#ffffff"; g.font = `bold 24px ${FUENTE}`;
  g.textAlign = "left"; g.fillText(`${nombre}  ${progFechaCorta(fecha)}`, 14, ALTO_TIT / 2);
  g.textAlign = "right"; g.fillText(`Total ${fmtM3(total)} m³`, W - 14, ALTO_TIT / 2);

  let y = ALTO_TIT, x = 0;
  g.font = `bold 18px ${FUENTE}`;
  cols.forEach((c) => {
    borde(x, y, c.w, ALTO_CAB, "#d6ebdd");
    g.fillStyle = "#142d20"; g.textAlign = "center"; g.fillText(c.t, x + c.w / 2, y + ALTO_CAB / 2);
    x += c.w;
  });
  y += ALTO_CAB;

  if (vacio) {
    borde(0, y, W, 44, "#ffffff");
    g.font = `18px ${FUENTE}`; g.fillStyle = "#6e7d74"; g.textAlign = "center";
    g.fillText("Sin llenados programados", W / 2, y + 22); y += 44;
  }
  celdas.forEach((c) => {
    const h = altoFila(c);
    if (c.sin) {
      borde(0, y, W, h, "#fdecea");
      g.font = `bold 18px ${FUENTE}`; g.fillStyle = "#b3413a"; g.textAlign = "center";
      c.lineas.forEach((l, i) => g.fillText(l, W / 2, y + 8 + LH / 2 + i * LH));
    } else {
      x = 0;
      c.cel.forEach((lineas, i) => {
        const col = cols[i];
        const bomba = i === 1 && progEsBomba(c.r.bombeado) && !c.tachado;
        borde(x, y, col.w, h, bomba ? "#fff200" : c.bg);
        g.font = `${bomba ? "bold " : ""}18px ${FUENTE}`;
        g.fillStyle = c.tachado ? "#8a2b2b" : "#1c2620";
        g.textAlign = col.der ? "right" : "left";
        const tx = col.der ? x + col.w - PAD : x + PAD;
        lineas.forEach((l, k) => {
          const ty = y + 8 + LH / 2 + k * LH;
          g.fillText(l, tx, ty);
          if (c.tachado && l) {
            const ancho = g.measureText(l).width;
            g.strokeStyle = "#8a2b2b";
            g.beginPath(); g.moveTo(col.der ? tx - ancho : tx, ty); g.lineTo(col.der ? tx : tx + ancho, ty); g.stroke();
          }
        });
        x += col.w;
      });
    }
    y += h;
  });

  const wTot = cols.slice(0, 4).reduce((a, c) => a + c.w, 0);
  borde(0, y, wTot, ALTO_TOT, "#d6ebdd");
  borde(wTot, y, cols[4].w, ALTO_TOT, "#d6ebdd");
  borde(wTot + cols[4].w, y, W - wTot - cols[4].w, ALTO_TOT, "#d6ebdd");
  g.font = `bold 18px ${FUENTE}`; g.fillStyle = "#142d20";
  g.textAlign = "right"; g.fillText("Total", wTot - PAD, y + ALTO_TOT / 2);
  g.fillText(fmtM3(total), wTot + cols[4].w - PAD, y + ALTO_TOT / 2);
  return cv.toDataURL("image/png").split(",")[1];
}

const PROG_FIRMA_LINEAS = ["Sistema de Control de Hormigón", "Mail enviado automáticamente"];

function progHtmlAviso(tipo, fila, anterior, obraNombre, nImagenes) {
  const rotulo = { agregado: "Se AGREGÓ un llenado", eliminado: "Se ELIMINÓ un llenado", modificado: "Se MODIFICÓ un llenado", reprogramado: "Se REPROGRAMÓ un llenado" }[tipo];
  const detalle = [];
  if (tipo === "modificado" || tipo === "reprogramado") {
    if (anterior) detalle.push(`<b>Antes:</b> ${xmlEsc(progDescLlenado(anterior))}`);
    detalle.push(`<b>Ahora:</b> ${xmlEsc(progDescLlenado(fila))}`);
  } else detalle.push(xmlEsc(progDescLlenado(fila)));
  const imgs = Array.from({ length: nImagenes }, (_, i) => `<p style="margin:0 0 14px 0"><img src="cid:dia${i}@controlhormigon" width="800" alt="Programación del día" style="width:800px;max-width:100%"></p>`).join("");
  return `<html><body style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#1c2620">
<p>Estimados:</p>
<p>Les informamos que hubo una modificación en la programación de hormigón de la obra <b>${xmlEsc(obraNombre)}</b>.</p>
<p style="margin:0 0 4px 0"><b>${rotulo}:</b></p>
<p style="margin:0 0 14px 14px">${detalle.join("<br>")}</p>
<p style="margin:0 0 6px 0">Así queda la programación ${nImagenes > 1 ? "de los días afectados" : "del día"}:</p>
${imgs}
<p>Saludos.<br><br><span style="color:#5d6b63">${PROG_FIRMA_LINEAS.join("<br>")}</span></p>
</body></html>`;
}

function progBase64Utf8(txt) {
  const bytes = new TextEncoder().encode(txt);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const progPartir76 = (b64) => b64.replace(/(.{76})/g, "$1\r\n");

// Borrador .eml con formato e imágenes embebidas (X-Unsent: 1 hace que
// Outlook lo abra como mensaje nuevo, editable, listo para enviar).
function progDescargarEml(asunto, htmlFn, imagenesB64) {
  const LIM = "----=_ControlHormigon_" + Date.now();
  const partes = [
    `To: ${PROG_MAIL_PARA.join(", ")}`,
    `Cc: ${PROG_MAIL_CC.join(", ")}`,
    `Subject: =?UTF-8?B?${progBase64Utf8(asunto)}?=`,
    "X-Unsent: 1",
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; type="text/html"; boundary="${LIM}"`,
    "",
    `--${LIM}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    progPartir76(progBase64Utf8(htmlFn(imagenesB64.length))),
  ];
  imagenesB64.forEach((b64, i) => {
    partes.push(`--${LIM}`, `Content-Type: image/png; name="dia${i + 1}.png"`, "Content-Transfer-Encoding: base64",
      `Content-ID: <dia${i}@controlhormigon>`, `Content-Disposition: inline; filename="dia${i + 1}.png"`, "", progPartir76(b64));
  });
  partes.push(`--${LIM}--`, "");
  const url = URL.createObjectURL(new Blob([partes.join("\r\n")], { type: "message/rfc822" }));
  const a = el("a", { href: url, download: "Aviso modificacion programacion.eml" });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function progAvisarCambio(tipo, fila, anterior) {
  if (!progAvisoActivo()) return;
  const obra = byId(state.obras, state.obraId);
  const obraNombre = obra?.nombre || "";
  const asunto = `Obra ${obraNombre} - Modificación en la programación de hormigón`;
  const modo = $("#progAvisoModo")?.value || "eml";
  if (modo === "eml") {
    const fechas = [fila.fecha];
    if (anterior && anterior.fecha !== fila.fecha) fechas.unshift(anterior.fecha);
    const imagenes = fechas.map((f) => progImagenDia(f, tipo === "eliminado" ? null : fila.id, tipo === "eliminado" ? fila : null));
    setTimeout(() => progDescargarEml(asunto, (n) => progHtmlAviso(tipo, fila, anterior, obraNombre, n), imagenes), 250);
    return;
  }
  const lineas = [];
  if (tipo === "agregado") lineas.push(`Se AGREGÓ un llenado:`, `  ${progDescLlenado(fila)}`);
  else if (tipo === "eliminado") lineas.push(`Se ELIMINÓ un llenado:`, `  ${progDescLlenado(fila)}`);
  else {
    lineas.push(tipo === "reprogramado" ? `Se REPROGRAMÓ un llenado:` : `Se MODIFICÓ un llenado:`);
    if (anterior) lineas.push(`  Antes: ${progDescLlenado(anterior)}`);
    lineas.push(`  Ahora: ${progDescLlenado(fila)}`);
  }
  const cuerpo = `Estimados:\n\nHubo una modificación en la programación de hormigón de la obra ${obraNombre}:\n\n${lineas.join("\n")}\n\nSaludos.\n\n${PROG_FIRMA_LINEAS.join("\n")}`;
  const href = `mailto:${PROG_MAIL_PARA.join(",")}?cc=${PROG_MAIL_CC.join(",")}&subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo.replace(/\n/g, "\r\n"))}`;
  setTimeout(() => {
    const a = el("a", { href });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, 250);
}

// ---------- Word para Tránsito (media calzada en los días con bomba) ----------
// Se arma el .docx a mano (un .docx es un zip con unos pocos XML), sin
// librerías externas. El zip va "sin comprimir" (STORE), que Word acepta.
const TRANSITO_CALLES = ["Chiverta", "Bvar Artigas"];

function zipCrc32(bytes) {
  if (!zipCrc32.tabla) {
    zipCrc32.tabla = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = zipCrc32.tabla[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipSinComprimir(archivos) {
  const enc = new TextEncoder();
  const partes = [], central = [];
  let offset = 0;
  archivos.forEach(({ nombre, contenido }) => {
    const n = enc.encode(nombre), d = enc.encode(contenido), crc = zipCrc32(d);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
    loc.setUint16(8, 0, true); loc.setUint16(10, 0, true); loc.setUint16(12, 0x21, true);
    loc.setUint32(14, crc, true); loc.setUint32(18, d.length, true); loc.setUint32(22, d.length, true);
    loc.setUint16(26, n.length, true); loc.setUint16(28, 0, true);
    partes.push(new Uint8Array(loc.buffer), n, d);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, d.length, true); cen.setUint32(24, d.length, true);
    cen.setUint16(28, n.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), n);
    offset += 30 + n.length + d.length;
  });
  const tamCentral = central.reduce((a, b) => a + b.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true);
  fin.setUint32(12, tamCentral, true); fin.setUint32(16, offset, true);
  return new Blob([...partes, ...central, new Uint8Array(fin.buffer)],
    { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

const xmlEsc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function wRun(texto, { negrita = false, rojo = false, tam = 24 } = {}) {
  return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${negrita ? "<w:b/>" : ""}${rojo ? '<w:color w:val="E8505B"/>' : ""}<w:sz w:val="${tam}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(texto)}</w:t></w:r>`;
}
function wPar(runs, { despues = 0, antes = 0, linea = false } = {}) {
  const borde = linea ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="808080"/></w:pBdr>' : "";
  return `<w:p><w:pPr>${borde}<w:spacing w:before="${antes}" w:after="${despues}"/></w:pPr>${runs}</w:p>`;
}

function progDiaTransito(iso) {
  const d = progParse(iso);
  const nombre = PROG_DIAS[d.getDay()].toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return `${nombre} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Normaliza "9:00", "09:00:00" o "9.30" a "HH:MM" (así ordenan bien y el
// campo de hora del Word las acepta).
function progHoraHHMM(h) {
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(h || "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

function progDiasConBomba() {
  const desde = state.prog.desde, hasta = state.prog.hasta;
  const dias = progAgruparPorDia(progFilas("TODAS", desde, hasta));
  const res = [];
  dias.forEach((dia) => {
    const conBomba = dia.filas.filter((r) => !r.sinLlenados && progEsBomba(r.bombeado));
    if (conBomba.length === 0) return;
    const horas = conBomba.map((r) => progHoraHHMM(r.hora)).filter(Boolean).sort();
    res.push({ fecha: dia.fecha, hora: horas[0] || "", detalle: conBomba });
  });
  return res;
}

function abrirModalTransito() {
  if (!esAdmin()) return;
  const desde = state.prog.desde, hasta = state.prog.hasta;
  if (!desde || !hasta) return toast("Elegí las fechas Desde y Hasta", "error");
  if (desde > hasta) return toast("La fecha Desde es posterior a la fecha Hasta", "error");
  const dias = progDiasConBomba();
  if (dias.length === 0) return toast("No hay días con bomba en ese rango de fechas", "error");
  let calleAnterior = TRANSITO_CALLES[0];
  try { calleAnterior = localStorage.getItem("transitoCalle") || calleAnterior; } catch (e) { /* sin storage */ }
  const cont = $("#transitoDias");
  cont.innerHTML = "";
  const lista = el("datalist", { id: "transitoCallesLista" }, TRANSITO_CALLES.map((c) => el("option", { value: c })));
  cont.appendChild(lista);
  dias.forEach((d, i) => {
    const bombas = d.detalle.slice().sort((a, b) => (progHoraHHMM(a.hora) || "99").localeCompare(progHoraHHMM(b.hora) || "99"))
      .map((r) => `${progHoraHHMM(r.hora) || "sin hora"} ${PROG_ZONAS[r.zona] || ""} (${r.bombeado}${r.elemento ? " · " + r.elemento : ""})`).join("  |  ");
    cont.appendChild(el("div", { style: "margin-bottom:10px" }, [
    el("div", { class: "row", style: "align-items:flex-end;gap:10px;flex-wrap:wrap", "data-fecha": d.fecha }, [
      el("label", { style: "display:flex;align-items:center;gap:6px;width:150px;font-weight:600" }, [
        el("input", { type: "checkbox", checked: "checked", class: "tr-incluir" }),
        progDiaTransito(d.fecha),
      ]),
      el("div", { class: "field", style: "flex:1;min-width:140px;margin:0" }, [
        el("label", {}, "Calle"),
        el("input", { type: "text", list: "transitoCallesLista", class: "tr-calle", value: calleAnterior }),
      ]),
      el("div", { class: "field", style: "width:110px;margin:0" }, [
        el("label", {}, "Desde las"),
        el("input", { type: "time", class: "tr-hora", value: d.hora }),
      ]),
    ]),
    el("div", { class: "hint", style: "margin:2px 0 0 0" }, `Bombas programadas: ${bombas}`),
    ]));
  });
  openModal("#modalTransito");
}

function generarWordTransito() {
  const obra = byId(state.obras, state.obraId);
  const filas = $all("#transitoDias [data-fecha]").filter((f) => f.querySelector(".tr-incluir").checked);
  if (filas.length === 0) return toast("Tildá al menos un día", "error");
  const dias = filas.map((f) => ({
    fecha: f.dataset.fecha,
    calle: f.querySelector(".tr-calle").value.trim(),
    hora: f.querySelector(".tr-hora").value,
  }));
  if (dias.some((d) => !d.calle)) return toast("Falta indicar la calle en algún día", "error");
  try { localStorage.setItem("transitoCalle", dias[dias.length - 1].calle); } catch (e) { /* sin storage */ }

  const cuerpo = [];
  cuerpo.push(wPar(wRun(`Programación de media calzada - Obra ${obra?.nombre || ""}`, { negrita: true, tam: 28 }), { despues: 240 }));
  dias.forEach((d, i) => {
    cuerpo.push(wPar(wRun(progDiaTransito(d.fecha), { negrita: true, rojo: true, tam: 26 }), { antes: i === 0 ? 0 : 120 }));
    cuerpo.push(wPar(wRun(`Media calzada por ${d.calle}`)));
    cuerpo.push(wPar(
      wRun("A partir de las ") + wRun(d.hora ? `${d.hora}hs` : "(hora a confirmar)", { rojo: true }),
      { linea: i < dias.length - 1, despues: i < dias.length - 1 ? 120 : 0 }
    ));
  });
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${cuerpo.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const blob = zipSinComprimir([
    { nombre: "[Content_Types].xml", contenido: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { nombre: "_rels/.rels", contenido: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { nombre: "word/document.xml", contenido: documento },
  ]);
  const nombreObra = (obra?.nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w .-]/g, "").trim();
  const a = el("a", { href: URL.createObjectURL(blob), download: `${fmtFechaArchivo(dias[0].fecha)} media calzada ${nombreObra}`.trim() + ".docx" });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  closeModal($("#modalTransito"));
  toast("Word generado");
}

// ---------- Eventos ----------
function bindProgramacionHandlers() {
  const f = progForm();
  if (!f) return;
  const sel = f.prog_bombeado;
  sel.innerHTML = "";
  PROG_BOMBEADO.forEach((b) => sel.appendChild(el("option", { value: b }, b)));
  progRenderHormigones("");

  $all("#progZonaTabs button").forEach((b) => b.addEventListener("click", () => progSetZona(b.dataset.zona)));
  f.addEventListener("submit", progOnSubmit);
  f.prog_sinLlenados.addEventListener("change", progOnSinLlenadosChange);
  $("#btnProgCancelar").addEventListener("click", () => progResetForm(true));

  const onRango = () => {
    state.prog.desde = $("#progDesde").value;
    state.prog.hasta = $("#progHasta").value;
    renderProgramacion();
  };
  $("#progDesde").addEventListener("change", onRango);
  $("#progHasta").addEventListener("change", onRango);
  $("#btnProg14").addEventListener("click", () => progSetRango(progHoy(), progSumarDias(progHoy(), 13)));
  $("#btnProgExportarPDF").addEventListener("click", exportarProgramacionPDF);
  $("#btnProgWordTransito").addEventListener("click", abrirModalTransito);
  $("#btnTransitoGenerar").addEventListener("click", generarWordTransito);
  const chk = $("#progAvisarMail");
  if (chk) {
    try { chk.checked = localStorage.getItem("progAvisarMail") !== "no"; } catch (e) { /* sin storage */ }
    chk.addEventListener("change", () => { try { localStorage.setItem("progAvisarMail", chk.checked ? "si" : "no"); } catch (e) { /* sin storage */ } });
  }
  const modo = $("#progAvisoModo");
  if (modo) {
    try { modo.value = localStorage.getItem("progAvisoModo") || "eml"; } catch (e) { /* sin storage */ }
    modo.addEventListener("change", () => { try { localStorage.setItem("progAvisoModo", modo.value); } catch (e) { /* sin storage */ } });
  }

  progResetForm(false);
  renderProgramacion();
}
