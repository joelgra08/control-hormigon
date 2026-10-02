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
  try {
    await DB.put("programacion", fila);
  } catch (err) { return; } // el aviso de error ya lo mostró la capa de datos
  const idx = state.programacion.findIndex((r) => r.id === fila.id);
  if (idx >= 0) state.programacion[idx] = fila; else state.programacion.push(fila);
  progResetForm(true);
  renderProgramacion();
  toast(editando ? "Llenado actualizado" : "Llenado agregado", "ok");
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
}

function progPasarAlSiguiente(fila) { return progMoverA(fila, progSiguienteHabil(fila.fecha)); }

// Cambia de día un llenado (botón ⏭ o arrastrando la fila a otro día).
async function progMoverA(fila, fecha) {
  if (!progPuedeEditar() || !fecha || fecha === fila.fecha) return;
  const nueva = { ...fila, fecha };
  try { await DB.put("programacion", nueva); } catch (err) { return; }
  const idx = state.programacion.findIndex((r) => r.id === fila.id);
  if (idx >= 0) state.programacion[idx] = nueva;
  renderProgramacion();
  toast(`Pasado al ${progDiaNombre(nueva.fecha).toLowerCase()} ${progFechaCorta(nueva.fecha)}`, "ok");
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

  progResetForm(false);
  renderProgramacion();
}
