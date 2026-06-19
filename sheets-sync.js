/**
 * sheets-sync.js
 * ──────────────────────────────────────────────────────────────
 * Sincroniza datos de jardines desde un Google Sheet AOC público.
 *
 * El Sheet debe tener publicado como CSV (Archivo → Compartir →
 * Publicar en la web → seleccionar hoja → CSV) y la URL se pasa
 * a la función loadJardinesFromSheets().
 *
 * ESTRUCTURA ESPERADA DEL SHEET (columnas mínimas):
 *   Columna A  : Nombre jardín   (ej: "El Canelito")
 *   Columna B  : Código          (ej: 14101001)
 *   Columna C  : Nivel           (ej: "SALA CUNA", "MEDIO MENOR"…)
 *   Columna D  : Cap. Sala       (capacidad total de la sala)
 *   Columna E  : Cupos disponibles
 *   Columna F  : Vacantes        ("SI" / "NO" / número > 0)
 *   Columna G  : Horario TÍAs inicio JH   (ej: "08:30")
 *   Columna H  : Horario niños inicio JH  (ej: "08:30")
 *   Columna I  : Horario niños término JH (ej: "16:30")
 *   Columna J  : Horario TÍAs término JH  (ej: "17:30")
 *   Columna K  : Inicio TJMJ    (ej: "16:00")
 *   Columna L  : Término TJMJ   (ej: "20:00")
 *
 * MODO FALLBACK:
 *   Si el Sheet no es accesible (CORS, sin publicar, offline)
 *   la función resuelve con los datos locales de jardines.json.
 * ──────────────────────────────────────────────────────────────
 */

/* ── Mapeo de nombres de nivel del Sheet → rango de edad ───── */
const RANGO_NIVEL = {
  'SC MENOR':          '0 - 11 Meses',
  'SC MAYOR':          '12 - 23 Meses',
  'SALA CUNA':         '0 - 23 Meses',
  'SALA CUNA MENOR':   '0 - 11 Meses',
  'SALA CUNA MAYOR':   '12 - 23 Meses',
  'SALA CUNA HETEROGENEA': '0 - 23 Meses',
  'HETEROGENEO':       '0 - 23 Meses',
  'MEDIO MENOR':       '24 - 35 Meses',
  'MEDIO MAYOR':       '36 - 47 Meses',
  'MEDIO MIXTO':       '24 - 47 Meses',
  'MEDIOS':            '24 - 47 Meses',
  'NIVEL MEDIO MENOR': '24 - 35 Meses',
  'NIVEL MEDIO MAYOR': '36 - 47 Meses',
  'NIVEL MEDIO MIXTO': '24 - 47 Meses',
  'TRANSICION 1':      '48 - 59 Meses',
  'NT1':               '48 - 59 Meses',
  'TRANSICION 2':      '60 - 71 Meses',
  'NT2':               '60 - 71 Meses',
};

