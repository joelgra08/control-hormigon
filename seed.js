/* ===========================================================
   seed.js — Catálogo base por defecto para una obra nueva
   (Tomado como plantilla general de construcción; el usuario
   puede editar/agregar/borrar todo desde la pantalla Catálogo)
   =========================================================== */

function catalogoElementosBase() {
  // codigo, tipoElemento, nombre, permiteModificado (cabezal/riostra que se
  // puede desplazar por un pilote corrido), pagaPorM2 (se paga por m2 y no
  // debe sumar al Total m3 del resumen)
  return [
    ["MC", "ELEM-VERT", "Muro colado"],
    ["MDC", "ELEM-VERT", "Muro de contención"],
    ["P", "ELEM-VERT", "Pilar"],
    ["PA", "ELEM-VERT", "Pantalla"],
    ["CT", "ELEM-VERT", "Cabezal", true],
    ["TD", "ELEM", "Tanque drenaje"],
    ["VR", "ELEM-HORIZ", "Viga riostra", true],
    ["VC", "ELEM-HORIZ", "Viga de coronamiento"],
    ["VL", "ELEM-HORIZ", "Viga losa"],
    ["L", "ELEM-HORIZ", "Losa"],
    ["HL", "HORM-LIMP", "Hormigón de limpieza"],
    ["D", "DESPERDICIO", "Desperdicio"],
    ["E", "ESCALERAS", "Escaleras"],
    ["CP", "ELEM-HORIZ", "Contrapiso", false, true],
    ["O", "OTROS", "Otros"],
  ].map(([codigo, tipoElemento, nombre, permiteModificado, pagaPorM2]) => ({
    id: uid("elem"),
    codigo,
    tipoElemento,
    nombre,
    permiteModificado: !!permiteModificado,
    pagaPorM2: !!pagaPorM2,
  }));
}

function catalogoEquiposBase() {
  // rol: TORRE | BASAMENTO | HERREROS | INDIRECTOS | OTRO — define si ese
  // equipo cuenta (y para qué cuadrilla) en el cálculo de HH/m3. "OTRO" es
  // para equipos que no entran en la productividad de hormigón (ej.
  // Sanitarios, Electricistas).
  return [
    { nombre: "Torre", rol: "TORRE" },
    { nombre: "Basamento", rol: "BASAMENTO" },
    { nombre: "Herreros", rol: "HERREROS" },
    { nombre: "Indirectos", rol: "INDIRECTOS" },
  ].map((e) => ({ id: uid("equipo"), ...e }));
}

function catalogoHormigonesBase() {
  return [
    ["C15", "15 N/mm²"],
    ["C20", "20 N/mm²"],
    ["C25", "25 N/mm²"],
    ["C30", "30 N/mm²"],
    ["C35", "35 N/mm²"],
    ["C40", "40 N/mm²"],
    ["C45", "45 N/mm²"],
    ["C50", "50 N/mm²"],
  ].map(([codigo, resistencia]) => ({ id: uid("horm"), codigo, resistencia }));
}

function catalogoProveedoresBase() {
  return ["Cielo Azul", "Hormigones Artigas", "Hormigones Uruguay", "Otros"].map(
    (nombre) => ({ id: uid("prov"), nombre })
  );
}

function catalogoCuadrillasBase() {
  // grupo: TORRE | BASAMENTO | OTRO — usado para separar la productividad (HH/m3) por equipo
  return [
    { nombre: "Cuadrilla 1", grupo: "OTRO" },
  ].map((c) => ({ id: uid("cuad"), ...c }));
}

function catalogoColocacionBase() {
  return ["Bomba lanza", "Bomba de arrastre", "Volcado directo", "Grúa/balde"].map(
    (nombre) => ({ id: uid("coloc"), nombre })
  );
}

async function seedObraCatalogo(obraId) {
  const withObra = (arr) => arr.map((x) => ({ ...x, obraId }));
  await DB.bulkPut("catalogoElementos", withObra(catalogoElementosBase()));
  await DB.bulkPut("catalogoHormigones", withObra(catalogoHormigonesBase()));
  await DB.bulkPut("catalogoProveedores", withObra(catalogoProveedoresBase()));
  await DB.bulkPut("catalogoCuadrillas", withObra(catalogoCuadrillasBase()));
  await DB.bulkPut("catalogoColocacion", withObra(catalogoColocacionBase()));
  await DB.bulkPut("catalogoEquipos", withObra(catalogoEquiposBase()));
}

// Catálogo real de la obra Summit (usado por la importación de datos reales)
async function seedObraCatalogoSummit(obraId) {
  const withObra = (arr) => arr.map((x) => ({ ...x, obraId }));
  await DB.bulkPut("catalogoElementos", withObra(catalogoElementosBase()));
  await DB.bulkPut("catalogoHormigones", withObra(catalogoHormigonesBase()));
  await DB.bulkPut("catalogoProveedores", withObra(catalogoProveedoresBase()));
  await DB.bulkPut("catalogoCuadrillas", withObra([
    { id: uid("cuad"), nombre: "Jhon (Torre)", grupo: "TORRE" },
    { id: uid("cuad"), nombre: "Pablo (Basamento)", grupo: "BASAMENTO" },
  ]));
  await DB.bulkPut("catalogoColocacion", withObra([
    { id: uid("coloc"), nombre: "LANZA" },
    { id: uid("coloc"), nombre: "ARRASTRE" },
  ]));
  await DB.bulkPut("catalogoEquipos", withObra(catalogoEquiposBase()));
}