/* ── Normaliza nombre de nivel ─────────────────────────────── */
function normalizarNivel(raw) {
  if (!raw) return '';
  return raw.trim()
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nombreMostrable(raw) {
  // Convierte "SC MAYOR" → "Sala Cuna Mayor" etc.
  const mapa = {
    'SC MENOR':       'Sala Cuna Menor',
    'SC MAYOR':       'Sala Cuna Mayor',
    'SALA CUNA':      'Sala Cuna',
    'SALA CUNA MENOR':'Sala Cuna Menor',
    'SALA CUNA MAYOR':'Sala Cuna Mayor',
    'SALA CUNA HETEROGENEA':'Sala Cuna Heterogénea',
    'HETEROGENEO':    'Sala Cuna Heterogénea',
    'MEDIO MENOR':    'Nivel Medio Menor',
    'MEDIO MAYOR':    'Nivel Medio Mayor',
    'MEDIO MIXTO':    'Nivel Medio Mixto',
    'MEDIOS':         'Nivel Medio',
    'NIVEL MEDIO MENOR':'Nivel Medio Menor',
    'NIVEL MEDIO MAYOR':'Nivel Medio Mayor',
    'NIVEL MEDIO MIXTO':'Nivel Medio Mixto',
    'TRANSICION 1':   'Nivel de Transición 1',
    'NT1':            'Nivel de Transición 1',
    'TRANSICION 2':   'Nivel de Transición 2',
    'NT2':            'Nivel de Transición 2',
  };
  const k = normalizarNivel(raw);
  return mapa[k] || raw.trim();
}

/* ── Parsea CSV respetando comas dentro de comillas ─────────── */
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

/**
 * Convierte CSV del Sheet AOC en un mapa:
 *   { "NOMBRE JARDIN (normalizado)": { niveles: [...], horarios: {...} } }
 *
 * Se asume que el CSV viene de la hoja "CONFORMACION 2026" donde:
 *  - Hay filas de jardín + filas de nivel mezcladas
 *  - Las filas de jardín tienen el nombre en alguna columna izquierda
 *  - Las filas de nivel tienen Cap.Sala y Cupos en columnas posteriores
 *
 * ADAPTACIÓN: la función es flexible y busca filas que:
 *   • Tengan un nombre de nivel reconocible en columna C (índice 2)
 *   • O columna B si es una fila de total/resumen
 */
function parsearAOC(csvText) {
  const lineas = csvText.split('\n').filter(l => l.trim());
  const resultado = {};

  let jardineActual = null;

  for (const linea of lineas) {
    const cols = parseCSVLine(linea);

    // Detectar nombre del jardín: columna A no vacía y columna C parece nivel o vacía
    const colA = (cols[0] || '').trim();
    const colB = (cols[1] || '').trim();
    const colC = (cols[2] || '').trim();  // Nivel
    const colD = (cols[3] || '').trim();  // Cap.Física o sala
    const colE = (cols[4] || '').trim();  // Cap R.O.
    const colG = (cols[6] || '').trim();  // Cupos disponibles (columna Y en imagen)
    const colH = (cols[7] || '').trim();  // Matricula
    const colI = (cols[8] || '').trim();  // MNA
    const colJ = (cols[9] || '').trim();  // Lista espera
    const colK = (cols[10] || '').trim(); // Cupos disp
    // Horarios (columnas más a la izquierda en el panel de horarios)
    const horTiasIni  = (cols[17] || '').trim(); // Aprox col R
    const horNinoIni  = (cols[18] || '').trim();
    const horNinoTerm = (cols[19] || '').trim();
    const horTiasTerm = (cols[20] || '').trim();
    const horTJMJIni  = (cols[21] || '').trim();
    const horTJMJTerm = (cols[22] || '').trim();

    // ¿Es fila de jardín? (colA tiene texto, colB vacía o tiene matrícula, colC tiene nivel)
    const esNombreJardin = colA.length > 3 &&
      !colA.toUpperCase().includes('TOTAL') &&
      !colA.toUpperCase().includes('NOMBRE') &&
      !colA.toUpperCase().includes('JARDIN') &&
      normalizarNivel(colC) === '';  // nivel no reconocido → es encabezado

    if (esNombreJardin && !colC) {
      jardineActual = colA.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      if (!resultado[jardineActual]) {
        resultado[jardineActual] = { niveles: [], horarios: {} };
      }
      // Capturar horarios si están en esta fila
      if (horTiasIni) {
        resultado[jardineActual].horarios = {
          jhTiasInicio: horTiasIni,
          jhNinoInicio: horNinoIni,
          jhNinoTermino: horNinoTerm,
          jhTiasTermino: horTiasTerm,
          tjmjInicio: horTJMJIni,
          tjmjTermino: horTJMJTerm,
        };
      }
      continue;
    }

    // ¿Es fila de nivel?
    const nivelNorm = normalizarNivel(colC);
    if (jardineActual && nivelNorm && RANGO_NIVEL[nivelNorm] !== undefined) {
      const capSala = parseInt(colD) || parseInt(colE) || 0;
      const cupos   = parseInt(colK) || parseInt(colG) || 0;
      const vacantes = cupos > 0;

      resultado[jardineActual].niveles.push({
        nombre:   nombreMostrable(colC),
        rango:    RANGO_NIVEL[nivelNorm] || '',
        capSala:  capSala,
        cuposDisponibles: cupos,
        vacantes: vacantes,
      });
    }
  }

  return resultado;
}

/**
 * Combina datos del Sheet con datos base de jardines.json
 * El Sheet enriquece/actualiza: niveles, cupos, horarios
 * El JSON local conserva: coordenadas, dirección, teléfono, etc.
 */
function combinarDatos(jardinesBase, datosSheet) {
  return jardinesBase.map(j => {
    // Buscar match por nombre normalizado
    const keyBuscar = j.nombre.toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .trim();

    // Buscar la clave más cercana en datosSheet
    const keyEncontrada = Object.keys(datosSheet).find(k =>
      k === keyBuscar ||
      k.includes(keyBuscar) ||
      keyBuscar.includes(k)
    );

    if (!keyEncontrada) return j; // sin datos del Sheet: retornar tal cual

    const datosSH = datosSheet[keyEncontrada];

    // Actualizar niveles si el Sheet tiene datos
    const nivelesActualizados = datosSH.niveles.length > 0
      ? datosSH.niveles
      : j.niveles;

    // Actualizar horario si el Sheet tiene datos
    let horarioActualizado = j.horario;
    const h = datosSH.horarios;
    if (h && h.jhTiasInicio && h.jhTiasTermino) {
      horarioActualizado = `${h.jhTiasInicio} A ${h.jhTiasTermino}`;
    }

    return {
      ...j,
      niveles: nivelesActualizados,
      horario: horarioActualizado,
      horarios: datosSH.horarios || null,
      _fuenteDatos: 'sheet',
      _ultimaActualizacion: new Date().toLocaleString('es-CL'),
    };
  });
}

/**
 * FUNCIÓN PRINCIPAL
 * Carga jardines combinando Google Sheet + jardines.json local.
 *
 * @param {string} sheetCsvUrl   URL pública de exportación CSV del Sheet
 * @param {string} jardinesUrl   URL del jardines.json local (default: './data/jardines.json')
 * @returns {Promise<Array>}     Array de jardines enriquecidos
 */
async function loadJardinesFromSheets(sheetCsvUrl, jardinesUrl = './data/jardines.json') {
  // Siempre cargar el JSON base (tiene coords, dirección, etc.)
  const jardinesBase = await fetch(jardinesUrl).then(r => r.json());

  if (!sheetCsvUrl) {
    console.info('[sheets-sync] Sin URL de Sheet → usando datos locales');
    return jardinesBase;
  }

  try {
    // Intentar cargar el Sheet (puede fallar por CORS si no está publicado como CSV)
    const resp = await fetch(sheetCsvUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csvText = await resp.text();

    const datosSheet = parsearAOC(csvText);
    const combinados = combinarDatos(jardinesBase, datosSheet);

    const conSheet = combinados.filter(j => j._fuenteDatos === 'sheet').length;
    console.info(`[sheets-sync] ✅ Sheet cargado. ${conSheet}/${jardinesBase.length} jardines actualizados.`);

    return combinados;
  } catch (err) {
    console.warn('[sheets-sync] ⚠️ No se pudo cargar el Sheet, usando datos locales.', err.message);
    return jardinesBase;
  }
}

// Exportar para uso en módulos o acceso global
if (typeof module !== 'undefined') {
  module.exports = { loadJardinesFromSheets, parsearAOC, combinarDatos };
} else {
  window.SheetsSync = { loadJardinesFromSheets, parsearAOC, combinarDatos };
}
